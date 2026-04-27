# MyBrain

**A personal knowledge base with semantic search, delivered as a Claude Code plugin.**

Capture thoughts, ideas, notes, and decisions as you work. Ask Claude about them later in plain English -- MyBrain finds matches by meaning, not just keywords. Everything is stored in your own PostgreSQL database with pgvector embeddings.

Works with **Claude Code** (CLI, Desktop, and Web) over MCP.

---

## What You Get

### MCP Tools

Four tools Claude can call on your behalf:

| Tool | What it does | Cost |
|---|---|---|
| `capture_thought` | Save a thought with optional type, importance, and metadata | ~$0.000004 (embedding) |
| `search_thoughts` | Semantic search with three-axis scoring | ~$0.000004 (embedding) |
| `browse_thoughts` | List recent thoughts, filter by metadata | Free (pure SQL) |
| `brain_stats` | Count, date range, token usage, auto-capture status | Free (pure SQL) |

`capture_thought` accepts optional parameters:
- `thought_type` — `decision`, `preference`, `lesson`, `rejection`, `drift`, `correction`, `insight`, `reflection`, `fact` (default: `insight`)
- `importance` — float 0–1 (default: `0.5`)
- `metadata` — arbitrary key/value tags

### Skills

Five skills ship with the plugin:

| Skill | What it does |
|---|---|
| `/mybrain-setup` | Interactive setup wizard (Docker or RDS) + auto-capture configuration |
| `/mybrain-overview` | Architecture, tools, and usage reference |
| `/mybrain-autocapture-status` | Show auto-capture state, thresholds, token usage, and warnings |
| `/mybrain-autocapture-on` | Enable background auto-capture |
| `/mybrain-autocapture-off` | Disable background auto-capture |

---

## Auto-Capture

MyBrain can automatically capture important information from your Claude Code sessions without manual `capture_thought` calls.

**Two layers, optionally configured by `/mybrain-setup` (enabled by default when asked):**

**Layer 1 — Proactive**: An instruction added to `~/.claude/CLAUDE.md` tells Claude to call `capture_thought` at the moment of insight — when it identifies a decision, rejection, preference, lesson, discovery, or personal fact. No extra LLM call, no extra cost.

**Layer 2 — Reactive (background)**: A Claude Code Stop hook spawns a detached background worker after each response. The worker reads the session transcript, checks whether a batch threshold has been met (default: 15 new messages or 20 min idle), and if so, sends the new content to an extraction model on OpenRouter to extract insights. **Total additional cost: $0.**

The default extraction model is `openai/gpt-oss-120b:free` — chosen for its combination of being free, capable at structured extraction, and having good context length. It can be swapped for any OpenRouter model by changing `extraction_model` in the config — free or paid. Some alternatives:

| Model | Cost |
|---|---|
| `google/gemini-3.1-flash-lite-preview` | Free |
| `nvidia/nemotron-3-super-120b-a12b:free` | Free |
| `anthropic/claude-haiku-4.5` | Paid |

An idle sweep (registered via CronCreate) catches abandoned threads that the Stop hook never fires for again.

Config lives at `~/.mybrain/<name>/.autocapture-config.json` (chmod 600). Key settings:

```json
{
  "enabled": true,
  "extraction_model": "openai/gpt-oss-120b:free",
  "batch_threshold_messages": 15,
  "batch_threshold_minutes": 20,
  "sweep_interval_minutes": 30,
  "prune_after_days": 30
}
```

Per-session cursors are tracked separately in `~/.mybrain/<name>/.sessions.json` (auto-created). Deleting this file resets all session cursors — thoughts already captured are unaffected, but the next sweep may re-analyze recent sessions (dedup prevents double-captures).

Use `/mybrain-autocapture-status` to monitor what's been captured. `/mybrain-autocapture-off` disables both layers — Layer 2 (background) and Layer 1 (removes the proactive instruction from `~/.claude/CLAUDE.md`). `/mybrain-autocapture-on` restores both.

---

## Install in Claude Code (Recommended)

This is the fastest path. The plugin marketplace installs the MCP server, skills, and templates for you.

### 1. Add the marketplace and install the plugin

```bash
claude plugin marketplace add dnaidionov/mybrain
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

The wizard handles everything: scaffolding files, wiring `.mcp.json`, starting containers or registering the MCP server, verifying connectivity, and configuring auto-capture (Stop hook, sweep cron, and CLAUDE.md instruction).

### 3. Get an OpenRouter API key

You'll need one for embeddings. It's the only paid external dependency.

1. Sign up at <https://openrouter.ai>
2. Create a key at <https://openrouter.ai/keys>
3. Load a few dollars of credits. The embedding model (`text-embedding-3-small`) costs fractions of a cent per call -- $5 goes a very long way.

The auto-capture extraction model (`openai/gpt-oss-120b:free`) uses the same key and costs nothing.

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
git clone https://github.com/dnaidionov/mybrain.git
cd mybrain
npm install
```

Then register the MCP server with Claude Code:

```bash
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://user:password@host:5432/mybrain?ssl=true&sslmode=no-verify" \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e BRAIN_SCOPE="personal" \
  -e AUTOCAPTURE_CONFIG="$HOME/.mybrain/default/.autocapture-config.json" \
  -- node /absolute/path/to/mybrain/server.mjs
```

If you're setting up a fresh database, apply the schema:

```bash
psql "$DATABASE_URL" -f templates/schema.sql
```

