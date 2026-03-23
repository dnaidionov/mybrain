# MyBrain

Personal knowledge base with semantic search for Claude.

Store thoughts, ideas, notes, and context in PostgreSQL with vector embeddings. Search by meaning -- not just keywords. Works with **Claude Code CLI** and **Claude Desktop**.

## Quick Start

```
/mybrain-setup
```

Claude walks you through choosing a deployment mode and configuring everything.

### Docker (local, self-contained)

Runs PostgreSQL + pgvector in containers. No external dependencies.

```
/mybrain-setup   # choose "Docker"
```

Scaffolds `.mybrain/` with compose files, starts containers, wires into `.mcp.json`.

### RDS (shared remote database)

Connects to a shared PostgreSQL database on AWS RDS with ltree scoping. Multiple users and projects share one database, isolated by scope.

```
/mybrain-setup   # choose "RDS"
```

Configures `DATABASE_URL`, `BRAIN_SCOPE`, and registers the MCP server.

## What It Does

- **4 MCP tools:** capture thoughts, semantic search, browse recent, get stats
- **PostgreSQL** with pgvector for storage and vector search
- **Three-axis scoring:** relevance (3.0) + importance (2.0) + recency (0.5)
- **ltree scoping** for multi-tenant isolation on shared databases
- **OpenRouter** for embedding generation (text-embedding-3-small, fractions of a cent per call)

## Architecture

```
Docker mode:
Claude Code --HTTP--> mybrain_mcp (port 8787) --> mybrain_postgres
                                              --> OpenRouter (embeddings)

RDS mode:
Claude Code --stdio--> server.mjs --> AWS RDS (projects_brain)
                                  --> OpenRouter (embeddings)
```

## Plugin Installation

Install via the Claude Code plugin marketplace:

```bash
claude plugin marketplace add robertsfeir/mybrain
claude plugin install mybrain@mybrain
```

Or clone and register manually:

```bash
git clone https://github.com/robertsfeir/mybrain.git
cd mybrain && npm install
claude mcp add mybrain --transport stdio \
  -e DATABASE_URL="postgresql://..." \
  -e OPENROUTER_API_KEY="sk-or-..." \
  -e BRAIN_SCOPE="personal" \
  -- node server.mjs
```

## Plugin Structure

```
.claude-plugin/
  plugin.json              # Plugin manifest
  marketplace.json         # Marketplace definition
.mcp.json                  # MCP server config
skills/
  mybrain-setup/SKILL.md   # Setup wizard (Docker or RDS)
  mybrain-overview/SKILL.md # How it works, tools, usage
templates/
  server.mjs               # MCP server (dual mode: stdio + HTTP)
  package.json             # Node.js dependencies
  schema.sql               # Full schema with ltree + scored search
  Dockerfile               # Container image
  compose.yml              # PostgreSQL + MCP server services
  .env.example             # Environment template
server.mjs                 # Root server (same as templates/server.mjs)
```

## Requirements

**Docker mode:**
- Podman (or Docker)

**RDS mode:**
- Node.js 18+
- Access to a PostgreSQL database with pgvector + ltree extensions
- OpenRouter API key (https://openrouter.ai)

## License

MIT
