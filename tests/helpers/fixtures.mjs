// Shared test fixtures and helpers

export const FAKE_CONFIG_PATH = "/tmp/mybrain-test/.autocapture-config.json";
export const FAKE_SESS_PATH   = "/tmp/mybrain-test/.sessions.json";

export const BASE_CONFIG = {
  enabled: true,
  database_url: "postgresql://localhost:5432/mybrain_test",
  openrouter_api_key: "sk-or-test-key",
  brain_scope: "personal",
  extraction_model: "openai/gpt-oss-120b:free",
  batch_threshold_messages: 15,
  batch_threshold_minutes: 20,
  prune_after_days: 30,
};

export const SESSION_ID_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
export const SESSION_ID_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
export const TRANSCRIPT_PATH = "/tmp/mybrain-test/session.jsonl";

/** Build a fake message in JSONL format */
export function makeMessage(role, text) {
  return JSON.stringify({
    message: {
      role,
      content: [{ type: "text", text }],
    },
  });
}

/** Build N messages with default long-enough text */
export function makeMessages(n, text = "This is a meaningful message with more than fifty characters to pass the gate.") {
  const messages = [];
  for (let i = 0; i < n; i++) {
    messages.push({ message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] } });
  }
  return messages;
}

/** Build an embedding response from OpenRouter */
export function fakeEmbeddingResponse(dims = 1536) {
  return {
    ok: true,
    json: async () => ({ data: [{ embedding: Array(dims).fill(0.1) }] }),
  };
}

/** Build a fake extraction API response */
export function fakeExtractionResponse(insights) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ insights }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }),
  };
}

/** Freeze time by overriding Date.now */
export function freezeTime(msEpoch) {
  const original = Date.now;
  Date.now = () => msEpoch;
  return () => { Date.now = original; };
}
