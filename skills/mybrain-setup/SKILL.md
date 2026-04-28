---
name: mybrain-setup
description: Use when users want to install or set up MyBrain -- a personal knowledge base with semantic search. Supports two modes -- Docker (local, self-contained) or RDS (shared remote database with ltree scoping). Guides through database setup, MCP server installation, and Claude Code configuration.
---

# MyBrain -- Setup

This skill installs MyBrain. It supports two deployment modes:

- **Docker** -- local PostgreSQL + pgvector in containers. Self-contained, no external dependencies.
- **RDS** -- connect to a shared PostgreSQL database on AWS RDS. Supports ltree scoping to isolate thoughts per user/project.

## Step 1: Choose Deployment Mode

Ask the user: **"Do you want to run MyBrain locally with Docker, or connect to a remote PostgreSQL database (e.g. AWS RDS)?"**

- If Docker: follow the **Docker Path** below
- If RDS: follow the **RDS Path** below

---

## Docker Path

### D1: Prerequisites

**Detect the container manager.** Run these checks in order and use the first one that succeeds:

1. `podman compose version` → use `podman compose`
2. `docker compose version` → use `docker compose`
3. `nerdctl compose version` → use `nerdctl compose`
4. `podman --version` → use `podman compose` (may need `podman-compose` installed separately)
5. `docker --version` → use `docker compose` (may need Compose plugin installed separately)

If none are found, tell the user no supported container manager was detected and offer two options:
- Install Podman: `brew install podman` (macOS) / see https://podman.io/getting-started/installation
- Switch to RDS mode, which needs only Node.js (no containers)

Store the detected compose command (e.g. `podman compose`) and use it for all subsequent steps.

Also verify Node.js v18+ is installed (`node --version`). If missing: `brew install node`.

### D2: Get OpenRouter API Key

Ask the user for their **OpenRouter API key**. If they don't have one:
- Sign up at https://openrouter.ai
- Go to https://openrouter.ai/keys
- Create a key and add a few dollars in credits
- The embedding model (`text-embedding-3-small`) costs fractions of a cent per call

### D3: Choose a Brain Name

Ask what to name this brain instance. Default: `default`. The name determines:
- Subdirectory: `.mybrain/<name>/`
- MCP server name: `mybrain` (default) or `mybrain-<name>`
- Container names: `mybrain_<name>_postgres`, `mybrain_<name>_mcp`

If `.mybrain/` already exists, show existing brains and help pick a non-conflicting name.

### D4: Assign Ports

Each brain needs two ports:
- `default`: MCP 8787, PostgreSQL 5433
- Additional brains: increment (8788/5434, 8789/5435, ...)

Check existing `.mybrain/*/compose.yml` for port conflicts.

### D5: Scaffold Files

**Show the user what you're about to create and ask for confirmation.**

Copy all files from the plugin's `templates/` directory into `.mybrain/<name>/`:

```
.mybrain/<name>/
  compose.yml       # PostgreSQL + MCP server
  .env              # OpenRouter API key + optional BRAIN_SCOPE
  schema.sql        # Full schema with ltree, scored search
  Dockerfile        # Container build
  package.json      # Dependencies
  server.mjs        # MCP server (ltree-aware)
```

