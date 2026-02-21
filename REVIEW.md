# Koshi Docs Review

## Sanitisation Changes

| File | Change |
|------|--------|
| `architecture/overview.md` | `name: monomi` → `name: koshi` in config example |
| `architecture/overview.md` | "You are Monomi. Calm, direct, dry wit..." → "You are Koshi..." |
| `architecture/overview.md` | `wss://relay.monomi.org` → `wss://relay.example.com` |
| `architecture/overview.md` | "No TUI" → "No web dashboard" (was also a contradiction, see below) |
| `architecture/system-prompt.md` | "You are Monomi..." / "Rich's home" / "Rich is wrong" → generic equivalents |
| `architecture/system-prompt.md` | "Shift4 HMAC" example → "API authentication" |
| `architecture/memory.md` | All "Shift4" references → "payment API" / "payments" |
| `architecture/memory.md` | "Rigel's debugging session" → "a related debugging session" |
| `architecture/memory.md` | "Claude reformulates" → "the LLM reformulates" (consistency) |
| `architecture/daemon.md` | `name: monomi` → `name: koshi`, "You are Monomi" → "You are Koshi" |
| `architecture/tasks.md` | `rich.monomi.org` → removed from table |
| `architecture/tasks.md` | "shift4-integration" → "api-integration" in examples |
| `LICENSE` | Clean — standard GPL3, no personal info |
| `README.md` | Clean — no personal info found |

## Inconsistencies

### 1. "No TUI" listed in "What's NOT here" — but TUI is a major feature (FIXED)

**overview.md** had a dedicated TUI section describing the TUI in detail, then listed "No TUI" under "What's NOT here". This was clearly a copy-paste artifact. Changed to "No web dashboard" which is actually accurate.

### 2. Memory retrieval: retry or no retry? (RESOLVED)

Memory recall is now fully model-driven. The agent queries memory mid-call via the `memory_query` tool — up to 3 rounds per message, each informed by previous results. No automatic pre-injection, no static synonym expansion. The contradiction has been resolved by removing the runtime-side query entirely and letting the agent control the full recall loop.

### 3. Main thread tools — agents.md vs overview.md (RESOLVED)

The system prompt now explicitly lists forbidden tools by name (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit) and states the reason: blocks main thread, bloats context. agents.md has been updated with the full permitted tools list. The `tools: [exec, files, web]` entries in templates are clearly sub-agent-only — these are referenced by agent templates, not the main thread.

### 4. Cron terminology

**overview.md** calls it `cron` with a `task` string field:
```yaml
cron:
  - name: lookout
    schedule: "30 7 * * *"
    task: "Publish the morning briefing"
```

**tasks.md** shows cron creating structured task objects:
```yaml
cron:
  - name: morning-briefing
    schedule: "30 7 * * *"
    task:
      title: "Publish morning briefing"
      template: "researcher"
      autoRun: true
```

These are different schemas. The tasks.md version is richer and more consistent with the task system.

### 5. Server plugin vs "no ports"

**daemon.md** says "The daemon itself doesn't open any ports" then describes a server plugin. This is fine conceptually but **overview.md** doesn't mention the server plugin at all, and the plugin directory listing doesn't include it. It should be listed somewhere.

### 6. CBOR vs JSON — not mentioned in overview

**daemon.md** introduces CBOR for IPC protocol. This is a meaningful technical decision not referenced in the overview or any other doc.

## Architecture Assessment

### Strengths

- **Clear separation of concerns.** Core vs plugins, main thread vs sub-agents, durable tasks vs ephemeral agents. The layering is clean.
- **FTS5 over embeddings is a strong call.** For a personal assistant with one user, keyword search + model-driven recall is simpler, cheaper, and more debuggable than vector search. The "model IS the keyword extractor" approach works — no static synonym maps needed.
- **Structural delegation.** The system prompt explicitly lists forbidden tools and the main thread's tool set doesn't include them. Combined with MCP-based tool scoping via `--allowedTools`, this is a better pattern than OpenClaw's convention-based delegation.
- **Single config file.** `koshi.yaml` consolidating everything is a good DX decision.
- **Memory scoring.** Reinforcement/demotion feedback loop with exponential weight formula (`Math.exp(score * 0.2)`) gives meaningful ranking that works in both directions. Recency uses `last_hit_at` so reinforced memories stay fresh.
- **Transparent system prompt.** No hidden prompt injection is a genuine differentiator and trust builder.

### Weaknesses

- **Claude-only is a feature AND a risk.** Great for focus, but one pricing change or API outage and you're stuck. No escape hatch.
- **No auth model.** Listed as an open question but critical for multi-channel deployment. Anyone who can reach a channel can talk to the agent.
- **Memory deduplication is punted.** Over time, similar memories will accumulate. Hit counting helps surface the best one, but storage will grow with duplicates.
- **No backup/restore story.** SQLite is the single source of truth for memory and tasks. One corruption event loses everything.

### Gaps

- **Error handling.** None of the docs discuss what happens when Claude API fails mid-agent-run, when a channel disconnects, when SQLite hits disk limits, etc.
- **Logging and observability.** daemon.md mentions a log file but there's no structured logging, no metrics, no way to understand agent performance or costs over time.
- **Cost tracking.** Sub-agents make API calls. There's no mention of tracking token usage, cost per task, or budget limits.
- **Plugin API specification.** The interfaces are sketched but there's no plugin lifecycle (init, configure, health check, graceful shutdown).
- **Testing strategy.** No mention of how to test plugins, agents, or the system as a whole.
- **Security model for tools.** Sub-agents get `exec` and `files`. What are the boundaries? Can they `rm -rf /`? Sandbox? Permissions?

### Risks

- **Scope creep from OpenClaw comparison.** Several docs define Koshi by what OpenClaw does wrong. This is useful for motivation but risks building a reaction rather than a product. Some OpenClaw patterns (like context stuffing) are dismissed but may have pragmatic value worth understanding.
- **Single-process SQLite.** Fine for v1, but if sub-agents are concurrent and all writing memories/tasks, WAL mode and write contention need consideration.
- **Memory quality depends entirely on the LLM.** "The agent writes all memories" is clean but means memory quality is as good as the model's judgment about what's worth remembering. No user override mechanism is described.

## Suggestions

1. ~~**Resolve the retry contradiction in memory.md**~~ — DONE. Memory recall is now model-driven (up to 3 queries per message).
2. ~~**Add a "tools are sub-agent-only" note to overview.md and daemon.md**~~ — DONE. System prompt lists forbidden tools explicitly. agents.md documents the full permitted/forbidden split.
3. **Unify cron schema** between overview.md and tasks.md
4. **Add server plugin to overview.md** plugin listing
5. **Write an error-handling doc** or at least a section in daemon.md
6. **Add cost tracking** to the agent architecture — even a simple token counter per run
7. **Consider a `koshi backup` command** — dump SQLite + config to a tarball
8. **Add a security section** covering tool sandboxing for sub-agents
