# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MyBrain is a Claude Code plugin that exposes a personal knowledge base as an MCP server. It stores and retrieves thoughts using PostgreSQL + pgvector (semantic search) and ltree (scope isolation). It ships as a plugin with two skills (`/mybrain-setup`, `/mybrain-overview`) and is distributed via the Claude Code plugin marketplace.

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

**`server.mjs`** is the entire MCP server — no build step, single ES module file. It detects transport mode from `process.argv[2]` (`stdio` default, `http` explicit). Both modes call the same `registerTools(srv)` function which defines the four MCP tools.

**Tool → DB flow:**
1. `capture_thought` / `search_thoughts` — call `getEmbedding()` (OpenRouter HTTP) → write/query PostgreSQL
2. `browse_thoughts` / `brain_stats` — pure SQL, no embedding call

**`match_thoughts_scored` (PostgreSQL function)** implements the three-axis scoring formula:
```
combined_score = (3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)
```
Recency decay: `0.995 ^ hours_since_last_access`.

**Scoping:** Every thought carries an `ltree[]` scope column. When `BRAIN_SCOPE` is set, all queries add `scope @> ARRAY[$1]::ltree[]` — multiple users/projects share one database without cross-contamination.

**HTTP session management:** In HTTP mode, each MCP session gets a UUID stored in `httpSessions` Map. Requests with an unknown `mcp-session-id` header return 404; new POST requests without a session ID create a fresh `McpServer` instance.

## Plugin Structure

```
.claude-plugin/
  plugin.json        # declares skills
  marketplace.json   # marketplace listing
skills/
  mybrain-setup/     # /mybrain-setup wizard skill
  mybrain-overview/  # /mybrain-overview reference skill
templates/           # Docker deployment artifacts (schema.sql, Dockerfile, compose.yml)
server.mjs           # top-level server (stdio entry point)
```

`templates/server.mjs` mirrors the top-level `server.mjs` — it's the copy bundled into the Docker image. Keep them in sync when making server changes.
