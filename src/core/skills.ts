// Skills loader — loads from file path + SQLite DB, provides matching & CRUD

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { parse as parseYaml } from 'yaml'
import { createLogger } from './logger.js'

const log = createLogger('skills')

export interface SkillEntry {
  name: string
  description: string
  triggers: string[]
  tools: string[]
  source: 'file' | 'db'
  filePath?: string
}

let skillIndex: SkillEntry[] = []
let _db: Database.Database | null = null

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { data: {}, body: content }
  try {
    const data = parseYaml(match[1]) as Record<string, unknown>
    return { data, body: match[2] }
  } catch {
    return { data: {}, body: content }
  }
}

/** Copy default skills from repo to external dir if it doesn't exist */
function seedSkillsDir(externalDir: string, repoSkillsDir: string): void {
  if (existsSync(externalDir)) return
  mkdirSync(externalDir, { recursive: true })
  if (!existsSync(repoSkillsDir)) return
  for (const file of readdirSync(repoSkillsDir).filter((f) => f.endsWith('.md'))) {
    copyFileSync(join(repoSkillsDir, file), join(externalDir, file))
  }
  log.info(`Seeded skills directory: ${externalDir}`)
}

function loadFileSkills(dir: string): SkillEntry[] {
  if (!existsSync(dir)) return []
  const entries: SkillEntry[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const filePath = resolve(dir, file)
    const { data } = parseFrontmatter(readFileSync(filePath, 'utf-8'))
    const name = data.name as string | undefined
    const description = data.description as string | undefined
    if (!name || !description) {
      log.warn(`Skipping ${file}: missing name or description`)
      continue
    }
    entries.push({
      name,
      description,
      triggers: (data.triggers as string[]) ?? [],
      tools: (data.tools as string[]) ?? [],
      source: 'file',
      filePath,
    })
  }
  return entries
}

function loadDbSkills(db: Database.Database): SkillEntry[] {
  const rows = db.prepare('SELECT name, description, triggers FROM skills').all() as {
    name: string
    description: string
    triggers: string
  }[]
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    triggers: JSON.parse(r.triggers) as string[],
    tools: [],
    source: 'db' as const,
  }))
}

/**
 * Initialize skills system.
 * @param externalDir - Where human-managed skill files live (~/.config/koshi/skills/)
 * @param repoSkillsDir - Default skills in the repo (for seeding)
 * @param db - SQLite database for agent-created skills
 */
export function loadSkillIndex(
  externalDir: string,
  repoSkillsDir: string,
  db: Database.Database,
): { name: string; description: string }[] {
  _db = db

  // Seed external dir from repo defaults on first boot
  seedSkillsDir(externalDir, repoSkillsDir)

  // Load from both sources; file skills win on collision
  const fileSkills = loadFileSkills(externalDir)
  const dbSkills = loadDbSkills(db)

  const fileNames = new Set(fileSkills.map((s) => s.name))
  const merged = [...fileSkills, ...dbSkills.filter((s) => !fileNames.has(s.name))]

  skillIndex = merged
  log.info(`Loaded ${merged.length} skill(s): ${merged.map((s) => s.name).join(', ')}`)
  return merged.map((s) => ({ name: s.name, description: s.description }))
}

/** Get current skill index (includes runtime-created skills) */
export function getSkillIndex(): { name: string; description: string }[] {
  return skillIndex.map((s) => ({ name: s.name, description: s.description }))
}

/** List all skills with metadata (name, description, triggers, tools, source) — no full content */
export function listSkills(): { name: string; description: string; triggers: string[]; tools: string[]; source: 'file' | 'db' }[] {
  return skillIndex.map((s) => ({
    name: s.name,
    description: s.description,
    triggers: s.triggers,
    tools: s.tools,
    source: s.source,
  }))
}

/** Match skills by scanning triggers against text (word-boundary, case-insensitive) */
export function matchSkills(text: string): { name: string; description: string }[] {
  return skillIndex
    .filter((s) =>
      s.triggers.some((t) => {
        const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(`\\b${escaped}\\b`, 'i')
        return re.test(text)
      }),
    )
    .map((s) => ({ name: s.name, description: s.description }))
}

/**
 * Match skills with per-turn budget enforcement.
 * Returns at most `maxPerTurn` skills, ranked by trigger specificity
 * (longest matching trigger first — longer = more specific).
 */
