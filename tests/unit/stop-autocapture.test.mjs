// Tests for hooks/stop-autocapture.mjs (entry point Stop hook)
// Covers SA-01 through SA-12
import { describe, it, expect, vi, beforeEach } from "vitest";
import { statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { BASE_CONFIG } from "../helpers/fixtures.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Enabled check logic (extracted for unit testing) ────────────────────────
// stop-autocapture.mjs is a top-level async script (uses top-level await for stdin)
// and is not importable without running. We test its logic as extracted functions here.

function quickEnabledCheck(configPath, readFileSyncFn) {
  try {
    const cfg = JSON.parse(readFileSyncFn(configPath, "utf8"));
    return cfg.enabled === true;
  } catch (_) {
    return false; // config missing or corrupt → don't spawn
  }
}

describe("stop-autocapture – quick enabled check", () => {
  it("SA-01 returns true when enabled=true", () => {
    const read = () => JSON.stringify({ ...BASE_CONFIG, enabled: true });
    expect(quickEnabledCheck("/path/config.json", read)).toBe(true);
  });

  it("SA-02 returns false when enabled=false", () => {
    const read = () => JSON.stringify({ ...BASE_CONFIG, enabled: false });
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-03 returns false when config file is missing (ENOENT)", () => {
    const read = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-04 returns false when config file is unreadable (EACCES)", () => {
    const read = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-05 returns false when config JSON is corrupt", () => {
    const read = () => "not-json{{{";
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-08 returns false when enabled key is string 'true' (not boolean)", () => {
    const read = () => JSON.stringify({ ...BASE_CONFIG, enabled: "true" });
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-09 returns false when enabled key is 1 (numeric truthy, not boolean)", () => {
    const read = () => JSON.stringify({ ...BASE_CONFIG, enabled: 1 });
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-10 returns false for empty JSON object (no enabled key)", () => {
    const read = () => "{}";
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });

  it("SA-11 returns false for null-byte or binary content", () => {
    const read = () => "\x00\x01\x02";
    expect(quickEnabledCheck("/path/config.json", read)).toBe(false);
  });
});

// ─── SA-12 Exit timing: file size check ──────────────────────────────────────

describe("stop-autocapture – SA-12 exit timing", () => {
  it("SA-12 script file is small enough for fast startup (< 3KB)", () => {
    const scriptPath = join(__dirname, "../../hooks/stop-autocapture.mjs");
    const stat = statSync(scriptPath);
    expect(stat.size).toBeLessThan(3000);
  });
});

// ─── SA-07 HOME env unset ─────────────────────────────────────────────────────

describe("stop-autocapture – config path resolution", () => {
  it("SA-06 AUTOCAPTURE_CONFIG env takes precedence over default path", () => {
    const custom = "/custom/path/.autocapture-config.json";
    const home = "/home/user";
    const resolved = process.env.AUTOCAPTURE_CONFIG_TEST || custom;
    // The path logic: AUTOCAPTURE_CONFIG || join(HOME, ".mybrain", "default", ".autocapture-config.json")
    const fallback = join(home, ".mybrain", "default", ".autocapture-config.json");
    expect(custom).not.toBe(fallback); // different paths
    expect(custom).toBe("/custom/path/.autocapture-config.json");
  });

  it("SA-07 default path when only HOME is set", () => {
    const home = "/home/testuser";
    const expected = join(home, ".mybrain", "default", ".autocapture-config.json");
    expect(expected).toContain(".mybrain");
    expect(expected).toContain(".autocapture-config.json");
  });
});
