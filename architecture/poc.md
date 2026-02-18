# Koshi v0.0.1 — Proof of Concept

## Goal

Get Koshi working end-to-end: message in → route → agent thinks → response out. Validate the core architecture before building the ecosystem.

## In Scope

### Core
- Fastify server with plugin lifecycle
- Message router with pattern-matching rules
- Persistent message buffer (SQLite)
- Config loader (koshi.yaml)
- SQLite database (memory, tasks, sessions, buffer — one DB)
- Cron scheduler
- Good logging throughout

### Plugins (4 total)
- `@koshi/anthropic` — Claude API client. Main agent session + sub-agent spawning. Streaming. Extended thinking. Native tool_use.
- `@koshi/tui` — Terminal UI. Copied from OpenClaw's TUI (MIT licensed source available). Connects to Koshi over local IPC.
- `@koshi/autotest` — Automated test channel. Acts as a user — sends messages, receives responses, validates the full pipeline. Used for development iteration and bug-finding. Demonstrates the channel plugin interface works.
- `@koshi/memory` — SQLite + FTS5 memory backend with reinforcement scoring.

### Memory
- FTS5 full-text search
- Reinforcement scoring (reinforce +3, demote -1)
- Size-based percentile pruning
- Four tools: query, store, reinforce, demote
- Synonym map (built-in, extensible)

### Sessions
- SQLite-backed session persistence
- Messages stored as rows in sessions table
- Bounded by message count or token count (configurable)
- One DB for everything — memory, tasks, sessions, buffer

## Out of Scope (for POC)

- Plugin registry / discovery
- Testing framework
- Additional channels (Nostr, Telegram, Slack, Discord, etc.)
- CLI commands beyond start/stop/status
- Doctor / audit tools
- Web dashboard
- Backup/restore CLI
- systemd service generator
- TOTP authentication
- Memory relations (v2)

## Success Criteria

1. `koshi start` boots cleanly, loads config, opens IPC socket
2. TUI connects to running instance
3. User sends message via TUI → Koshi routes to Anthropic → Claude responds → response appears in TUI
4. Memory query works: relevant memories injected into context
5. Memory reinforcement works: agent can reinforce/demote
6. Sub-agent spawning works: main agent delegates a task, sub-agent completes it
7. Routing rules work: a webhook-style message auto-spawns a sub-agent without main agent involvement
8. Autotest channel can send/receive messages programmatically
9. Buffer persists across restart

## Architecture Validation

The POC validates these architectural bets:
- Fastify plugin model works for our use case
- SQLite handles memory + tasks + sessions + buffer in one DB
- FTS5 + synonym expansion provides good retrieval without embeddings
- Structural delegation (main thread can't run tools) works in practice
- Routing rules successfully divert work from the main agent
- Message batching reduces token usage
