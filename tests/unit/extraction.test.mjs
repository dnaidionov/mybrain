// Tests for getEmbedding and extractInsights
// Covers E-01 through E-10, SP-19 through SP-28
import { describe, it, expect, vi, afterEach } from "vitest";
import { getEmbedding, extractInsights, JSON_MODE_MODELS } from "../../hooks/stop-process.mjs";

const API_KEY = "sk-or-test";

afterEach(() => { vi.restoreAllMocks(); });

// ─── getEmbedding ─────────────────────────────────────────────────────────────

describe("getEmbedding", () => {
  it("E-01 returns float array on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1536).fill(0.1) }] }),
    }));
    const result = await getEmbedding("hello world", API_KEY);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1536);
  });

  it("E-02 accepts empty string without throwing (passes to API)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }),
    }));
    await expect(getEmbedding("", API_KEY)).resolves.toHaveLength(1536);
  });

  it("E-03 returned values are numbers (not strings)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: Array(1536).fill(0.42) }] }),
    }));
    const result = await getEmbedding("test", API_KEY);
    expect(typeof result[0]).toBe("number");
  });

  it("E-04 uses correct OpenRouter embeddings endpoint URL", async () => {
    let capturedUrl;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    }));
    await getEmbedding("test", API_KEY);
    expect(capturedUrl).toBe("https://openrouter.ai/api/v1/embeddings");
  });

  it("E-05 throws on 401 unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "Unauthorized" }));
    await expect(getEmbedding("test", API_KEY)).rejects.toThrow("Embedding error: 401");
  });

  it("E-06 throws on 500 server error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" }));
    await expect(getEmbedding("test", API_KEY)).rejects.toThrow("Embedding error: 500");
  });

  it("E-07 throws on 429 rate limit without retry", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "Rate limit" });
    vi.stubGlobal("fetch", mockFetch);
    await expect(getEmbedding("test", API_KEY)).rejects.toThrow("Embedding error: 429");
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry
  });

  it("E-08 throws on network failure (fetch rejects)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    await expect(getEmbedding("test", API_KEY)).rejects.toThrow("Network error");
  });

  it("E-09 throws when API response has no data array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }));
    await expect(getEmbedding("test", API_KEY)).rejects.toThrow();
  });

  it("E-10 long input string is passed through to API body unchanged", async () => {
    let capturedBody;
    const longText = "word ".repeat(500);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    }));
    await getEmbedding(longText, API_KEY);
    expect(capturedBody.input).toBe(longText);
  });

  it("E-01a sends correct model in request body", async () => {
    let capturedBody;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    }));
    await getEmbedding("test text", API_KEY);
    expect(capturedBody.model).toBe("openai/text-embedding-3-small");
  });

  it("E-01b sends Authorization header with Bearer token", async () => {
    let capturedHeaders;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedHeaders = opts.headers;
      return { ok: true, json: async () => ({ data: [{ embedding: Array(1536).fill(0) }] }) };
    }));
    await getEmbedding("test", "sk-or-mykey");
    expect(capturedHeaders.Authorization).toBe("Bearer sk-or-mykey");
  });
});

// ─── JSON_MODE_MODELS ─────────────────────────────────────────────────────────

describe("JSON_MODE_MODELS", () => {
  it("SP-20 contains the default extraction model", () => {
    expect(JSON_MODE_MODELS.has("openai/gpt-oss-120b:free")).toBe(true);
  });

  it("SP-21 does not contain an unknown free model", () => {
    expect(JSON_MODE_MODELS.has("meta-llama/llama-3.1-8b-instruct:free")).toBe(false);
  });
});

// ─── extractInsights ─────────────────────────────────────────────────────────

describe("extractInsights", () => {
  it("SP-20 sends response_format for JSON mode models", async () => {
    let capturedBody;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"insights":[]}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }));
    await extractInsights("text", API_KEY, "openai/gpt-oss-120b:free", 15);
    expect(capturedBody.response_format).toEqual({ type: "json_object" });
  });

  it("SP-21 omits response_format for non-JSON mode models", async () => {
    let capturedBody;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "[]" } }],
          usage: {},
        }),
      };
    }));
    await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free", 15);
    expect(capturedBody.response_format).toBeUndefined();
  });

  it("SP-29 maxInsights formula: ceil(msgCount/3)+3", async () => {
    let capturedBody;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "[]" } }], usage: {} }),
      };
    }));
    await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free", 15);
    const systemPrompt = capturedBody.messages[0].content;
    // ceil(15/3)+3 = 5+3 = 8
    expect(systemPrompt).toContain("8");
  });

  it("SP-24 returns empty insights array when model responds with empty array", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"insights":[]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "openai/gpt-oss-120b:free");
    expect(insights).toEqual([]);
  });

  it("SP-25 strips markdown code fences from response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '```json\n[{"content":"hi","thought_type":"insight","importance":0.6,"metadata":{}}]\n```' } }],
        usage: {},
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(insights).toHaveLength(1);
    expect(insights[0].content).toBe("hi");
  });

  it("SP-26 parses raw JSON array response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[{"content":"raw","thought_type":"fact","importance":0.9,"metadata":{}}]' } }],
        usage: {},
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(insights[0].content).toBe("raw");
  });

  it("SP-27 extracts JSON array via regex when embedded in prose", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Here are the insights: [{"content":"found it","thought_type":"insight","importance":0.5,"metadata":{}}]' } }],
        usage: {},
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(insights[0].content).toBe("found it");
  });

  it("SP-28 returns empty array for completely unparseable response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Sorry, I cannot help with that." } }],
        usage: {},
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(insights).toEqual([]);
  });

  it("SP-22 AbortController fires on timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url, opts) => {
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }));
    const promise = extractInsights("text", API_KEY, "openai/gpt-oss-120b:free");
    vi.advanceTimersByTime(31_000);
    await expect(promise).rejects.toThrow(/aborted/i);
    vi.useRealTimers();
  });

  it("SP-23 throws on 401 extraction API error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 401,
      text: async () => "Unauthorized",
    }));
    await expect(extractInsights("text", API_KEY, "openai/gpt-oss-120b:free")).rejects.toThrow("Extraction API error: 401");
  });

  it("SP-35 extractInsights result always includes inputTokens and outputTokens fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "[]" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const result = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(result).toHaveProperty("inputTokens");
    expect(result).toHaveProperty("outputTokens");
  });

  it("SP-35a returns correct token counts from API response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "[]" } }],
        usage: { prompt_tokens: 200, completion_tokens: 75 },
      }),
    }));
    const { inputTokens, outputTokens } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(inputTokens).toBe(200);
    expect(outputTokens).toBe(75);
  });

  it("SP-35b returns 0 tokens when usage field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "[]" } }] }),
    }));
    const { inputTokens, outputTokens } = await extractInsights("text", API_KEY, "meta-llama/llama-3.1-8b-instruct:free");
    expect(inputTokens).toBe(0);
    expect(outputTokens).toBe(0);
  });

  it("SP-25a parses wrapped object with 'insights' key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ insights: [{ content: "wrapped", thought_type: "insight", importance: 0.5, metadata: {} }] }) } }],
        usage: {},
      }),
    }));
    const { insights } = await extractInsights("text", API_KEY, "openai/gpt-oss-120b:free");
    expect(insights[0].content).toBe("wrapped");
  });
});
