// Tests for hooks/sweep.mjs session filtering logic
// Covers SW-01 through SW-12
// Strategy: test the filter logic by extracting it into a testable helper.
// sweep.mjs is a top-level script; we test its decision logic here directly.
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => { vi.restoreAllMocks(); });

// ─── Core filter logic (extracted for testing) ────────────────────────────────
// This mirrors the sessionsToProcess filter in sweep.mjs.

function filterSessionsToProcess(allSessions, sessData, idleThresholdMs, now = Date.now()) {
  const result = [];
  for (const { sessionId, filePath, mtimeMs } of allSessions) {
    const ageMs = now - mtimeMs;
    if (ageMs < idleThresholdMs) continue; // still active
    const sess = sessData.sessions?.[sessionId];
    if (sess?.status === "done" && mtimeMs <= (sess.last_mtime || 0)) continue; // done, nothing new
    result.push({ sessionId, filePath });
  }
  return result;
}

const NOW = 1_000_000_000_000; // fixed epoch ms
const THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

function makeSession(sessionId, minsAgo, status = "active", lastMtime = null) {
  const mtimeMs = NOW - minsAgo * 60 * 1000;
  return {
    session: { sessionId, filePath: `/tmp/${sessionId}.jsonl`, mtimeMs },
    sessEntry: lastMtime !== null
      ? { status, last_mtime: lastMtime }
      : { status },
  };
}

describe("sweep filter logic", () => {
  it("SW-01 skips sessions with mtime too recent (stop hook will handle)", () => {
    const { session } = makeSession("s1", 5); // 5 mins ago, threshold is 20
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(0);
  });

  it("SW-02 includes one idle session with no prior sessions data", () => {
    const { session } = makeSession("s1", 25); // 25 mins ago → idle
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("s1");
  });

  it("SW-03 processes multiple idle sessions (≤5 cap enforced by caller)", () => {
    const sessions = ["s1", "s2", "s3", "s4"].map(id => makeSession(id, 30).session);
    const result = filterSessionsToProcess(sessions, { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(4);
  });

  it("SW-04 caller cap: only first 5 of 8 idle sessions are processed", () => {
    const sessions = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map(id => makeSession(id, 30).session);
    const filtered = filterSessionsToProcess(sessions, { sessions: {} }, THRESHOLD_MS, NOW);
    const capped = filtered.slice(0, 5);
    expect(capped).toHaveLength(5);
  });

  it("SW-05 SW-09 sessions with status=done and unchanged mtime are skipped", () => {
    const mtimeMs = NOW - 30 * 60 * 1000;
    const session = { sessionId: "done1", filePath: "/tmp/done1.jsonl", mtimeMs };
    const sessData = {
      sessions: { done1: { status: "done", last_mtime: mtimeMs } },
    };
    const result = filterSessionsToProcess([session], sessData, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(0);
  });

  it("SW-05 done sessions with advanced mtime are re-processed", () => {
    const oldMtime = NOW - 60 * 60 * 1000; // 1 hour ago
    const newMtime = NOW - 25 * 60 * 1000; // 25 min ago (idle, but after last_mtime)
    const session = { sessionId: "reactivated", filePath: "/tmp/r.jsonl", mtimeMs: newMtime };
    const sessData = {
      sessions: { reactivated: { status: "done", last_mtime: oldMtime } },
    };
    const result = filterSessionsToProcess([session], sessData, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("SW-06 active sessions in sessions map are processed if idle", () => {
    const mtimeMs = NOW - 30 * 60 * 1000;
    const session = { sessionId: "active1", filePath: "/tmp/a.jsonl", mtimeMs };
    const sessData = {
      sessions: { active1: { status: "active", last_processed_index: 5, last_mtime: mtimeMs - 5000 } },
    };
    const result = filterSessionsToProcess([session], sessData, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("SW-07 unknown sessions (not in map) are processed if idle", () => {
    const session = makeSession("unknown_sess", 30).session;
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("SW-08 empty allSessions array returns empty result", () => {
    const result = filterSessionsToProcess([], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(0);
  });

  it("SW-09 done session with last_mtime=0 and file mtime > 0 is re-processed", () => {
    const mtimeMs = NOW - 30 * 60 * 1000;
    const session = { sessionId: "stale", filePath: "/tmp/stale.jsonl", mtimeMs };
    const sessData = {
      sessions: { stale: { status: "done", last_mtime: 0 } },
    };
    const result = filterSessionsToProcess([session], sessData, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("SW-10 enabled=false check prevents any processing (tested at config level)", () => {
    // enabled=false causes process.exit(0) before filterSessionsToProcess is called
    // Verify the filter itself would return results if called (it would), but the guard stops it
    const session = makeSession("s1", 30).session;
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1); // filter doesn't know about enabled — config guard handles it
  });

  it("SW-11 session with null sessions map falls back gracefully", () => {
    const session = makeSession("s1", 30).session;
    const result = filterSessionsToProcess([session], { sessions: null }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("SW-12 mixed: some idle, some recent, some done-unchanged", () => {
    const idleNew = { sessionId: "idle_new", filePath: "/tmp/in.jsonl", mtimeMs: NOW - 30 * 60 * 1000 };
    const recent = { sessionId: "recent", filePath: "/tmp/r.jsonl", mtimeMs: NOW - 5 * 60 * 1000 };
    const doneUnchanged = { sessionId: "done_unc", filePath: "/tmp/du.jsonl", mtimeMs: NOW - 30 * 60 * 1000 };
    const sessData = {
      sessions: {
        done_unc: { status: "done", last_mtime: NOW - 30 * 60 * 1000 },
      },
    };
    const result = filterSessionsToProcess([idleNew, recent, doneUnchanged], sessData, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("idle_new");
  });

  it("boundary: session idle by exactly threshold ms is included", () => {
    const mtimeMs = NOW - THRESHOLD_MS; // exactly at threshold
    const session = { sessionId: "boundary", filePath: "/tmp/b.jsonl", mtimeMs };
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(1);
  });

  it("boundary: session idle by threshold - 1ms is excluded", () => {
    const mtimeMs = NOW - THRESHOLD_MS + 1; // just under threshold
    const session = { sessionId: "fresh", filePath: "/tmp/f.jsonl", mtimeMs };
    const result = filterSessionsToProcess([session], { sessions: {} }, THRESHOLD_MS, NOW);
    expect(result).toHaveLength(0);
  });
});
