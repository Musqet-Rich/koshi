# Koshi Process Architecture

## What Koshi IS

Koshi is a single Node.js process running as a daemon. There is no separate "daemon" vs "server" — Koshi is the process. It's a hub/router/switchboard built on Fastify.

It:

1. **Loads config** — reads [`koshi.yaml`](./overview.md#config-koshiyaml), validates, resolves plugin references
2. **Initialises Fastify** — the HTTP/WebSocket server that plugins register on
3. **Loads plugins** — each plugin's `init(koshi, config)` runs, registering channels/services/listeners via Fastify's `fastify.register()` pattern
4. **Starts listening** — channels connect, listeners bind routes, services initialise
5. **Routes messages** — incoming messages hit the router, matched against [YAML rules](./overview.md#routing-rules) or forwarded to the main agent
6. **Manages the [message buffer](./buffer.md)** — persistent queue of incoming messages with provenance
7. **Batches and routes messages** — the buffer collects incoming messages, groups them by conversation/source in a configurable window (default 500ms), and the router dispatches batches to the main agent, spawned [sub-agents](./agents.md), or drops them per routing rules
8. **Runs cron** — scheduled tasks fire at their times
8. **Serves IPC** — local Unix socket for TUI and CLI

## Fastify as the Foundation

Fastify is the backbone. Its plugin system maps directly onto Koshi's needs:

- **Plugin encapsulation** — each Koshi plugin registers via `fastify.register()`, getting its own scope
- **Lifecycle hooks** — `onReady`, `onClose` for clean startup/shutdown
- **Graceful shutdown** — `fastify.close()` tears down all plugins in reverse order
- **HTTP routing** — listener plugins register routes directly on the Fastify instance
- **WebSocket support** — via `@fastify/websocket` for channels that need it
- **Decorators** — Koshi decorates the Fastify instance with `koshi.router`, `koshi.memory` ([memory system](./memory.md)), `koshi.buffer` ([message buffer](./buffer.md)) etc.

```ts
const fastify = Fastify({ logger: true })

// Decorate with Koshi subsystems
fastify.decorate('router', router)
fastify.decorate('memory', memoryStore)
fastify.decorate('buffer', messageBuffer)

// Load each plugin via Fastify's register
for (const pluginConfig of config.plugins) {
  const plugin = require(pluginConfig.name)
  await fastify.register(plugin.init, pluginConfig)
}

await fastify.listen({ port: config.port || 3000 })
```

## Lifecycle

```
koshi start
    │
    ▼
Load koshi.yaml, validate config
    │
    ▼
Create Fastify instance
    │
    ▼
Init SQLite DB (data/koshi.db — memory, tasks, sessions, buffer)
    │
    ▼
Load & register plugins (fastify.register for each)
  ├── Channels: connect to external services
  ├── Services: init API clients, register tools
  └── Listeners: register HTTP routes on Fastify
    │
    ▼
Start cron scheduler
    │
    ▼
Open IPC socket (for TUI/CLI)
    │
    ▼
fastify.listen() — ready
```

## Plugin Lifecycle

Plugins are npm packages or local files. They follow Fastify's plugin pattern:

```ts
// Example: @koshi/telegram channel plugin
export default {
  name: '@koshi/telegram',
  version: '1.0.0',
  async init(koshi, config) {
    const bot = new TelegramBot(config.token)

    // Register as a channel on the router
    koshi.router.registerChannel('telegram', {
      connect: () => bot.startPolling(),
      disconnect: () => bot.stopPolling(),
      send: (target, msg) => bot.sendMessage(target, msg.text),
      onMessage: null  // set by router
    })

    // Lifecycle: clean shutdown
    koshi.fastify.addHook('onClose', async () => {
      await bot.stopPolling()
    })
  }
}
```

**Adding plugins:**
```bash
koshi add @koshi/telegram    # npm install + add to koshi.yaml
koshi remove @koshi/telegram # npm uninstall + remove from koshi.yaml
```

Adding/removing requires a restart. Sub-second cold start makes this negligible.

## IPC

The TUI and CLI commands (`koshi status`, `koshi memories`, etc.) talk to the running process over a Unix domain socket.

```
~/.koshi/koshi.sock
```

CBOR protocol (binary, ~30% smaller than JSON, native binary support for blobs/screenshots). TUI connects, sends messages, receives streamed responses. No HTTP overhead, no auth needed — local-only.

JSON at the HTTP boundary where external clients expect it (webhook responses, REST). All internal communication uses CBOR.

## Process Model

Single Node.js process. No cluster, no workers. Reasons:

- Claude API is the bottleneck, not CPU
- SQLite prefers single-writer
- Simpler to reason about, debug, and log
- Channels are async I/O, not CPU-bound

Parallel [sub-agents](./agents.md) are separate Claude API calls within the same process — concurrent promises.

## State Directory

```
~/.koshi/
├── koshi.sock          # IPC socket (runtime only)
├── koshi.pid           # PID file
├── node_modules/       # Installed plugins
├── package.json        # Plugin dependency manifest
└── logs/
    └── koshi.log       # daemon log (rotated)
```

Project data lives wherever `koshi.yaml` points:

```
./data/
├── koshi.db            # SQLite — memory, tasks, sessions, buffer (one DB)
└── blobs/              # attachments, audio, etc.
```

## CLI

```bash
koshi start             # start daemon (daemonizes, returns immediately)
koshi stop              # graceful shutdown (fastify.close())
koshi restart           # stop + start
koshi status            # running? channels connected? memory stats?
koshi tui               # connect interactive TUI
koshi add <plugin>      # install plugin (npm install + koshi.yaml)
koshi remove <plugin>   # uninstall plugin
koshi memories          # browse/search memory DB
koshi logs              # tail daemon logs
```

## Signals

- `SIGTERM` — graceful shutdown (fastify.close() → all plugins torn down in reverse order, memory flushed, exit)
- `SIGHUP` — reload config (re-read koshi.yaml, restart changed plugins)
- `SIGUSR1` — dump status to log

## Error Handling

### Claude API failures mid-agent-run
- Retry with exponential backoff (3 attempts, then fail the agent run)
- If a sub-agent fails, the main thread is notified with the error — it can retry or report to the user
- Main thread API failures surface as a visible error in the conversation ("I lost my train of thought — let me try again")

### Channel disconnects
- Each channel plugin manages its own reconnection with backoff
- Messages received during disconnect are lost (channels are assumed unreliable)
- The daemon logs disconnects and reconnects; `koshi status` shows channel health

### SQLite disk limits
- Check available disk before writes; if below threshold, log a warning and reject new memory stores
- Existing sessions and queries continue to work (reads don't need disk)
- `koshi status` reports DB size and available disk

### Sub-agent crashes
- Unhandled exceptions in a sub-agent are caught by the process, not the agent itself
- The task is marked `failed` with the error message
- Main thread is notified so it can retry or inform the user
- Other running agents are unaffected (isolated promises)

## Backup

```bash
koshi backup                    # dump SQLite DBs + koshi.yaml to timestamped tarball
koshi backup -o ./my-backup.tar.gz  # custom output path
```

Produces a `.tar.gz` containing:
- `koshi.db` — full SQLite database (memory, tasks, sessions, buffer — one DB)
- `koshi.yaml` — current config
- `blobs/` — attachments directory

Simple, scriptable, cron-friendly. Restore is just extracting the tarball and pointing `koshi.yaml` at the data directory.

## Resolved Questions

- **Auto-start on boot:** `koshi install-service` generates a systemd unit file. Out of scope for POC.
- **Multiple instances:** One. A second instance would clash on ports.
- **Log level:** Default `info`, configurable to `debug` in `koshi.yaml`.
- **Health endpoint:** Built into core. Aggregates plugin health via a standard `health()` method on each plugin.
