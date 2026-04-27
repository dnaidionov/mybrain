#!/usr/bin/env node
// Auto-capture background worker. Runs detached after each Claude Code response.
// Analyzes new conversation content in batches and captures worth-keeping insights.
import { readFileSync, writeFileSync, existsSync, statSync, appendFileSync } from "fs";
import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import pgvector from "pgvector/pg";

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const [, , SESSION_ID, TRANSCRIPT_PATH, CONFIG_PATH] = process.argv;

// ─── Session tracking ────────────────────────────────────────────────────────

export function getSessPath(configPath) {
  return join(dirname(configPath), ".sessions.json");
}

export function loadSessions(configPath, migrationHint = {}) {
  try {
    return JSON.parse(readFileSync(getSessPath(configPath), "utf8"));
  } catch (_) {
    // One-time migration: seed from flat config cursor fields if present
    const { last_session_id, last_processed_index, last_capture_at } = migrationHint;
    if (last_session_id) {
      return {
        sessions: {
          [last_session_id]: {
            last_processed_index: last_processed_index || 0,
            last_capture_at: last_capture_at || null,
            last_mtime: 0,
            transcript_path: null,
            status: "active",
          },
        },
      };
    }
    return { sessions: {} };
  }
}

export function saveSessions(configPath, sessData, pruneAfterDays = 30) {
  const cutoffMs = Date.now() - pruneAfterDays * 86_400_000;
  const pruned = {};
  for (const [id, s] of Object.entries(sessData.sessions || {})) {
    if (s.status === "done" && s.last_capture_at && new Date(s.last_capture_at).getTime() < cutoffMs) continue;
    pruned[id] = s;
  }
  writeFileSync(
    getSessPath(configPath),
    JSON.stringify({ ...sessData, sessions: pruned }, null, 2),
    { mode: 0o600 }
  );
}

