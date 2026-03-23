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

Verify these are installed. If any are missing, give the install command and wait for confirmation.

| Dependency | Check | Install (macOS) |
|------------|-------|-----------------|
| Podman or Docker | `podman --version` or `docker --version` | `brew install podman` |
| Node.js (v18+) | `node --version` | `brew install node` |

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
{ "mcpServers": { "mybrain": { "url": "http://localhost:8787/mcp" } } }
```

For named brains (e.g. `research`):
```json
{ "mcpServers": { "mybrain-research": { "url": "http://localhost:8788/mcp" } } }
```

Merge with existing entries -- do not overwrite other MCP servers.

### D7: Start and Verify

```bash
cd .mybrain/<name> && podman compose up -d
podman compose ps  # wait for healthy
```

Restart Claude Code. Test: "How many thoughts do I have?"

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

Try: "Remember this: I just set up MyBrain"
```

## Important Notes

- **Do NOT use `z.record(z.any())` in zod schemas.** Use `z.record(z.string(), z.unknown())`. The MCP SDK crashes on `z.any()` from zod v4.
- **`onsessioninitialized` is a constructor option**, not a property.
- **Credentials must never be committed.** Ensure `.env` and connection strings with passwords are in `.gitignore`.
- **OpenRouter credits** are needed for capture and search. Browse and stats are pure SQL (free).
- **ltree scoping** -- when `BRAIN_SCOPE` is set, all queries filter by `scope @> ARRAY['<scope>']::ltree[]`. This lets multiple users/projects share one database without seeing each other's thoughts.
