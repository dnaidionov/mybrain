#!/usr/bin/env node
// Periodic sweep for idle/abandoned Claude Code sessions.
// Invoked by CronCreate on a configurable interval (default: 30 min).
// Finds session JSONL files with unprocessed content that haven't grown in N minutes,
// and triggers stop-process.mjs for each one.
import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { spawnSync } from "child_process";
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

// Check which sessions have unprocessed content.
// Note: the config cursor tracks only the last session — older sessions restart from 0,
// but dedup in stop-process.mjs prevents duplicate insertions.
const { last_session_id, last_processed_index = 0 } = cfg;

const sessionsToProcess = [];
for (const { sessionId, filePath } of idleSessions) {
  try {
    const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const cursor = sessionId === last_session_id ? last_processed_index : 0;
    if (lines.length > cursor) sessionsToProcess.push({ sessionId, filePath });
  } catch (_) { /* skip unreadable sessions */ }
}

// Process serially (cap at 5) to avoid concurrent config writes and unbounded spawning.
const MAX_SESSIONS = 5;
for (const { sessionId, filePath } of sessionsToProcess.slice(0, MAX_SESSIONS)) {
  spawnSync(
    process.execPath,
    [join(__dirname, "stop-process.mjs"), sessionId, filePath, CONFIG_PATH],
    { stdio: "ignore", env: process.env }
  );
}