export function matchSkillsWithBudget(
  text: string,
  opts: { maxPerTurn: number },
): { name: string; description: string }[] {
  // Score each skill by the length of its longest matching trigger
  const scored: { entry: SkillEntry; bestTriggerLen: number }[] = []

  for (const s of skillIndex) {
    let bestLen = 0
    for (const t of s.triggers) {
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const re = new RegExp(`\\b${escaped}\\b`, 'i')
      if (re.test(text) && t.length > bestLen) {
        bestLen = t.length
      }
    }
    if (bestLen > 0) {
      scored.push({ entry: s, bestTriggerLen: bestLen })
    }
  }

  if (scored.length === 0) return []

  // Sort by specificity: longest matching trigger first
  scored.sort((a, b) => b.bestTriggerLen - a.bestTriggerLen)

  // Enforce per-turn cap
  const limit = Math.max(1, opts.maxPerTurn)
  if (scored.length > limit) {
    const skipped = scored.slice(limit).map((s) => s.entry.name)
    log.warn(`Skill budget: ${scored.length} skills matched, capping to ${limit}. Skipped: ${skipped.join(', ')}`)
  }

  return scored.slice(0, limit).map((s) => ({
    name: s.entry.name,
    description: s.entry.description,
  }))
}

/** Get full skill content — checks files first, then DB */
export function getSkillContent(name: string): string | null {
  const skill = skillIndex.find((s) => s.name === name)
  if (!skill) return null

  if (skill.source === 'file' && skill.filePath) {
    const { body } = parseFrontmatter(readFileSync(skill.filePath, 'utf-8'))
    return body.trim()
  }

  if (skill.source === 'db' && _db) {
    const row = _db.prepare('SELECT content FROM skills WHERE name = ?').get(name) as { content: string } | undefined
    return row?.content ?? null
  }

  return null
}

/**
 * Get skill content with a character budget.
 * If content exceeds `maxChars`, it is truncated and a warning is appended.
 * Returns null if the skill is not found.
 */
export function getSkillContentWithBudget(
  name: string,
  opts: { maxChars: number },
): string | null {
  const content = getSkillContent(name)
  if (content === null) return null

  if (content.length <= opts.maxChars) return content

  log.warn(`Skill "${name}" content is ${content.length} chars, truncating to ${opts.maxChars}`)
  return (
    content.slice(0, opts.maxChars) +
    `\n\n[... truncated — skill "${name}" exceeds ${opts.maxChars} char budget (was ${content.length} chars)]`
  )
}

// ─── Skill Validation (Security Hardening) ──────────────────────────────────

/** Phrases that indicate prompt injection attempts in skill content. */
const INJECTION_PHRASES = [
  'ignore previous instructions',
  'you are now',
  'forget your rules',
  'system prompt',
  'override',
  'disregard',
  'new instructions',
]

/** Triggers that are too common/short to be meaningful — would match nearly every message. */
const BANNED_TRIGGERS = new Set([
  'a', 'an', 'the', 'is', 'it', 'i', 'to', 'and', 'or', 'of', 'in', 'on',
  'at', 'be', 'do', 'he', 'me', 'my', 'no', 'so', 'up', 'we', 'if', 'as',
  'by', 'go', 'am', 'us', 'ok', 'hi',
])

export interface SkillValidationResult {
  valid: boolean
  reason?: string
}

/**
 * Validate a skill definition for suspicious content before creation or update.
 * Returns { valid: true } if the skill is safe, or { valid: false, reason } if rejected.
 */
export function validateSkillContent(input: {
  name: string
  description?: string
  triggers?: string[]
  content?: string
}): SkillValidationResult {
  // Check content + description for injection phrases
  const textToScan = [input.content ?? '', input.description ?? ''].join(' ').toLowerCase()
  for (const phrase of INJECTION_PHRASES) {
    if (textToScan.includes(phrase)) {
      return { valid: false, reason: `Content contains suspicious phrase: "${phrase}"` }
    }
  }

  // Check triggers — reject single characters or extremely common words
  if (input.triggers) {
    for (const trigger of input.triggers) {
      const normalized = trigger.trim().toLowerCase()
      if (normalized.length <= 1) {
        return { valid: false, reason: `Trigger "${trigger}" is too short (single character)` }
      }
      if (BANNED_TRIGGERS.has(normalized)) {
        return { valid: false, reason: `Trigger "${trigger}" is too common and would match nearly every message` }
      }
    }
  }

  return { valid: true }
}

