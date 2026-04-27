# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MyBrain is a Claude Code plugin that exposes a personal knowledge base as an MCP server. It stores and retrieves thoughts using PostgreSQL + pgvector (semantic search) and ltree (scope isolation). It ships as a plugin with skills (`/mybrain-setup`, `/mybrain-overview`, `/mybrain-autocapture-status`, `/mybrain-autocapture-on`, `/mybrain-autocapture-off`) and is distributed via the Claude Code plugin marketplace.

## Running the Server

```bash
npm install
npm start                    # stdio mode (default, used by Claude Code)
node server.mjs http         # HTTP mode (used by Docker deployment)
```

**Required env vars:**
- `DATABASE_URL` — PostgreSQL connection string
- `OPENROUTER_API_KEY` — used for embeddings (`text-embedding-3-small` via OpenRouter)
- `BRAIN_SCOPE` — ltree scope label (e.g. `personal`); optional in single-user setups, required for shared RDS
- `AUTOCAPTURE_CONFIG` — (optional) path to `~/.mybrain/<name>/.autocapture-config.json`; enables token usage and status in `brain_stats`

## Docker Mode

All Docker artifacts live in `templates/`. The `compose.yml` there runs two services: `mybrain_postgres` (pgvector/pg16, port 5433) and `mybrain_mcp` (HTTP mode, port 8787).

```bash
cd templates
OPENROUTER_API_KEY=sk-or-... docker compose up -d   # or: podman compose / nerdctl compose
```

The schema is auto-applied on first run via the `docker-entrypoint-initdb.d` mount. To reset: `docker compose down -v && docker compose up -d` (substitute your compose command).

## Registering with Claude Code (stdio / RDS mode)

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://..." \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e BRAIN_SCOPE="personal" \
  -- node /absolute/path/to/mybrain/server.mjs
```

Apply schema manually if the database is fresh:
```bash
psql "$DATABASE_URL" -f templates/schema.sql
```

## Architecture

**`server.mjs`** is the entire MCP server — no build step, single ES module file. It detects transport mode from `MCP_TRANSPORT` env var, then `process.argv[2]`, defaulting to `stdio`. Both modes call the same `registerTools(srv)` function which defines the four MCP tools.

**Tool → DB flow** (canonical tool descriptions in `README.md` → "What You Get"):
1. `capture_thought` / `search_thoughts` — call `getEmbedding()` (OpenRouter HTTP) → write/query PostgreSQL
2. `browse_thoughts` / `brain_stats` — pure SQL, no embedding call

**`capture_thought` optional params** (all backward-compatible — existing callers unaffected):
- `thought_type` — one of: `decision`, `preference`, `lesson`, `rejection`, `drift`, `correction`, `insight`, `reflection`, `fact` (default: `insight`)
- `importance` — float 0-1 (default: `0.5`)
- Default `source_agent` changed from `'robert'` → `'claude'`; `source_phase` remains `'build'` for manual captures

**`brain_stats` extended output:** includes token usage (from `token_usage` table), auto-captured vs. manual counts, auto-capture enabled/disabled status (requires `AUTOCAPTURE_CONFIG` env var), and truncation warnings.

**`match_thoughts_scored` (PostgreSQL function)** implements the three-axis scoring formula (canonical definition in `templates/schema.sql`):
```
combined_score = (3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)
```
Recency decay: `0.995 ^ hours_since_last_access`.

**Scoping:** Every thought carries an `ltree[]` scope column. When `BRAIN_SCOPE` is set, all queries add `scope @> ARRAY[$1]::ltree[]` — multiple users/projects share one database without cross-contamination.

**HTTP session management:** In HTTP mode, each MCP session gets a UUID stored in `httpSessions` Map. Requests with an unknown `mcp-session-id` header return 404; new POST requests without a session ID create a fresh `McpServer` instance.

## Plugin Structure

```
.claude-plugin/
  plugin.json              # declares skills
  marketplace.json         # marketplace listing
skills/
  mybrain-setup/           # /mybrain-setup wizard skill
  mybrain-overview/        # /mybrain-overview reference skill
  mybrain-autocapture-status/ # /mybrain-autocapture-status — show auto-capture status + token usage
  mybrain-autocapture-on/          # /mybrain-autocapture-on — enable background capture
  mybrain-autocapture-off/         # /mybrain-autocapture-off — disable background capture
hooks/
  stop-autocapture.mjs     # Claude Code Stop hook entry point (exits < 1ms)
  stop-process.mjs         # Detached background worker for batch analysis
  sweep.mjs                # Periodic sweep for idle/abandoned sessions (CronCreate)
templates/                 # Docker deployment artifacts (schema.sql, Dockerfile, compose.yml)
server.mjs                 # top-level server (stdio entry point)
```

`templates/server.mjs` mirrors the top-level `server.mjs` — it's the copy bundled into the Docker image. Keep them in sync when making server changes.

## Auto-Capture Architecture

Two-layer system set up by `/mybrain-setup`:

**Layer 1 — Proactive**: A CLAUDE.md instruction added to `~/.claude/CLAUDE.md` that tells Claude to call `capture_thought` at the moment of insight (decisions, rejections, preferences, lessons, facts, reflections). No extra LLM call — Claude itself decides what to capture.

**Layer 2 — Reactive**: A Claude Code Stop hook (`hooks/stop-autocapture.mjs`) that fires after each response, exits in < 1ms, and spawns `hooks/stop-process.mjs` as a detached background process. The background process:
1. Checks if the message count or idle time threshold is met
2. Builds conversation text from new messages (incremental cursor tracking)
3. Calls `meta-llama/llama-3.1-8b-instruct:free` via OpenRouter to extract insights
4. Deduplicates against existing thoughts (same embedding, cosine similarity > 0.8)
5. Inserts captured thoughts with `source_agent='claude'`, `source_phase='reconciliation'`
6. Logs to `token_usage` and `autocapture_warnings` tables

A periodic sweep (`hooks/sweep.mjs`, invoked via CronCreate) handles idle/abandoned threads.

**Config**: `~/.mybrain/<name>/.autocapture-config.json` (chmod 600) — stores DB credentials, API key, thresholds, and the incremental cursor.

**Scoping**: Auto-captured thoughts use the current git repo name as scope (`projects.<slug>`), falling back to the configured `brain_scope` or `personal`. One database, no new MCP instances per project.

**New DB tables**: `token_usage` (tracks extraction token counts per session) and `autocapture_warnings` (truncation events). New enum values: `thought_type='fact'`, `source_agent='claude'`.

**Migration for existing databases**: see `README.md` → "Migrating an existing database" for the canonical SQL commands.
