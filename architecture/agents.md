# Agent Architecture

## Core Principle

The main thread is the UI thread. It never blocks.

Same pattern as web workers in browser development — heavy work goes to background agents so the main thread stays responsive and context-rich.

## Anthropic as a Service Plugin

Claude is not inside Koshi — it's an external service accessed via the `@koshi/anthropic` service plugin. This plugin:

- Registers tools: `claude_conversation`, `spawn_agent`
- Maintains the main agent session as a persistent connection to the Anthropic API
- Spawns sub-agents as separate API conversations
- Is structurally the same as any other service plugin (GitHub, web search, TTS) — just the one that thinks

The main agent session is a long-lived conversation with context. Sub-agents are ephemeral — spawned, do work, return result, die.

## Main Thread

The user's conversation partner. Optimised for context, not execution.

The main agent receives messages as **batched arrays** — never individual messages. The buffer collects messages in a configurable window (default 500ms), groups by conversation/source, and delivers the highest-priority batch when the agent is ready for its next turn. Even a single message arrives as a one-element array. This means the agent always processes `Message[]`, keeping the interface consistent.

**Auto-routed work does not notify the main agent.** When routing rules spawn sub-agents automatically (e.g. for GitHub webhooks), the main agent's context is untouched — no push summaries, no interruptions. If the agent needs to know what happened, it queries memory or tasks. Context stays clean.

**Tools available:**
- `spawn_agent` — create a background worker
- `memory_query` — recall relevant context
- `memory_store` — save new context

**No other tools.** No exec, no file I/O, no web fetching. This is structural, not instructional — the main thread literally cannot run shell commands.

**Why:**
- Maximum context window for conversation
- Never blocked by a 10-minute build
- No tool call results cluttering the history
- Stays responsive to the user at all times

## Sub-Agents

Background workers. Spawned by the main thread OR by routing rules. Run independently, report back.

**Tools available:** configured per-spawn, from the full plugin set
```ts
spawn_agent({
  task: "Fix lint errors in src/api/webhook.ts and commit",
  tools: ["exec", "files"],
  timeout: 300
})
```

**Lifecycle:**
1. Spawn triggered — either by main thread calling `spawn_agent`, or by a routing rule match
2. Koshi creates a new Claude API conversation via the Anthropic service plugin
3. System prompt: task description + relevant memories (queried from DB)
4. Agent works — uses tools, makes API calls, runs commands
5. Agent completes → result returned to main thread (or stored directly if rule-spawned)
6. Work summary stored as a memory entry
7. Agent conversation discarded (ephemeral)

**Properties:**
- Ephemeral — no persistent session, no history to manage
- Isolated — own conversation, own tool calls, can't interfere with main thread
- Concurrent — multiple agents can run in parallel
- Timeout-bound — always has a deadline, can't run forever
- Fire-and-forget — main thread doesn't wait, gets notified on completion

## Communication

### Main thread → sub-agent (explicit spawn)

```
Main Thread                    Sub-Agent
    │                              │
    ├── spawn_agent(task) ────────►│
    │                              ├── works...
    │   (keeps talking to user)    ├── uses tools...
    │                              ├── works...
    │◄── result notification ──────┤
    │                              ╳ (dies)
    ▼
Stores result as memory
```

### Routing rules → sub-agent (automatic spawn)

```
Incoming Message                Router                     Sub-Agent
    │                              │                          │
    ├── GitHub PR webhook ────────►│                          │
    │                              ├── matches route rule     │
    │                              ├── spawn_agent(task) ────►│
    │                              │                          ├── reviews PR...
    │                              │                          ├── posts comments...
    │                              │◄── result ───────────────┤
    │                              │                          ╳ (dies)
    │                              ├── creates task record
    │                              ├── stores memory
    │                              │
    (main agent never involved)
```

No bidirectional communication. The agent gets a task, does it, returns a result. If the task is unclear, the agent does its best — it can't ask the main thread for clarification. Task descriptions need to be complete.

## Model Selection

Models are defined once as named entries in `koshi.yaml` and referenced by name everywhere — no hardcoded model strings:

```yaml
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
  model: main                   # main thread uses this named model
```

The main agent's model is set via `agent.model`. Templates and explicit spawns reference models by name. Change the definition once, it ripples everywhere.

Complex tasks can override with a different named model:

```ts
spawn_agent({
  task: "Architect the payment refund system",
  model: "opus",               // references the named model, not a raw model string
  tools: ["files", "web"]
})
```