/** Create a new agent skill in SQLite */
export function createSkill(input: { name: string; description: string; triggers: string[]; content: string }): string {
  if (!_db) throw new Error('Skills DB not initialized')

  // Security validation — reject suspicious content
  const validation = validateSkillContent(input)
  if (!validation.valid) {
    log.warn('Skill creation blocked by security validation', { name: input.name, reason: validation.reason })
    throw new Error(`Skill creation blocked: ${validation.reason}`)
  }

  // Check if file-based skill exists with this name
  if (skillIndex.some((s) => s.name === input.name && s.source === 'file')) {
    throw new Error(`Skill "${input.name}" exists as a file-based skill and cannot be overwritten`)
  }

  // Check if DB skill already exists
  const existing = _db.prepare('SELECT name FROM skills WHERE name = ?').get(input.name)
  if (existing) {
    throw new Error(`Skill "${input.name}" already exists. Use update_skill instead.`)
  }

  _db
    .prepare('INSERT INTO skills (name, description, triggers, content) VALUES (?, ?, ?, ?)')
    .run(input.name, input.description, JSON.stringify(input.triggers), input.content)

  // Add to in-memory index
  skillIndex.push({
    name: input.name,
    description: input.description,
    triggers: input.triggers,
    tools: [],
    source: 'db',
  })

  log.info(`Created skill: ${input.name}`)
  return `Created skill "${input.name}"`
}

/** Update an existing agent skill in SQLite (partial update) */
export function updateSkill(input: {
  name: string
  description?: string
  triggers?: string[]
  content?: string
}): string {
  if (!_db) throw new Error('Skills DB not initialized')

  // Cannot update file-based skills
  const skill = skillIndex.find((s) => s.name === input.name)
  if (!skill) throw new Error(`Skill "${input.name}" not found`)
  if (skill.source === 'file') throw new Error('Cannot modify file-based skills')

  // Security validation — reject suspicious content on update too
  const validation = validateSkillContent(input)
  if (!validation.valid) {
    log.warn('Skill update blocked by security validation', { name: input.name, reason: validation.reason })
    throw new Error(`Skill update blocked: ${validation.reason}`)
  }

  const existing = _db.prepare('SELECT name FROM skills WHERE name = ?').get(input.name)
  if (!existing) throw new Error(`Skill "${input.name}" not found in database`)

  const updates: string[] = []
  const params: unknown[] = []

  if (input.description !== undefined) {
    updates.push('description = ?')
    params.push(input.description)
  }
  if (input.triggers !== undefined) {
    updates.push('triggers = ?')
    params.push(JSON.stringify(input.triggers))
  }
  if (input.content !== undefined) {
    updates.push('content = ?')
    params.push(input.content)
  }

  if (updates.length === 0) return `No changes to skill "${input.name}"`

  updates.push('updated_at = CURRENT_TIMESTAMP')
  params.push(input.name)

  _db.prepare(`UPDATE skills SET ${updates.join(', ')} WHERE name = ?`).run(...params)

  // Update in-memory index
  if (input.description !== undefined) skill.description = input.description
  if (input.triggers !== undefined) skill.triggers = input.triggers

  log.info(`Updated skill: ${input.name}`)
  return `Updated skill "${input.name}"`
}

/** Delete an agent-created skill from SQLite (cannot delete file-based skills) */
export function deleteSkill(name: string): string {
  if (!_db) throw new Error('Skills DB not initialized')

  const skill = skillIndex.find((s) => s.name === name)
  if (!skill) throw new Error(`Skill "${name}" not found`)
  if (skill.source === 'file') throw new Error('Cannot delete file-based skills — they are human-managed')

  _db.prepare('DELETE FROM skills WHERE name = ?').run(name)

  // Remove from in-memory index
  skillIndex = skillIndex.filter((s) => s.name !== name)

  log.info(`Deleted skill: ${name}`)
  return `Deleted skill "${name}"`
}

/** Get full skill entries with source/filePath info (for agent spawning) */
export function getSkillEntries(): SkillEntry[] {
  return [...skillIndex]
}

/**
 * Get the raw file content of a skill (including frontmatter).
 * For file-based skills, reads the file directly.
 * For DB-based skills, returns the stored content (no frontmatter).
 */
export function getSkillRawContent(name: string): string | null {
  const skill = skillIndex.find((s) => s.name === name)
  if (!skill) return null

  if (skill.source === 'file' && skill.filePath) {
    return readFileSync(skill.filePath, 'utf-8')
  }

  if (skill.source === 'db' && _db) {
    const row = _db.prepare('SELECT content FROM skills WHERE name = ?').get(name) as { content: string } | undefined
    return row?.content ?? null
  }

  return null
}
