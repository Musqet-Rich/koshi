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

The counter: the LLM handles synonyms. Before querying, the LLM expands the search terms with synonyms in a single pass (e.g. "car" → "car OR automobile OR vehicle"). One query, no retries. The search stays dumb and fast, the intelligence is in the caller.

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
  source TEXT,                     -- where it came from (conversation, slack, pr, research)
  tags TEXT,                       -- comma-separated keywords
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_hit_at DATETIME,           -- last time this memory was retrieved
  score INTEGER DEFAULT 0,        -- reinforcement score (positive = useful, negative = stale/wrong)
  session_id TEXT                  -- which session created this memory
);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  tags,
  source,
  content='memories',
  content_rowid='id'
);
```

## Retrieval Flow

```
User message
    │
    ▼
LLM generates expanded query (keywords + synonyms in one pass)
    e.g. "api auth" → "api OR auth OR authentication OR signature OR hmac"
    │
    ▼
Single FTS5 query — broad net, BM25 ranks by relevance
    │
    ├── Results found → inject top N into system prompt
    │
    └── No results → proceed without memory (don't loop)
```

One query, one DB hit. No retry loops. The synonym expansion happens before the search, not after a miss.

## Ranking

Three signals combined:

```
score = BM25_relevance × (1 + max(score, 0)) × recency_factor
```

- **BM25 relevance** — how well the keywords match
- **Reinforcement score** — explicit signal from the agent about usefulness (positive = useful, negative = stale/wrong)
- **Recency** — slight boost for newer memories (configurable decay)

Negative-scored memories are still returned if they match, but ranked lower — the `max(score, 0)` means negative scores don't boost, only positive ones do. A memory reinforced several times dominates over one that's never been confirmed useful.

The ranking is Hebbian in nature — neurons that fire and are confirmed useful strengthen. But unlike a passive hit counter, the agent makes an explicit judgement: "this memory helped me" (reinforce) or "this is wrong/stale" (demote). Memories that are returned but not acted upon receive no signal — neutral, not punished.

If the first expanded query returns nothing, the memory genuinely doesn't exist — don't waste API calls retrying.

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

The agent interacts with memory through four tools:

```ts
// Remember something
memory_store({
  content: "Payment API HMAC signature: when no request body, signature string must NOT include trailing empty string",
  source: "conversation",
  tags: "payments, hmac, api, bug"
})

// Recall something
memory_query({
  query: "payment API HMAC",
  limit: 5
})

// This memory was useful to me (+3)
memory_reinforce(id)

// This memory is wrong/stale/irrelevant (-1)
memory_demote(id)
```

**Why asymmetric weights**: Confirming usefulness is a stronger signal than noting irrelevance. A memory reinforced once (+3) survives three demotions before going neutral. Takes consistent irrelevance to kill a proven memory.

**Flow**:
1. User message → automatic query → top N memories injected into context
2. Agent reasons, finds memory #3 useful
3. Agent calls `memory_reinforce(3)` — score += 3
4. Memories not used get nothing (neutral, not punished)
5. Agent spots memory #5 is outdated → `memory_demote(5)` — score -= 1

The agent learns what matters to its user over time. Two users with similar memories develop completely different rankings based on actual usage patterns. Personalised without personalisation logic.

## Forgetting & Pruning

Memories can be explicitly deleted, or automatically pruned when space is needed:

- `memory_forget(id)` — delete a specific memory
- **Size-based pruning** — pruning only triggers when the database hits a size or count limit. When triggered, the bottom N% by score are archived. No arbitrary score threshold — a memory at -8 lives forever if the DB has room. Only when space is needed does Koshi ask "who's least useful?" and archive from the bottom up.
  - Archived to `memories_archive` table (not deleted)
  - Recoverable via `koshi memories --archived`
  - A low-scoring memory with rare but important keywords is still valuable — it only gets pruned if it's truly at the bottom of the pile AND the DB needs space
- Manual review — `koshi memories` CLI to browse, prune, export

```yaml
memory:
  reinforceWeight: 3
  demoteWeight: -1
  maxSize: 100MB            # pruning triggers when this is exceeded
  # maxEntries: 100000      # alternative: cap by count
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

## Resolved Decisions

- **Conversation summaries** — auto-store a summary at session end and before compaction.
- **Memory deduplication** — housekeeping cron job detects and merges near-duplicate entries.
- **Export** — `koshi memories export` CLI command. It's just one SQLite file, but a clean command makes it explicit.
- **Synonym lookups** — hybrid approach: ship a small built-in synonym map, agent can extend it over time. Avoids API call for common expansions. Map is user/agent extensible.
