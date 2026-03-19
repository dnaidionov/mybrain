# MyBrain

Personal knowledge base with semantic search for Claude.

Store thoughts, ideas, notes, and context in a local PostgreSQL database with vector embeddings. Search by meaning, not just keywords. Works with **Claude Code CLI** and **Claude Desktop** (claude.ai).

## Quick Start

### Step 1: Clone the repo

```bash
git clone https://github.com/robertsfeir/mybrain.git
```

### Step 2: Add it as a Claude Code plugin

```bash
claude plugins add ./mybrain
```

If you cloned it somewhere else, use the full path:

```bash
claude plugins add /full/path/to/mybrain
```

### Step 3: Run the setup wizard

Open Claude Code and say:

```
/mybrain-setup
```

Claude will walk you through everything step by step -- database, API key, Claude Desktop access, all of it. Just answer the questions.

## What It Does

- **4 MCP tools:** capture thoughts, semantic search, browse recent, get stats
- **Local PostgreSQL** with pgvector for storage and vector search
- **OpenRouter** for embedding generation (text-embedding-3-small)
- **Optional Cloudflare Tunnel** for Claude Desktop access via HTTPS

## Requirements

- macOS (Linux support possible but launchd steps need adaptation)
- Node.js 18+
- PostgreSQL with pgvector extension
- OpenRouter API key (https://openrouter.ai)
- Cloudflare account + domain (only if you want Claude Desktop access)

## Architecture

```
Claude Code CLI --stdio--> server.mjs --> PostgreSQL (local)
                                      --> OpenRouter (embeddings)

Claude Desktop --HTTPS--> Cloudflare Tunnel --> server.mjs (HTTP)
                                            --> PostgreSQL (local)
                                            --> OpenRouter (embeddings)
```

## Plugin Structure

```
.claude-plugin/
  plugin.json                 # Plugin manifest
skills/
  mybrain-setup/SKILL.md      # Interactive setup wizard
  mybrain-overview/SKILL.md   # How it works, tools, usage
templates/
  server.mjs                  # MCP server (dual mode: stdio + HTTP)
  package.json                # Node.js dependencies
  schema.sql                  # PostgreSQL schema with pgvector
```

## License

MIT
