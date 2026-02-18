// Skills loader — scans skills/*.md, parses frontmatter, provides matching

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { createLogger } from './logger.js'

const log = createLogger('skills')

export interface SkillEntry {
  name: string
  description: string
  triggers: string[]
  filePath: string
}

const skillIndex: SkillEntry[] = []

const DEFAULT_SKILLS: Record<string, string> = {
  'reminders.md': `---
name: reminders
description: Set reminders and scheduled notifications for the user
triggers: [remind, reminder, notify, notification, alert, schedule, meeting, before, "in X minutes", pm, am]
---

## How to handle reminders

1. Parse what the user wants reminded and when
2. Create a cron job with the appropriate payload:
   - \`notify\` payload for simple reminders (message back to user)
   - \`spawn\` payload for work tasks (sub-agent does something at the scheduled time)
3. Confirm to the user: what will be reminded, when it will fire, what type
4. NEVER fire the notification during setup — the cron system handles delivery at the scheduled time
5. For relative times ("in 5 minutes"), calculate the absolute time from now
6. For clock times ("at 4pm"), use the user's timezone if known

## Common patterns
- "Remind me to X in Y minutes" → one-shot cron, notify payload
- "Remind me about X before my Y meeting" → one-shot cron, calculate time
- "Every day at 9am, check X" → recurring cron, spawn payload with task description
`,
}

function parseFrontmatter(content: string): { data: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { data: {}, body: content }
  const yamlStr = match[1]
  const body = match[2]
  try {
    const data = parseYaml(yamlStr) as Record<string, unknown>
    return { data, body }
  } catch {
    return { data: {}, body: content }
  }
}

/** Ensure skills directory exists with defaults, then load all skills */
export function loadSkillIndex(skillsDir?: string): { name: string; description: string }[] {
  const dir = skillsDir ?? resolve('skills')

  // Create dir and write defaults if missing
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    for (const [filename, content] of Object.entries(DEFAULT_SKILLS)) {
      writeFileSync(resolve(dir, filename), content)
    }
    log.info('Created skills directory with defaults')
  }

  // Clear and reload
  skillIndex.length = 0

  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
  for (const file of files) {
    const filePath = resolve(dir, file)
    const raw = readFileSync(filePath, 'utf-8')
    const { data } = parseFrontmatter(raw)

    const name = data.name as string | undefined
    const description = data.description as string | undefined
    const triggers = data.triggers as string[] | undefined

    if (!name || !description) {
      log.warn(`Skipping ${file}: missing name or description in frontmatter`)
      continue
    }

    skillIndex.push({
      name,
      description,
      triggers: triggers ?? [],
      filePath,
    })
  }

  log.info(`Loaded ${skillIndex.length} skill(s): ${skillIndex.map((s) => s.name).join(', ')}`)
  return skillIndex.map((s) => ({ name: s.name, description: s.description }))
}

/** Match skills by scanning triggers against text (case-insensitive) */
export function matchSkills(text: string): { name: string; description: string }[] {
  const lower = text.toLowerCase()
  const matched: { name: string; description: string }[] = []

  for (const skill of skillIndex) {
    const hit = skill.triggers.some((trigger) => lower.includes(trigger.toLowerCase()))
    if (hit) {
      matched.push({ name: skill.name, description: skill.description })
    }
  }

  return matched
}

/** Get full skill content (body only, no frontmatter) */
export function getSkillContent(name: string): string | null {
  const skill = skillIndex.find((s) => s.name === name)
  if (!skill) return null
  const raw = readFileSync(skill.filePath, 'utf-8')
  const { body } = parseFrontmatter(raw)
  return body.trim()
}
