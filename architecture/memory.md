# Memory Architecture

## Design

SQLite + FTS5 for storage and retrieval. The LLM is the semantic layer — no embeddings needed.

## Why FTS5

- Zero dependencies (ships with better-sqlite3)
- No API costs
- Millisecond queries
- Deterministic — you can see why a result matched
- BM25 ranking (relevance scoring)
- One portable `.db` file

## Why Not Embeddings

The standard argument for vector search: "car" doesn't match "automobile" in keyword search.

The counter: the model IS the keyword extractor. When the agent calls `memory_query`, it extracts key nouns and natural synonyms from the user's message and constructs a targeted keyword search. No static synonym maps, no thesaurus — the model understands what to search for. The search stays dumb and fast, the intelligence is in the caller.

Benefits over embeddings:
- No embedding API costs per query
- No embedding model dependency
- Debuggable — you can see exactly what matched and why
- No vector DB to maintain
- No dimensional drift when embedding models change

## Schema

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,           -- the actual memory (clean, agent-written)
  source TEXT,                     -- provenance tag: conversation, agent, extraction, narrative
  tags TEXT,                       -- comma-separated keywords
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_hit_at DATETIME,           -- last time this memory was retrieved
  score INTEGER DEFAULT 0,        -- reinforcement score (positive = useful, negative = stale/wrong)
  session_id TEXT,                 -- which session created this memory
  narrative_id INTEGER,            -- links to the narrative active when this memory was created (nullable)
  task_id INTEGER                  -- links to the task that produced this memory (nullable)
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  source,
  content='memories',
  content_rowid='id'
);
```

See [narrative.md](./narrative.md#provenance-tags-full-set) for the full provenance tag taxonomy and [narrative.md](./narrative.md#bidirectional-link-memories--narratives) for how `narrative_id` enables bidirectional traversal between memories and narratives.

## Retrieval Flow

Memory recall is fully model-driven. There is no automatic pre-injection — the agent queries memory mid-call via the `memory_query` tool. See [system prompt architecture](./system-prompt.md#3-memory-recall-instructions) for how the recall protocol is communicated to the model.

```
User message arrives
    │
    ▼
Agent reads the message, identifies key concepts
    │
    ▼
Agent calls memory_query with targeted keywords + natural synonyms
    e.g. user asks about "api auth" → query "api auth authentication signature hmac"
    │
    ├── Results found → agent uses them, reinforces/demotes as appropriate
    │
    ├── Insufficient results → agent queries again with different terms (up to 3 rounds)
    │
    └── No results → proceed without memory
```

The agent controls the entire recall loop. Up to 3 queries per message, each informed by previous results. No static synonym maps — the model handles expansion naturally.

## Ranking

Three signals combined:

```
finalRank = bm25 × Math.exp(score × 0.2) × 1/(1 + daysSince × 0.01)
```

- **BM25 relevance** (`bm25`) — how well the keywords match (FTS5 rank, negated so higher = better)
- **Score weight** (`Math.exp(score × 0.2)`) — exponential scaling of the reinforcement score. Works in both directions: score 3 = 1.82x boost, score 0 = 1.0x (neutral), score -1 = 0.82x penalty, score -5 = 0.37x penalty. Demotion genuinely pushes memories down.
- **Recency** (`1/(1 + daysSince × 0.01)`) — uses `last_hit_at` when available, falling back to `created_at`. When a memory is reinforced, its recency clock resets via `last_hit_at`, giving recently-confirmed memories a recency boost.

The ranking is Hebbian in nature — neurons that fire and are confirmed useful strengthen. The agent makes an explicit judgement: "this memory helped me" (reinforce) or "this is wrong/stale" (demote). Memories that are returned but not acted upon receive no signal — neutral, not punished.

Memory results include IDs in `[id:N]` format so the agent can reinforce or demote them directly.

## Data Quality

The agent writes all memories, never the user directly. This means:
- Correct spelling always (user can type badly, agent cleans it up)
- Consistent formatting
- Proper tags
- No garbage in, no garbage out

## Storage Flow

Memories are stored when something worth remembering happens:

1. **Explicit** — Claude decides "this is worth remembering" and calls the store tool
2. **Automatic** — key decisions, user corrections, new facts get auto-stored
3. **Import** — bulk import from existing files (migration from OpenClaw's flat files)

Each memory is a discrete unit. Not a daily log, not a giant document — a single fact, decision, or piece of context.

## Tool Interface

The agent interacts with memory through five tools:

```ts
// Remember something
memory_store({
  content: "Payment API HMAC signature: when no request body, signature string must NOT include trailing empty string",
  tags: "payments, hmac, api, bug"
})

