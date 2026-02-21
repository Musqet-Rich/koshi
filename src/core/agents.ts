/**
 * Specialist Agent Execution Model
 *
 * Agents are workers scoped by skills. Each agent gets:
 * - A skill file that defines its instructions and permitted tools
 * - A task description (ad-hoc or from the tasks table)
 * - A worker prompt (no coordinator instructions, no memory write access)
 *
 * The skill's `tools:` frontmatter array is the ceiling — only those tools
 * are registered via --allowedTools. No memory, narrative, spawn, or task tools.
 */

import type Database from 'better-sqlite3'
import { parse as parseYaml } from 'yaml'
import type { AgentResult, KoshiConfig, TokenUsage } from '../types.js'
import { claudeCodeComplete } from '../plugins/claude-code/client.js'
import { createLogger } from './logger.js'
import type { createPromptBuilder } from './prompt.js'
import { getSkillEntries, getSkillRawContent } from './skills.js'

const log = createLogger('agents')

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit']

/** Tools that sub-agents must NEVER receive, regardless of skill frontmatter. */
const FORBIDDEN_TOOLS = new Set([
  'memory_store',
  'memory_query',
  'memory_update',
  'memory_reinforce',
  'memory_demote',
  'spawn_agent',
  'list_agents',
  'narrative_update',
  'narrative_search',
  'task_create',
  'task_list',
  'task_update',
  // MCP variants
  'mcp__koshi__memory_store',
  'mcp__koshi__memory_query',
  'mcp__koshi__memory_update',
  'mcp__koshi__memory_reinforce',
  'mcp__koshi__memory_demote',
  'mcp__koshi__spawn_agent',
  'mcp__koshi__list_agents',
  'mcp__koshi__narrative_update',
  'mcp__koshi__narrative_search',
  'mcp__koshi__task_create',
  'mcp__koshi__task_list',
  'mcp__koshi__task_update',
])

// ─── Skill Frontmatter Parsing ───────────────────────────────────────────────

interface SkillFrontmatter {
  name?: string
  description?: string
  tools?: string[]
  model?: string
  triggers?: string[]
}

interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
}

/**
 * Parse a skill file's YAML frontmatter and markdown body.
 */
function parseSkillContent(content: string): ParsedSkill {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }
  try {
    const data = parseYaml(match[1]) as SkillFrontmatter
    return { frontmatter: data, body: match[2] }
  } catch {
    return { frontmatter: {}, body: content }
  }
}

/**
 * Resolve the tool list for a sub-agent.
 * Uses the skill's tools: frontmatter if present; otherwise DEFAULT_TOOLS.
 * Filters out any forbidden tools.
 */
function resolveToolList(skillTools?: string[]): string[] {
  const raw = skillTools && skillTools.length > 0 ? skillTools : DEFAULT_TOOLS
  return raw.filter((t) => !FORBIDDEN_TOOLS.has(t))
}

/**
 * Resolve [agent_result:ID] references in a context string.
 * Replaces each reference with the actual output from the agent_results table.
 */
function resolveContextReferences(context: string, db: Database.Database): string {
  return context.replace(/\[agent_result:(\d+)\]/g, (_match, idStr: string) => {
    const id = Number.parseInt(idStr, 10)
    const row = db.prepare('SELECT output FROM agent_results WHERE id = ?').get(id) as
      | { output: string }
      | undefined
    if (!row) return `[agent_result:${id} -- not found]`
    return row.output
  })
}

// ─── Skill Loading ───────────────────────────────────────────────────────────

/**
 * Load a skill by name via the skills module.
 * For file-based skills, parses the full raw content (frontmatter + body).
 * For DB-based skills, constructs a ParsedSkill from the DB row.
 */
