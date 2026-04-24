#!/usr/bin/env node
// Periodic sweep for idle/abandoned Claude Code sessions.
// Invoked by CronCreate on a configurable interval (default: 30 min).
// Finds session JSONL files with unprocessed content that haven't grown in N minutes,
// and triggers stop-process.mjs for each one.
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_PATH = process.env.AUTOCAPTURE_CONFIG ||
  join(homedir(), ".mybrain", "default", ".autocapture-config.json");

let cfg;
try {
  cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (_) {
  process.exit(0); // No config
}

if (!cfg.enabled) process.exit(0);

const { batch_threshold_minutes = 20 } = cfg;

// ─── Find Claude Code transcript directory ────────────────────────────────────
// Claude Code stores session transcripts in:
//   ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// The transcript_path in Stop hook stdin points to the exact file.
// For sweep purposes, we scan all project directories.

const claudeDir = join(homedir(), ".claude", "projects");

if (!existsSync(claudeDir)) {
  process.exit(0); // No Claude projects directory
}

const now = Date.now();
const idleThresholdMs = batch_threshold_minutes * 60 * 1000;

function findIdleSessions(baseDir) {
  const sessions = [];
  try {
    for (const projectDir of readdirSync(baseDir)) {
      const projectPath = join(baseDir, projectDir);
      if (!statSync(projectPath).isDirectory()) continue;
      for (const file of readdirSync(projectPath)) {
        if (!file.endsWith(".jsonl")) continue;
        const filePath = join(projectPath, file);
        const stat = statSync(filePath);
        const ageMs = now - stat.mtimeMs;
        if (ageMs >= idleThresholdMs) {
          // Extract session ID from filename (UUID before .jsonl)
          const sessionId = file.replace(".jsonl", "");
          sessions.push({ sessionId, filePath, ageMs });
        }
      }
    }
  } catch (_) { /* permission errors etc */ }
  return sessions;
}

const idleSessions = findIdleSessions(claudeDir);

// Check which sessions have unprocessed content
const { last_session_id, last_processed_index = 0 } = cfg;

for (const { sessionId, filePath } of idleSessions) {
  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const cursor = sessionId === last_session_id ? last_processed_index : 0;
    if (lines.length <= cursor) continue; // No new content

    // Trigger background processing
    const child = spawn(
      process.execPath,
      [join(__dirname, "stop-process.mjs"), sessionId, filePath, CONFIG_PATH],
      { detached: true, stdio: "ignore", env: process.env }
    );
    child.unref();
  } catch (_) { /* skip unreadable sessions */ }
}
