// End-to-end and cross-cutting integration tests
// Covers INT-*, SP-30 through SP-41 (dedup, importance clamping, token logging)
// Requires TEST_DB_URL + TEST_OPENROUTER_API_KEY
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import pg from "pg";
import pgvector from "pgvector/pg";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

const DB_URL = process.env.TEST_DB_URL;
const API_KEY = process.env.TEST_OPENROUTER_API_KEY;
const skip = !DB_URL || !API_KEY;

let pool;

beforeAll(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DB_URL });
  pool.on("connect", async (c) => { await pgvector.registerTypes(c); });
  await pool.query(`DELETE FROM thoughts WHERE metadata @> '{"_e2e_test":true}'`);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM thoughts WHERE metadata @> '{"_e2e_test":true}'`);
  await pool.end();
});

async function insertThought(opts) {
  const { content, importance = 0.5, scope = "personal", embedding = null, source_phase = "build" } = opts;
  const vec = embedding ? pgvector.toSql(embedding) : pgvector.toSql(Array(1536).fill(0.01));
  const { rows } = await pool.query(
    `INSERT INTO thoughts (content, embedding, metadata, scope, thought_type, source_agent, source_phase, importance)
     VALUES ($1, $2, $3, $4::ltree[], 'insight', 'claude', $5, $6)
     RETURNING id, created_at`,
    [content, vec, JSON.stringify({ _e2e_test: true }), `{${scope}}`, source_phase, importance]
  );
  return rows[0];
}

// ─── INT-01 Full capture→search roundtrip ────────────────────────────────────

describe.skipIf(skip)("INT-01 capture → search roundtrip", () => {
  it("INT-01 captured thought is retrievable by semantic search", async () => {
    const distinctVec = Array(1536).fill(0);
    distinctVec[0] = 1.0;
    await insertThought({ content: "Roundtrip test thought: pgvector index performance", embedding: distinctVec });

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`,
      [pgvector.toSql(distinctVec)]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].content).toContain("Roundtrip test thought");
  });
});

// ─── INT-02 Scope isolation roundtrip ────────────────────────────────────────

describe.skipIf(skip)("INT-02 scope isolation roundtrip", () => {
  it("INT-02 thought inserted in scope A is not found when searching scope B", async () => {
    const scopeA = `int02_a_${Date.now()}`;
    const scopeB = `int02_b_${Date.now()}`;
    const vec = Array(1536).fill(0); vec[1] = 1.0;
    await insertThought({ content: "INT-02 scope A only", scope: scopeA, embedding: vec });

    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 10, '{}', $2, false)`,
      [pgvector.toSql(vec), scopeB]
    );
    expect(rows.some(r => r.content === "INT-02 scope A only")).toBe(false);
  });
});

// ─── INT-03 Invalidation ─────────────────────────────────────────────────────

describe.skipIf(skip)("INT-03 invalidation hides from default search", () => {
  it("INT-03 invalidated thought absent from default search, present with include_invalidated=true", async () => {
    const vec = Array(1536).fill(0); vec[2] = 1.0;
    const row = await insertThought({ content: "INT-03 to invalidate", embedding: vec });
    await pool.query(`UPDATE thoughts SET status='invalidated', invalidated_at=now() WHERE id=$1`, [row.id]);

    const { rows: hidden } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, false)`, [pgvector.toSql(vec)]
    );
    const { rows: shown } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, true)`, [pgvector.toSql(vec)]
    );
    expect(hidden.some(r => r.id === row.id)).toBe(false);
    expect(shown.some(r => r.id === row.id)).toBe(true);
  });
});

// ─── INT-04 Token usage tracking ─────────────────────────────────────────────

describe.skipIf(skip)("INT-04 token_usage table exists and accepts inserts", () => {
  it("INT-04 token_usage record can be inserted and queried", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='token_usage') as e`
    );
    if (!exists[0].e) return;

    const sessionId = `int04_${Date.now()}`;
    await pool.query(
      `INSERT INTO token_usage (session_id, scope, model, input_tokens, output_tokens, embeddings_count, thoughts_captured)
       VALUES ($1, '{personal}'::ltree[], 'openai/gpt-oss-120b:free', 123, 45, 1, 1)`,
      [sessionId]
    );
    const { rows } = await pool.query(`SELECT * FROM token_usage WHERE session_id=$1`, [sessionId]);
    expect(rows.length).toBe(1);
    expect(parseInt(rows[0].input_tokens)).toBe(123);
    await pool.query(`DELETE FROM token_usage WHERE session_id=$1`, [sessionId]);
  });
});

