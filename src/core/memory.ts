import type Database from 'better-sqlite3'
import type { MemoryResult } from '../types.js'
import { createLogger } from './logger.js'
import { expandSynonyms } from './synonyms.js'

const log = createLogger('memory')

interface MemoryRow {
  id: number
  content: string
  source: string | null
  tags: string | null
  score: number
  created_at: string
  last_hit_at: string | null
  bm25_rank: number
}

export function createMemory(db: Database.Database) {
  // Prepare statements
  const insertStmt = db.prepare(
    `INSERT INTO memories (content, source, tags, session_id, score) VALUES (?, ?, ?, ?, 0)`,
  )

  const matchStmt = db.prepare(
    `SELECT memories.*, memories_fts.rank AS bm25_rank
     FROM memories_fts
     JOIN memories ON memories.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
     ORDER BY memories_fts.rank
     LIMIT ?`,
  )

  const reinforceStmt = db.prepare(
    `UPDATE memories SET score = score + ?, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )

  const demoteStmt = db.prepare(`UPDATE memories SET score = score - ? WHERE id = ?`)

  const updateStmt = db.prepare(
    `UPDATE memories SET content = ?, tags = COALESCE(?, tags), last_hit_at = CURRENT_TIMESTAMP WHERE id = ?`,
  )

  const getStmt = db.prepare(`SELECT id, content, source, tags, score FROM memories WHERE id = ?`)

  const deleteStmt = db.prepare(`DELETE FROM memories WHERE id = ?`)

  const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM memories`)

  const lowestStmt = db.prepare(`SELECT id FROM memories ORDER BY score ASC LIMIT ?`)

  return {
    store(content: string, source?: string, tags?: string, sessionId?: string): number {
      const result = insertStmt.run(content, source ?? null, tags ?? null, sessionId ?? null)
      return Number(result.lastInsertRowid)
    },

    update(id: number, content: string, tags?: string): { success: boolean; memory?: MemoryResult } {
      const existing = getStmt.get(id) as MemoryRow | undefined
      if (!existing) return { success: false }
      updateStmt.run(content, tags ?? null, id)
      const updated = getStmt.get(id) as MemoryRow
      return {
        success: true,
        memory: {
          id: updated.id,
          content: updated.content,
          source: updated.source ?? undefined,
          tags: updated.tags ?? undefined,
          score: updated.score,
          rank: 0,
        },
      }
    },

    query(queryString: string, limit = 20): MemoryResult[] {
      // Strip URLs first (they produce noisy, FTS5-incompatible tokens)
      const noUrls = queryString.replace(/https?:\/\/\S+/g, ' ')

      // Strip hyphens (FTS5 interprets "word-word" as column:term or subtraction)
      // then strip remaining punctuation / FTS5-special chars
      const cleaned = noUrls
        .replace(/-/g, ' ')
        .replace(/[?!.,;:'"()[\]{}<>*^~@#$%&|\\]/g, ' ')

      // Split into words, drop single-char tokens
      const words = cleaned
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)
      if (words.length === 0) return []

      // Expand synonyms per word, then quote bare terms so FTS5 treats them as
      // literal tokens (preventing column-reference or operator misparses).
      // expandSynonyms returns either the bare word unchanged or a grouped
      // expression like "(api OR interface OR endpoint)"; only quote the former.
      const ftsQuery = words
        .map((w) => {
          const expanded = expandSynonyms(w)
          // If synonyms were found, expanded is a parenthesised group — keep as-is.
          // Otherwise wrap the bare word in double-quotes for FTS5 literal matching.
          return expanded.startsWith('(') ? expanded : `"${expanded}"`
        })
        .join(' OR ')

      let rows: MemoryRow[]
      try {
        rows = matchStmt.all(ftsQuery, limit * 3) as MemoryRow[]
      } catch (err) {
        log.warn('Memory FTS query failed', {
          query: ftsQuery,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }

      // Re-rank: BM25_relevance × score_weight × recency_factor
      // - recency uses last_hit_at (reinforced timestamp) when available,
      //   falling back to created_at for untouched memories
      // - score_weight uses full score (including negative from demote)
      //   so demoted memories rank lower, reinforced ones rank higher
      const now = Date.now()
      const scored = rows.map((row) => {
        const bm25 = -row.bm25_rank // FTS5 rank is negative (lower = better)

        // Score weight: allow negative scores to push memories down.
        // sigmoid-like: maps score → (0, ∞), centered at 1 for score=0
        const s = row.score ?? 0
        const scoreWeight = Math.exp(s * 0.2)

        // Recency: prefer last_hit_at (set by reinforce) over created_at
        const recencyRef = row.last_hit_at
          ? new Date(row.last_hit_at).getTime()
          : new Date(row.created_at).getTime()
        const daysSince = (now - recencyRef) / (1000 * 60 * 60 * 24)
        const recency = 1 / (1 + daysSince * 0.01)

        const finalRank = bm25 * scoreWeight * recency
        return { row, finalRank }
      })

      scored.sort((a, b) => b.finalRank - a.finalRank)

      return scored.slice(0, limit).map((s, i) => ({
        id: s.row.id,
        content: s.row.content,
        source: s.row.source ?? undefined,
        tags: s.row.tags ?? undefined,
        score: s.row.score,
        rank: i + 1,
        finalRank: Math.round(s.finalRank * 1000) / 1000,
      }))
    },

    reinforce(id: number, weight = 3): void {
      reinforceStmt.run(weight, id)
    },

    demote(id: number, weight = 1): void {
      demoteStmt.run(weight, id)
    },

    forget(id: number): void {
      deleteStmt.run(id)
    },

    prune(prunePercent: number): number {
      const { cnt } = countStmt.get() as { cnt: number }
      const pruneCount = Math.floor(cnt * (prunePercent / 100))
      if (pruneCount <= 0) return 0

      const ids = (lowestStmt.all(pruneCount) as { id: number }[]).map((r) => r.id)
      if (ids.length === 0) return 0

      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`INSERT INTO memories_archive SELECT * FROM memories WHERE id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids)

      return ids.length
    },
  }
}
