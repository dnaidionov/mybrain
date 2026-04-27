// Tests for exported pure helpers in stop-process.mjs
// Covers: getSessPath, minutesSince, extractText, buildConversationText, parseTranscript, detectScope
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

import * as fs from "fs";
import * as child_process from "child_process";
import {
  buildConversationText,
  extractText,
  minutesSince,
  detectScope,
  getSessPath,
  parseTranscript,
} from "../../hooks/stop-process.mjs";

beforeEach(() => vi.resetAllMocks());

// ─── getSessPath ──────────────────────────────────────────────────────────────

describe("getSessPath", () => {
  it("SESS-01 derives .sessions.json path from config path", () => {
    expect(getSessPath("/home/user/.mybrain/default/.autocapture-config.json"))
      .toBe("/home/user/.mybrain/default/.sessions.json");
  });

  it("SESS-02 handles paths without subdirectory", () => {
    expect(getSessPath("/tmp/.autocapture-config.json"))
      .toBe("/tmp/.sessions.json");
  });
});

// ─── minutesSince ─────────────────────────────────────────────────────────────

describe("minutesSince", () => {
  it("UTIL-01 returns Infinity for null", () => {
    expect(minutesSince(null)).toBe(Infinity);
  });

  it("UTIL-02 returns Infinity for undefined", () => {
    expect(minutesSince(undefined)).toBe(Infinity);
  });

  it("UTIL-03 returns ~0 for current timestamp", () => {
    const now = new Date().toISOString();
    expect(minutesSince(now)).toBeLessThan(0.1);
  });

  it("UTIL-04 returns correct minutes for past timestamp", () => {
    const past = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(minutesSince(past)).toBeCloseTo(30, 0);
  });
});

// ─── extractText ─────────────────────────────────────────────────────────────

describe("extractText", () => {
  it("UTIL-05 extracts text from message.message.content", () => {
    const msg = { message: { content: [{ type: "text", text: "hello" }] } };
    expect(extractText(msg)).toBe("hello");
  });

  it("UTIL-06 extracts text from top-level content array", () => {
    const msg = { content: [{ type: "text", text: "world" }] };
    expect(extractText(msg)).toBe("world");
  });

  it("UTIL-07 concatenates multiple text blocks with newline", () => {
    const msg = { content: [
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]};
    expect(extractText(msg)).toBe("first\nsecond");
  });

  it("UTIL-08 ignores non-text blocks (tool_use, tool_result)", () => {
    const msg = { content: [
      { type: "tool_use", id: "x" },
      { type: "text", text: "only this" },
      { type: "tool_result", content: "y" },
    ]};
    expect(extractText(msg)).toBe("only this");
  });

  it("UTIL-09 returns empty string for missing content", () => {
    expect(extractText({})).toBe("");
  });

  it("UTIL-10 returns empty string for null message", () => {
    expect(extractText(null)).toBe("");
  });

  it("UTIL-11 returns empty string for non-array content", () => {
    const msg = { content: "raw string" };
    expect(extractText(msg)).toBe("");
  });

  it("UTIL-12 ignores text blocks where text is not a string", () => {
    const msg = { content: [{ type: "text", text: 42 }] };
    expect(extractText(msg)).toBe("");
  });
});

// ─── buildConversationText ────────────────────────────────────────────────────

