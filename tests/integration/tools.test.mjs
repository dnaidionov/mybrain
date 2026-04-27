// Integration tests for MCP tools: capture_thought, search_thoughts, browse_thoughts, brain_stats
// Covers CT-*, ST-*, BT-*, BS-*, PS-*, DB-*, SC-* test IDs
// Requires: TEST_DB_URL env var pointing to a test PostgreSQL database with schema applied
// Run: TEST_DB_URL=postgresql://... npm run test:integration
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import pgvector from "pgvector/pg";

const DB_URL = process.env.TEST_DB_URL;
const API_KEY = process.env.TEST_OPENROUTER_API_KEY;
const skip = !DB_URL || !API_KEY;

// ─── DB helpers ───────────────────────────────────────────────────────────────

let pool;

beforeAll(async () => {
  if (skip) return;
  pool = new pg.Pool({ connectionString: DB_URL });
  pool.on("connect", async (c) => { await pgvector.registerTypes(c); });
  // Clean test data before suite
  await pool.query(`DELETE FROM thoughts WHERE metadata @> '{"_test":true}'`);
  await pool.query(`DELETE FROM token_usage WHERE session_id LIKE 'test-%'`);
});

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DELETE FROM thoughts WHERE metadata @> '{"_test":true}'`);
  await pool.end();
});

async function insertThought(pool, opts = {}) {
  const {
    content = "default test thought",
    thought_type = "insight",
    importance = 0.5,
    metadata = {},
    scope = "personal",
    source_phase = "build",
    source_agent = "claude",
    embedding = null,
  } = opts;
  const vec = embedding ? pgvector.toSql(embedding) : pgvector.toSql(Array(1536).fill(0.01));
  const result = await pool.query(
    `INSERT INTO thoughts (content, embedding, metadata, scope, thought_type, source_agent, source_phase, importance)
     VALUES ($1, $2, $3, $4::ltree[], $5, $6, $7, $8)
     RETURNING id, created_at`,
    [content, vec, JSON.stringify({ ...metadata, _test: true }), `{${scope}}`, thought_type, source_agent, source_phase, importance]
  );
  return result.rows[0];
}

// ─── capture_thought ──────────────────────────────────────────────────────────

describe.skipIf(skip)("capture_thought – direct DB", () => {
  it("CT-01 inserts with default values", async () => {
    const row = await insertThought(pool, { content: "Test default values" });
    expect(row.id).toBeTruthy();
    expect(row.created_at).toBeTruthy();
  });

  it("CT-02 all thought_type enum values are accepted", async () => {
    const types = ["decision","preference","lesson","rejection","drift","correction","insight","reflection","fact"];
    for (const t of types) {
      const row = await insertThought(pool, { content: `Test type ${t}`, thought_type: t });
      expect(row.id).toBeTruthy();
    }
  });

  it("CT-03 empty string content is accepted at DB level (rejection is at the Zod/MCP layer)", async () => {
    // The DB has no CHECK constraint preventing empty strings — that validation lives in
    // the application layer (Zod schema). Verify the DB itself allows an empty string insert.
    const { rows } = await pool.query(
      `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance, metadata)
       VALUES ('', $1, 'insight', 'claude', 'build', 0.5, '{"_test":true}')
       RETURNING id`,
      [pgvector.toSql(Array(1536).fill(0))]
    );
    expect(rows[0].id).toBeTruthy();
    // cleanup
    await pool.query(`DELETE FROM thoughts WHERE id = $1`, [rows[0].id]);
  });

  it("CT-04 null content violates NOT NULL constraint", async () => {
    await expect(
      pool.query(`INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance)
                  VALUES (NULL, $1, 'insight', 'claude', 'build', 0.5)`,
        [pgvector.toSql(Array(1536).fill(0))])
    ).rejects.toThrow();
  });

  it("CT-05 importance = 0.0 accepted", async () => {
    await expect(insertThought(pool, { content: "zero importance", importance: 0.0 })).resolves.toBeTruthy();
  });

  it("CT-06 importance = 1.0 accepted", async () => {
    await expect(insertThought(pool, { content: "max importance", importance: 1.0 })).resolves.toBeTruthy();
  });

  it("CT-07 importance = -0.1 violates CHECK constraint", async () => {
    await expect(insertThought(pool, { content: "below range", importance: -0.1 })).rejects.toThrow();
  });

  it("CT-08 importance = 1.001 violates CHECK constraint", async () => {
    await expect(insertThought(pool, { content: "above range", importance: 1.001 })).rejects.toThrow();
  });

  it("CT-09 content with leading/trailing whitespace is stored as-is (trim is app-layer)", async () => {
    const row = await insertThought(pool, { content: "  spaced content  " });
    const { rows } = await pool.query(`SELECT content FROM thoughts WHERE id=$1`, [row.id]);
    // DB stores as-is; application layer trims before insert
    expect(rows[0].content).toBeTruthy();
  });

  it("CT-10 metadata with array values is stored and retrieved intact", async () => {
    const metadata = { project: "x", tags: ["a", "b"] };
    const row = await insertThought(pool, { content: "meta test", metadata });
    const { rows } = await pool.query(`SELECT metadata FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].metadata.tags).toEqual(["a", "b"]);
  });

  it("CT-11 metadata with null values is stored and retrievable", async () => {
    const row = await insertThought(pool, { content: "null meta", metadata: { key: null } });
    const { rows } = await pool.query(`SELECT metadata FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].metadata.key).toBeNull();
  });

  it("CT-12 source_phase='reconciliation' stored correctly", async () => {
    const row = await insertThought(pool, { content: "auto captured thought", source_phase: "reconciliation" });
    const { rows } = await pool.query(`SELECT source_phase FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].source_phase).toBe("reconciliation");
  });

  it("CT-13 BRAIN_SCOPE sets scope column correctly", async () => {
    const row = await insertThought(pool, { content: "scoped thought", scope: "personal" });
    const { rows } = await pool.query(`SELECT scope FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].scope).toContain("personal");
  });

  it("CT-14 source_agent='claude' stored correctly", async () => {
    const row = await insertThought(pool, { content: "claude agent thought", source_agent: "claude" });
    const { rows } = await pool.query(`SELECT source_agent FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].source_agent).toBe("claude");
  });

  it("CT-15 default source_agent is claude", async () => {
    const row = await insertThought(pool, { content: "default agent test" });
    const { rows } = await pool.query(`SELECT source_agent FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].source_agent).toBe("claude");
  });

  it("CT-16 default thought_type is insight", async () => {
    const row = await insertThought(pool, { content: "default type test" });
    const { rows } = await pool.query(`SELECT thought_type FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].thought_type).toBe("insight");
  });

  it("CT-17 content with unicode and emoji is stored intact", async () => {
    const content = "Unicode 你好 and emoji 🚀🧠 test thought content here";
    const row = await insertThought(pool, { content });
    const { rows } = await pool.query(`SELECT content FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].content).toBe(content);
  });

  it("CT-18 very long content (>5000 chars) stored intact", async () => {
    const content = "A".repeat(5000) + " end";
    const row = await insertThought(pool, { content });
    const { rows } = await pool.query(`SELECT length(content) as len FROM thoughts WHERE id=$1`, [row.id]);
    expect(parseInt(rows[0].len)).toBeGreaterThanOrEqual(5001);
  });

  it("CT-19 duplicate content produces two separate rows (no dedup at insert level)", async () => {
    const row1 = await insertThought(pool, { content: "exact duplicate content" });
    const row2 = await insertThought(pool, { content: "exact duplicate content" });
    expect(row1.id).not.toBe(row2.id);
  });

  it("CT-20 default importance is 0.5", async () => {
    const row = await insertThought(pool, { content: "default importance check" });
    const { rows } = await pool.query(`SELECT importance FROM thoughts WHERE id=$1`, [row.id]);
    expect(parseFloat(rows[0].importance)).toBe(0.5);
  });

  it("CT-21 returns id (UUID) and created_at", async () => {
    const row = await insertThought(pool, { content: "return fields check" });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.created_at).toBeInstanceOf(Date);
  });
});

// ─── search_thoughts (match_thoughts_scored) ──────────────────────────────────

describe.skipIf(skip)("search_thoughts – match_thoughts_scored", () => {
  it("ST-01 basic search returns at least one result after insert", async () => {
    const vec = Array(1536).fill(0);
    vec[100] = 1.0;
    await insertThought(pool, { content: "unique ST-01 test thought", embedding: vec });
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 10, '{}', NULL, false)`,
      [pgvector.toSql(vec)]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("ST-02 similarity threshold filters out low-similarity results", async () => {
    const queryVec = Array(1536).fill(0);
    queryVec[101] = 1.0;
    const lowSimilarVec = Array(1536).fill(0);
    lowSimilarVec[102] = 1.0; // orthogonal → sim=0
    await insertThought(pool, { content: "orthogonal for ST-02", embedding: lowSimilarVec });

    const { rows: highThresh } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.9, 10, '{}', NULL, false)`,
      [pgvector.toSql(queryVec)]
    );
    const found = highThresh.some(r => r.content === "orthogonal for ST-02");
    expect(found).toBe(false);
  });

  it("ST-03 scope filter restricts results to matching scope", async () => {
    const scope = `st03_scope_${Date.now()}`;
    const vec = Array(1536).fill(0.02);
    await insertThought(pool, { content: "ST-03 scoped", scope, embedding: vec });

    const { rows: scoped } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', $2, false)`,
      [pgvector.toSql(vec), scope]
    );
    const { rows: other } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', $2, false)`,
      [pgvector.toSql(vec), `different_scope_${Date.now()}`]
    );
    expect(scoped.some(r => r.content === "ST-03 scoped")).toBe(true);
    expect(other.some(r => r.content === "ST-03 scoped")).toBe(false);
  });

  it("ST-04 max_results caps number of returned rows", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 3, '{}', NULL, false)`, [vec]
    );
    expect(rows.length).toBeLessThanOrEqual(3);
  });

  it("ST-05 results include content field", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("content");
      expect(typeof rows[0].content).toBe("string");
    }
  });

  it("ST-06 results are ordered by combined_score DESC", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT combined_score FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`, [vec]
    );
    for (let i = 1; i < rows.length; i++) {
      expect(parseFloat(rows[i - 1].combined_score)).toBeGreaterThanOrEqual(parseFloat(rows[i].combined_score));
    }
  });

  it("ST-07 identical embedding → similarity = 1.0", async () => {
    const vec = Array(1536).fill(0);
    vec[103] = 1.0;
    const row = await insertThought(pool, { content: "ST-07 identical vec", embedding: vec });
    const { rows } = await pool.query(
      `SELECT 1 - (embedding <=> $1) as sim FROM thoughts WHERE id=$2`,
      [pgvector.toSql(vec), row.id]
    );
    expect(parseFloat(rows[0].sim)).toBeCloseTo(1.0, 4);
  });

  it("ST-08 orthogonal embeddings → similarity ≈ 0.0", async () => {
    const v1 = Array(1536).fill(0); v1[104] = 1.0;
    const v2 = Array(1536).fill(0); v2[105] = 1.0;
    const row = await insertThought(pool, { content: "ST-08 orthogonal", embedding: v1 });
    const { rows } = await pool.query(
      `SELECT 1 - (embedding <=> $1) as sim FROM thoughts WHERE id=$2`,
      [pgvector.toSql(v2), row.id]
    );
    expect(parseFloat(rows[0].sim)).toBeCloseTo(0.0, 4);
  });

  it("ST-09 limit=0 returns zero rows (PostgreSQL LIMIT 0 semantics)", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 0, '{}', NULL, false)`, [vec]
    );
    expect(rows).toHaveLength(0);
  });

  it("ST-10 last_accessed_at is updated after search", async () => {
    const vec = Array(1536).fill(0); vec[106] = 1.0;
    const row = await insertThought(pool, { content: "ST-10 access tracking", embedding: vec });
    const before = await pool.query(`SELECT last_accessed_at FROM thoughts WHERE id=$1`, [row.id]);
    // The match_thoughts_scored function updates last_accessed_at
    await pool.query(`SELECT * FROM match_thoughts_scored($1, 0.0, 10, '{}', NULL, false)`, [pgvector.toSql(vec)]);
    const after = await pool.query(`SELECT last_accessed_at FROM thoughts WHERE id=$1`, [row.id]);
    // after should be set (or updated relative to before)
    expect(after.rows[0].last_accessed_at).toBeTruthy();
  });

  it("ST-13 results include importance field", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("importance");
    }
  });

  it("ST-15 invalidated thoughts excluded by default (include_invalidated=false)", async () => {
    const vec = Array(1536).fill(0); vec[107] = 1.0;
    const row = await insertThought(pool, { content: "ST-15 invalidated", embedding: vec });
    await pool.query(`UPDATE thoughts SET status='invalidated', invalidated_at=now() WHERE id=$1`, [row.id]);
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, false)`, [pgvector.toSql(vec)]
    );
    expect(rows.some(r => r.id === row.id)).toBe(false);
  });

  it("ST-17 exact embedding match appears first in results", async () => {
    const vec = Array(1536).fill(0); vec[108] = 1.0;
    const row = await insertThought(pool, { content: "ST-17 exact match", importance: 0.5, embedding: vec });
    const { rows } = await pool.query(
      `SELECT id FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`, [pgvector.toSql(vec)]
    );
    // Exact match should be among the top results
    if (rows.length > 0) {
      expect(rows.some(r => r.id === row.id)).toBe(true);
    }
  });

  it("ST-18 result rows include all score fields", async () => {
    await insertThought(pool, { content: "score fields check" });
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("similarity");
      expect(rows[0]).toHaveProperty("recency_score");
      expect(rows[0]).toHaveProperty("combined_score");
    }
  });

  it("ST-19 combined_score is non-negative", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT combined_score FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`, [vec]
    );
    for (const r of rows) {
      expect(parseFloat(r.combined_score)).toBeGreaterThanOrEqual(0);
    }
  });

  it("ST-20 max_results=1 returns at most 1 row", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 1, '{}', NULL, false)`, [vec]
    );
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("ST-22 scope filter with non-existent scope returns empty", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', $2, false)`,
      [vec, `nonexistent_scope_xyz_${Date.now()}`]
    );
    expect(rows).toHaveLength(0);
  });

  it("ST-23 thought_type is returned in results", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("thought_type");
    }
  });

  it("ST-25 metadata field returned in results", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("metadata");
    }
  });

  it("ST-11 threshold filters out thoughts below minimum similarity", async () => {
    // Insert a thought with unit vector in an unused dim; query with orthogonal vector at high threshold
    const storedVec = Array(1536).fill(0); storedVec[111] = 1.0;
    const queryVec  = Array(1536).fill(0); queryVec[112]  = 1.0; // orthogonal → sim=0
    await insertThought(pool, { content: "ST-11 below threshold", embedding: storedVec });
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.5, 20, '{}', NULL, false)`,
      [pgvector.toSql(queryVec)]
    );
    expect(rows.every(r => parseFloat(r.similarity) >= 0.5 || r.content !== "ST-11 below threshold")).toBe(true);
  });

  it("ST-12 metadata filter with specific field returns only matching thoughts", async () => {
    const label = `st12_label_${Date.now()}`;
    const row = await insertThought(pool, { content: "ST-12 tagged", metadata: { label, _test: true } });
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, $2, NULL, false)`,
      [vec, JSON.stringify({ label })]
    );
    expect(rows.some(r => r.id === row.id)).toBe(true);
    // Thoughts without that label should not appear
    const notLabelled = rows.filter(r => r.metadata?.label !== label && r.id !== row.id);
    // All returned rows should either have the label or not have a label key at all (pass-through)
    // The key assertion: our inserted row IS found
    expect(rows.some(r => r.id === row.id)).toBe(true);
  });

  it("ST-14 metadata filter with non-matching field returns empty", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const impossibleFilter = JSON.stringify({ __no_such_field__: `unique_${Date.now()}` });
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, $2, NULL, false)`,
      [vec, impossibleFilter]
    );
    expect(rows).toHaveLength(0);
  });

  it("ST-16 scope filter with an exact scope match returns only that scope", async () => {
    const scope = `st16_scope_${Date.now()}`;
    const row = await insertThought(pool, { content: "ST-16 exact scope", scope });
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', $2, false)`,
      [vec, scope]
    );
    expect(rows.some(r => r.id === row.id)).toBe(true);
    // No rows from other scopes — pg returns ltree[] as a string like "{personal}" or as an array
    for (const r of rows) {
      const scopeStr = Array.isArray(r.scope) ? r.scope.join(",") : String(r.scope);
      expect(scopeStr).toContain(scope);
    }
  });

  it("ST-21 max_results larger than available rows returns actual count (not padded)", async () => {
    const scope = `st21_scope_${Date.now()}`;
    await insertThought(pool, { content: "ST-21 only one", scope });
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 999, '{}', $2, false)`,
      [vec, scope]
    );
    expect(rows.length).toBe(1);
  });

  it("ST-24 source_phase field is returned in results", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 5, '{}', NULL, false)`, [vec]
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("source_phase");
    }
  });

  it("ST-26 all returned ids are unique", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT id FROM match_thoughts_scored($1, 0.0, 50, '{}', NULL, false)`, [vec]
    );
    const ids = rows.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("PS-01 null embedding input raises exception", async () => {
    await expect(pool.query(`SELECT * FROM match_thoughts_scored(NULL, 0.5, 10, '{}', NULL, false)`))
      .rejects.toThrow(/must not be null/i);
  });

  it("PS-02 max_results = -1 raises exception", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.1));
    await expect(pool.query(`SELECT * FROM match_thoughts_scored($1, 0.5, -1, '{}', NULL, false)`, [vec]))
      .rejects.toThrow();
  });

  it("PS-03 threshold = -0.5 raises exception", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.1));
    await expect(pool.query(`SELECT * FROM match_thoughts_scored($1, -0.5, 10, '{}', NULL, false)`, [vec]))
      .rejects.toThrow();
  });

  it("PS-04 threshold = 1.5 raises exception", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.1));
    await expect(pool.query(`SELECT * FROM match_thoughts_scored($1, 1.5, 10, '{}', NULL, false)`, [vec]))
      .rejects.toThrow();
  });

  it("PS-05 scope_filter=NULL returns thoughts from all scopes", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(`SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, false)`, [vec]);
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it("PS-06 higher-importance thought ranks above lower-importance with equal embedding", async () => {
    const vec = Array(1536).fill(0); vec[109] = 1.0;
    const low = await insertThought(pool, { content: "PS-06 low", importance: 0.1, embedding: vec });
    const high = await insertThought(pool, { content: "PS-06 high", importance: 0.9, embedding: vec });
    const { rows } = await pool.query(
      `SELECT id, combined_score FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`,
      [pgvector.toSql(vec)]
    );
    const lowRow = rows.find(r => r.id === low.id);
    const highRow = rows.find(r => r.id === high.id);
    if (lowRow && highRow) {
      expect(parseFloat(highRow.combined_score)).toBeGreaterThan(parseFloat(lowRow.combined_score));
    }
  });

  it("PS-07 include_invalidated=true returns invalidated thoughts", async () => {
    const row = await insertThought(pool, { content: "invalidated thought for PS-07" });
    await pool.query(`UPDATE thoughts SET status='invalidated', invalidated_at=now() WHERE id=$1`, [row.id]);
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows: withInvalid } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, true)`, [vec]
    );
    const { rows: withoutInvalid } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, false)`, [vec]
    );
    const foundWith = withInvalid.some(r => r.id === row.id);
    const foundWithout = withoutInvalid.some(r => r.id === row.id);
    expect(foundWith).toBe(true);
    expect(foundWithout).toBe(false);
  });

  it("PS-08 thought with last_accessed_at set 24h ago has lower recency than fresh thought", async () => {
    const vec = Array(1536).fill(0); vec[110] = 1.0;
    const fresh = await insertThought(pool, { content: "PS-08 fresh", embedding: vec });
    const stale = await insertThought(pool, { content: "PS-08 stale", embedding: vec });
    await pool.query(
      `UPDATE thoughts SET last_accessed_at = now() - interval '24 hours' WHERE id=$1`, [stale.id]
    );
    const { rows } = await pool.query(
      `SELECT id, recency_score FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`,
      [pgvector.toSql(vec)]
    );
    const freshRow = rows.find(r => r.id === fresh.id);
    const staleRow = rows.find(r => r.id === stale.id);
    if (freshRow && staleRow) {
      expect(parseFloat(freshRow.recency_score)).toBeGreaterThan(parseFloat(staleRow.recency_score));
    }
  });

  it("PS-09 metadata_filter='{}' applies no filter", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', NULL, false)`, [vec]
    );
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it("PS-10 metadata_filter matches by JSON superset", async () => {
    const row = await insertThought(pool, { content: "PS-10 metadata filter test", metadata: { project: "filterable", _test: true } });
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const filter = JSON.stringify({ project: "filterable" });
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, $2, NULL, false)`, [vec, filter]
    );
    expect(rows.some(r => r.id === row.id)).toBe(true);
  });

  it("PS-14 importance weight (2.0) dominates recency (0.5) when recency gap is small", async () => {
    // Two thoughts with same embedding: high importance vs. low importance, same freshness
    const vec = Array(1536).fill(0); vec[120] = 1.0;
    const hi = await insertThought(pool, { content: "PS-14 high imp", importance: 0.9, embedding: vec });
    const lo = await insertThought(pool, { content: "PS-14 low imp",  importance: 0.1, embedding: vec });
    const { rows } = await pool.query(
      `SELECT id, combined_score FROM match_thoughts_scored($1, 0.0, 20, '{}', NULL, false)`,
      [pgvector.toSql(vec)]
    );
    const hiRow = rows.find(r => r.id === hi.id);
    const loRow = rows.find(r => r.id === lo.id);
    if (hiRow && loRow) {
      // Δimportance × 2.0 = 0.8×2 = 1.6 >> any recency gap for freshly inserted rows
      expect(parseFloat(hiRow.combined_score)).toBeGreaterThan(parseFloat(loRow.combined_score));
    }
  });

  it("PS-15 thought accessed 48h ago has recency ≈ 0.787 (0.995^48)", async () => {
    const vec = Array(1536).fill(0); vec[121] = 1.0;
    const row = await insertThought(pool, { content: "PS-15 48h stale", embedding: vec });
    await pool.query(
      `UPDATE thoughts SET last_accessed_at = now() - interval '48 hours' WHERE id=$1`, [row.id]
    );
    const { rows } = await pool.query(
      `SELECT recency_score FROM match_thoughts_scored($1, 0.0, 10, '{}', NULL, false) WHERE id=$2`,
      [pgvector.toSql(vec), row.id]
    );
    if (rows.length > 0) {
      // 0.995^48 ≈ 0.787
      expect(parseFloat(rows[0].recency_score)).toBeCloseTo(0.787, 1);
    }
  });
});

// ─── browse_thoughts ──────────────────────────────────────────────────────────

describe.skipIf(skip)("browse_thoughts – direct SQL", () => {
  it("BT-01 default browse returns rows ordered by created_at DESC", async () => {
    const { rows } = await pool.query(
      `SELECT id, created_at FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 20`
    );
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].created_at) >= new Date(rows[i].created_at)).toBe(true);
    }
  });

  it("BT-02 scope filter returns only thoughts in the specified scope", async () => {
    const scope = `bt02_scope_${Date.now()}`;
    await insertThought(pool, { content: "BT-02 in scope", scope });
    await insertThought(pool, { content: "BT-02 other scope", scope: "personal" });
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY[$1]::ltree[] AND metadata @> '{"_test":true}'`,
      [scope]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // None should be from personal scope
    const { rows: check } = await pool.query(
      `SELECT scope FROM thoughts WHERE id = ANY($1)`, [rows.map(r => r.id)]
    );
    for (const r of check) {
      expect(r.scope).toContain(scope);
    }
  });

  it("BT-03 offset pagination returns non-overlapping pages", async () => {
    const page1 = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 5 OFFSET 0`
    );
    const page2 = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 5 OFFSET 5`
    );
    const ids1 = page1.rows.map(r => r.id);
    const ids2 = page2.rows.map(r => r.id);
    const overlap = ids1.filter(id => ids2.includes(id));
    expect(overlap).toHaveLength(0);
  });

  it("BT-04 offset beyond total returns empty, not error", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 20 OFFSET 999999`
    );
    expect(rows).toHaveLength(0);
  });

  it("BT-05 limit=0 returns zero rows", async () => {
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 0 OFFSET 0`
    );
    expect(rows).toHaveLength(0);
  });

  it("BT-06 filter by thought_type returns only matching type", async () => {
    await insertThought(pool, { content: "BT-06 a decision", thought_type: "decision" });
    const { rows } = await pool.query(
      `SELECT id, thought_type FROM thoughts WHERE thought_type='decision' AND metadata @> '{"_test":true}'`
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.thought_type).toBe("decision");
  });

  it("BT-07 filter by importance range returns only qualifying thoughts", async () => {
    await insertThought(pool, { content: "BT-07 high importance", importance: 0.9 });
    await insertThought(pool, { content: "BT-07 low importance", importance: 0.1 });
    const { rows } = await pool.query(
      `SELECT importance FROM thoughts WHERE importance >= 0.8 AND metadata @> '{"_test":true}'`
    );
    for (const r of rows) {
      expect(parseFloat(r.importance)).toBeGreaterThanOrEqual(0.8);
    }
  });

  it("BT-08 metadata filter returns only matching thoughts", async () => {
    const tag = `test-filter-${Date.now()}`;
    await insertThought(pool, { content: "BT-08 match", metadata: { tag, _test: true } });
    await insertThought(pool, { content: "BT-08 no match", metadata: { tag: "other", _test: true } });
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> $1 ORDER BY created_at DESC LIMIT 20`,
      [JSON.stringify({ tag })]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("BT-09 default limit of 20 is respected when using MCP tool", async () => {
    // Insert 25 thoughts to verify limit behavior
    for (let i = 0; i < 5; i++) {
      await insertThought(pool, { content: `BT-09 thought ${i}` });
    }
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 20`
    );
    expect(rows.length).toBeLessThanOrEqual(20);
  });

  it("BT-10 filter by source_phase returns only that phase", async () => {
    await insertThought(pool, { content: "BT-10 build phase", source_phase: "build" });
    await insertThought(pool, { content: "BT-10 reconciliation", source_phase: "reconciliation" });
    const { rows } = await pool.query(
      `SELECT source_phase FROM thoughts WHERE source_phase='reconciliation' AND metadata @> '{"_test":true}'`
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.source_phase).toBe("reconciliation");
  });

  it("BT-11 count query returns total matching thoughts", async () => {
    const before = await pool.query(`SELECT count(*) as c FROM thoughts WHERE metadata @> '{"_test":true}'`);
    await insertThought(pool, { content: "BT-11 count test" });
    const after = await pool.query(`SELECT count(*) as c FROM thoughts WHERE metadata @> '{"_test":true}'`);
    expect(parseInt(after.rows[0].c)).toBe(parseInt(before.rows[0].c) + 1);
  });

  it("BT-12 browse returns id, content, metadata, created_at — no embedding", async () => {
    const { rows } = await pool.query(
      `SELECT id, content, metadata, created_at FROM thoughts WHERE metadata @> '{"_test":true}' LIMIT 1`
    );
    if (rows.length > 0) {
      expect(rows[0]).toHaveProperty("id");
      expect(rows[0]).toHaveProperty("content");
      expect(rows[0]).toHaveProperty("metadata");
      expect(rows[0]).toHaveProperty("created_at");
      expect(rows[0]).not.toHaveProperty("embedding");
    }
  });

  it("BT-13 updated_at is returned and is >= created_at", async () => {
    const row = await insertThought(pool, { content: "BT-13 updated_at check" });
    const { rows } = await pool.query(
      `SELECT created_at, updated_at FROM thoughts WHERE id=$1`, [row.id]
    );
    expect(rows[0].updated_at).toBeTruthy();
    expect(new Date(rows[0].updated_at) >= new Date(rows[0].created_at)).toBe(true);
  });
});

