// Integration tests for HTTP transport mode (HT-01 through HT-12)
// Spins up the server in HTTP mode against a real or mock DB and exercises the HTTP layer.
// Requires TEST_DB_URL to be set; skipped otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// HTTP tests require templates/server.mjs which has the /health endpoint and HTTP session management.
// The root server.mjs is stdio-only; templates/server.mjs supports both transports.
const SERVER_PATH = join(__dirname, "../../templates/server.mjs");
const DB_URL = process.env.TEST_DB_URL;
const API_KEY = process.env.TEST_OPENROUTER_API_KEY || "sk-or-test";
const skip = !DB_URL;

const TEST_PORT = 18787;
const BASE = `http://localhost:${TEST_PORT}`;

let serverProcess;

async function waitForServer(retries = 50, delayMs = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE}/health`).catch(() => null);
      if (r?.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error("Server did not start in time");
}

beforeAll(async () => {
  if (skip) return;
  serverProcess = spawn(process.execPath, [SERVER_PATH, "http"], {
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      OPENROUTER_API_KEY: API_KEY,
      PORT: String(TEST_PORT),
    },
    stdio: "pipe", // capture stderr so startup errors surface in CI
  });
  serverProcess.stderr?.on("data", (d) => process.stderr.write(d));
  await waitForServer();
}, 30_000); // allow up to 30s for server startup

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  // Brief wait to ensure port is released before next run
  await new Promise(r => setTimeout(r, 200));
});

describe.skipIf(skip)("HTTP transport", () => {
  it("HT-04 GET /health returns {status:'ok'} with 200", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("HT-05 OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await fetch(`${BASE}/`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("HT-09 CORS headers present on POST", async () => {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("HT-01 POST without session ID creates new session", async () => {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const sessionId = res.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("HT-03 POST with unknown session ID returns 404", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": fakeId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.message).toMatch(/session not found/i);
  });

  it("HT-02 POST with valid session ID reuses session", async () => {
    // Create session
    const init = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
    });
    const sessionId = init.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    // Reuse session
    const reuse = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 2 }),
    });
    expect(reuse.status).not.toBe(404);
  });

  it("HT-06 PUT method returns 405", async () => {
    const res = await fetch(`${BASE}/`, { method: "PUT" });
    expect(res.status).toBe(405);
  });

  it("HT-07 PATCH method returns 405", async () => {
    const res = await fetch(`${BASE}/`, { method: "PATCH" });
    expect(res.status).toBe(405);
  });

  it("HT-08 concurrent new sessions get distinct IDs", async () => {
    const requests = Array(5).fill(null).map(() =>
      fetch(`${BASE}/`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
      })
    );
    const responses = await Promise.all(requests);
    const ids = responses.map(r => r.headers.get("mcp-session-id")).filter(Boolean);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);
  });

  it("HT-10 GET /health includes Content-Type application/json", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("HT-11 POST with malformed JSON body returns error response", async () => {
    const res = await fetch(`${BASE}/`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: "{ not valid json {{",
    });
    // Should return a non-2xx status or a JSON-RPC error, not crash
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("HT-12 DELETE method on / returns 405", async () => {
    const res = await fetch(`${BASE}/`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });
});
