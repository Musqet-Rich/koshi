# Koshi (骨子) — Architecture Overview

> A skeleton, bare framework for agentic assistants.

## Philosophy

- Built for Claude, not every model
- Thin core, plugin everything else
- Memory is a first-class system, not file stuffing
- Let the model do what it's good at; the runtime just connects things

## Runtime

**Node.js** — chosen for the event loop. Node's superpower is non-blocking I/O handling thousands of concurrent connections. All channels, webhooks, and API calls are async I/O — exactly what Node is built for.

**Fastify** — plugin-first HTTP framework. Handles HTTP, WebSocket, lifecycle, graceful shutdown. Koshi's plugin architecture maps directly onto Fastify's `fastify.register()` pattern. One server, one port, plugins register routes on it.

## What Koshi IS

Koshi is a Node.js process running as a daemon. It's a hub/router/switchboard — messages come in from channels, get routed, and go out. Claude is an external service Koshi calls via the Anthropic API, not something that lives inside it. The Anthropic connection is structurally the same as any other plugin connection (Telegram, Nostr, etc.) — just the one that thinks.

There is no separate "daemon" vs "server" concept. Koshi is the process. Period.

## Core (`src/core/`)

The kernel. Always present, no plugins needed.

```
src/core/
├── server.ts       # Fastify instance — HTTP, WebSocket, lifecycle
├── router.ts       # Message routing — channel → buffer → agent/rules
├── buffer.ts       # Message buffer with provenance (persistent)
├── memory.ts       # Memory store interface — store, query, forget
├── tools.ts        # Tool registry — schema declaration + dispatch
├── config.ts       # Config loading, validation (koshi.yaml)
├── cron.ts         # Scheduled tasks, timers
├── plugins.ts      # Plugin loader — discovers, validates, registers
└── index.ts        # Bootstrap, Fastify init, plugin loading, startup
```

## Plugins

Everything outside the core. Plugins are npm packages (or local files). Installed via CLI:

```bash
koshi add @koshi/telegram    # npm install under ~/.koshi + add to koshi.yaml
koshi add @koshi/anthropic   # the thinking service
koshi add ./my-local-plugin  # local file
```