function loadSkill(skillName: string, db: Database.Database): ParsedSkill | null {
  // Try file-based skills via skills.ts (returns raw content including frontmatter)
  const rawContent = getSkillRawContent(skillName)
  if (rawContent) {
    return parseSkillContent(rawContent)
  }

  // Fallback: check the skill entries for a DB skill that might not have raw content
  const entries = getSkillEntries()
  const entry = entries.find((e) => e.name === skillName && e.source === 'db')
  if (entry) {
    // DB skills store content without frontmatter
    const dbRow = db.prepare('SELECT name, description, triggers, content FROM skills WHERE name = ?').get(
      skillName,
    ) as { name: string; description: string; triggers: string; content: string } | undefined
    if (dbRow) {
      return {
        frontmatter: {
          name: dbRow.name,
          description: dbRow.description,
          triggers: JSON.parse(dbRow.triggers) as string[],
        },
        body: dbRow.content,
      }
    }
  }

  return null
}

// ─── Running Agent Tracking ──────────────────────────────────────────────────

interface RunningAgent {
  id: string
  task: string
  skill: string
  startedAt: number
  model: string
}

// ─── Spawn Options ───────────────────────────────────────────────────────────

export interface SpawnAgentOptions {
  task: string
  skill: string
  context?: string
  model?: string
  timeout?: number
}

// ─── Notification Type ───────────────────────────────────────────────────────

type NotifyFn = (message: string, channels?: string[]) => Promise<string>

// ─── Agent Manager ───────────────────────────────────────────────────────────

