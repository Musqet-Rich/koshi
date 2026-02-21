import { statSync } from 'node:fs'
import type Database from 'better-sqlite3'
import type { MemoryResult, TrustLevel } from '../types.js'
import { createLogger } from './logger.js'
// synonyms.ts is deprecated — the agent handles synonym expansion naturally
// during memory_query tool calls. FTS queries now use simple quoted terms.

const log = createLogger('memory')

// ─── Injection Patterns ─────────────────────────────────────────────────────

/** Patterns that indicate prompt injection or instruction override attempts. */
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  // Markdown-style system/instruction blocks
  { pattern: /```system[\s\S]*?```/gi, label: 'markdown-system-block' },
  { pattern: /```instruction[\s\S]*?```/gi, label: 'markdown-instruction-block' },
  { pattern: /\[INST\][\s\S]*?\[\/INST\]/gi, label: 'inst-block' },
  { pattern: /<<SYS>>[\s\S]*?<<\/SYS>>/gi, label: 'sys-block' },

  // "Ignore previous instructions" style patterns
  { pattern: /ignore\s+(all\s+)?previous\s+instructions/gi, label: 'ignore-previous-instructions' },
  { pattern: /disregard\s+(all\s+)?previous\s+(instructions|context|rules)/gi, label: 'disregard-previous' },
  { pattern: /forget\s+(all\s+)?previous\s+(instructions|context|rules)/gi, label: 'forget-previous' },
  { pattern: /override\s+(all\s+)?previous\s+(instructions|context|rules)/gi, label: 'override-previous' },
  { pattern: /you\s+are\s+now\s+(a|an)\s+/gi, label: 'role-override' },
  { pattern: /new\s+system\s+prompt[:\s]/gi, label: 'new-system-prompt' },
  { pattern: /system:\s*you\s+are/gi, label: 'system-role-injection' },
  { pattern: /\bact\s+as\s+(if\s+)?(you\s+are\s+|a\s+|an\s+)/gi, label: 'act-as-injection' },
]

export interface SanitizeResult {
  content: string
  stripped: { label: string; match: string }[]
}

/**
 * Sanitize memory content before storage.
 *
 * Strips obvious injection patterns (system blocks, instruction overrides)
 * and returns both the cleaned content and details of what was stripped.
 * The caller is responsible for logging stripped content to security_events.
 */
export function sanitizeMemoryContent(raw: string): SanitizeResult {
  let content = raw
  const stripped: { label: string; match: string }[] = []

  for (const { pattern, label } of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      stripped.push({ label, match: match[0].slice(0, 200) })
    }
    // Remove all occurrences
    content = content.replace(pattern, '')
  }

  // Collapse leftover whitespace from removals
  content = content.replace(/\n{3,}/g, '\n\n').trim()

  return { content, stripped }
}

/**
 * Determine trust_level based on the source parameter.
 *
 * - 'high': user-provided content (direct user input)
 * - 'medium': model-extracted content (agent/conversation extraction)
 * - 'low': sub-agent output or external sources
 */
export function determineTrustLevel(source?: string): TrustLevel {
  if (!source) return 'medium'
  const s = source.toLowerCase()
  if (s === 'user' || s === 'user-input' || s === 'direct') return 'high'
  if (s === 'sub-agent' || s === 'sub_agent' || s === 'external' || s === 'plugin') return 'low'
  // 'agent', 'conversation', 'model', etc. → medium
  return 'medium'
}

/** Parse a human-readable size string like "100MB" into bytes. */
function parseSize(size: string): number {
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i)
  if (!match) throw new Error(`Invalid size format: "${size}". Expected e.g. "100MB"`)
  const value = Number.parseFloat(match[1])
  const unit = match[2].toUpperCase()
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 * 1024,
    GB: 1024 * 1024 * 1024,
    TB: 1024 * 1024 * 1024 * 1024,
  }
  return Math.floor(value * multipliers[unit])
}

interface MemoryRow {
  id: number
  content: string
  source: string | null
  tags: string | null
  trust_level: string | null
  score: number
  created_at: string
  last_hit_at: string | null
  bm25_rank: number
}

