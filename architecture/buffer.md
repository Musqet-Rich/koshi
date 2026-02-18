# Message Buffer

## Purpose

The message buffer sits between incoming connections (channels, listeners) and the agent. It is the single entry point for all inbound messages. Every message that enters Koshi passes through the buffer — no exceptions.

Core guarantees:
- **Never loses a message.** Persistent storage in SQLite (`buffer.db`), survives restarts.
- **Always knows where it came from.** Every message carries full provenance metadata.
- **Decouples ingestion from processing.** Channels write to the buffer; the router reads from it. They never interact directly.

## Schema

Each buffered message:

```sql
CREATE TABLE buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- unique, monotonically ordered
  channel TEXT NOT NULL,                  -- nostr, telegram, github-webhook, etc.
  sender TEXT NOT NULL,                   -- who sent it (pubkey, user ID, "system")
  conversation TEXT NOT NULL,             -- thread/DM/session identifier
  payload TEXT NOT NULL,                  -- the actual message content (JSON)
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  priority INTEGER NOT NULL DEFAULT 100,  -- lower = higher priority
  routed BOOLEAN NOT NULL DEFAULT FALSE   -- has the router processed this?
);

CREATE INDEX idx_buffer_unrouted ON buffer (routed, priority, id)
  WHERE routed = FALSE;
CREATE INDEX idx_buffer_conversation ON buffer (conversation, received_at);
CREATE INDEX idx_buffer_retention ON buffer (received_at) WHERE routed = TRUE;
```

### Priority values

| Priority | Value | Examples |
|----------|-------|----------|
| User DMs | 10 | Telegram message, Nostr DM, TUI input |
| Webhooks | 50 | GitHub PR, push events |
| Notifications | 100 | Cron results, system events |

Configurable per-channel and per-route. Lower value = higher priority.

## Batching

Messages are **always** delivered as arrays, even single messages. The router collects messages in a configurable window and groups them by conversation/source before delivery.

### How it works

1. A message arrives → written to `buffer` table with `routed = FALSE`
2. The router runs on a tick (default every 500ms)
3. Each tick, the router queries unrouted messages, groups them by `(conversation, channel)`
4. Each group becomes a **batch** — an array of messages ordered by `id`
5. The batch is matched against routing rules and dispatched

### Why batching matters

- **Deduplication by design.** 5 GitHub webhooks for the same PR in 10 seconds → one batch, one sub-agent spawn, one task. No wasted tokens on redundant work.
- **Natural message grouping.** User sends 2 quick messages → agent sees both in one turn, responds once. Half the tokens, better responses.
- **Consistent interface.** Every consumer (main agent, routing rules, sub-agents) always receives `Message[]`. No special-casing for single vs. multiple messages.

### Batch structure

```ts
interface MessageBatch {
  channel: string
  conversation: string
  messages: BufferedMessage[]  // always an array, length >= 1
}
```

## Routing

After batching, each batch is matched against routing rules (defined in `koshi.yaml`). Three possible outcomes:

### → Main agent
Default path. The batch is queued for the main agent's next turn. When the agent is ready, it pulls the highest-priority unprocessed batch.

### → Spawn
A routing rule matches and specifies a `spawn` action. Koshi creates a task record and spawns a sub-agent automatically. The main agent is **not notified** — no push summaries, no interruptions. The agent queries memory or tasks when it needs to know what happened.

### → Drop
No matching route and no default forward. The batch is logged but discarded. The `routed` flag is set to `TRUE` so it won't be reprocessed.

## Priority Ordering

When the main agent is ready for its next turn, it pulls the highest-priority unprocessed batch. Priority is determined by:

1. **Priority value** — lowest number first (user DMs before webhooks before notifications)
2. **Arrival order** — within the same priority, oldest first (FIFO)

This is configurable. The default priority mapping can be overridden per-channel in config:

```yaml
plugins:
  - name: "@koshi/telegram"
    token: ${TELEGRAM_TOKEN}
    priority: 10          # user messages — highest priority

  - name: "@koshi/github-webhook"
    priority: 50          # webhooks — medium priority
```

## Persistence

SQLite (`buffer.db`). Messages survive restarts — if Koshi goes down mid-processing, unrouted messages are waiting when it comes back. Messages received during restart (if channels have their own queues) are written to the buffer on reconnect.

The buffer DB can be the same SQLite file as memory (`memory.db`) or a separate file. Default: separate `buffer.db` for operational isolation — the buffer is high-write, memory is high-read.

## Retention

Processed messages are retained for a configurable period, then pruned.

```yaml
buffer:
  retentionDays: 7       # default, user configurable
  batchWindowMs: 500     # how long to collect before batching
```

A daily cron job prunes processed messages older than `retentionDays`:

```sql
DELETE FROM buffer WHERE routed = TRUE AND received_at < datetime('now', '-7 days');
```

Unrouted messages are **never** pruned regardless of age.

## Backpressure

If messages pile up faster than the agent can process them, the buffer grows in SQLite. This is by design — SQLite handles millions of rows efficiently, and disk is cheap.

Monitoring:
- `koshi status` shows buffer depth (total unrouted messages, oldest unrouted age, breakdown by channel)
- Warning threshold configurable — log a warning when unrouted count exceeds a limit

Auto-triage behaviour (when buffer exceeds threshold) is TBD for v1. Current design: just grow and warn.

## Main Agent Isolation

The main agent is **not notified** about auto-routed work. When a routing rule spawns a sub-agent, the main agent's context is untouched — no push summaries, no "hey, I handled 3 PRs while you were idle" messages.

If the main agent needs to know what happened, it queries:
- **Memory** — sub-agent results are stored as memory entries
- **Tasks** — task records show status, results, and history

This keeps the main agent's context clean and focused on the current conversation. Background work is discoverable, not pushed.

## Flow Summary

```
Channel (Telegram, Nostr, GitHub webhook, ...)
    │
    ▼
Message Buffer (SQLite, persistent)
    │
    ├── write: channel, sender, conversation, payload, priority
    │
    ▼
Router (runs every batchWindowMs)
    │
    ├── group unrouted messages by (conversation, channel)
    ├── match each batch against routing rules
    │
    ├── → main agent queue (default)
    ├── → spawn sub-agent (rule match)
    └── → drop (no route, logged)
```