export function createAgentManager(opts: {
  config: KoshiConfig
  promptBuilder: ReturnType<typeof createPromptBuilder>
  db: Database.Database
  notify?: NotifyFn
}) {
  const { config, promptBuilder, db } = opts
  const running = new Map<string, RunningAgent>()
  const completed: Array<{ id: string; task: string; skill: string; status: string; completedAt: number }> = []

  // Resolve the claude CLI binary path from config
  const claudeBin = resolveClaudeBin(config)

  /**
   * Core spawn logic shared by ad-hoc and task-based spawning.
   */
  async function spawnWorker(params: {
    agentRunId: string
    task: string
    skillName: string
    skillContent: string
    tools: string[]
    model: string
    timeout: number
    taskId?: number
  }): Promise<AgentResult> {
    const { agentRunId, task, skillName, skillContent, tools, model, timeout, taskId } = params

    running.set(agentRunId, {
      id: agentRunId,
      task: task.slice(0, 100),
      skill: skillName,
      startedAt: Date.now(),
      model,
    })

    log.info('Spawning specialist agent', {
      runId: agentRunId.slice(0, 8),
      skill: skillName,
      model,
      tools: tools.join(', '),
      task: task.slice(0, 80),
    })

    // Build worker prompt via the prompt builder.
    // The prompt builder accepts agentType: 'worker' to produce a stripped-down
    // worker prompt. If agentType support is not yet in prompt.ts, it falls back
    // to a basic prompt with the skill content and task.
    const systemPrompt = promptBuilder.build({
      agentType: 'worker',
      task,
      skillContent,
    })

    try {
      const response = await Promise.race([
        claudeCodeComplete({
          bin: claudeBin,
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: task },
          ],
          skipPermissions: true,
          allowedTools: tools,
        }),
        // Timeout race
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new TimeoutError(timeout)), timeout * 1000)
        }),
      ])

      running.delete(agentRunId)

      const output = response.content ?? ''

      // Store result in agent_results table
      const resultId = storeAgentResult(db, {
        taskId: taskId ?? null,
        skillUsed: skillName,
        output,
      })

      // If task-based, update the task row
      if (taskId != null) {
        db.prepare('UPDATE tasks SET status = ?, agent_result_id = ? WHERE id = ?').run(
          'completed',
          resultId,
          taskId,
        )
      }

      completed.push({
        id: agentRunId,
        task: task.slice(0, 100),
        skill: skillName,
        status: 'completed',
        completedAt: Date.now(),
      })

      const usage: TokenUsage | undefined = response.usage
        ? { ...response.usage, agentRunId }
        : undefined

      log.info('Specialist agent completed', {
        runId: agentRunId.slice(0, 8),
        skill: skillName,
        resultId,
        outputLength: output.length,
      })

      return {
        agentRunId,
        taskId,
        status: 'completed',
        result: output,
        usage,
      }
    } catch (err) {
      running.delete(agentRunId)

      const isTimeout = err instanceof TimeoutError
      const status = isTimeout ? 'timed_out' : 'failed'
      const error = err instanceof Error ? err.message : String(err)

      // Store failed result
      const failOutput = isTimeout
        ? `Agent timed out after ${timeout}s`
        : `Agent failed: ${error}`

      const resultId = storeAgentResult(db, {
        taskId: taskId ?? null,
        skillUsed: skillName,
        output: failOutput,
      })

      // If task-based, mark the task as failed
      if (taskId != null) {
        db.prepare('UPDATE tasks SET status = ?, agent_result_id = ? WHERE id = ?').run(
          'failed',
          resultId,
          taskId,
        )
      }

      completed.push({
        id: agentRunId,
        task: task.slice(0, 100),
        skill: skillName,
        status,
        completedAt: Date.now(),
      })

      log.error('Specialist agent failed', {
        runId: agentRunId.slice(0, 8),
        skill: skillName,
        status,
        error,
      })

      return { agentRunId, taskId, status, error }
    }
  }

  return {
    /**
     * Ad-hoc spawn: coordinator provides task + skill directly.
     */
    async spawnAgent(options: SpawnAgentOptions): Promise<AgentResult> {
      const maxConcurrent = config.agents?.maxConcurrent ?? 3
      if (running.size >= maxConcurrent) {
        return {
          agentRunId: crypto.randomUUID(),
          status: 'failed',
          error: `Concurrency limit reached (${maxConcurrent})`,
        }
      }

      const agentRunId = crypto.randomUUID()

      // Load the skill
      const skill = loadSkill(options.skill, db)
      if (!skill) {
        return {
          agentRunId,
          status: 'failed',
          error: `Skill "${options.skill}" not found`,
        }
      }

      // Resolve tools from skill frontmatter
      const tools = resolveToolList(skill.frontmatter.tools)

      // Resolve model: explicit override > skill frontmatter > config default
      const model =
        options.model ??
        skill.frontmatter.model ??
        config.agent.subAgentModel ??
        config.agent.model

      const timeout = options.timeout ?? config.agents?.defaultTimeout ?? 300

      // Resolve context references (e.g. [agent_result:12])
      let taskDescription = options.task
      if (options.context) {
        const resolvedContext = resolveContextReferences(options.context, db)
        taskDescription = `${options.task}\n\n## Context\n${resolvedContext}`
      }

      return spawnWorker({
        agentRunId,
        task: taskDescription,
        skillName: options.skill,
        skillContent: skill.body.trim(),
        tools,
        model,
        timeout,
      })
    },

    /**
     * Task-based spawn: read the task row from the DB and follow the same flow.
     */
    async spawnAgentForTask(taskId: number): Promise<AgentResult> {
      const maxConcurrent = config.agents?.maxConcurrent ?? 3
      if (running.size >= maxConcurrent) {
        return {
          agentRunId: crypto.randomUUID(),
          status: 'failed',
          error: `Concurrency limit reached (${maxConcurrent})`,
        }
      }

      // Read the task row
      const taskRow = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as
        | Record<string, unknown>
        | undefined
      if (!taskRow) {
        return {
          agentRunId: crypto.randomUUID(),
          status: 'failed',
          error: `Task ${taskId} not found`,
        }
      }

      const title = taskRow.title as string
      const context = taskRow.context as string | null
      const skillName = taskRow.skill as string | null

      if (!skillName) {
        return {
          agentRunId: crypto.randomUUID(),
          status: 'failed',
          error: `Task ${taskId} has no skill assigned`,
        }
      }

      // Mark task as running
      db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('running', taskId)

      const agentRunId = crypto.randomUUID()

      // Load the skill
      const skill = loadSkill(skillName, db)
      if (!skill) {
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('failed', taskId)
        return {
          agentRunId,
          taskId,
          status: 'failed',
          error: `Skill "${skillName}" not found`,
        }
      }

      // Resolve tools from skill frontmatter
      const tools = resolveToolList(skill.frontmatter.tools)

      // Model: skill frontmatter > config default (no ad-hoc override for task-based)
      const model =
        skill.frontmatter.model ??
        config.agent.subAgentModel ??
        config.agent.model

      const timeout = config.agents?.defaultTimeout ?? 300

      // Build task description from title + context
      let taskDescription = title
      if (context) {
        const resolvedContext = resolveContextReferences(context, db)
        taskDescription = `${title}\n\n## Context\n${resolvedContext}`
      }

      return spawnWorker({
        agentRunId,
        task: taskDescription,
        skillName,
        skillContent: skill.body.trim(),
        tools,
        model,
        timeout,
        taskId,
      })
    },

    /**
     * Legacy spawn interface — bridges the old SpawnOptions signature.
     * Used by main-loop.ts and cron until they are updated to use spawnAgent/spawnAgentForTask.
     */
    async spawn(options: {
      task: string
      skill?: string
      model?: string
      timeout?: number
    }): Promise<AgentResult> {
      // If a skill is provided, use the new specialist flow
      if (options.skill) {
        return this.spawnAgent({
          task: options.task,
          skill: options.skill,
          model: options.model,
          timeout: options.timeout,
        })
      }

      // No skill specified — try to match a skill from the task text
      const { matchSkills } = await import('./skills.js')
      const matches = matchSkills(options.task)

      if (matches.length > 0) {
        return this.spawnAgent({
          task: options.task,
          skill: matches[0].name,
          model: options.model,
          timeout: options.timeout,
        })
      }

      // No skill match — spawn a generic worker with default tools
      const agentRunId = crypto.randomUUID()
      const maxConcurrent = config.agents?.maxConcurrent ?? 3
      if (running.size >= maxConcurrent) {
        return {
          agentRunId,
          status: 'failed',
          error: `Concurrency limit reached (${maxConcurrent})`,
        }
      }

      const model = options.model ?? config.agent.subAgentModel ?? config.agent.model
      const timeout = options.timeout ?? config.agents?.defaultTimeout ?? 300

      return spawnWorker({
        agentRunId,
        task: options.task,
        skillName: '_generic',
        skillContent: 'You are a general-purpose worker. Complete the task using the tools available to you.',
        tools: DEFAULT_TOOLS,
        model,
        timeout,
      })
    },

    getRunningCount(): number {
      return running.size
    },

    getRunning(): RunningAgent[] {
      return [...running.values()]
    },

    getCompleted(
      limit = 10,
    ): Array<{ id: string; task: string; skill: string; status: string; completedAt: number }> {
      return completed.slice(-limit)
    },
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

class TimeoutError extends Error {
  constructor(seconds: number) {
    super(`Agent timed out after ${seconds}s`)
    this.name = 'TimeoutError'
  }
}

/**
 * Insert a row into agent_results and return its ID.
 */
function storeAgentResult(
  db: Database.Database,
  result: { taskId: number | null; skillUsed: string; output: string },
): number {
  const res = db
    .prepare(
      `INSERT INTO agent_results (task_id, skill_used, output, memory_ids)
       VALUES (?, ?, ?, '[]')`,
    )
    .run(result.taskId, result.skillUsed, result.output)
  return res.lastInsertRowid as number
}

/**
 * Resolve the Claude CLI binary path from config.
 * Looks at the claude-code plugin config for the 'bin' field.
 */
function resolveClaudeBin(config: KoshiConfig): string {
  for (const plugin of config.plugins) {
    if (
      plugin.name.includes('claude-code') ||
      plugin.name.includes('claude_code')
    ) {
      if (typeof plugin.bin === 'string') return plugin.bin
    }
  }
  return 'claude'
}
