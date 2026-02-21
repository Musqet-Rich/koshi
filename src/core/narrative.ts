import type Database from 'better-sqlite3'
import type { Narrative } from '../types.js'
import { createLogger } from './logger.js'

const log = createLogger('narrative')

/** Row shape returned by SQLite queries on the narratives table. */
interface NarrativeRow {
  id: number
  summary: string
  memory_ids: string
  previous_narrative_id: number | null
  topic: string | null
  created_at: string
}

/** Convert a DB row (snake_case, JSON strings) to a typed Narrative object. */
function rowToNarrative(row: NarrativeRow): Narrative {
  let memoryIds: number[]
  try {
    memoryIds = JSON.parse(row.memory_ids)
  } catch {
    log.warn('Failed to parse memory_ids JSON, defaulting to empty array', { id: row.id, raw: row.memory_ids })
    memoryIds = []
  }
  return {
    id: row.id,
    summary: row.summary,
    memoryIds,
    previousNarrativeId: row.previous_narrative_id,
    topic: row.topic,
    createdAt: row.created_at,
  }
}

export function createNarrative(db: Database.Database) {
  // Prepare statements
  const insertStmt = db.prepare(
    `INSERT INTO narratives (summary, memory_ids, previous_narrative_id, topic) VALUES (?, ?, ?, ?)`,
  )

  const getByIdStmt = db.prepare(
    `SELECT id, summary, memory_ids, previous_narrative_id, topic, created_at FROM narratives WHERE id = ?`,
  )

  const updateStmt = db.prepare(
    `UPDATE narratives SET summary = ?, memory_ids = ? WHERE id = ?`,
  )

  const latestStmt = db.prepare(
    `SELECT id, summary, memory_ids, previous_narrative_id, topic, created_at FROM narratives ORDER BY created_at DESC LIMIT 1`,
  )

  const ftsSearchStmt = db.prepare(
    `SELECT narratives.id, narratives.summary, narratives.memory_ids, narratives.previous_narrative_id, narratives.topic, narratives.created_at
     FROM narratives_fts
     JOIN narratives ON narratives.id = narratives_fts.rowid
     WHERE narratives_fts MATCH ?
     ORDER BY narratives.created_at DESC
     LIMIT 5`,
  )

  const forwardStmt = db.prepare(
    `SELECT id, summary, memory_ids, previous_narrative_id, topic, created_at FROM narratives WHERE previous_narrative_id = ? ORDER BY created_at ASC`,
  )

  return {
    /**
     * Create a new narrative entry.
     * Inserts the narrative and returns the full object with its assigned ID.
     */
    create(summary: string, memoryIds: number[], previousNarrativeId?: number, topic?: string): Narrative {
      const memoryIdsJson = JSON.stringify(memoryIds)
      const result = insertStmt.run(summary, memoryIdsJson, previousNarrativeId ?? null, topic ?? null)
      const id = Number(result.lastInsertRowid)
      const row = getByIdStmt.get(id) as NarrativeRow
      log.info('Narrative created', { id, topic: topic ?? null, memoryIds })
      return rowToNarrative(row)
    },

    /**
     * Update an existing narrative in place.
     * Used for incremental updates within a session (e.g. appending new memory IDs).
     * Returns the updated narrative, or null if the ID was not found.
     */
    update(id: number, summary: string, memoryIds: number[]): Narrative | null {
      const existing = getByIdStmt.get(id) as NarrativeRow | undefined
      if (!existing) {
        log.warn('Narrative not found for update', { id })
        return null
      }
      const memoryIdsJson = JSON.stringify(memoryIds)
      updateStmt.run(summary, memoryIdsJson, id)
      const row = getByIdStmt.get(id) as NarrativeRow
      log.info('Narrative updated', { id, memoryIds })
      return rowToNarrative(row)
    },

    /**
     * Search for narratives. Three modes:
     * - No query → returns the latest narrative (session recovery)
     * - Numeric string → fetch by ID
     * - Text → FTS5 keyword search, top 5 by created_at DESC
     */
    search(query?: string): Narrative[] {
      // No query → latest narrative
      if (!query || query.trim() === '') {
        const row = latestStmt.get() as NarrativeRow | undefined
        return row ? [rowToNarrative(row)] : []
      }

      const trimmed = query.trim()

      // Numeric string → fetch by ID
      if (/^\d+$/.test(trimmed)) {
        const row = getByIdStmt.get(Number(trimmed)) as NarrativeRow | undefined
        return row ? [rowToNarrative(row)] : []
      }

      // Text → FTS5 search
      // Clean the query the same way memory.ts does: strip URLs, hyphens, punctuation
      const noUrls = trimmed.replace(/https?:\/\/\S+/g, ' ')
      const cleaned = noUrls
        .replace(/-/g, ' ')
        .replace(/[?!.,;:'"()[\]{}<>*^~@#$%&|\\]/g, ' ')
      const words = cleaned
        .trim()
        .split(/\s+/)
        .filter((w) => w.length > 1)

      if (words.length === 0) return []

      const ftsQuery = words.map((w) => `"${w}"`).join(' OR ')

      try {
        const rows = ftsSearchStmt.all(ftsQuery) as NarrativeRow[]
        return rows.map(rowToNarrative)
      } catch (err) {
        log.warn('Narrative FTS query failed', {
          query: ftsQuery,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },

    /**
     * Direct primary key lookup.
     * Returns the narrative if found, null otherwise.
     */
    getById(id: number): Narrative | null {
      const row = getByIdStmt.get(id) as NarrativeRow | undefined
      return row ? rowToNarrative(row) : null
    },

    /**
     * Forward traversal: find all narratives that point to this one
     * as their previous_narrative_id (i.e. what came next in the chain).
     */
    getForward(narrativeId: number): Narrative[] {
      const rows = forwardStmt.all(narrativeId) as NarrativeRow[]
      return rows.map(rowToNarrative)
    },
  }
}
