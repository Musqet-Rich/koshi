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
┌─────────────────────────────────────┐
│          System Prompt              │
├─────────────────────────────────────┤
│ 1. Identity (from koshi.yaml)       │  ~200 tokens, always present
│ 2. Tools (auto-generated schemas)   │  only loaded tools
│ 3. Relevant memories (queried)      │  top N by relevance to current msg
│ 4. Active context (if any)          │  current task, open files, etc.
└─────────────────────────────────────┘
```

### 1. Identity

From the `identity.soul` field in `koshi.yaml`. Plain text. The user writes it, the user owns it. No wrapping, no injection around it.

```yaml
identity:
  soul: |
    You are Koshi. Calm, direct, dry wit.
    You run on a dedicated home server.
    Push back when the user is wrong. They respect directness.
```

### 2. Tools

Auto-generated from loaded tool plugins. Each tool declares its name, description, and JSON schema. Koshi formats these for Claude's tool_use API — no prompt engineering needed, Claude handles tools natively.

### 3. Relevant Memories

This is the key difference. Instead of dumping MEMORY.md (all memories) into every turn:

1. User sends a message
2. Koshi extracts keywords / intent
3. Queries memory DB: `SELECT * FROM memories WHERE ... ORDER BY relevance LIMIT 10`
4. Injects only matching memories into system prompt
5. Sends to Claude via the Anthropic service plugin

If the user asks about "API authentication", only auth-related memories load. Not the refund proposal, not the Slack integration, not the nightly build notes.

### 4. Active Context

Optional, ephemeral. If the agent is mid-task (editing a file, reviewing a PR), that context stays attached until the task completes. Not permanently in the prompt.

## Safety

OpenClaw hardcodes safety rules the user can't remove. Reasonable, but opaque.

Koshi ships a default `safety.md` that's included in the identity section. The user can see it, and technically edit it — but the defaults are sensible and we document why each rule exists. Trust the user, be transparent.

## Token Budget

Target: <2KB system prompt for a typical turn. Compare to OpenClaw's 10KB+.

The savings come from:
- No redundant context (memory is queried, not dumped)
- No hidden boilerplate (no tool-call-style instructions Claude doesn't need)
- No skill catalogue listing (tools are declared via API, not prompt text)
- Identity is short (user writes what matters, not a template)

## Resolved Questions

- **Cache memory query results across turns:** Skip for v1. SQLite FTS5 is sub-millisecond. Premature optimisation.
- **First message cold start:** The user's message provides the keywords for memory lookup. A greeting like "Hi" needs no memory context. No special handling required.
- **Mid-turn memory requests:** Yes. `memory_query` is a tool the main agent can call at any time during a turn.