export function logError(configPath, sessionId, err) {
  try {
    const logPath = join(dirname(configPath), "errors.log");
    const line = `[${new Date().toISOString()}] [session:${sessionId || "unknown"}] ${err.message}\n${err.stack || ""}\n\n`;
    appendFileSync(logPath, line);
  } catch (_) {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function minutesSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

export function parseTranscript(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return messages;
}

export function extractText(message) {
  const content = message?.message?.content || message?.content || [];
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

export function buildConversationText(messages, maxTokenEstimate = 6000) {
  // Rough estimate: 1 token ≈ 4 chars
  const maxChars = maxTokenEstimate * 4;
  const parts = [];
  let totalChars = 0;
  let truncated = false;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg?.message?.role || msg?.role || "unknown";
    const text = extractText(msg);
    if (!text) continue;
    const entry = `[${role}]: ${text}\n`;
    if (totalChars + entry.length > maxChars) {
      truncated = true;
      break;
    }
    parts.push(entry);
    totalChars += entry.length;
  }
  return { text: parts.reverse().join("\n"), truncated };
}

export function detectScope(configScope) {
  // Prefer git repo slug, fallback to configured scope or 'personal'
  try {
    const remote = execSync("git remote get-url origin 2>/dev/null", { encoding: "utf8" }).trim();
    const match = remote.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (match) return `projects.${match[1].replace(/[^a-zA-Z0-9_]/g, "_")}`;
  } catch (_) { /* not in a git repo or git not available */ }
  return configScope || "personal";
}

export function checkThresholds({ newMessageCount, lastCaptureAt, batchThresholdMessages, batchThresholdMinutes }) {
  const messageThresholdMet = newMessageCount >= batchThresholdMessages;
  const timeThresholdMet = minutesSince(lastCaptureAt) >= batchThresholdMinutes;
  return { messageThresholdMet, timeThresholdMet, shouldProcess: messageThresholdMet || timeThresholdMet };
}

export function checkContentGate(messages) {
  return messages.some((msg) => extractText(msg).trim().length > 50);
}

export async function getEmbedding(text, apiKey) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`Embedding error: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// Models confirmed to support response_format on OpenRouter (including free variants).
// openai/gpt-oss-120b:free does not list it in supported_parameters but is included
// here intentionally — it handles json_object gracefully in practice.
export const JSON_MODE_MODELS = new Set([
  "openai/gpt-oss-120b:free",
  "anthropic/claude-haiku-4.5",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemini-3.1-flash-lite-preview",
]);

export async function extractInsights(conversationText, apiKey, model, messageCount = 15) {
  const maxInsights = Math.ceil(messageCount / 3) + 3;
  const jsonMode = JSON_MODE_MODELS.has(model);

  const returnFormat = jsonMode
    ? `Return a JSON object with a single key "insights" containing an array. Each item: {"content":"...","thought_type":"...","importance":0.0,"metadata":{}}
If nothing worth capturing, return {"insights": []}.`
    : `Return ONLY a raw JSON array with no markdown, no code fences, no explanation. Each item: {"content":"...","thought_type":"...","importance":0.0,"metadata":{}}
If nothing worth capturing, return [].`;

  const systemPrompt = `You extract knowledge worth saving in a personal knowledge base.
Analyze the conversation and capture everything genuinely worth keeping — up to ${maxInsights} items for a conversation of this length. Only capture what you actually find; do not pad to reach the limit.
Only capture: architectural decisions, rejected alternatives with reasoning, explicit user preferences, non-obvious lessons or patterns, important discoveries, persistent personal facts (subscriptions, reference info), personal reflections.
Do NOT capture: greetings, step-by-step explanations, trivial confirmations, things the user already knows, summaries of what was done.
${returnFormat}
thought_type must be one of: decision|preference|lesson|rejection|drift|correction|insight|reflection|fact
Importance guidance by type (0.0–1.0): decision=0.7-0.9, preference=0.8-1.0, lesson=0.6-0.8, rejection=0.5-0.7, insight=0.5-0.7, reflection=0.7-0.9, fact=0.9-1.0, drift=0.7-0.8, correction=0.6-0.8`;

  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 30_000);
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Conversation to analyze:\n\n${conversationText}` },
        ],
        ...(jsonMode && { response_format: { type: "json_object" } }),
        max_tokens: 1024,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Extraction API error: ${res.status} ${err}`);
  }

  const data = await res.json();
  const usage = data.usage || {};
  const raw = data.choices?.[0]?.message?.content || "[]";

  // No response_format enforcement on free tier — extract JSON defensively
  let parsed;
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) parsed = parsed.insights || parsed.thoughts || parsed.items || [];
  } catch (_) {
    // Try extracting a JSON array from anywhere in the response
    const match = raw.match(/\[[\s\S]*\]/);
    try { parsed = match ? JSON.parse(match[0]) : []; } catch (_2) { parsed = []; }
  }

  return { insights: parsed, inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0 };
}

// ─── Main (only runs when executed as script) ─────────────────────────────────

async function main(cfg) {
  const {
    database_url,
    openrouter_api_key,
    brain_scope,
    extraction_model = "openai/gpt-oss-120b:free",
    batch_threshold_messages = 15,
    batch_threshold_minutes = 20,
    prune_after_days = 30,
  } = cfg;

  // ── Session lookup ──
  const sessData = loadSessions(CONFIG_PATH, cfg);
  const session = sessData.sessions?.[SESSION_ID] || null;

  let cursor;
  if (!session) {
    cursor = 0;
  } else if (session.status === "done") {
    // Check if transcript has new content since last processing
    let fileMtime = 0;
    try { fileMtime = statSync(TRANSCRIPT_PATH).mtimeMs; } catch (_) { process.exit(0); }
    if (fileMtime <= (session.last_mtime || 0)) process.exit(0); // nothing new
    cursor = session.last_processed_index || 0;
  } else {
    cursor = session.last_processed_index || 0;
  }

  const allMessages = parseTranscript(TRANSCRIPT_PATH);
  const newMessages = allMessages.slice(cursor);

  // ── Threshold check (cheap — no API calls yet) ──
  const messageThresholdMet = newMessages.length >= batch_threshold_messages;
  const timeThresholdMet = minutesSince(session?.last_capture_at) >= batch_threshold_minutes;

  if (!messageThresholdMet && !timeThresholdMet) {
    sessData.sessions[SESSION_ID] = {
      ...(session || {}),
      last_processed_index: cursor,
      transcript_path: TRANSCRIPT_PATH,
      status: "active",
    };
    saveSessions(CONFIG_PATH, sessData, prune_after_days);
    return;
  }

  // ── Content gate ──
  const hasMeaningfulText = newMessages.some((msg) => extractText(msg).trim().length > 50);
  if (!hasMeaningfulText) {
    let fileMtime = 0;
    try { fileMtime = statSync(TRANSCRIPT_PATH).mtimeMs; } catch (_) {}
    sessData.sessions[SESSION_ID] = {
      last_processed_index: allMessages.length,
      last_capture_at: session?.last_capture_at || null,
      last_mtime: fileMtime,
      transcript_path: TRANSCRIPT_PATH,
      status: "done",
    };
    saveSessions(CONFIG_PATH, sessData, prune_after_days);
    return;
  }

  // ── Build conversation text ──
  const { text: conversationText, truncated } = buildConversationText(newMessages);

  // ── DB connection ──
  const pool = new pg.Pool({ connectionString: database_url });
  pool.on("connect", async (client) => { await pgvector.registerTypes(client); });

  let inputTokens = 0, outputTokens = 0, thoughtsCaptured = 0;

  try {
    // ── Log truncation warning ──
    if (truncated) {
      try {
        await pool.query(
          `INSERT INTO autocapture_warnings (session_id, warning_type, detail) VALUES ($1, 'truncation', $2)`,
          [SESSION_ID, `Large response truncated during batch processing at ${new Date().toISOString()}`]
        );
      } catch (_) { /* table may not exist yet */ }
    }

    // ── Detect scope ──
    const scope = detectScope(brain_scope);

    // ── Extract insights ──
    const { insights, inputTokens: iT, outputTokens: oT } = await extractInsights(
      conversationText, openrouter_api_key, extraction_model, newMessages.length
    );
    inputTokens = iT;
    outputTokens = oT;

    for (const insight of insights) {
      const { content, thought_type = "insight", importance = 0.5, metadata = {} } = insight;
      if (!content || typeof content !== "string" || content.trim().length < 10) continue;

      try {
        // Generate embedding (reused for dedup check AND insert)
        const embedding = await getEmbedding(content, openrouter_api_key);
        const vec = pgvector.toSql(embedding);

        // Dedup check
        const dupCheck = await pool.query(
          `SELECT count(*) as cnt FROM thoughts WHERE (1 - (embedding <=> $1)) > 0.8 AND scope @> ARRAY[$2]::ltree[]`,
          [vec, scope]
        );
        if (parseInt(dupCheck.rows[0].cnt, 10) > 0) continue; // near-duplicate exists

        // Insert
        const scopeArray = `{${scope}}`;
        await pool.query(
          `INSERT INTO thoughts (content, embedding, metadata, scope, thought_type, source_agent, source_phase, importance)
           VALUES ($1, $2, $3, $4::ltree[], $5, 'claude', 'reconciliation', $6)`,
          [
            content.trim(),
            vec,
            JSON.stringify({ ...metadata, autocaptured: true, session_id: SESSION_ID }),
            scopeArray,
            thought_type,
            Math.max(0, Math.min(1, importance)),
          ]
        );
        thoughtsCaptured++;
      } catch (err) {
        process.stderr.write(`[autocapture] Failed to capture insight: ${err.message}\n`);
        try {
          await pool.query(
            `INSERT INTO autocapture_warnings (session_id, warning_type, detail) VALUES ($1, 'capture_failure', $2)`,
            [SESSION_ID, `Failed to capture insight: ${err.message}`]
          );
        } catch (_) { /* table may not exist yet */ }
      }
    }

    // ── Log token usage ──
    if (inputTokens > 0 || thoughtsCaptured > 0) {
      try {
        const scopeArray = `{${scope}}`;
        await pool.query(
          `INSERT INTO token_usage (session_id, scope, model, input_tokens, output_tokens, embeddings_count, thoughts_captured)
           VALUES ($1, $2::ltree[], $3, $4, $5, $6, $7)`,
          [SESSION_ID, scopeArray, extraction_model, inputTokens, outputTokens, thoughtsCaptured, thoughtsCaptured]
        );
      } catch (_) { /* token_usage table may not exist yet */ }
    }

  } finally {
    await pool.end();
  }

  // ── Update session ──
  let fileMtime = 0;
  try { fileMtime = statSync(TRANSCRIPT_PATH).mtimeMs; } catch (_) {}
  sessData.sessions[SESSION_ID] = {
    last_processed_index: allMessages.length,
    last_capture_at: new Date().toISOString(),
    last_mtime: fileMtime,
    transcript_path: TRANSCRIPT_PATH,
    status: "done",
  };
  saveSessions(CONFIG_PATH, sessData, prune_after_days);
}

if (isMain) {
  // Load config early for the enabled check (guard before any async work)
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (_) {
    process.exit(0);
  }
  if (!cfg.enabled) process.exit(0);

  main(cfg).catch((err) => {
    process.stderr.write(`[autocapture] Fatal error: ${err.message}\n`);
    if (CONFIG_PATH) logError(CONFIG_PATH, SESSION_ID, err);
    process.exit(0); // Never block anything
  });
}
