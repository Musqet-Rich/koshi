# System Prompt Architecture

## The Problem with OpenClaw

OpenClaw builds the system prompt from two sources:

### 1. Hardcoded (in source code, user can't see or edit)
- Base identity: "You are a personal assistant running inside OpenClaw"
- Safety rules (don't manipulate, don't copy yourself, etc.)
- Tool call style instructions
- Silent reply rules (NO_REPLY, HEARTBEAT_OK)
- Reply tag syntax
- Messaging routing rules
- Runtime metadata (OS, model, channel, capabilities)
- Sub-agent framing for spawned sessions
- Sandbox awareness

### 2. User workspace files (visible, editable)
- AGENTS.md — agent behaviour rules
- SOUL.md — personality/identity
- USER.md — info about the human
- MEMORY.md — long-term context
- HEARTBEAT.md — background task instructions
- TOOLS.md — local tool notes
- IDENTITY.md — name/avatar card
- Skill descriptions (front matter from all skills)
- Any other workspace files configured for injection

**Result:** ~10KB+ system prompt on every turn. Much of it irrelevant to the current message. Expensive, noisy, and the user can't see half of it.

## Koshi's Approach

### Principle: No hidden prompts

Everything in the system prompt comes from files the user can see and edit. The runtime adds nothing invisible.

### Principle: Dynamic, not static

The system prompt is assembled per-turn based on what's relevant, not dumped wholesale at boot.

### Structure

```
┌─────────────────────────────────────────┐
│          System Prompt                  │
├─────────────────────────────────────────┤
│ 1. Identity (from koshi.yaml)           │  ~200 tokens, always present
│ 2. Architecture & Tool Rules            │  forbidden tools, delegation model
│ 3. Memory Recall Instructions           │  model-driven query protocol
│ 4. Current Time                         │  UTC timestamp
│ 5. Available Skills (index)             │  names + descriptions
│ 6. Active Skills (if triggered)         │  full content for matched skills
│ 7. Active context (if any)              │  current task, etc.
└─────────────────────────────────────────┘
```

### 1. Identity

From the `identity.soul` field in [`koshi.yaml`](./overview.md#config-koshiyaml). Plain text. The user writes it, the user owns it. No wrapping, no injection around it.

```yaml
identity:
  soul: |
    You are Koshi. Calm, direct, dry wit.
    You run on a dedicated home server.
    Push back when the user is wrong. They respect directness.
```

### 2. Architecture & Tool Rules

The prompt explicitly frames the agent as a [coordinator](./agents.md#coordinator-main-thread): "Think, decide, delegate — in that order. Never act directly."

**Forbidden tools** are listed by name with a clear reason:
> Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit
> Using them directly blocks the main thread, bloats your context window, and defeats the architecture.

These are Claude Code tools that are behaviorally forbidden (listed in the prompt). In the Claude Code/MCP bridge, they cannot be structurally removed — but the prompt instructs the coordinator not to use them.

**Permitted tools** are listed explicitly:
- Scheduling: `schedule_job`, `cancel_job`, `list_jobs`
- [Memory](./memory.md#tool-interface): `memory_store`, `memory_query`, `memory_update`, `memory_reinforce`, `memory_demote`
- Skills: `load_skill`, `create_skill`, `update_skill`
- [Delegation](./agents.md#spawn-signature): `spawn_agent`, `list_agents`, `read_file`

Note: `read_file` (an MCP tool for reading agent output files) is permitted and distinct from `Read` (a Claude Code file reading tool) which is forbidden. The coordinator uses `read_file` to access agent results.

**Background spawning rule**: Always spawn agents with `run_in_background: true` unless the result is needed before responding. Respond immediately after spawning — do not wait.

### 3. Memory Recall Instructions

No automatic pre-injection. The system prompt instructs the agent to use the [model-driven recall](./memory.md#retrieval-flow) protocol:
1. Read the user's message
2. Identify key concepts, names, topics — the words that matter
3. Call `memory_query` with targeted keywords (include natural synonyms)
4. If the first query doesn't surface what's needed, query again with different terms — up to 3 queries per message
5. Reinforce/demote recalled memories based on usefulness
6. Then respond, grounded in what was found

The model IS the keyword extractor — no static stop-word lists, no synonym thesaurus.

Memory results include IDs in `[id:N]` format. The prompt instructs the agent to call `memory_reinforce(id)` when a memory helped or `memory_demote(id)` when it was irrelevant/outdated. This closes the [feedback loop](./memory.md#ranking).

Short messages like "hi" or "ok" don't need memory queries. The agent uses judgment.

### 4. Available Skills

The [skill index](./agents.md#skill-defined-tool-scope) (name + one-line description) is always present. Full skill content is loaded when triggers match the user message or when the agent calls `load_skill`.

### 5. Active Context

Optional, ephemeral. If the agent is mid-task, that context stays attached until the task completes. Not permanently in the prompt.

## Safety

OpenClaw hardcodes safety rules the user can't remove. Reasonable, but opaque.

Koshi ships a default `safety.md` that's included in the identity section. The user can see it, and technically edit it — but the defaults are sensible and we document why each rule exists. Trust the user, be transparent.

## Token Budget

Target: <2KB system prompt for a typical turn. Compare to OpenClaw's 10KB+.

The savings come from:
- No memory dumping (memory is model-driven via tool calls, not pre-injected)
- No hidden boilerplate (no tool-call-style instructions Claude doesn't need)
- Skills loaded on demand (only matched skills included, not the full catalogue)
- Identity is short (user writes what matters, not a template)

## Resolved Questions

- **Cache memory query results across turns:** Skip for v1. SQLite FTS5 is sub-millisecond. Premature optimisation.
- **First message cold start:** The agent queries memory if the message warrants it. A greeting like "Hi" needs no memory query. No special handling required.
- **Mid-turn memory requests:** Yes. `memory_query` is a tool the agent calls proactively during every non-trivial turn — up to 3 rounds per message.