describe("buildConversationText", () => {
  const makeMsg = (role, text) => ({ message: { role, content: [{ type: "text", text }] } });

  it("UTIL-13 builds text with role prefixes in chronological order", () => {
    const msgs = [makeMsg("user", "hello"), makeMsg("assistant", "world")];
    const { text } = buildConversationText(msgs);
    expect(text).toContain("[user]: hello");
    expect(text).toContain("[assistant]: world");
    expect(text.indexOf("[user]")).toBeLessThan(text.indexOf("[assistant]"));
  });

  it("UTIL-14 emits messages in chronological order", () => {
    const msgs = [
      makeMsg("user", "first"),
      makeMsg("assistant", "second"),
      makeMsg("user", "third"),
    ];
    const { text } = buildConversationText(msgs);
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("third"));
  });

  it("UTIL-15 uses 'unknown' role when role is missing", () => {
    const msg = { content: [{ type: "text", text: "no role" }] };
    const { text } = buildConversationText([msg]);
    expect(text).toContain("[unknown]: no role");
  });

  it("UTIL-16 truncated=false for short conversations", () => {
    const msgs = [makeMsg("user", "short")];
    const { truncated } = buildConversationText(msgs);
    expect(truncated).toBe(false);
  });

  it("UTIL-17 truncated=true when total chars exceed token limit", () => {
    const msgs = Array(20).fill(null).map(() => makeMsg("user", "x".repeat(2000)));
    const { truncated } = buildConversationText(msgs, 100); // 100 tokens = 400 chars max
    expect(truncated).toBe(true);
  });

  it("UTIL-18 truncated result text stays within char limit", () => {
    const msgs = Array(20).fill(null).map(() => makeMsg("user", "x".repeat(2000)));
    const { text } = buildConversationText(msgs, 100);
    expect(text.length).toBeLessThanOrEqual(600);
  });

  it("UTIL-19 skips messages with no text content", () => {
    const msgs = [
      { message: { role: "user", content: [{ type: "tool_use" }] } },
      makeMsg("assistant", "visible"),
    ];
    const { text } = buildConversationText(msgs);
    expect(text).not.toContain("[user]:");
    expect(text).toContain("[assistant]: visible");
  });

  it("UTIL-20 handles empty messages array", () => {
    const { text, truncated } = buildConversationText([]);
    expect(text).toBe("");
    expect(truncated).toBe(false);
  });
});

// ─── parseTranscript ─────────────────────────────────────────────────────────

describe("parseTranscript", () => {
  it("SP-15 returns empty array when file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(parseTranscript("/nonexistent.jsonl")).toEqual([]);
  });

  it("SP-12 parses valid JSONL lines into messages array", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"a":1}\n{"b":2}\n');
    const result = parseTranscript("/test.jsonl");
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("SP-13 skips malformed JSON lines without throwing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{"a":1}\nnot-json\n{"c":3}\n');
    const result = parseTranscript("/test.jsonl");
    expect(result).toEqual([{ a: 1 }, { c: 3 }]);
  });

  it("SP-14 returns empty array for empty file", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    expect(parseTranscript("/empty.jsonl")).toEqual([]);
  });

  it("SP-14b handles file with only blank lines", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("\n\n\n");
    expect(parseTranscript("/blank.jsonl")).toEqual([]);
  });
});

// ─── detectScope ─────────────────────────────────────────────────────────────

describe("detectScope", () => {
  it("SP-16 returns projects.<repo> from HTTPS git remote", () => {
    vi.mocked(child_process.execSync).mockReturnValue("https://github.com/user/my-project.git\n");
    expect(detectScope("personal")).toBe("projects.my_project");
  });

  it("SP-16a handles SSH remote URL", () => {
    vi.mocked(child_process.execSync).mockReturnValue("git@github.com:user/my-repo.git\n");
    expect(detectScope("personal")).toBe("projects.my_repo");
  });

  it("SP-19 slugifies repo name: hyphens become underscores", () => {
    vi.mocked(child_process.execSync).mockReturnValue("https://github.com/user/my-cool-project\n");
    expect(detectScope(null)).toBe("projects.my_cool_project");
  });

  it("SP-19a slugifies repo name: dots become underscores", () => {
    vi.mocked(child_process.execSync).mockReturnValue("https://github.com/user/repo.name\n");
    expect(detectScope(null)).toBe("projects.repo_name");
  });

  it("SP-17 falls back to configScope when git command fails", () => {
    vi.mocked(child_process.execSync).mockImplementation(() => { throw new Error("not a git repo"); });
    expect(detectScope("myproject")).toBe("myproject");
  });

  it("SP-18 falls back to 'personal' when git fails and configScope is null", () => {
    vi.mocked(child_process.execSync).mockImplementation(() => { throw new Error(); });
    expect(detectScope(null)).toBe("personal");
  });

  it("SP-18a falls back to 'personal' when git fails and configScope is empty string", () => {
    vi.mocked(child_process.execSync).mockImplementation(() => { throw new Error(); });
    expect(detectScope("")).toBe("personal");
  });
});