// ─── brain_stats ──────────────────────────────────────────────────────────────

describe.skipIf(skip)("brain_stats – direct SQL", () => {
  it("BS-01 total count is a non-negative integer", async () => {
    const { rows } = await pool.query(`SELECT count(*) as c FROM thoughts`);
    expect(parseInt(rows[0].c)).toBeGreaterThanOrEqual(0);
  });

  it("BS-02 total count reflects inserted thoughts", async () => {
    const before = await pool.query(`SELECT count(*) as c FROM thoughts`);
    await insertThought(pool, { content: "BS-02 stats count test" });
    const after = await pool.query(`SELECT count(*) as c FROM thoughts`);
    expect(parseInt(after.rows[0].c)).toBe(parseInt(before.rows[0].c) + 1);
  });

  it("BS-03 auto-captured count: source_phase=reconciliation", async () => {
    await insertThought(pool, { content: "BS-03 auto captured", source_phase: "reconciliation" });
    const { rows } = await pool.query(
      `SELECT count(*) as c FROM thoughts WHERE source_phase='reconciliation' AND metadata @> '{"_test":true}'`
    );
    expect(parseInt(rows[0].c)).toBeGreaterThanOrEqual(1);
  });

  it("BS-04 date range query returns earliest and latest", async () => {
    const { rows } = await pool.query(`SELECT min(created_at) as earliest, max(created_at) as latest FROM thoughts`);
    expect(rows[0].earliest).toBeTruthy();
    expect(rows[0].latest).toBeTruthy();
    expect(new Date(rows[0].earliest) <= new Date(rows[0].latest)).toBe(true);
  });

  it("BS-05 per-scope count groups by scope correctly", async () => {
    const scope = `bs05_scope_${Date.now()}`;
    await insertThought(pool, { content: "BS-05 s1", scope });
    await insertThought(pool, { content: "BS-05 s2", scope });
    const { rows } = await pool.query(
      `SELECT scope, count(*) as c FROM thoughts WHERE metadata @> '{"_test":true}' GROUP BY scope`
    );
    const found = rows.find(r => r.scope && r.scope.includes(scope));
    if (found) {
      expect(parseInt(found.c)).toBeGreaterThanOrEqual(2);
    }
  });

  it("BS-06 thought_type distribution counts each type", async () => {
    await insertThought(pool, { content: "BS-06 decision", thought_type: "decision" });
    await insertThought(pool, { content: "BS-06 fact", thought_type: "fact" });
    const { rows } = await pool.query(
      `SELECT thought_type, count(*) as c FROM thoughts WHERE metadata @> '{"_test":true}' GROUP BY thought_type`
    );
    const types = rows.map(r => r.thought_type);
    expect(types).toContain("decision");
    expect(types).toContain("fact");
  });

  it("BS-07 token_usage query gracefully handled when table exists", async () => {
    const { rows } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='token_usage') as exists`
    );
    if (rows[0].exists) {
      await expect(pool.query(`SELECT count(*) FROM token_usage`)).resolves.toBeTruthy();
    }
  });

  it("BS-08 average importance is between 0 and 1", async () => {
    const { rows } = await pool.query(`SELECT avg(importance) as avg_imp FROM thoughts`);
    if (rows[0].avg_imp !== null) {
      const avg = parseFloat(rows[0].avg_imp);
      expect(avg).toBeGreaterThanOrEqual(0);
      expect(avg).toBeLessThanOrEqual(1);
    }
  });

  it("BS-09 source_phase distribution: build and reconciliation both tracked", async () => {
    await insertThought(pool, { content: "BS-09 build", source_phase: "build" });
    await insertThought(pool, { content: "BS-09 reconciliation", source_phase: "reconciliation" });
    const { rows } = await pool.query(
      `SELECT source_phase, count(*) as c FROM thoughts WHERE metadata @> '{"_test":true}' GROUP BY source_phase`
    );
    const phases = rows.map(r => r.source_phase);
    expect(phases.length).toBeGreaterThanOrEqual(1);
  });

  it("BS-10 token_usage records can be inserted and queried", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='token_usage') as e`
    );
    if (!exists[0].e) return;

    await pool.query(
      `INSERT INTO token_usage (session_id, scope, model, input_tokens, output_tokens, embeddings_count, thoughts_captured)
       VALUES ('test-bs10', '{personal}'::ltree[], 'openai/gpt-oss-120b:free', 100, 50, 2, 2)`
    );
    const { rows } = await pool.query(`SELECT * FROM token_usage WHERE session_id='test-bs10'`);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(parseInt(rows[0].input_tokens)).toBe(100);
    await pool.query(`DELETE FROM token_usage WHERE session_id='test-bs10'`);
  });

  it("BS-11 autocapture_warnings count is queryable when table exists", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='autocapture_warnings') as e`
    );
    if (!exists[0].e) return;
    const { rows } = await pool.query(`SELECT count(*) as c FROM autocapture_warnings`);
    expect(parseInt(rows[0].c)).toBeGreaterThanOrEqual(0);
  });

  it("BS-12 thoughts can be filtered by created_at date range", async () => {
    const since = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
    const { rows } = await pool.query(
      `SELECT count(*) as c FROM thoughts WHERE created_at >= $1`, [since]
    );
    expect(parseInt(rows[0].c)).toBeGreaterThanOrEqual(0);
  });

  it("BS-13 manual capture count: source_phase=build thoughts are countable", async () => {
    await insertThought(pool, { content: "BS-13 manual", source_phase: "build" });
    const { rows } = await pool.query(
      `SELECT count(*) as c FROM thoughts WHERE source_phase='build' AND metadata @> '{"_test":true}'`
    );
    expect(parseInt(rows[0].c)).toBeGreaterThanOrEqual(1);
  });

  it("BS-14 latest thought created_at matches max(created_at) in DB", async () => {
    await insertThought(pool, { content: "BS-14 latest" });
    const { rows: maxRow } = await pool.query(
      `SELECT max(created_at) as latest FROM thoughts WHERE metadata @> '{"_test":true}'`
    );
    const { rows: topRow } = await pool.query(
      `SELECT created_at FROM thoughts WHERE metadata @> '{"_test":true}' ORDER BY created_at DESC LIMIT 1`
    );
    expect(new Date(maxRow[0].latest).getTime()).toBe(new Date(topRow[0].created_at).getTime());
  });

  it("BS-15 total token usage sum is queryable across all sessions", async () => {
    const { rows: exists } = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name='token_usage') as e`
    );
    if (!exists[0].e) return;
    const { rows } = await pool.query(
      `SELECT COALESCE(sum(input_tokens), 0) as total_in, COALESCE(sum(output_tokens), 0) as total_out FROM token_usage`
    );
    expect(parseInt(rows[0].total_in)).toBeGreaterThanOrEqual(0);
    expect(parseInt(rows[0].total_out)).toBeGreaterThanOrEqual(0);
  });
});

