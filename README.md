# MyBrain

**A personal knowledge base with semantic search, delivered as a Claude Code plugin.**

Capture thoughts, ideas, notes, and decisions as you work. Ask Claude about them later in plain English -- MyBrain finds matches by meaning, not just keywords. Everything is stored in your own PostgreSQL database with pgvector embeddings.

Works with **Claude Code** (CLI, Desktop, and Web) over MCP.

---

## What You Get

Four MCP tools Claude can call on your behalf:

| Tool | What it does | Cost |
|---|---|---|
| `capture_thought` | Save a thought with optional metadata | ~$0.0001 (embedding) |
| `search_thoughts` | Semantic search with three-axis scoring | ~$0.0001 (embedding) |
| `browse_thoughts` | List recent thoughts, filter by metadata | Free (pure SQL) |
| `brain_stats` | Total count, date range, top metadata keys | Free (pure SQL) |

Two skills that ship with the plugin:

- **`/mybrain-setup`** -- interactive setup wizard (Docker or RDS)
- **`/mybrain-overview`** -- explains architecture, tools, and usage

---

## Install in Claude Code (Recommended)

This is the fastest path. The plugin marketplace installs the MCP server, skills, and templates for you.

### 1. Add the marketplace and install the plugin

```bash
claude plugin marketplace add robertsfeir/mybrain
claude plugin install mybrain@mybrain
```

### 2. Run the setup wizard

Inside any Claude Code session, run:

```
/mybrain-setup
```

Claude will ask whether you want:

- **Docker mode** -- local, self-contained. Runs PostgreSQL + pgvector + the MCP server in containers. Best if you're not sure which to pick.
- **RDS mode** -- connect to a shared PostgreSQL on AWS RDS (or any remote Postgres with `pgvector` and `ltree` extensions). Best for multi-project / multi-user setups.

The wizard handles the rest: scaffolding files, wiring `.mcp.json`, starting containers (Docker) or registering the MCP server (RDS), and verifying everything works.

### 3. Get an OpenRouter API key

You'll need one for embeddings. It's the only external dependency.

1. Sign up at <https://openrouter.ai>
2. Create a key at <https://openrouter.ai/keys>
3. Load a few dollars of credits. The embedding model (`text-embedding-3-small`) costs fractions of a cent per call -- $5 of credits goes a very long way.

### 4. Restart Claude Code and try it

```
Remember this: I just set up MyBrain.
How many thoughts do I have?
```

If Claude responds with a thought count, you're done.

---

## Install Manually (Clone and Register)

Use this path if you don't want to go through the marketplace, or you need to customize the server.

```bash
git clone https://github.com/robertsfeir/mybrain.git
cd mybrain
npm install
```

Then register the MCP server with Claude Code:

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://user:password@host:5432/mybrain?ssl=true&sslmode=no-verify" \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e BRAIN_SCOPE="personal" \
  -- node /absolute/path/to/mybrain/server.mjs
```

If you're setting up a fresh database, apply the schema:

```bash
psql "$DATABASE_URL" -f templates/schema.sql
```

---

## Deployment Modes

### Docker mode

```
Claude Code --HTTP--> mybrain_mcp (:8787) --> mybrain_postgres
                                          --> OpenRouter (embeddings)
```

- PostgreSQL + pgvector in containers
- MCP server runs in a container, exposed on `http://localhost:8787/mcp`
- `BRAIN_SCOPE` is optional (single-user, single database)
- You can run multiple named brains side-by-side on different ports

### RDS mode

```
Claude Code --stdio--> server.mjs --> AWS RDS (your database)
                                  --> OpenRouter (embeddings)
```

- Connects to an existing Postgres with `pgvector` and `ltree` extensions
- `BRAIN_SCOPE` is required -- isolates your thoughts from others on the same database
- Good for teams or users syncing a brain across multiple machines

---

## How Semantic Search Works

When you capture a thought, the text is sent to OpenRouter (`text-embedding-3-small`) and returned as a 1536-dimensional vector. That vector is stored next to your text in PostgreSQL with an HNSW index.

When you search, your query is embedded the same way and scored with the **three-axis formula**:

```
score = (3.0 × cosine_similarity) + (2.0 × importance) + (0.5 × recency_decay)
```

Results come back sorted by combined score, so recent *and* important *and* relevant thoughts rise to the top.

### ltree scoping

Every thought carries an `ltree[]` scope (e.g. `personal`, `work.acme.app`). When `BRAIN_SCOPE` is set, every query is filtered to that scope -- multiple users or projects can share one database without leaking thoughts to each other.

---

## Requirements

**Docker mode:**
- Podman or Docker
- Node.js 18+ (only if you install manually)

**RDS mode:**
- Node.js 18+
- PostgreSQL with `pgvector` and `ltree` extensions
- OpenRouter API key (<https://openrouter.ai>)

---

## Usage Examples

Once installed, talk to Claude naturally:

- `Remember this: Sarah said she wants to start a consulting business next quarter.`
- `What do I know about Sarah?`
- `Show me my recent thoughts.`
- `Search my brain for anything about deployment pipelines.`
- `How many thoughts do I have?`
- `Capture thought: pg_dump with --data-only skips schema changes.`

Claude will pick the right tool (`capture_thought`, `search_thoughts`, `browse_thoughts`, `brain_stats`) automatically.

---

## Repository Layout

```
.claude-plugin/
  plugin.json              Plugin manifest (declares skills)
  marketplace.json         Marketplace definition
.mcp.json                  MCP server config (stdio, plugin-root path)
skills/
  mybrain-setup/SKILL.md   Interactive setup wizard
  mybrain-overview/SKILL.md Architecture + tool reference
templates/
  server.mjs               MCP server (dual mode: stdio + HTTP)
  package.json             Node dependencies
  schema.sql               Full schema (ltree, match_thoughts_scored, HNSW)
  Dockerfile               Container image
  compose.yml              PostgreSQL + MCP server services
  .env.example             Environment template
server.mjs                 Top-level server (used by stdio registration)
```

---

## Troubleshooting

**"No thoughts found" on every search.**
The schema may not be loaded. In Docker mode, run `podman compose down -v && podman compose up -d` in your `.mybrain/<name>/` directory to rebuild the volume with the schema. In RDS mode, re-run `psql "$DATABASE_URL" -f templates/schema.sql`.

**`Embedding API error: 401`.**
Your `OPENROUTER_API_KEY` is missing or invalid. Check it's set in `.env` (Docker mode) or the `claude mcp add` command (RDS mode).

**Claude doesn't see the tools.**
Restart Claude Code after installing. In Docker mode, check the container is running and healthy: `podman compose ps` inside `.mybrain/<name>/`.

**`capture_thought` succeeds but `search_thoughts` returns nothing.**
Lower the similarity threshold: `Search my brain for X with threshold 0.2`. The default is conservative.

**Port conflicts in Docker mode.**
Each brain instance uses two ports (default: MCP 8787, Postgres 5433). Run `/mybrain-setup` again with a different brain name to pick new ports.

---

## License

MIT
