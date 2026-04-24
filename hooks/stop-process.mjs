#!/usr/bin/env node
// Auto-capture background worker. Runs detached after each Claude Code response.
// Analyzes new conversation content in batches and captures worth-keeping insights.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import pg from "pg";
import pgvector from "pgvector/pg";

const [, , SESSION_ID, TRANSCRIPT_PATH, CONFIG_PATH] = process.argv;

// ─── Config ─────────────────────────────────────────────────────────────────

function loadConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveConfig(path, cfg) {
  writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

let cfg;
try {
  cfg = loadConfig(CONFIG_PATH);
} catch (e) {
  process.exit(0); // No config — nothing to do
}

if (!cfg.enabled) process.exit(0);

const {
  database_url,
  openrouter_api_key,
  brain_scope,
  extraction_model = "openai/gpt-oss-120b:free",
  batch_threshold_messages = 15,
  batch_threshold_minutes = 20,
  last_processed_index = 0,
  last_session_id,
  last_capture_at,
} = cfg;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minutesSince(isoString) {
  if (!isoString) return Infinity;
  return (Date.now() - new Date(isoString).getTime()) / 60000;
}

function parseTranscript(path) {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const messages = [];
  for (const line of lines) {
    try { messages.push(JSON.parse(line)); } catch (_) { /* skip malformed */ }
  }
  return messages;
}

function extractText(message) {
  const content = message?.message?.content || message?.content || [];
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function buildConversationText(messages, maxTokenEstimate = 6000) {
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
    parts.unshift(entry);
    totalChars += entry.length;
  }
  return { text: parts.join("\n"), truncated };
}

function detectScope(configScope) {
  // Prefer git repo slug, fallback to configured scope or 'personal'
  try {
    const remote = execSync("git remote get-url origin 2>/dev/null", { encoding: "utf8" }).trim();
    const match = remote.match(/[/:]([^/]+?)(?:\.git)?$/);
    if (match) return `projects.${match[1].replace(/[^a-zA-Z0-9_]/g, "_")}`;
  } catch (_) { /* not in a git repo or git not available */ }
  return configScope || "personal";
}

async function getEmbedding(text, apiKey) {
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
const JSON_MODE_MODELS = new Set([
  "openai/gpt-oss-120b:free",
  "anthropic/claude-haiku-4.5",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemini-3.1-flash-lite-preview",
]);

async function extractInsights(conversationText, apiKey, model) {
  const systemPrompt = `You extract knowledge worth saving in a personal knowledge base.
Analyze the conversation and identify 0-3 things worth capturing permanently.
Only capture: architectural decisions, rejected alternatives with reasoning, explicit user preferences, non-obvious lessons or patterns, important discoveries, persistent personal facts (subscriptions, reference info), personal reflections.
Do NOT capture: greetings, step-by-step explanations, trivial confirmations, things the user already knows, summaries of what was done.
Return ONLY a raw JSON array with no markdown, no code fences, no explanation. Each item: {"content":"...","thought_type":"decision|preference|lesson|rejection|drift|correction|insight|reflection|fact","importance":0.0,"metadata":{}}
If nothing worth capturing, return [].`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Conversation to analyze:\n\n${conversationText}` },
      ],
      ...(JSON_MODE_MODELS.has(model) && { response_format: { type: "json_object" } }),
      max_tokens: 1024,
    }),
  });

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const allMessages = parseTranscript(TRANSCRIPT_PATH);

  // Reset cursor if new session
  const isNewSession = SESSION_ID && SESSION_ID !== last_session_id;
  const cursor = isNewSession ? 0 : last_processed_index;

  const newMessages = allMessages.slice(cursor);

  // ── Threshold check (cheap — no API calls yet) ──
  const messageThresholdMet = newMessages.length >= batch_threshold_messages;
  const timeThresholdMet = minutesSince(last_capture_at) >= batch_threshold_minutes;

  if (!messageThresholdMet && !timeThresholdMet) {
    // Not enough new content yet — exit silently
    if (isNewSession) {
      saveConfig(CONFIG_PATH, { ...cfg, last_session_id: SESSION_ID, last_processed_index: 0 });
    }
    return;
  }

  // ── Content gate ──
  const hasMeaningfulText = newMessages.some((msg) => {
    const text = extractText(msg);
    return text.trim().length > 50;
  });
  if (!hasMeaningfulText) {
    saveConfig(CONFIG_PATH, { ...cfg, last_session_id: SESSION_ID, last_processed_index: allMessages.length });
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
      conversationText, openrouter_api_key, extraction_model
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

  // ── Update cursor ──
  saveConfig(CONFIG_PATH, {
    ...cfg,
    last_session_id: SESSION_ID,
    last_processed_index: allMessages.length,
    last_capture_at: new Date().toISOString(),
  });
}

main().catch((err) => {
  process.stderr.write(`[autocapture] Fatal error: ${err.message}\n`);
  process.exit(0); // Never block anything
});
