// Tests for checkThresholds and checkContentGate (SP-02 through SP-11)
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { checkThresholds, checkContentGate } from "../../hooks/stop-process.mjs";

beforeEach(() => vi.resetAllMocks());

// ─── checkThresholds ──────────────────────────────────────────────────────────

describe("checkThresholds", () => {
  it("SP-02 shouldProcess=false when both thresholds are unmet", () => {
    const result = checkThresholds({
      newMessageCount: 5,
      lastCaptureAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.shouldProcess).toBe(false);
    expect(result.messageThresholdMet).toBe(false);
    expect(result.timeThresholdMet).toBe(false);
  });

  it("SP-03 shouldProcess=true when message count meets threshold", () => {
    const result = checkThresholds({
      newMessageCount: 15,
      lastCaptureAt: new Date(Date.now() - 1 * 60 * 1000).toISOString(), // 1 min ago
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.messageThresholdMet).toBe(true);
    expect(result.shouldProcess).toBe(true);
  });

  it("SP-04 shouldProcess=true when time threshold is met", () => {
    const result = checkThresholds({
      newMessageCount: 3,
      lastCaptureAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(), // 25 min ago
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.timeThresholdMet).toBe(true);
    expect(result.shouldProcess).toBe(true);
  });

  it("SP-05 shouldProcess=true when both thresholds are met", () => {
    const result = checkThresholds({
      newMessageCount: 20,
      lastCaptureAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.messageThresholdMet).toBe(true);
    expect(result.timeThresholdMet).toBe(true);
    expect(result.shouldProcess).toBe(true);
  });

  it("SP-06 time threshold: null lastCaptureAt (first run) → timeThresholdMet=true", () => {
    const result = checkThresholds({
      newMessageCount: 5,
      lastCaptureAt: null,
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    // minutesSince(null) = Infinity ≥ 20 → timeThresholdMet
    expect(result.timeThresholdMet).toBe(true);
    expect(result.shouldProcess).toBe(true);
  });

  it("SP-07 exactly at message threshold boundary: shouldProcess=true", () => {
    const result = checkThresholds({
      newMessageCount: 15,
      lastCaptureAt: new Date().toISOString(), // just now
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.messageThresholdMet).toBe(true);
  });

  it("SP-07a one below message threshold: messageThresholdMet=false", () => {
    const result = checkThresholds({
      newMessageCount: 14,
      lastCaptureAt: new Date().toISOString(),
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.messageThresholdMet).toBe(false);
  });

  it("SP-08 zero new messages: messageThresholdMet=false", () => {
    const result = checkThresholds({
      newMessageCount: 0,
      lastCaptureAt: new Date().toISOString(),
      batchThresholdMessages: 15,
      batchThresholdMinutes: 20,
    });
    expect(result.messageThresholdMet).toBe(false);
  });

  it("SP-08a custom thresholds respected", () => {
    const result = checkThresholds({
      newMessageCount: 5,
      lastCaptureAt: null,
      batchThresholdMessages: 3, // low threshold
      batchThresholdMinutes: 60,
    });
    expect(result.messageThresholdMet).toBe(true);
  });
});

// ─── checkContentGate ────────────────────────────────────────────────────────

describe("checkContentGate", () => {
  it("SP-10 content gate handles message.message.content JSONL nesting (stop-process format)", () => {
    // JSONL transcript messages use { message: { role, content: [...] } } structure
    const msgs = [
      { message: { role: "user", content: [{ type: "text", text: "x".repeat(51) }] } },
    ];
    expect(checkContentGate(msgs)).toBe(true);
  });

  it("SP-09 returns true when at least one message has text > 50 chars", () => {
    const msgs = [
      { content: [{ type: "text", text: "short" }] },
      { content: [{ type: "text", text: "This message has more than fifty characters in it for sure." }] },
    ];
    expect(checkContentGate(msgs)).toBe(true);
  });

  it("SP-09b returns false when all messages have short text (≤50 chars)", () => {
    const msgs = [
      { content: [{ type: "text", text: "hi" }] },
      { content: [{ type: "text", text: "ok" }] },
      { content: [{ type: "text", text: "yes" }] },
    ];
    expect(checkContentGate(msgs)).toBe(false);
  });

  it("SP-09c returns false for empty messages array", () => {
    expect(checkContentGate([])).toBe(false);
  });

  it("SP-09d returns false when messages have only tool_use blocks (no text)", () => {
    const msgs = [
      { content: [{ type: "tool_use", id: "x", input: {} }] },
      { message: { content: [{ type: "tool_result", content: "result" }] } },
    ];
    expect(checkContentGate(msgs)).toBe(false);
  });

  it("SP-11 content gate: text exactly 50 chars does not pass (> 50 required)", () => {
    const text = "x".repeat(50); // exactly 50
    const msgs = [{ content: [{ type: "text", text }] }];
    expect(checkContentGate(msgs)).toBe(false);
  });

  it("SP-11a content gate: text of 51 chars passes", () => {
    const text = "x".repeat(51);
    const msgs = [{ content: [{ type: "text", text }] }];
    expect(checkContentGate(msgs)).toBe(true);
  });

  it("SP-11b whitespace-only text does not pass gate (trimmed to 0)", () => {
    const msgs = [{ content: [{ type: "text", text: " ".repeat(100) }] }];
    expect(checkContentGate(msgs)).toBe(false);
  });
});