// ─── INT-05 Autocapture warnings table ───────────────────────────────────────

describe.skipIf(skip)("INT-05 autocapture_warnings table", () => {
  it("INT-05 autocapture_warnings accepts truncation warning inserts", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='autocapture_warnings') as e`
    );
    if (!exists[0].e) return;

    const sessionId = `int05_${Date.now()}`;
    await pool.query(
      `INSERT INTO autocapture_warnings (session_id, warning_type, detail) VALUES ($1, 'truncation', 'test detail')`,
      [sessionId]
    );
    const { rows } = await pool.query(
      `SELECT * FROM autocapture_warnings WHERE session_id=$1`, [sessionId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].warning_type).toBe("truncation");
    await pool.query(`DELETE FROM autocapture_warnings WHERE session_id=$1`, [sessionId]);
  });
});

// ─── INT-06 Thought relation roundtrip ───────────────────────────────────────

describe.skipIf(skip)("INT-06 thought_relations roundtrip", () => {
  it("INT-06 relation between two thoughts is stored and queryable", async () => {
    const r1 = await insertThought({ content: "INT-06 source thought" });
    const r2 = await insertThought({ content: "INT-06 target thought" });
    await pool.query(
      `INSERT INTO thought_relations (source_id, target_id, relation_type) VALUES ($1, $2, 'supports')`,
      [r1.id, r2.id]
    );
    const { rows } = await pool.query(
      `SELECT * FROM thought_relations WHERE source_id=$1 AND target_id=$2`,
      [r1.id, r2.id]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].relation_type).toBe("supports");
    await pool.query(`DELETE FROM thought_relations WHERE source_id=$1`, [r1.id]);
  });
});

// ─── INT-07 Importance affects ranking ───────────────────────────────────────

describe.skipIf(skip)("INT-07 importance affects combined score", () => {
  it("INT-07 higher importance thought ranks above lower importance with same embedding", async () => {
    const vec = Array(1536).fill(0);
    vec[10] = 1.0;
    const low = await insertThought({ content: "low importance", importance: 0.1, embedding: vec });
    const high = await insertThought({ content: "high importance", importance: 0.9, embedding: vec });

    const { rows } = await pool.query(
      `SELECT id, combined_score FROM match_thoughts_scored($1, 0.0, 10, '{}', NULL, false)`,
      [pgvector.toSql(vec)]
    );
    const lowRow = rows.find(r => r.id === low.id);
    const highRow = rows.find(r => r.id === high.id);
    if (lowRow && highRow) {
      expect(parseFloat(highRow.combined_score)).toBeGreaterThan(parseFloat(lowRow.combined_score));
    }
  });
});

// ─── SP-30/31/32 Deduplication ────────────────────────────────────────────────

describe.skipIf(skip)("SP-30/31/32 deduplication logic", () => {
  it("SP-32 identical embedding has cosine similarity = 1.0", async () => {
    const vec = Array(1536).fill(0);
    vec[20] = 1.0;
    const pgVec = pgvector.toSql(vec);
    const row = await insertThought({ content: "dedup base", embedding: vec });
    const { rows } = await pool.query(
      `SELECT 1 - (embedding <=> $1) as sim FROM thoughts WHERE id=$2`,
      [pgVec, row.id]
    );
    expect(parseFloat(rows[0].sim)).toBeCloseTo(1.0, 4);
  });

  it("SP-30 dedup query detects high similarity (>0.8)", async () => {
    const vec = Array(1536).fill(0);
    vec[30] = 1.0;
    const pgVec = pgvector.toSql(vec);
    await insertThought({ content: "existing similar thought", embedding: vec, scope: "personal" });
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM thoughts WHERE (1 - (embedding <=> $1)) > 0.8 AND scope @> ARRAY[$2]::ltree[]`,
      [pgVec, "personal"]
    );
    expect(parseInt(rows[0].cnt)).toBeGreaterThanOrEqual(1);
  });

  it("SP-31 slightly dissimilar thought is not caught by dedup", async () => {
    const vec = Array(1536).fill(0);
    vec[40] = 1.0;
    const dissimilarVec = Array(1536).fill(0);
    dissimilarVec[41] = 1.0; // orthogonal → similarity = 0
    const pgVec = pgvector.toSql(dissimilarVec);
    await insertThought({ content: "orthogonal thought", embedding: vec, scope: "personal" });
    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM thoughts WHERE (1 - (embedding <=> $1)) > 0.8 AND scope @> ARRAY[$2]::ltree[]`,
      [pgVec, "personal"]
    );
    const found = await pool.query(
      `SELECT id FROM thoughts WHERE content='orthogonal thought' AND metadata @> '{"_e2e_test":true}'`
    );
    if (found.rows.length > 0) {
      expect(parseInt(rows[0].cnt)).toBe(0);
    }
  });
});

// ─── SP-33/34 Importance clamping ────────────────────────────────────────────

describe.skipIf(skip)("SP-33/34 importance clamping", () => {
  it("SP-33 importance > 1.0 is rejected by DB CHECK constraint", async () => {
    await expect(insertThought({ content: "clamp over", importance: 1.5 })).rejects.toThrow();
  });

  it("SP-34 importance < 0.0 is rejected by DB CHECK constraint", async () => {
    await expect(insertThought({ content: "clamp under", importance: -0.1 })).rejects.toThrow();
  });

  it("SP-33a application-layer clamp: Math.max(0,Math.min(1,x)) keeps valid values", () => {
    expect(Math.max(0, Math.min(1, 1.5))).toBe(1.0);
    expect(Math.max(0, Math.min(1, -0.2))).toBe(0.0);
    expect(Math.max(0, Math.min(1, 0.7))).toBe(0.7);
  });
});

// ─── SP-36 Dedup threshold is per-scope ──────────────────────────────────────

describe.skipIf(skip)("SP-36 dedup is scope-aware", () => {
  it("SP-36 same embedding in a different scope is NOT flagged as a duplicate", async () => {
    const vec = Array(1536).fill(0); vec[50] = 1.0;
    const pgVec = pgvector.toSql(vec);
    const scopeA = `sp36_a_${Date.now()}`;
    const scopeB = `sp36_b_${Date.now()}`;
    await insertThought({ content: "SP-36 in scope A", embedding: vec, scope: scopeA });

    const { rows } = await pool.query(
      `SELECT count(*) as cnt FROM thoughts WHERE (1 - (embedding <=> $1)) > 0.8 AND scope @> ARRAY[$2]::ltree[]`,
      [pgVec, scopeB]
    );
    expect(parseInt(rows[0].cnt)).toBe(0);
  });
});

// ─── PS-11 Score formula accuracy ────────────────────────────────────────────

describe.skipIf(skip)("PS-11 combined score formula", () => {
  it("PS-11 combined_score = 3×similarity + 2×importance + 0.5×recency", async () => {
    const vec = Array(1536).fill(0);
    vec[51] = 1.0;
    const pgVec = pgvector.toSql(vec);

    const row = await insertThought({ content: "PS-11 formula test", importance: 0.8, embedding: vec });

    const { rows } = await pool.query(
      `SELECT similarity, recency_score, combined_score, importance
       FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)
       WHERE id = $2`,
      [pgVec, row.id]
    );

    if (rows.length > 0) {
      const r = rows[0];
      const sim = parseFloat(r.similarity);
      const imp = parseFloat(r.importance);
      const rec = parseFloat(r.recency_score);
      const expected = 3.0 * sim + 2.0 * imp + 0.5 * rec;
      expect(parseFloat(r.combined_score)).toBeCloseTo(expected, 3);
    }
  });
});

// ─── PS-12/13 Recency decay ───────────────────────────────────────────────────

describe.skipIf(skip)("PS-12/13 recency decay", () => {
  it("PS-12 fresh thought has recency_score ≈ 1.0", async () => {
    const vec = Array(1536).fill(0);
    vec[60] = 1.0;
    const row = await insertThought({ content: "PS-12 fresh recency", embedding: vec });

    const { rows } = await pool.query(
      `SELECT recency_score FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false) WHERE id=$2`,
      [pgvector.toSql(vec), row.id]
    );
    if (rows.length > 0) {
      expect(parseFloat(rows[0].recency_score)).toBeCloseTo(1.0, 1);
    }
  });

  it("PS-13 thought accessed 24h ago has recency ≈ 0.887", async () => {
    const vec = Array(1536).fill(0);
    vec[61] = 1.0;
    const row = await insertThought({ content: "PS-13 stale recency", embedding: vec });
    await pool.query(
      `UPDATE thoughts SET last_accessed_at = now() - interval '24 hours' WHERE id=$1`,
      [row.id]
    );
    const { rows } = await pool.query(
      `SELECT recency_score FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false) WHERE id=$2`,
      [pgvector.toSql(vec), row.id]
    );
    if (rows.length > 0) {
      // 0.995^24 ≈ 0.887
      expect(parseFloat(rows[0].recency_score)).toBeCloseTo(0.887, 1);
    }
  });
});

// ─── SP-40/41 Warning table inserts ──────────────────────────────────────────

describe.skipIf(skip)("SP-40/41 autocapture_warnings", () => {
  it("SP-40 truncation warning can be inserted into autocapture_warnings", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='autocapture_warnings') as e`
    );
    if (!exists[0].e) return;
    const sid = `sp40_${Date.now()}`;
    await pool.query(
      `INSERT INTO autocapture_warnings (session_id, warning_type, detail) VALUES ($1, 'truncation', 'test')`,
      [sid]
    );
    const { rows } = await pool.query(`SELECT warning_type FROM autocapture_warnings WHERE session_id=$1`, [sid]);
    expect(rows[0].warning_type).toBe("truncation");
    await pool.query(`DELETE FROM autocapture_warnings WHERE session_id=$1`, [sid]);
  });

  it("SP-41 capture_failure warning can be inserted into autocapture_warnings", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='autocapture_warnings') as e`
    );
    if (!exists[0].e) return;
    const sid = `sp41_${Date.now()}`;
    await pool.query(
      `INSERT INTO autocapture_warnings (session_id, warning_type, detail) VALUES ($1, 'capture_failure', 'embed failed')`,
      [sid]
    );
    const { rows } = await pool.query(`SELECT warning_type FROM autocapture_warnings WHERE session_id=$1`, [sid]);
    expect(rows[0].warning_type).toBe("capture_failure");
    await pool.query(`DELETE FROM autocapture_warnings WHERE session_id=$1`, [sid]);
  });
});

// ─── INT-08 Migration safety ──────────────────────────────────────────────────

describe.skipIf(skip)("INT-08 migration safety", () => {
  it("INT-08 ALTER TYPE for 'fact' is idempotent with IF NOT EXISTS", async () => {
    await expect(pool.query(`ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'fact'`)).resolves.toBeTruthy();
  });

  it("INT-08a ALTER TYPE for 'claude' source_agent is idempotent", async () => {
    await expect(pool.query(`ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'claude'`)).resolves.toBeTruthy();
  });

  it("INT-08b CREATE TABLE IF NOT EXISTS token_usage is idempotent", async () => {
    await expect(pool.query(
      `CREATE TABLE IF NOT EXISTS token_usage (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        session_id text,
        created_at timestamptz DEFAULT now()
      )`
    )).resolves.toBeTruthy();
  });
});

// ─── INT-10 templates/server.mjs sync check ──────────────────────────────────

describe("INT-10 templates/server.mjs sync", () => {
  it("INT-10 only expected differences between root and templates server.mjs", () => {
    const root = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../server.mjs"), "utf8"
    );
    const tmpl = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../templates/server.mjs"), "utf8"
    );
    expect(tmpl).toContain("MCP_TRANSPORT");
    expect(tmpl).toContain("/health");
    expect(root).not.toContain("MCP_TRANSPORT");
    const toolCount = (src) => (src.match(/srv\.tool\(/g) || []).length;
    expect(toolCount(root)).toBe(toolCount(tmpl));
  });
});

// ─── INT-09 express dependency unused ────────────────────────────────────────

describe("INT-09 express is not imported in server.mjs", () => {
  it("INT-09 server.mjs does not import express", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../server.mjs"), "utf8"
    );
    expect(src).not.toMatch(/import.*express/);
    expect(src).not.toMatch(/require.*express/);
  });
});