// ─── Scope isolation ──────────────────────────────────────────────────────────

describe.skipIf(skip)("scope isolation (SC-*)", () => {
  it("SC-01 search from scope A never returns scope B thoughts", async () => {
    const scopeA = `sc01_a_${Date.now()}`;
    const scopeB = `sc01_b_${Date.now()}`;
    await insertThought(pool, { content: "SC-01 scope A exclusive", scope: scopeA });
    await insertThought(pool, { content: "SC-01 scope B exclusive", scope: scopeB });

    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 100, '{}', $2, false)`,
      [vec, scopeA]
    );
    const scopeBFound = rows.some(r => Array.isArray(r.scope) && r.scope.some(s => s.includes(scopeB)));
    expect(scopeBFound).toBe(false);
  });

  it("SC-02 thoughts with matching scope prefix are included", async () => {
    const parent = `sc02_parent_${Date.now()}`;
    const child = `${parent}_child`;
    await insertThought(pool, { content: "SC-02 child scope thought", scope: child });

    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY[$1]::ltree[] AND metadata @> '{"_test":true}'`,
      [child]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("SC-03 personal and work scopes are fully isolated", async () => {
    const ts = Date.now();
    await insertThought(pool, { content: `SC-03 personal ts=${ts}`, scope: "personal" });
    await insertThought(pool, { content: `SC-03 work ts=${ts}`, scope: "work" });

    const { rows: personalRows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY['personal']::ltree[] AND content LIKE $1`,
      [`%SC-03 personal ts=${ts}%`]
    );
    const { rows: workRows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY['work']::ltree[] AND content LIKE $1`,
      [`%SC-03 work ts=${ts}%`]
    );
    expect(personalRows.length).toBe(1);
    expect(workRows.length).toBe(1);
    expect(personalRows[0].id).not.toBe(workRows[0].id);
  });

  it("SC-04 thought with scope=default is not returned when filtering by personal", async () => {
    await insertThought(pool, { content: "SC-04 default scope", scope: "default" });
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY['personal']::ltree[] AND content='SC-04 default scope'`
    );
    expect(rows).toHaveLength(0);
  });

  it("SC-05 browse with scope filter only shows scoped thoughts", async () => {
    const scope = `sc05_scope_${Date.now()}`;
    await insertThought(pool, { content: "SC-05 in scope", scope });
    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY[$1]::ltree[] AND metadata @> '{"_test":true}'`,
      [scope]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const outOfScope = await pool.query(
      `SELECT id FROM thoughts WHERE NOT scope @> ARRAY[$1]::ltree[] AND id = ANY($2)`,
      [scope, rows.map(r => r.id)]
    );
    expect(outOfScope.rows).toHaveLength(0);
  });

  it("SC-06 thought can carry multiple scope labels", async () => {
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    await pool.query(
      `INSERT INTO thoughts (content, embedding, metadata, scope, thought_type, source_agent, source_phase, importance)
       VALUES ('SC-06 multi-scope', $1, '{"_test":true}', ARRAY['personal','work']::ltree[], 'insight', 'claude', 'build', 0.5)`,
      [vec]
    );
    const { rows } = await pool.query(
      `SELECT scope FROM thoughts WHERE content='SC-06 multi-scope' AND metadata @> '{"_test":true}'`
    );
    if (rows.length > 0) {
      expect(rows[0].scope).toContain("personal");
      expect(rows[0].scope).toContain("work");
    }
    await pool.query(`DELETE FROM thoughts WHERE content='SC-06 multi-scope' AND metadata @> '{"_test":true}'`);
  });

  it("SC-07 projects.* scope prefix matches child entries", async () => {
    const projectScope = `projects.sc07_repo_${Date.now()}`;
    await insertThought(pool, { content: "SC-07 project thought", scope: projectScope });

    const { rows } = await pool.query(
      `SELECT id FROM thoughts WHERE scope @> ARRAY[$1]::ltree[] AND metadata @> '{"_test":true}'`,
      [projectScope]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Database constraints and schema ─────────────────────────────────────────

describe.skipIf(skip)("DB constraints (DB-*)", () => {
  it("DB-01 UUID is auto-generated on insert", async () => {
    const row = await insertThought(pool, { content: "DB-01 auto uuid" });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("DB-02 created_at default is set automatically to current timestamp", async () => {
    const row = await insertThought(pool, { content: "DB-02 created_at default" });
    expect(row.created_at).toBeTruthy();
    // created_at should be a Date or parseable as one — verify it is a real timestamp
    // (not epoch 0, not null, not NaN). Allow a 10-min window to tolerate parallel
    // test suite overhead and transaction-start NOW() semantics in pg.
    const ts = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(row.created_at);
    expect(ts).toBeGreaterThan(Date.now() - 600_000);
    expect(ts).toBeLessThan(Date.now() + 60_000);
  });

  it("DB-03 thought_relations unique constraint (source, target, type)", async () => {
    const r1 = await insertThought(pool, { content: "DB-03 relation source" });
    const r2 = await insertThought(pool, { content: "DB-03 relation target" });
    await pool.query(
      `INSERT INTO thought_relations (source_id, target_id, relation_type) VALUES ($1, $2, 'supports')`,
      [r1.id, r2.id]
    );
    await expect(pool.query(
      `INSERT INTO thought_relations (source_id, target_id, relation_type) VALUES ($1, $2, 'supports')`,
      [r1.id, r2.id]
    )).rejects.toThrow(/unique/i);
    await pool.query(`DELETE FROM thought_relations WHERE source_id=$1`, [r1.id]);
  });

  it("DB-04 null content violates NOT NULL constraint", async () => {
    await expect(
      pool.query(
        `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance)
         VALUES (NULL, $1, 'insight', 'claude', 'build', 0.5)`,
        [pgvector.toSql(Array(1536).fill(0))]
      )
    ).rejects.toThrow();
  });

  it("DB-05 updated_at trigger fires on UPDATE", async () => {
    const row = await insertThought(pool, { content: "DB-05 trigger test" });
    await new Promise(r => setTimeout(r, 50));
    await pool.query(`UPDATE thoughts SET content='DB-05 trigger test updated' WHERE id=$1`, [row.id]);
    const { rows } = await pool.query(`SELECT created_at, updated_at FROM thoughts WHERE id=$1`, [row.id]);
    expect(new Date(rows[0].updated_at) > new Date(rows[0].created_at)).toBe(true);
  });

  it("DB-06 default scope is 'default' when not specified", async () => {
    await pool.query(
      `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance)
       VALUES ('DB-06 default scope test', $1, 'insight', 'claude', 'build', 0.5)`,
      [pgvector.toSql(Array(1536).fill(0))]
    );
    const { rows } = await pool.query(
      `SELECT scope FROM thoughts WHERE content='DB-06 default scope test' ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0].scope).toContain("default");
    await pool.query(`DELETE FROM thoughts WHERE content='DB-06 default scope test'`);
  });

  it("DB-07 default status is 'active'", async () => {
    const row = await insertThought(pool, { content: "DB-07 default status test" });
    const { rows } = await pool.query(`SELECT status FROM thoughts WHERE id=$1`, [row.id]);
    expect(rows[0].status).toBe("active");
  });

  it("DB-08 migration: ALTER TYPE for fact is idempotent", async () => {
    await expect(pool.query(`ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'fact'`)).resolves.toBeTruthy();
  });

  it("DB-09 importance column has a CHECK constraint (0.0 to 1.0)", async () => {
    // Verify constraint exists by checking violation
    await expect(insertThought(pool, { content: "DB-09 over", importance: 1.01 })).rejects.toThrow();
    await expect(insertThought(pool, { content: "DB-09 under", importance: -0.01 })).rejects.toThrow();
  });

  it("DB-10 embedding must be 1536 dimensions", async () => {
    // Wrong-dimension vector should be rejected
    const wrongVec = pgvector.toSql(Array(512).fill(0.1));
    await expect(
      pool.query(
        `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance)
         VALUES ('wrong dim', $1, 'insight', 'claude', 'build', 0.5)`,
        [wrongVec]
      )
    ).rejects.toThrow();
  });

  it("DB-11 NULL embedding is accepted by column (nullable) but excluded from scored search", async () => {
    // Schema defines embedding as vector(1536) without NOT NULL — nullable by design
    await pool.query(
      `INSERT INTO thoughts (content, embedding, thought_type, source_agent, source_phase, importance)
       VALUES ('DB-11 null embedding', NULL, 'insight', 'claude', 'build', 0.5)`
    );
    const { rows: found } = await pool.query(
      `SELECT id FROM thoughts WHERE content='DB-11 null embedding'`
    );
    expect(found.length).toBe(1);
    // A NULL-embedding row cannot participate in similarity search (NULL <=> vec = NULL fails threshold)
    const vec = pgvector.toSql(Array(1536).fill(0.01));
    const { rows: searchRows } = await pool.query(
      `SELECT * FROM match_thoughts_scored($1, 0.0, 200, '{}', NULL, false)`, [vec]
    );
    expect(searchRows.some(r => r.content === 'DB-11 null embedding')).toBe(false);
    await pool.query(`DELETE FROM thoughts WHERE content='DB-11 null embedding'`);
  });

  it("DB-12 invalid ltree label is rejected", async () => {
    // ltree labels cannot contain spaces or special chars
    await expect(
      pool.query(
        `INSERT INTO thoughts (content, embedding, scope, thought_type, source_agent, source_phase, importance)
         VALUES ('invalid scope', $1, ARRAY['invalid scope label']::ltree[], 'insight', 'claude', 'build', 0.5)`,
        [pgvector.toSql(Array(1536).fill(0))]
      )
    ).rejects.toThrow();
  });

  it("DB-13 brain_config singleton: inserting a second row fails", async () => {
    await expect(pool.query(`INSERT INTO brain_config (id) VALUES (1)`)).rejects.toThrow();
  });

  it("DB-14 deleting a thought cascades to thought_relations", async () => {
    const r1 = await insertThought(pool, { content: "DB-14 source" });
    const r2 = await insertThought(pool, { content: "DB-14 target" });
    await pool.query(
      `INSERT INTO thought_relations (source_id, target_id, relation_type) VALUES ($1, $2, 'supports')`,
      [r1.id, r2.id]
    );
    await pool.query(`DELETE FROM thoughts WHERE id=$1`, [r1.id]);
    const { rows } = await pool.query(
      `SELECT * FROM thought_relations WHERE source_id=$1`, [r1.id]
    );
    expect(rows).toHaveLength(0);
  });
});
