// Tests for session tracking: loadSessions, saveSessions, logError
// Covers SP-01, SP-37, SP-38, SP-39 and SESS-* helpers
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

import * as fs from "fs";
import { getSessPath, loadSessions, saveSessions, logError } from "../../hooks/stop-process.mjs";
import { FAKE_CONFIG_PATH, SESSION_ID_A, SESSION_ID_B } from "../helpers/fixtures.mjs";

beforeEach(() => vi.resetAllMocks());

describe("loadSessions", () => {
  it("SESS-03 returns sessions from existing file", () => {
    const data = { sessions: { [SESSION_ID_A]: { status: "active", last_processed_index: 5 } } };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    expect(loadSessions(FAKE_CONFIG_PATH)).toEqual(data);
  });

  it("SESS-04 returns empty sessions when file does not exist", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(loadSessions(FAKE_CONFIG_PATH)).toEqual({ sessions: {} });
  });

  it("SESS-05 returns empty sessions when file contains invalid JSON", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("not-json{{{");
    expect(loadSessions(FAKE_CONFIG_PATH)).toEqual({ sessions: {} });
  });

  it("SP-01 migration: seeds from flat config cursor on first run", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    const hint = { last_session_id: SESSION_ID_A, last_processed_index: 10, last_capture_at: "2026-01-01T00:00:00Z" };
    const result = loadSessions(FAKE_CONFIG_PATH, hint);
    expect(result.sessions[SESSION_ID_A]).toMatchObject({
      last_processed_index: 10,
      last_capture_at: "2026-01-01T00:00:00Z",
      status: "active",
    });
  });

  it("SESS-06 no migration when sessions file already exists", () => {
    const data = { sessions: { [SESSION_ID_B]: { status: "done" } } };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(data));
    const hint = { last_session_id: SESSION_ID_A, last_processed_index: 99 };
    const result = loadSessions(FAKE_CONFIG_PATH, hint);
    expect(result.sessions[SESSION_ID_A]).toBeUndefined();
    expect(result.sessions[SESSION_ID_B]).toBeDefined();
  });
});

describe("saveSessions", () => {
  it("SP-37 writes sessions to .sessions.json path", () => {
    const data = { sessions: { [SESSION_ID_A]: { status: "active" } } };
    saveSessions(FAKE_CONFIG_PATH, data);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      getSessPath(FAKE_CONFIG_PATH),
      expect.any(String),
      { mode: 0o600 }
    );
  });

  it("SP-38 writes with chmod 0o600", () => {
    saveSessions(FAKE_CONFIG_PATH, { sessions: {} });
    const [, , opts] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(opts.mode).toBe(0o600);
  });

  it("SP-37a prunes done sessions older than prune_after_days", () => {
    const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    const data = {
      sessions: {
        old_sess: { status: "done", last_capture_at: old },
        new_sess: { status: "done", last_capture_at: recent },
      },
    };
    saveSessions(FAKE_CONFIG_PATH, data, 30);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(written.sessions.old_sess).toBeUndefined();
    expect(written.sessions.new_sess).toBeDefined();
  });

  it("SP-37b does not prune active sessions regardless of age", () => {
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const data = {
      sessions: { active_sess: { status: "active", last_capture_at: old } },
    };
    saveSessions(FAKE_CONFIG_PATH, data, 30);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(written.sessions.active_sess).toBeDefined();
  });

  it("SP-37c does not prune done sessions with null last_capture_at", () => {
    const data = {
      sessions: { no_date: { status: "done", last_capture_at: null } },
    };
    saveSessions(FAKE_CONFIG_PATH, data, 30);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(written.sessions.no_date).toBeDefined();
  });

  it("SP-37d preserves extra fields on sessData", () => {
    const data = { prune_after_days: 7, sessions: {} };
    saveSessions(FAKE_CONFIG_PATH, data, 7);
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(written.prune_after_days).toBe(7);
  });
});

describe("logError", () => {
  it("SP-39 appends to errors.log in same directory as config", () => {
    const err = new Error("DB connection failed");
    logError(FAKE_CONFIG_PATH, SESSION_ID_A, err);
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.stringContaining("errors.log"),
      expect.stringContaining("DB connection failed")
    );
  });

  it("SP-39a includes session ID in log entry", () => {
    logError(FAKE_CONFIG_PATH, SESSION_ID_A, new Error("oops"));
    const [, content] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(content).toContain(SESSION_ID_A);
  });

  it("SP-39b uses 'unknown' when session ID is null", () => {
    logError(FAKE_CONFIG_PATH, null, new Error("test"));
    const [, content] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(content).toContain("unknown");
  });

  it("SP-39c silently swallows errors if appendFileSync throws", () => {
    vi.mocked(fs.appendFileSync).mockImplementation(() => { throw new Error("disk full"); });
    expect(() => logError(FAKE_CONFIG_PATH, SESSION_ID_A, new Error("test"))).not.toThrow();
  });

  it("SP-39d includes ISO timestamp in log entry", () => {
    logError(FAKE_CONFIG_PATH, SESSION_ID_A, new Error("x"));
    const [, content] = vi.mocked(fs.appendFileSync).mock.calls[0];
    expect(content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
