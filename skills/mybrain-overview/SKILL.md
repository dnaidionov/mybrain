---
name: mybrain-overview
description: Use when users ask about MyBrain, what it does, how it works, what tools are available, or how to use the personal knowledge base. Covers architecture, tools, deployment modes, and usage.
---

# MyBrain -- Overview

MyBrain is a personal knowledge base with semantic search. It stores thoughts, ideas, notes, and context in PostgreSQL with vector embeddings, making everything searchable by meaning -- not just keywords.

It works as an MCP (Model Context Protocol) server, accessible from Claude Code CLI and Claude Desktop.

## Deployment Modes

| Mode | Database | Best For |
|------|----------|----------|
| **Docker** | Local PostgreSQL + pgvector in containers | Self-contained, no external dependencies |
| **RDS** | Shared AWS RDS with ltree scoping | Teams, multi-project, persistent cloud storage |

Run `/mybrain-setup` to install either mode.

## How It Works

### Storing a thought

1. You say "remember this: ..." to Claude
2. Claude calls `capture_thought` with your text
3. The server sends text to OpenRouter (`text-embedding-3-small`) for a 1536-dim vector
4. Text, vector, metadata, and scope are stored in PostgreSQL
5. HNSW index on the embedding column enables fast search

### Searching

1. You ask "what do I know about X?"
2. Claude calls `search_thoughts` with your query
3. Query is embedded via OpenRouter, then matched using `match_thoughts_scored()`
4. Three-axis scoring: **(3.0 * relevance) + (2.0 * importance) + (0.5 * recency)**
5. Results return sorted by combined score

### ltree Scoping

When `BRAIN_SCOPE` is set (e.g. `personal`, `myproject.app`), all queries filter by scope. This lets multiple users or projects share one database without interference.

- Docker mode: scope is optional (single-user, single database)
- RDS mode: scope is required (shared database, multi-tenant)

## Tools

| Tool | Description | Uses OpenRouter | Cost |
|------|-------------|-----------------|------|
| `capture_thought` | Save a thought with metadata | Yes | ~$0.0001 |
| `search_thoughts` | Semantic search with scored ranking | Yes | ~$0.0001 |
| `browse_thoughts` | List recent thoughts, filter by metadata | No | Free |
| `brain_stats` | Total count, date range, top metadata | No | Free |

## Usage Examples

- "Remember this: Sarah mentioned she wants to start a consulting business"
- "What do I know about Sarah?"
- "Show me my recent thoughts"
- "How many thoughts do I have?"
- "Search for anything about project architecture"
- "Capture thought: The deploy pipeline needs a staging gate before prod"

## Architecture

```
Docker mode:
Claude Code --HTTP--> mybrain_mcp (port 8787) --> mybrain_postgres
                                              --> OpenRouter (embeddings)

RDS mode:
Claude Code --stdio--> server.mjs --> AWS RDS (projects_brain)
                                  --> OpenRouter (embeddings)

Claude Desktop (either mode):
Claude Desktop --HTTPS--> Cloudflare Tunnel --> server.mjs (HTTP :8787)
```

## Schema

The database uses the full atelier brain schema:
- **thoughts** table with ltree scope, thought_type, importance, status
- **thought_relations** for typed edges between thoughts
- **match_thoughts_scored()** -- three-axis scoring function
- **HNSW index** on embeddings, **GiST index** on scope, **GIN index** on metadata

## State

All data lives in PostgreSQL. OpenRouter is only used for generating embeddings -- no thought content leaves your database.
