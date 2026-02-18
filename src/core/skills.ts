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

/** Match skills by scanning triggers against text (case-insensitive) */
export function matchSkills(text: string): { name: string; description: string }[] {
  const lower = text.toLowerCase()
  return skillIndex
    .filter((s) => s.triggers.some((t) => lower.includes(t.toLowerCase())))
    .map((s) => ({ name: s.name, description: s.description }))
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

/** Create a new agent skill in SQLite */
export function createSkill(input: { name: string; description: string; triggers: string[]; content: string }): string {
  if (!_db) throw new Error('Skills DB not initialized')

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