export function createMemory(db: Database.Database) {
  // Prepare statements
  const insertStmt = db.prepare(
    `INSERT INTO memories (content, source, tags, trust_level, session_id, score, narrative_id) VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )

  const securityEventStmt = db.prepare(
    `INSERT INTO security_events (event_type, source, detail) VALUES (?, ?, ?)`,
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

  const countStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM memories`)

  const lowestStmt = db.prepare(`SELECT id FROM memories ORDER BY score ASC LIMIT ?`)

  return {
    store(content: string, source?: string, tags?: string, sessionId?: string, narrativeId?: number): number {
      // Sanitize content before storage
      const { content: cleanContent, stripped } = sanitizeMemoryContent(content)

      // Log security events for any stripped injection patterns
      if (stripped.length > 0) {
        for (const s of stripped) {
          securityEventStmt.run(
            'injection_stripped',
            source ?? 'unknown',
            `Pattern: ${s.label} | Match: ${s.match}`,
          )
        }
        log.warn('Injection patterns stripped from memory content', {
          source: source ?? 'unknown',
          patternsStripped: stripped.length,
          labels: stripped.map((s) => s.label).join(', '),
        })
      }

      // Skip storing if sanitization removed all meaningful content
      if (!cleanContent || cleanContent.length < 2) {
        log.warn('Memory content empty after sanitization, skipping store', { source })
        securityEventStmt.run(
          'memory_rejected',
          source ?? 'unknown',
          'Content empty after sanitization',
        )
        return -1
      }

      // Determine trust level from source
      const trustLevel = determineTrustLevel(source)

      const result = insertStmt.run(
        cleanContent,
        source ?? null,
        tags ?? null,
        trustLevel,
        sessionId ?? null,
        narrativeId ?? null,
      )
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

      // Quote each word for FTS5 literal matching (prevents column-reference
      // or operator misparses). Synonym expansion is now handled by the agent
      // at query time via the memory_query tool.
      const ftsQuery = words.map((w) => `"${w}"`).join(' OR ')

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
        trustLevel: (s.row.trust_level as TrustLevel) ?? 'medium',
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

    /**
     * Prune the bottom N% of memories by score+recency, but only if the DB
     * file exceeds the configured maxSize.  Pruned memories are moved to a
     * searchable archive table — never deleted.
     *
     * @param dbPath  - Absolute path to the SQLite DB file
     * @param maxSize - Human-readable size threshold, e.g. "100MB"
     * @param prunePercent - Bottom N% of memories to archive (1 = 1%)
     * @returns Object with count of archived memories and new file size
     */
    prune(dbPath: string, maxSize: string, prunePercent: number): { archived: number; dbSizeBefore: number; dbSizeAfter: number } {
      // 1. Check file size
      let dbSizeBefore: number
      try {
        dbSizeBefore = statSync(dbPath).size
      } catch {
        log.warn('Could not stat DB file for pruning', { dbPath })
        return { archived: 0, dbSizeBefore: 0, dbSizeAfter: 0 }
      }

      const maxBytes = parseSize(maxSize)
      if (dbSizeBefore <= maxBytes) {
        log.info('DB under size limit, skipping prune', {
          dbSize: `${(dbSizeBefore / (1024 * 1024)).toFixed(1)}MB`,
          maxSize,
        })
        return { archived: 0, dbSizeBefore, dbSizeAfter: dbSizeBefore }
      }

      log.info('DB over size limit, pruning', {
        dbSize: `${(dbSizeBefore / (1024 * 1024)).toFixed(1)}MB`,
        maxSize,
        prunePercent,
      })

      // 2. Calculate how many to prune
      const { cnt } = countStmt.get() as { cnt: number }
      const pruneCount = Math.max(1, Math.floor(cnt * (prunePercent / 100)))

      // 3. Score all memories using the same formula as query re-ranking:
      //    scoreWeight = exp(score * 0.2), recency = 1 / (1 + daysSince * 0.01)
      //    combined = scoreWeight * recency  (lower = worse = prune candidate)
      const allRows = db
        .prepare('SELECT id, score, created_at, last_hit_at FROM memories')
        .all() as { id: number; score: number; created_at: string; last_hit_at: string | null }[]

      const now = Date.now()
      const scored = allRows.map((row) => {
        const s = row.score ?? 0
        const scoreWeight = Math.exp(s * 0.2)
        const recencyRef = row.last_hit_at
          ? new Date(row.last_hit_at).getTime()
          : new Date(row.created_at).getTime()
        const daysSince = (now - recencyRef) / (1000 * 60 * 60 * 24)
        const recency = 1 / (1 + daysSince * 0.01)
        return { id: row.id, rank: scoreWeight * recency }
      })

      // Sort ascending — lowest rank first (worst memories)
      scored.sort((a, b) => a.rank - b.rank)

      const idsToArchive = scored.slice(0, pruneCount).map((r) => r.id)
      if (idsToArchive.length === 0) {
        return { archived: 0, dbSizeBefore, dbSizeAfter: dbSizeBefore }
      }

      // 4. Archive in a transaction
      const archiveTransaction = db.transaction((ids: number[]) => {
        const placeholders = ids.map(() => '?').join(',')
        // Insert into archive with original_id mapping
        db.prepare(
          `INSERT INTO memories_archive (original_id, content, source, tags, created_at, last_hit_at, score, session_id)
           SELECT id, content, source, tags, created_at, last_hit_at, score, session_id
           FROM memories WHERE id IN (${placeholders})`,
        ).run(...ids)
        // Delete from main table (FTS sync handled by existing triggers)
        db.prepare(`DELETE FROM memories WHERE id IN (${placeholders})`).run(...ids)
        return ids.length
      })

      const archived = archiveTransaction(idsToArchive)

      // 5. Get new size after pruning
      let dbSizeAfter: number
      try {
        dbSizeAfter = statSync(dbPath).size
      } catch {
        dbSizeAfter = dbSizeBefore
      }

      log.info('Pruning complete', {
        archived,
        dbSizeBefore: `${(dbSizeBefore / (1024 * 1024)).toFixed(1)}MB`,
        dbSizeAfter: `${(dbSizeAfter / (1024 * 1024)).toFixed(1)}MB`,
      })

      return { archived, dbSizeBefore, dbSizeAfter }
    },

    /**
     * Search the archive for memories matching a query (FTS5 fallback search).
     */
    queryArchive(queryString: string, limit = 10): MemoryResult[] {
      const noUrls = queryString.replace(/https?:\/\/\S+/g, ' ')
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
        const rows = db
          .prepare(
            `SELECT memories_archive.*, memories_archive_fts.rank AS bm25_rank
             FROM memories_archive_fts
             JOIN memories_archive ON memories_archive.id = memories_archive_fts.rowid
             WHERE memories_archive_fts MATCH ?
             ORDER BY memories_archive_fts.rank
             LIMIT ?`,
          )
          .all(ftsQuery, limit) as (MemoryRow & { original_id: number; archived_at: string })[]

        return rows.map((row, i) => ({
          id: row.original_id ?? row.id,
          content: row.content,
          source: row.source ?? undefined,
          tags: row.tags ?? undefined,
          score: row.score,
          rank: i + 1,
        }))
      } catch (err) {
        log.warn('Archive FTS query failed', {
          query: ftsQuery,
          error: err instanceof Error ? err.message : String(err),
        })
        return []
      }
    },
  }
}
