#!/usr/bin/env node
// Claude Code Stop hook entry point.
// Exits in < 1ms — spawns stop-process.mjs as a detached background process.
import { spawn } from "child_process";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const data = JSON.parse(input || "{}");
const { session_id, transcript_path } = data;

if (!transcript_path) process.exit(0);

// Find autocapture config — check AUTOCAPTURE_CONFIG env, then common locations
if (!process.env.HOME && !process.env.AUTOCAPTURE_CONFIG) {
  process.stderr.write("[autocapture] HOME is unset and AUTOCAPTURE_CONFIG is not set — cannot locate config\n");
  process.exit(0);
}
const configPath = process.env.AUTOCAPTURE_CONFIG ||
  join(process.env.HOME, ".mybrain", "default", ".autocapture-config.json");

// Quick enabled check before spawning (saves process spawn overhead when disabled)
try {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  if (!cfg.enabled) process.exit(0);
} catch (_) {
  // Config missing — auto-capture not set up yet
  process.exit(0);
}

const child = spawn(
  process.execPath,
  [join(__dirname, "stop-process.mjs"), session_id || "", transcript_path, configPath],
  { detached: true, stdio: "ignore", env: process.env }
);
child.unref();

process.exit(0);