**compose.yml** -- use this template (replace `<name>`, `<mcp-port>`, `<pg-port>`):

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    container_name: mybrain_<name>_postgres
    environment:
      POSTGRES_DB: mybrain
      POSTGRES_USER: mybrain
      POSTGRES_PASSWORD: mybrain
    ports:
      - "<pg-port>:5432"
    volumes:
      - mybrain_<name>_data:/var/lib/postgresql/data
      - ./schema.sql:/docker-entrypoint-initdb.d/schema.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mybrain"]
      interval: 5s
      timeout: 5s
      retries: 5

  mcp:
    build: .
    container_name: mybrain_<name>_mcp
    environment:
      MCP_TRANSPORT: http
      PORT: "8787"
      DATABASE_URL: postgresql://mybrain:mybrain@postgres:5432/mybrain
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY}
      BRAIN_SCOPE: ${BRAIN_SCOPE:-}
    ports:
      - "<mcp-port>:8787"
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8787/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  mybrain_<name>_data:
```

**.env**:
```env
OPENROUTER_API_KEY=<user's key>
# BRAIN_SCOPE=personal
```

Add `.mybrain/*/.env` to the project's `.gitignore` if not already there.

### D6: Update .mcp.json

Add the brain to `.mcp.json` in the project root (create if needed):

For `default`:
```json
{ "mcpServers": { "mybrain": { "type": "http", "url": "http://localhost:8787/mcp" } } }
```

For named brains (e.g. `research`):
```json
{ "mcpServers": { "mybrain-research": { "type": "http", "url": "http://localhost:8788/mcp" } } }
```

Merge with existing entries -- do not overwrite other MCP servers.

### D7: Start and Verify

Use the compose command you detected and stored in D1 (e.g. `podman compose`, `docker compose`, or `nerdctl compose`):

```bash
cd .mybrain/<name> && <compose-cmd> up -d
<compose-cmd> ps  # wait for healthy
```

Restart Claude Code. Test: "How many thoughts do I have?"

### D8: Enable Auto-Capture

Ask the user: **"Would you like to enable auto-capture? It automatically extracts decisions, insights, and lessons from your Claude Code sessions in the background at $0 cost. (yes/no, default: yes)"**

- If yes (or Enter): follow the **Auto-Capture Setup** steps at the bottom of this file.
- If no: skip to the Summary Template. Auto-capture can be enabled later with `/mybrain-autocapture-on`.

---

## RDS Path

### R1: Gather Connection Details

Ask the user for:

1. **RDS host** -- e.g. `my-brain.abc123.us-east-2.rds.amazonaws.com`
2. **Database name** -- e.g. `projects_brain`
3. **Username** -- e.g. `myuser`
4. **Password** -- the database password
5. **SSL mode** -- default: `?ssl=true&sslmode=no-verify`
6. **Scope** -- what ltree scope to use for this brain (e.g. `personal`, `myproject.app`). This isolates thoughts from other users/projects sharing the same database.
7. **OpenRouter API key** -- same as Docker path

### R2: Construct DATABASE_URL

Build the connection string:
```
postgresql://<user>:<password>@<host>:5432/<database>?ssl=true&sslmode=no-verify
```

### R3: Register MCP Server

Run:

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="<constructed URL>" \
  -e OPENROUTER_API_KEY="<key>" \
  -e BRAIN_SCOPE="<scope>" \
  -- node <path-to-plugin>/server.mjs
```

The path to `server.mjs` depends on how the plugin was installed:
- Plugin marketplace: `${CLAUDE_PLUGIN_ROOT}/server.mjs` (automatic)
- Manual clone: wherever they cloned the repo

### R4: Verify Schema

The RDS database must already have the full schema (with ltree, `match_thoughts_scored()`, etc.). If the user is setting up a fresh database, run `templates/schema.sql` against it:

```bash
psql "<DATABASE_URL>" -f templates/schema.sql
```

### R5: Test

Restart Claude Code. Test: "How many thoughts do I have?" -- should call `brain_stats` and return a count scoped to the user's ltree scope.

### R6: Enable Auto-Capture

Ask the user: **"Would you like to enable auto-capture? It automatically extracts decisions, insights, and lessons from your Claude Code sessions in the background at $0 cost. (yes/no, default: yes)"**

- If yes (or Enter): follow the **Auto-Capture Setup** steps at the bottom of this file.
- If no: skip to the Summary Template. Auto-capture can be enabled later with `/mybrain-autocapture-on`.

---

## Summary Template

After either path completes:

```
MyBrain installed successfully.

Mode:       {{Docker | RDS}}
{{if Docker}}
Location:   .mybrain/<name>/
Database:   PostgreSQL + pgvector (containerized, port <pg-port>)
MCP:        http://localhost:<mcp-port>/mcp
{{/if}}
{{if RDS}}
Database:   <host>/<database>
Scope:      <scope>
MCP:        stdio (Claude Code CLI)
{{/if}}

Tools:
  capture_thought   -- Save a thought (uses OpenRouter)
  search_thoughts   -- Semantic search (uses OpenRouter)
  browse_thoughts   -- List recent thoughts (free)
  brain_stats       -- Statistics (free)

Auto-capture: {{ENABLED | DISABLED (run /mybrain-autocapture-on to enable)}}

Try: "Remember this: I just set up MyBrain"
```

---

## Auto-Capture Setup

This section is shared by both Docker (D8) and RDS (R6) paths. Run after the brain is verified working.

### AC1: Write the autocapture config file

Determine the plugin root path (where `server.mjs` lives). For marketplace installs this is `${CLAUDE_PLUGIN_ROOT}`; for manual clones it's wherever the user cloned the repo.

Create `~/.mybrain/<name>/.autocapture-config.json` with these contents:

```json
{
  "enabled": true,
  "database_url": "<same DATABASE_URL used for the brain>",
  "openrouter_api_key": "<OPENROUTER_API_KEY>",
  "brain_scope": "<scope or null>",
  "extraction_model": "openai/gpt-oss-120b:free",
  "batch_threshold_messages": 15,
  "batch_threshold_minutes": 20,
  "sweep_interval_minutes": 30,
  "prune_after_days": 30
}
```

Secure the file immediately:

```bash
chmod 600 ~/.mybrain/<name>/.autocapture-config.json
```

### AC2: Register the Stop hook

Read `~/.claude/settings.json` (create if missing as `{}`). Add the Stop hook under `"hooks"`, merging with any existing hook configuration:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "AUTOCAPTURE_CONFIG=~/.mybrain/<name>/.autocapture-config.json node <plugin-root>/hooks/stop-autocapture.mjs",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Use `~` expansion for the home directory. If a Stop hook array already exists, append to it rather than replacing. Do not remove existing hooks.

Also set `AUTOCAPTURE_CONFIG` as an env var on the MCP server registration (in `.mcp.json` for Docker, or via `claude mcp add -e` for RDS) so `brain_stats` can read the enabled/disabled status.

### AC3: Register the periodic sweep cron

Add an entry to the system crontab so the sweep runs locally, survives reboots, and works without Claude being open. Use `$HOME` (not `~`) because crontab does not expand tilde:

```bash
(crontab -l 2>/dev/null; echo "*/<sweep_interval_minutes> * * * * AUTOCAPTURE_CONFIG=$HOME/.mybrain/<name>/.autocapture-config.json node <plugin-root>/hooks/sweep.mjs >> $HOME/.mybrain/<name>/sweep.log 2>&1") | crontab -
```

Replace `<sweep_interval_minutes>` with the value from the config (default: `30`), `<name>` with the brain name, and `<plugin-root>` with the absolute path to the plugin root (where `server.mjs` lives).

Verify with `crontab -l` — the new entry should appear at the bottom.

### AC4: Add the proactive instruction to global CLAUDE.md

Check if `~/.claude/CLAUDE.md` already contains the mybrain auto-capture instruction block (search for `"mybrain:capture_thought proactively"` marker). If not present, read the canonical block from `<plugin-root>/templates/proactive-instruction.md` and append its full contents to `~/.claude/CLAUDE.md`.

### AC5: Write the external prompt snippet

Create `~/.mybrain/<name>/external-prompt.md`:

```markdown
# MyBrain — External Tools System Prompt