Adding a plugin requires restart (sub-second cold start, that's fine).

**Koshi ships with zero plugins. Core only. Everything is addable.**

Plugin interface:
```ts
interface Plugin {
  name: string
  version: string
  init(koshi: Koshi, config: any): Promise<void>  // receives Koshi instance to register routes/tools/channels
}
```

### Three plugin types:

### Channels — bidirectional message connections

How messages get in and out. Each channel maintains a persistent connection to its service.

Examples: Nostr DMs, Telegram, Slack, Discord, TUI, Signal

```ts
interface Channel {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(target: string, message: Message): Promise<void>
  onMessage: (msg: IncomingMessage) => void  // set by router
}
```

### Services — outbound API connections exposing tools

Outbound connections to external APIs. Each service registers tools that agents can use.

Examples: Anthropic (the thinker), GitHub API, web search, TTS

The Anthropic plugin is special — it's the one that reasons — but structurally it's just another service plugin that implements the model interface. It registers tools like `claude_conversation`, the main agent session is a persistent connection to this service, and sub-agents are spawned through it. Other model plugins (e.g. `@koshi/ollama` for local models) implement the same `complete`/`stream` interface — the router doesn't care which backend handles the request.

### Listeners — inbound-only endpoints

Register HTTP routes on Koshi's Fastify instance. Receive data but don't initiate conversations.

Examples: GitHub webhook receiver, health check endpoint, OAuth callbacks

```ts
// Inside a listener plugin's init():
koshi.fastify.post('/webhook/github', handler)
koshi.fastify.get('/health', handler)
```

## Routing Rules

Smart routing without burning LLM tokens. A pattern-matching rule engine at the router level.

Incoming messages are matched against YAML rules — can auto-spawn sub-agents without main agent involvement:

```yaml
routes:
  - match:
      channel: github-webhooks
      event: pull_request
      action: opened
    action:
      spawn:
        template: reviewer
        task: "Review PR #{{number}}: {{title}}"

  - match:
      channel: telegram
      from: "*"
    action:
      forward: main-agent    # default: send to the main agent
```

The main agent can WRITE these routing rules (modify koshi.yaml), becoming an architect that builds automation rather than a worker that processes everything. This saves massive tokens — no more burning Opus turns on noise.

## Message Buffer

All incoming messages pass through the persistent message buffer before the agent sees them. See [`buffer.md`](buffer.md) for the full design.

Key properties:
- **Persistent** — SQLite (`buffer.db`), survives restarts. Messages received during downtime are waiting when Koshi comes back.
- **Provenance** — every message carries channel, sender, conversation, timestamp, and priority.
- **Batched delivery** — messages are always delivered as arrays. The router collects messages in a configurable window (default 500ms) and groups by conversation/source before delivery. Multiple rapid messages become one batch → one agent turn → fewer tokens.
- **Priority ordering** — when the main agent is ready, it pulls the highest-priority unprocessed batch. User DMs > webhooks > notifications.
- **Three routing outcomes** — forward to main agent (default), spawn a sub-agent (rule match), or drop (no route, logged).
- **No push summaries** — auto-routed work doesn't notify the main agent. Context stays clean.

## TUI

Ships as a channel plugin, but expected to be the first one installed. The primary interface — if nothing else is configured, install this and go.

- `koshi tui` connects to the running process over local IPC (Unix socket)
- Streaming visible in real time
- No message size limits

## Config (`koshi.yaml`)

Single config file. No config directory, no dotfiles scattered everywhere.

```yaml
name: koshi

identity:
  soul: |
    You are Koshi. Calm, direct, dry wit...

models:
  main:
    plugin: "@koshi/anthropic"
    model: claude-sonnet-4-20250514
    apiKey: ${ANTHROPIC_API_KEY}
  opus:
    plugin: "@koshi/anthropic"
    model: claude-opus-4-20250514
    apiKey: ${ANTHROPIC_API_KEY}
  local:
    plugin: "@koshi/ollama"
    model: qwen-coder-32b
    endpoint: http://localhost:11434

agent:
  model: main                   # main thread uses this model

plugins:
  - name: "@koshi/anthropic"
    apiKey: ${ANTHROPIC_API_KEY}
  - name: "@koshi/nostr"
    relay: wss://relay.example.com
    nsec: ${NOSTR_NSEC}
  - name: "@koshi/telegram"
    token: ${TELEGRAM_TOKEN}

routes:
  - match:
      channel: github-webhooks
      event: pull_request
    action:
      spawn:
        template: reviewer
        task: "Review PR #{{number}}"

templates:
  coder:
    tools: [exec, files]
    model: local
    timeout: 300
  researcher:
    tools: [web, files]
    model: main
    timeout: 120
  reviewer:
    tools: [exec, files, web]
    model: opus
    timeout: 300

buffer:
  retentionDays: 7
  batchWindowMs: 500

memory:
  backend: sqlite

sessions:
  maxMessages: 200        # per session, oldest pruned
  # maxTokens: 100000     # alternative: cap by token count

cron:
  - name: lookout
    schedule: "30 7 * * *"
    task:
      title: "Publish the morning briefing"
      template: "researcher"
      autoRun: true
```

### Named Models

Models are defined once in `koshi.yaml` under the `models:` section with user-chosen names, then referenced by name everywhere else — agent config, templates, routing rules.

A **model plugin** is a service plugin that implements a standard interface:

```ts
interface ModelPlugin {
  complete(messages: Message[], tools: Tool[]): Promise<Response>
  stream(messages: Message[], tools: Tool[]): AsyncIterable<Chunk>
}
```

Koshi core defines this interface; plugins implement it. The `@koshi/anthropic` plugin is the primary/official one, optimised for Claude (extended thinking, prompt caching, native `tool_use`). But the interface is open — anyone can write a model plugin for any provider.

Key properties:
- **One definition, many references.** Change a model definition once, it ripples everywhere it's referenced.
- **Multi-model by default.** Different tasks use different models — cheap/fast for conversation, powerful for complex reasoning, local for private code.
- **`agent.model`** designates which named model the main agent thread uses.
- **Templates reference by name.** No hardcoded model strings scattered through config.

## Data (`data/`)

All persistent state in one place.

```
data/
├── koshi.db        # SQLite — memory, tasks, sessions, buffer (one DB)
└── blobs/          # File attachments, audio, etc.
```

## Project Root

```
koshi/
├── src/
│   ├── core/       # The kernel
│   └── types.ts    # Shared type definitions
├── data/           # Runtime state (gitignored)
├── koshi.yaml      # Config
├── package.json
├── tsconfig.json
└── README.md
```

## Sessions

SQLite-backed session persistence. Messages stored as rows in the sessions table, same database as memory, tasks, and buffer.

Sessions are bounded to prevent unbounded growth:

```yaml
sessions:
  maxMessages: 200        # per session, oldest pruned
  # maxTokens: 100000     # alternative: cap by token count
```

When the limit is reached, oldest messages are pruned from the session.

## Resolved Questions

- **Auth model:** TOTP-based authentication. Out of scope for POC, designed for v1.
- **Workspace:** Koshi runs as its own user. Workspace = wherever `koshi.yaml` lives.
- **Multiple instances:** One instance. A second would clash on ports.