// Recall something (agent extracts keywords, no raw questions)
memory_query({
  query: "payment HMAC signature api",
  limit: 5
})

// This memory was useful to me (+3)
memory_reinforce(id)

// This memory is wrong/stale/irrelevant (-1)
memory_demote(id)

// Fix or update a memory in place (preserves score, refreshes last_hit_at)
memory_update(id, "corrected content", "updated, tags")
```

**Why asymmetric weights**: Confirming usefulness is a stronger signal than noting irrelevance. A memory reinforced once (+3) survives three demotions before going neutral. Takes consistent irrelevance to kill a proven memory.

**Flow**:
1. User message arrives
2. Agent reads the message, extracts key concepts and natural synonyms
3. Agent calls `memory_query` with targeted keywords (up to 3 rounds)
4. Agent finds memory #3 useful → `memory_reinforce(3)` — score += 3, `last_hit_at` resets
5. Memories not used get nothing (neutral, not punished)
6. Agent spots memory #5 is outdated → `memory_demote(5)` — score -= 1
7. Agent spots memory #7 has wrong content → `memory_update(7, "corrected content")` — updated in place

The agent learns what matters to its user over time. Two users with similar memories develop completely different rankings based on actual usage patterns. Personalised without personalisation logic.

## Pruning

Store everything, delete almost nothing. Pruning is a last resort at hard size limits only.

- **Size-based pruning** — a [cron job](./daemon.md) (default 4am daily, configurable via `pruneSchedule`) checks the DB file size against `maxSize`. Only when the limit is exceeded does it archive the bottom N% by combined score+recency ranking (same formula as query re-ranking: `scoreWeight × recency`). No arbitrary score threshold — a memory at -8 lives forever if the DB has room.
  - Archived to `memories_archive` table (never truly deleted)
  - Archive is FTS5-searchable via `queryArchive`
  - A low-scoring memory with rare but important keywords is still valuable — it only gets pruned if it's truly at the bottom of the pile AND the DB needs space

Demotion means "less relevant now" not "less valuable forever". Pruning archives, never truly deletes.

```yaml
memory:
  reinforceWeight: 3
  demoteWeight: 1
  maxSize: 100MB            # pruning triggers when this is exceeded
  pruneSchedule: "0 4 * * *"  # when to check (cron syntax, default 4am)
  prunePercent: 1           # archive bottom 1% when limit hit
```

## Migration

From OpenClaw flat files (MEMORY.md, memory/*.md):
- Parse into discrete memories
- Store each as a separate entry with source="migration"
- One-time import, then the files are no longer needed

## Capacity

SQLite FTS5 handles millions of rows efficiently. For a personal assistant's lifetime of memories, this is effectively unlimited. No scaling concerns.

## Future: Relations (v2)

Memories that get recalled together should link together — same Hebbian principle.

```sql
CREATE TABLE memory_links (
  memory_id INTEGER REFERENCES memories(id),
  related_id INTEGER REFERENCES memories(id),
  strength REAL DEFAULT 1.0,       -- reinforced each time co-recalled
  PRIMARY KEY (memory_id, related_id)
);
```

When memories A and B appear in the same query result, link them and increment strength. Then retrieving one can pull its related memories — following a chain of thought. "payment API HMAC" → API onboarding → a related debugging session.

Not needed for v1 — FTS5 + hit ranking gets us far. Schema is easy to add later. But don't forget this exists.

## FTS5 Query Handling

FTS5 queries are sanitised before execution:
1. URLs stripped (they produce noisy, FTS5-incompatible tokens)
2. Hyphens split to spaces (FTS5 interprets "word-word" as column:term or subtraction)
3. Remaining punctuation and FTS5-special characters stripped
4. Single-character tokens dropped
5. Each remaining word quoted for literal matching (`"word"`) to prevent column-reference or operator misparses
6. Words joined with OR for broad matching

Synonym expansion is handled entirely by the agent at query time — no static maps.

## Resolved Decisions

- **Conversation summaries** — auto-store a summary at session end and before [compaction](./narrative.md#relationship-to-compaction).
- **Export** — `koshi memories export` CLI command. It's just one SQLite file, but a clean command makes it explicit.
- **Synonym lookups** — the model IS the keyword extractor. Static synonym maps were removed (`synonyms.ts` is a no-op). The agent naturally includes synonyms when constructing `memory_query` calls. No thesaurus, no stop-word lists.
