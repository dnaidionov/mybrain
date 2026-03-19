# MyBrain

Personal knowledge base with semantic search for Claude.

Store thoughts, ideas, notes, and context in PostgreSQL with vector embeddings. Search by meaning, not just keywords. Works with **Claude Code CLI** and **Claude Desktop** (claude.ai).

## Quick Start (containers)

The fastest way to get started. No Node.js install, no PostgreSQL install, no build step.

```
/mybrain-init
```

This scaffolds a project-local brain in `.mybrain/`, wires it into `.mcp.json`, and starts the containers. Just provide your OpenRouter API key.

### Multiple brains

You can run multiple brains per project. Each init creates a named instance with its own database and port:

```
/mybrain-init    # creates .mybrain/default/  (port 8787)
/mybrain-init    # creates .mybrain/research/ (port 8788)
```

Each brain gets its own entry in `.mcp.json` (`mybrain`, `mybrain-research`, etc.).

### Manual container setup

```bash
cd templates

# Add your OpenRouter API key
cp .env.example .env
# Edit .env

# Start everything
podman compose up -d
```

Register the MCP server:

```bash
claude mcp add --transport http --scope user mybrain http://localhost:8787/mcp
```

## Full Setup (native, no containers)

For native installation with more options (local PostgreSQL, Claude Desktop via Cloudflare Tunnel):

```
/mybrain-setup
```

Claude walks you through everything step by step.

## What It Does

- **4 MCP tools:** capture thoughts, semantic search, browse recent, get stats
- **PostgreSQL** with pgvector for storage and vector search
- **OpenRouter** for embedding generation (text-embedding-3-small, fractions of a cent per call)
- **Optional Cloudflare Tunnel** for Claude Desktop access via HTTPS

## Architecture

```
Claude Code CLI ──stdio──> server.mjs ──> PostgreSQL
                                      ──> OpenRouter (embeddings)

Container mode:
Claude Code ──HTTP──> mybrain_mcp (port 8787) ──> mybrain_postgres
                                               ──> OpenRouter (embeddings)

Claude Desktop ──HTTPS──> Cloudflare Tunnel ──> server.mjs (HTTP)
                                            ──> PostgreSQL
                                            ──> OpenRouter (embeddings)
```

## Plugin Structure

```
.claude-plugin/
  plugin.json                 # Plugin manifest
skills/
  mybrain-init/SKILL.md       # Quick scaffolding (containers)
  mybrain-setup/SKILL.md      # Full setup wizard (native + Desktop)
  mybrain-overview/SKILL.md   # How it works, tools, usage
templates/
  server.mjs                  # MCP server (dual mode: stdio + HTTP)
  package.json                # Node.js dependencies
  schema.sql                  # PostgreSQL schema with pgvector
  Dockerfile                  # Container image
  compose.yml                 # PostgreSQL + MCP server services
  .env.example                # Environment template
```

## Requirements

**Container setup** (recommended):
- Podman (or Docker)

**Native setup:**
- Node.js 18+
- PostgreSQL with pgvector
- OpenRouter API key (https://openrouter.ai)
- Cloudflare account + domain (only for Claude Desktop access)

## License

MIT
