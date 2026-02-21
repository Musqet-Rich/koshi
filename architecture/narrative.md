# Narrative Memory

> **Status: Not yet built.** Design document from brainstorming session on 2026-02-20. Implementation TBD.

## The Problem

[Memories](./memory.md) in Koshi are isolated facts — "Rich likes apples", "Config weights use exp(score * 0.2)". They're true but disconnected. There's no record of *why* a decision was made, what was rejected, or how one insight led to the next.

A **narrative** is the reasoning arc that connects facts. It holds the thread, not the content.

## Structure

Narratives are a new [memory](./memory.md) type tagged `source:narrative`. They don't replace fact memories — they reference them.

Rich's model: a narrative is like a block in a blockchain.

Each narrative contains:

1. **Summary** — one sentence describing the reasoning arc
2. **Memory references** — array of memory IDs it connects (like transaction hashes in a block)
3. **previous_narrative_id** — link to the prior narrative (like a previous block hash)

Memories are the "transactions" — already in the DB, searchable, scored. Narratives don't duplicate them. They just hold the thread. This makes narratives small and cheap.

Walk backwards through the chain to reconstruct any reasoning thread. How far back depends on how much context is needed.

## Topic Boundaries

- Topic change detection determines where one narrative ends and another begins
- Same topic across sessions = same narrative continues
- New topic = new narrative, with a back-link to the previous one
- The model detects topic shifts naturally — no algorithmic classification needed

## Relationship to Compaction

Current [compaction](./overview.md#sessions): wait until 180k tokens, summarize oldest 70%. Expensive, lossy, blunt.

Proposed incremental compaction:

- After each turn, a small background call updates the running narrative
- The narrative is: one summary sentence + memory ID references
- Raw exchanges can drop out of context; the narrative preserves coherence
- End of session, the final narrative gets stored as `source:narrative`
- Next session, it's available for recall — the train of thought resumes

Compaction becomes trivial: just a sentence plus IDs. If detail is needed, follow the IDs to the actual memories.

## Context Window Impact

At any point, the context window contains:

- The current narrative (tiny — one sentence + IDs)
- The last few raw exchanges
- Whatever memories were pulled via mid-call recall

Everything else is reachable but not loaded. Lean by default, deep on demand.

## Provenance Tags (Full Set)

With narratives, the complete tag taxonomy becomes:

- `source:conversation` — facts from user exchanges
- `source:agent` — [sub-agent](./agents.md) operational output
- `source:extraction` — background-extracted insights
- `source:narrative` — trains of thought, decision arcs, session flow

During recall, narrative memories are often worth more than fact memories because they carry the "why" not just the "what."

## Tool API

> **Status: Decided.** Implementation not yet built.

Two tools expose the narrative system to the model: `narrative_update` and `narrative_search`. No other tools are needed. There is no scoring, reinforcement, or demotion — narratives are always valid, sorted by time only.

### `narrative_update`

Creates a new narrative entry.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `summary` | `string` | One-sentence summary of the reasoning arc |
| `memory_ids` | `number[]` | Array of memory IDs this narrative references |
| `previous_narrative_id` | `number \| null` | ID of the prior narrative in the chain, or `null` to start a new thread |
| `topic` | `string` | Topic label for this narrative |

If `previous_narrative_id` is set, the new entry is a **continuation** of an existing chain. If `null`, it starts a **new thread**.

### `narrative_search`

Retrieves narratives. Operates in three modes depending on which parameters are provided.

**Modes:**

1. **By ID** — fetch a specific narrative for chain-walking (follow `previous_narrative_id` links backwards).
2. **By keyword** — FTS5 full-text search across narrative summaries.
3. **No params** — return the latest narrative. This is the session recovery path ("where was I?").

Forward traversal is also supported: when viewing a narrative, you can find what came next by searching for narratives that reference it as their `previous_narrative_id`. This requires no additional schema — just a query in the reverse direction (`WHERE previous_narrative_id = current_id`).

All modes return narratives with summaries and memory ID references, sorted by `created_at` descending.

### Schema

```
id                    INTEGER PRIMARY KEY
summary               TEXT
memory_ids            JSON ARRAY (of memory IDs)
previous_narrative_id INTEGER (nullable, FK to self)
topic                 TEXT
created_at            TIMESTAMP
```

No `score`, no `last_hit_at`, no [reinforcement](./memory.md#ranking) columns. Narratives are immutable facts about what happened — they never become less valid over time.

The [`memories` table](./memory.md#schema) also gets a new nullable column:

```
narrative_id  INTEGER (nullable, FK to narratives.id)
```

This stamps each memory with the narrative that was active when it was created. Pre-narrative memories will have `NULL`.

### Bidirectional Link: Memories ↔ Narratives

The relationship runs both ways:

- **Narrative → Memories**: the `memory_ids` array in the narrative lists the facts it connects.
- **Memory → Narrative**: the `narrative_id` column on the memory points back to the narrative that was active when it was stored.

This enables a full recall chain from any starting point:

1. Find a memory (via search, reinforcement hit, whatever).
2. Follow its `narrative_id` → get the narrative summary and topic.
3. Follow the narrative's `memory_ids` → get sibling facts from the same reasoning arc.
4. Walk `previous_narrative_id` → get deeper history, earlier decisions, rejected alternatives.

One memory becomes a door into the entire thread. No separate lookup needed — just follow the links.

### Session Recovery

The primary session-start story:

1. New session begins.
2. Model calls `narrative_search()` with no parameters.
3. Returns the latest narrative — its summary plus the memory IDs it references.
4. Model is caught up in one query.

If more context is needed, the model follows the chain backwards.

### Chain-Walking

To reconstruct a full reasoning thread:

1. Get a narrative (from session recovery or keyword search).
2. Read its `previous_narrative_id`.
3. Call `narrative_search(id)` with that ID.
4. Repeat backwards as far as needed.

This is the blockchain analogy in practice — each block points to the previous one, and walking the chain reconstructs the full history.

#### Bidirectional Traversal

Forward traversal is also possible without any schema change. The `previous_narrative_id` back-link enables both directions:

- **Backward**: read `previous_narrative_id` from the current narrative.
- **Forward**: query `WHERE previous_narrative_id = current_id` to find the narrative that came after.

No `next_narrative_id` column is needed — the back-link does both jobs. The narrative chain is fully traversable in both directions with the existing schema.

## Design Principles

1. Narratives are lightweight — summary + memory IDs + previous link. Never the full story.
2. Long-term memories hold the facts. Narratives hold the thread.
3. Topic shift = new narrative. Same topic = continue, even across sessions.
4. Each narrative links to the previous one — traversable chain.
5. The model detects boundaries and writes summaries — no separate classifier.
6. Incremental, not batch — small updates each turn, not one massive compaction.
7. No scoring or demotion — narratives are always valid, sorted by time only.