Paste this into the system prompt for Claude.ai Projects, Codex, or any other AI tool
that has access to mybrain's HTTP endpoint.

---
You have access to mybrain tools for personal knowledge management:
- capture_thought: Save important information (decisions, lessons, preferences, insights, facts)
- search_thoughts: Search your knowledge base with natural language
- browse_thoughts: Browse recent entries
- brain_stats: See storage statistics

Proactively use capture_thought when you identify:
- Decisions and their reasoning
- Rejected alternatives (what was considered and why it was declined)
- Preferences and personal choices
- Non-obvious lessons and patterns
- Persistent personal facts (subscriptions, reference information, key contacts)
- Reflections and personal insights
```

### AC6: Run database migration (existing databases only)

If this brain was set up before auto-capture was introduced, run these migration statements:

```sql
ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'fact';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'claude';
```

Then create the new tables (run the CREATE TABLE IF NOT EXISTS statements from schema.sql).

### AC7: Confirm

Print:

```
Auto-capture configured successfully.

  Config:   ~/.mybrain/<name>/.autocapture-config.json
  Model:    llama-3.1-8b-instruct:free (free tier — $0 extraction cost)
  Triggers: 15 new messages OR 20 min idle (configurable)
  Sweep:    Every 30 min (catches idle/abandoned sessions)

Layer 1 (proactive): Claude will capture insights mid-session autonomously.
Layer 2 (background): Batch analysis runs after threshold is met.

Run /mybrain-autocapture-status to monitor. Run /mybrain-autocapture-off to pause background capture.
```

---

## Important Notes

- **Do NOT use `z.record(z.any())` in zod schemas.** Use `z.record(z.string(), z.unknown())`. The MCP SDK crashes on `z.any()` from zod v4.
- **`onsessioninitialized` is a constructor option**, not a property.
- **Credentials must never be committed.** Ensure `.env` and connection strings with passwords are in `.gitignore`.
- **OpenRouter credits** are needed for capture and search. Browse and stats are pure SQL (free).
- **ltree scoping** -- when `BRAIN_SCOPE` is set, all queries filter by `scope @> ARRAY['<scope>']::ltree[]`. This lets multiple users/projects share one database without seeing each other's thoughts.
