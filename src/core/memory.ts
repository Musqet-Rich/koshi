import Database from 'better-sqlite3'
import type { MemoryResult } from '../types.js'
import { expandSynonyms } from './synonyms.js'

export function createMemory(db: Database.Database) {
  // Prepare statements
  const insertStmt = db.prepare(
    `INSERT INTO memories (content, source, tags, session_id, score) VALUES (?, ?, ?, ?, 0)`
  )

  const matchStmt = db.prepare(
    `SELECT memories.*, memories_fts.rank AS bm25_rank
     FROM memories_fts
     JOIN memories ON memories.id = memories_fts.rowid
     WHERE memories_fts MATCH ?
     ORDER BY memories_fts.rank
     LIMIT ?`
  )

  const reinforceStmt = db.prepare(
    `UPDATE memories SET score = score + ?, last_hit_at = CURRENT_TIMESTAMP WHERE id = ?`
  )

  const demoteStmt = db.prepare(
    `UPDATE memories SET score = score - ? WHERE id = ?`
  )

  const deleteStmt = db.prepare(`DELETE FROM memories WHERE id = ?`)

  const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM memories`)

  const lowestStmt = db.prepare(
    `SELECT id FROM memories ORDER BY score ASC LIMIT ?`
  )

  return {
    store(content: string, source?: string, tags?: string, sessionId?: string): number {
      const result = insertStmt.run(content, source ?? null, tags ?? null, sessionId ?? null)
      return Number(result.lastInsertRowid)
    },

    query(queryString: string, limit = 20): MemoryResult[] {
      // Expand each word via synonym map, join with OR
      const words = queryString.trim().split(/\s+/).filter(Boolean)
      if (words.length === 0) return []

      const ftsQuery = expandSynonyms(words.join(' '))

      let rows: any[]
      try {
        rows = matchStmt.all(ftsQuery, limit * 3) as any[]
      } catch {
        return []
      }

      // Re-rank: BM25_relevance × (1 + max(score, 0)) × recency_factor
      const now = Date.now()
      const scored = rows.map(row => {
        const bm25 = -row.bm25_rank // FTS5 rank is negative (lower = better)
        const scoreBoost = 1 + Math.max(row.score ?? 0, 0)
        const created = new Date(row.created_at).getTime()
        const daysSince = (now - created) / (1000 * 60 * 60 * 24)
        const recency = 1 / (1 + daysSince * 0.01)
        const finalRank = bm25 * scoreBoost * recency
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

      const ids = (lowestStmt.all(pruneCount) as { id: number }[]).map(r => r.id)
      if (ids.length === 0) return 0

      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`INSERT INTO memories_archive SELECT * FROM memories WHERE id IN (${placeholders})`).run(...ids)
      db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids)

      return ids.length
    },
  }
}
