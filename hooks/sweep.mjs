#!/usr/bin/env node
// Periodic sweep for idle/abandoned Claude Code sessions.
// Invoked by CronCreate on a configurable interval (default: 30 min).
// Finds session JSONL files that are idle and have unprocessed content,
// then triggers stop-process.mjs for each one — serially, cap at 5.
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

// ─── Sessions map ─────────────────────────────────────────────────────────────
// Derived from same directory as the autocapture config.

const sessPath = join(dirname(CONFIG_PATH), ".sessions.json");
let sessData = { sessions: {} };
try {
  sessData = JSON.parse(readFileSync(sessPath, "utf8"));
} catch (_) {}

// ─── Find Claude Code transcript directory ────────────────────────────────────

const claudeDir = join(homedir(), ".claude", "projects");

if (!existsSync(claudeDir)) {
  process.exit(0); // No Claude projects directory
}

const now = Date.now();
const idleThresholdMs = batch_threshold_minutes * 60 * 1000;

function findSessions(baseDir) {
  const sessions = [];
  try {
    for (const projectDir of readdirSync(baseDir)) {
      const projectPath = join(baseDir, projectDir);
      try { if (!statSync(projectPath).isDirectory()) continue; } catch (_) { continue; }
      try {
        for (const file of readdirSync(projectPath)) {
          if (!file.endsWith(".jsonl")) continue;
          const filePath = join(projectPath, file);
          try {
            const st = statSync(filePath);
            sessions.push({
              sessionId: file.replace(".jsonl", ""),
              filePath,
              mtimeMs: st.mtimeMs,
              ageMs: now - st.mtimeMs,
            });
          } catch (_) { /* unreadable file */ }
        }
      } catch (_) { /* unreadable directory */ }
    }
  } catch (_) { /* base dir unreadable */ }
  return sessions;
}

const allSessions = findSessions(claudeDir);

const sessionsToProcess = [];
for (const { sessionId, filePath, mtimeMs, ageMs } of allSessions) {
  // Only consider files that have been idle long enough for the stop hook to have fired its last time
  if (ageMs < idleThresholdMs) continue;

  const sess = sessData.sessions?.[sessionId];
  // Skip sessions already fully processed where nothing new has arrived
  if (sess?.status === "done" && mtimeMs <= (sess.last_mtime || 0)) continue;

  sessionsToProcess.push({ sessionId, filePath });
}

// Process serially (cap at 5) to avoid concurrent config/sessions writes and unbounded spawning.
const MAX_SESSIONS = 5;
for (const { sessionId, filePath } of sessionsToProcess.slice(0, MAX_SESSIONS)) {
  spawnSync(
    process.execPath,
    [join(__dirname, "stop-process.mjs"), sessionId, filePath, CONFIG_PATH],
    { stdio: "ignore", env: process.env }
  );
}