## Concurrency

Multiple agents can run simultaneously. Koshi manages:
- Active agent count (configurable limit)
- Queue if limit exceeded
- Timeout enforcement
- Result delivery

```yaml
agents:
  maxConcurrent: 3        # max parallel agents
  defaultTimeout: 300     # 5 minutes default
```

## What This Replaces

In OpenClaw:
- `sessions_spawn` creates isolated sessions with full session management
- Sessions persist, have history, need cleanup
- Main session has ALL tools and delegates by convention (AGENTS.md instructions)
- Sub-agents are heavyweight — separate sessions with their own lifecycle

In Koshi:
- `spawn_agent` creates an ephemeral API call via the Anthropic service plugin
- No session persistence — work is done, result stored as memory, conversation discarded
- Main thread has NO execution tools — delegation is structural, not instructional
- Sub-agents are lightweight — just another Claude API conversation with tools
- Routing rules can spawn agents without main thread involvement — massive token savings

## Decisions

### No nested agents (v1)
Sub-agents cannot spawn their own sub-agents. Flat hierarchy only. Anthropic does it this way for a reason — nested spawning could spiral exponentially. The main thread (or the router) is the only coordinator.

### Streaming output
Sub-agent output streams to the main thread in real time. The TUI can show it if the user wants visibility into background work — a side panel or collapsible section. Default: collapsed, expandable on demand. The main thread always sees results.

### Agent Templates
Pre-configured tool sets for common tasks. Users can define their own, and the main agent can create new ones at runtime.

```yaml
# koshi.yaml
templates:
  coder:
    tools: [exec, files]
    model: local                # uses the local Ollama model
    timeout: 300
  researcher:
    tools: [web, files]
    model: main                 # uses the main Sonnet model
    timeout: 120
  reviewer:
    tools: [exec, files, web]
    model: opus                 # uses the Opus model
    timeout: 300
```

Templates reference named models, not raw model strings. Change the model definition once in `models:`, every template using that name picks up the change.

Usage:
```ts
spawn_agent({
  template: "coder",
  task: "Fix lint errors in src/api/webhook.ts"
})

// Or override template defaults with a different named model
spawn_agent({
  template: "coder",
  task: "Complex refactor of payment module",
  model: "opus",               // override to a more capable model
  timeout: 600
})
```

The main agent can also create templates on the fly — if it notices a recurring task pattern, it saves a new template to config. User templates and agent-created templates live in the same config, both editable.

Similarly, the main agent can write new routing rules — it becomes an architect that builds automation rather than a worker that handles everything.

## Cost Tracking

Every agent run tracks token usage:

```sql
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY,
  agent_run_id TEXT,              -- NULL for main thread turns
  session_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model TEXT,
  cost_usd REAL,                  -- estimated from token counts × model pricing
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Koshi records usage after each Claude API response. Cost is estimated from published per-token pricing (hardcoded per model, updated with releases).

CLI:
```bash
koshi usage                     # today's totals
koshi usage --period 7d         # last 7 days
koshi usage --by-model          # breakdown by model
koshi usage --by-template       # breakdown by agent template
```

This is just accounting — no enforcement or limits in v1. But having the data means you can spot expensive patterns and adjust.

## Tool Sandboxing

Sub-agents have restricted access to tools. The boundaries:

### `exec` tool
- Working directory is locked to the project workspace (where `koshi.yaml` lives)
- Cannot `cd` above the workspace root
- Configurable command allowlist/denylist per template:
  ```yaml
  templates:
    coder:
      tools: [exec, files]
      exec:
        allowlist: ["git", "pnpm", "npm", "node", "tsc", "eslint"]
  ```
- No `sudo` by default — must be explicitly allowed
- Timeout applies to individual commands, not just the agent run

### `files` tool
- Read/write restricted to workspace directory and below
- No access to `~/.koshi/`, config files, or system paths
- Symlinks that escape the workspace are rejected
- Configurable additional paths:
  ```yaml
  templates:
    researcher:
      tools: [files, web]
      files:
        extraPaths: ["/home/user/shared/data"]
  ```

### General principles
- Sub-agents cannot modify `koshi.yaml` or any runtime config (only the main agent can write routing rules/templates)
- Sub-agents cannot spawn other agents (no nested spawning, v1)
- All tool calls are logged with the agent run ID for audit
- The main thread is the only trust boundary — it decides what tools each agent gets