**Migrating an existing database:**
```sql
ALTER TYPE thought_type ADD VALUE IF NOT EXISTS 'fact';
ALTER TYPE source_agent ADD VALUE IF NOT EXISTS 'claude';
-- Then run the CREATE TABLE IF NOT EXISTS blocks from templates/schema.sql
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
- Transport mode set via `MCP_TRANSPORT=http` env var (falls back to `process.argv[2]` or `stdio`)
- `BRAIN_SCOPE` is optional (single-user, single database)
- Multiple named brains run side-by-side on different ports

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

### Thought types

| Type | Default importance | TTL | When to use |
|---|---|---|---|
| `decision` | 0.9 | permanent | Architectural or product decisions |
| `preference` | 1.0 | permanent | Explicit user preferences |
| `lesson` | 0.7 | 1 year | Retro learnings, patterns |
| `rejection` | 0.5 | 6 months | Alternatives considered and discarded |
| `insight` | 0.6 | 6 months | Mid-task discoveries |
| `reflection` | 0.85 | permanent | Goals, values, synthesis |
| `fact` | 0.9 | permanent | Personal facts: subscriptions, reference info, key contacts |
| `drift` | 0.8 | 3 months | Spec/UX drift findings |
| `correction` | 0.7 | 3 months | Fixes after drift detection |

### ltree scoping

Every thought carries an `ltree[]` scope (e.g. `personal`, `projects.mybrain`). When `BRAIN_SCOPE` is set, every query is filtered to that scope. Auto-capture detects the current git repo and scopes thoughts to `projects.<repo-name>` automatically, falling back to `personal`.

---

## Requirements

**Docker mode:**
- Podman or Docker with Compose
- Node.js 18+ (only for manual registration)

**RDS mode:**
- Node.js 18+
- PostgreSQL with `pgvector` and `ltree` extensions
- OpenRouter API key (<https://openrouter.ai>)

---

## Usage Examples

Once installed, talk to Claude naturally:

- `Remember this: we decided to use ltree for multi-tenant scoping instead of separate schemas.`
- `What do I know about our database architecture decisions?`
- `Show me my recent thoughts.`
- `Search my brain for anything about deployment pipelines.`
- `How many thoughts do I have?`
- `Capture thought: pg_dump with --data-only skips schema changes -- type: lesson`

Claude picks the right tool automatically. For typed captures:

```
Remember this as a preference with importance 0.9: always use podman over docker on this machine.
```

---

## Repository Layout

```
.claude-plugin/
  plugin.json              Plugin manifest (declares skills)
  marketplace.json         Marketplace definition
.mcp.json                  MCP server config (stdio, plugin-root path)
hooks/
  stop-autocapture.mjs     Claude Code Stop hook entry point (<1ms, spawns worker)
  stop-process.mjs         Detached background worker (transcript analysis + capture)
  sweep.mjs                Periodic sweep for idle/abandoned sessions
skills/
  mybrain-setup/           /mybrain-setup — wizard + auto-capture configuration
  mybrain-overview/        /mybrain-overview — architecture + tool reference
  mybrain-autocapture-status/  /mybrain-autocapture-status — status, thresholds, token usage
  mybrain-autocapture-on/      /mybrain-autocapture-on — enable background capture
  mybrain-autocapture-off/     /mybrain-autocapture-off — disable background capture
templates/
  server.mjs               MCP server (dual mode: stdio + HTTP) — must stay identical to top-level server.mjs
  package.json             Node dependencies
  schema.sql               Full schema (ltree, match_thoughts_scored, HNSW, token_usage)
  Dockerfile               Container image
  compose.yml              PostgreSQL + MCP server services
  .env.example             Environment template
  proactive-instruction.md Canonical Layer 1 CLAUDE.md instruction block (single source of truth)
scripts/
  check-sync.sh            Fails if server.mjs and templates/server.mjs have diverged
server.mjs                 Top-level server (used by stdio registration)
```

---

## Troubleshooting

**"No thoughts found" on every search.**
The schema may not be loaded. In Docker mode, run `podman compose down -v && podman compose up -d` in your `.mybrain/<name>/` directory to rebuild the volume with the schema. In RDS mode, re-run `psql "$DATABASE_URL" -f templates/schema.sql`.

**`Embedding API error: 401`.**
Your `OPENROUTER_API_KEY` is missing or invalid. Check it's set in `.env` (Docker mode) or the `claude mcp add` command (RDS mode). Also ensure the key is exported in your shell profile (`~/.zshrc` or `~/.bashrc`) before launching Claude Code — plugin env vars are only passed if they exist in the shell at launch time.

**Claude doesn't see the tools.**
Restart Claude Code after installing. In Docker mode, check the container is running and healthy: `podman compose ps` inside `.mybrain/<name>/`.

**`capture_thought` succeeds but `search_thoughts` returns nothing.**
Lower the similarity threshold: `Search my brain for X with threshold 0.2`. The default is conservative.

**Port conflicts in Docker mode.**
Each brain instance uses two ports (default: MCP 8787, Postgres 5433). Run `/mybrain-setup` again with a different brain name to pick new ports.

**Auto-capture not working.**
1. Check `~/.claude/settings.json` has a Stop hook pointing to `stop-autocapture.mjs`
2. Check `~/.mybrain/<name>/.autocapture-config.json` exists and `"enabled": true`
3. Run `/mybrain-autocapture-status` to see current state
4. Check that `OPENROUTER_API_KEY` is set in the environment (not just the plugin config)

**`brain_stats` doesn't show token usage.**
The `AUTOCAPTURE_CONFIG` env var must be set on the MCP server registration pointing to your config file. Re-run the auto-capture setup step from `/mybrain-setup` or add `-e AUTOCAPTURE_CONFIG=...` to your `claude mcp add` command.

---

## License

MIT
