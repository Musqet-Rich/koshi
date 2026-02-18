// Main agent loop — polls router for batches, sends to model, routes responses back

import type { ChannelPlugin, KoshiConfig, ModelPlugin, SessionMessage, Tool, ToolCall } from '../types.js'
import type { createAgentManager } from './agents.js'
import { compactSession, estimateMessagesChars } from './compaction.js'
import { cancelJob, createJob, listJobs } from './cron.js'
import { createLogger } from './logger.js'
import type { createMemory } from './memory.js'
import type { createPromptBuilder } from './prompt.js'
import type { createRouter } from './router.js'
import type { createSessionManager } from './sessions.js'
import { createSkill, getSkillContent, matchSkills, updateSkill } from './skills.js'
import type { WsActivityUpdate } from './ws.js'
import { broadcast } from './ws.js'

const log = createLogger('main-loop')

/** Pending notifications — delivered after current model response completes */
const pendingNotifications: string[] = []

/** Queue a system notification for delivery after the current tick */
function notifyTui(text: string): void {
  pendingNotifications.push(text)
}

/** Flush all pending notifications to the TUI */
function flushNotifications(): void {
  while (pendingNotifications.length > 0) {
    const text = pendingNotifications.shift()
    if (text) broadcast({ type: 'assistant_done', content: text })
  }
}

const MAIN_SESSION_ID = 'main'
const MAX_TOOL_ROUNDS = 10

// Context limits by model name fragment
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  'claude-haiku-3': 200_000,
}

function getContextLimit(modelName: string, configOverride?: number): number {
  if (configOverride) return configOverride
  for (const [fragment, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (modelName.includes(fragment)) return limit
  }
  return 200_000 // sensible default
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const MAIN_TOOLS: Tool[] = [
  {
    name: 'spawn_agent',
    description:
      'Spawn a background sub-agent for complex multi-step work requiring shell access or file operations. ONLY use when simpler tools cannot do the job. DO NOT use for reminders, scheduling, or cron — use schedule_job instead. DO NOT use for memory — use memory_store/memory_query. DO NOT use for skills — use load_skill/create_skill.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Clear description of what the agent should do. Be specific — it has no conversation context.',
        },
        model: { type: 'string', description: 'Model to use (optional, defaults to config)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 300)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_agents',
    description: 'List running and recently completed sub-agents with their status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from disk. Use this to read files that sub-agents have written (e.g. /tmp/koshi-agent/*.md). Returns the file contents.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to read' },
      },
      required: ['path'],
    },
  },
]

const MEMORY_TOOLS: Tool[] = [
  {
    name: 'memory_query',
    description:
      'Search your memory for relevant information. Extract key nouns and synonyms from the user\'s question — do NOT pass the raw question. Example: user asks "what do you know about my pets?" → query "pets dog cat animal". Strip filler words (what, do, you, about, my, the, etc). Include synonyms for better recall.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords and synonyms only — no filler words or punctuation' },
        limit: { type: 'number', description: 'Max results to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description:
      'Store something in long-term memory. Use for facts, preferences, or anything worth remembering across conversations.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember' },
        tags: { type: 'string', description: 'Comma-separated tags for categorisation' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_reinforce',
    description:
      'Mark a memory as useful — increases its ranking in future searches. Call this when a recalled memory was helpful.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Memory ID to reinforce' },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_demote',
    description:
      'Mark a memory as less useful — decreases its ranking. Call this when a recalled memory was irrelevant or outdated.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Memory ID to demote' },
      },
      required: ['id'],
    },
  },
]

const SKILL_TOOLS: Tool[] = [
  {
    name: 'load_skill',
    description:
      'Load the full instructions for a skill by name. Use this when the system prompt indicates a skill may be relevant to the current request.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to load' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_skill',
    description:
      'Create a new skill to teach yourself how to handle a recurring pattern. Skills are reusable recipes that get loaded when relevant triggers match.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short kebab-case identifier (e.g. "code-review")' },
        description: { type: 'string', description: 'One sentence explaining what the skill covers' },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords/phrases that should activate this skill',
        },
        content: { type: 'string', description: 'Full recipe in markdown' },
      },
      required: ['name', 'description', 'triggers', 'content'],
    },
  },
  {
    name: 'update_skill',
    description: 'Update an existing agent-created skill. Cannot modify file-based (human-managed) skills.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name to update' },
        description: { type: 'string', description: 'New description' },
        triggers: {
          type: 'array',
          items: { type: 'string' },
          description: 'New triggers array',
        },
        content: { type: 'string', description: 'New content' },
      },
      required: ['name'],
    },
  },
]

const CRON_TOOLS: Tool[] = [
  {
    name: 'schedule_job',
    description:
      'Schedule a timed job. For reminders use payload_type "notify" with payload { message: "..." }. For background work use "spawn" with payload { task: "..." }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human-readable name for the job' },
        schedule_at: { type: 'string', description: 'ISO 8601 timestamp when the job should fire' },
        payload_type: { type: 'string', enum: ['notify', 'spawn'], description: 'Job type' },
        payload: { type: 'object', description: 'Job payload — { message } for notify, { task } for spawn' },
      },
      required: ['name', 'schedule_at', 'payload_type', 'payload'],
    },
  },
  {
    name: 'cancel_job',
    description: 'Cancel a pending scheduled job by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job ID to cancel' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_jobs',
    description: 'List all scheduled jobs with their status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
]

// ─── Tool Execution ──────────────────────────────────────────────────────────

function executeTool(
  toolCall: ToolCall,
  memory: ReturnType<typeof createMemory>,
  agentManager?: ReturnType<typeof createAgentManager>,
  router?: ReturnType<typeof createRouter>,
  batch?: { channel: string; conversation: string },
  sessionManager?: ReturnType<typeof createSessionManager>,
): string {
  const { name, input } = toolCall

  if (name === 'read_file') {
    const filePath = input.path as string
    try {
      const { readFileSync } = require('node:fs') as typeof import('node:fs')
      const content = readFileSync(filePath, 'utf-8')
      if (content.length > 20_000) {
        return `${content.slice(0, 20_000)}\n... (truncated at 20k chars, file is ${content.length} chars total)`
      }
      return content
    } catch (err) {
      return `Failed to read file: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  switch (name) {
    case 'load_skill': {
      const skillName = input.name as string
      const content = getSkillContent(skillName)
      return content ?? `Skill "${skillName}" not found.`
    }
    case 'create_skill': {
      try {
        return createSkill({
          name: input.name as string,
          description: input.description as string,
          triggers: input.triggers as string[],
          content: input.content as string,
        })
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'update_skill': {
      try {
        return updateSkill({
          name: input.name as string,
          description: input.description as string | undefined,
          triggers: input.triggers as string[] | undefined,
          content: input.content as string | undefined,
        })
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'memory_query': {
      const query = input.query as string
      const limit = (input.limit as number) ?? 5
      const results = memory.query(query, limit)
      if (results.length === 0) return 'No memories found.'
      return `From memory:\n${results.map((r) => `- [id:${r.id}] ${r.content}${r.tags ? ` (tags: ${r.tags})` : ''}`).join('\n')}`
    }
    case 'memory_store': {
      const content = input.content as string
      const tags = (input.tags as string) ?? undefined
      const id = memory.store(content, 'agent', tags)
      return `Stored memory #${id}`
    }
    case 'memory_reinforce': {
      const id = input.id as number
      memory.reinforce(id)
      return `Reinforced memory #${id}`
    }
    case 'memory_demote': {
      const id = input.id as number
      memory.demote(id)
      return `Demoted memory #${id}`
    }
    case 'spawn_agent': {
      const task = input.task as string
      const model = input.model as string | undefined
      const timeout = input.timeout as number | undefined
      if (!agentManager) return 'Agent manager not available'
      const runId = crypto.randomUUID()
      agentManager
        .spawn({ task, model, timeout })
        .then((result) => {
          log.info('Sub-agent finished', { runId: result.agentRunId.slice(0, 8), status: result.status })
          const summary = result.result?.slice(0, 2000) ?? result.error ?? ''
          const notification = `🤖 Sub-agent [${result.agentRunId.slice(0, 8)}] ${result.status}${summary ? `: ${summary}` : ''}`
          // Show notification immediately in TUI
          notifyTui(notification)
          // Inject into router so the model can respond to it contextually
          if (router) {
            router.push({
              channel: 'tui',
              conversation: 'tui',
              messages: [
                {
                  id: Date.now(),
                  channel: 'tui',
                  sender: 'system',
                  conversation: 'tui',
                  payload: `[Sub-agent completed] ${summary}`,
                  receivedAt: new Date().toISOString(),
                  priority: 5,
                  routed: true,
                },
              ],
            })
          }
        })
        .catch((err) => {
          const error = err instanceof Error ? err.message : String(err)
          log.error('Sub-agent error', { runId: runId.slice(0, 8), error })
          notifyTui(`🤖 Sub-agent [${runId.slice(0, 8)}] failed: ${error}`)
        })
      return `Agent spawned (run: ${runId.slice(0, 8)}). It will notify you when done.`
    }
    case 'list_agents': {
      if (!agentManager) return 'Agent manager not available'
      const running = agentManager.getRunning()
      const completed = agentManager.getCompleted(5)
      const lines: string[] = []
      if (running.length > 0) {
        lines.push('Running:')
        for (const a of running) {
          const elapsed = Math.round((Date.now() - a.startedAt) / 1000)
          lines.push(`  [${a.id.slice(0, 8)}] ${a.task} (${elapsed}s, ${a.model})`)
        }
      } else {
        lines.push('No agents currently running.')
      }
      if (completed.length > 0) {
        lines.push('Recent:')
        for (const a of completed) {
          lines.push(`  [${a.id.slice(0, 8)}] ${a.task} — ${a.status}`)
        }
      }
      return lines.join('\n')
    }
    case 'schedule_job': {
      try {
        const job = createJob({
          name: input.name as string,
          schedule_at: input.schedule_at as string,
          payload_type: input.payload_type as 'notify' | 'spawn',
          payload: input.payload as Record<string, unknown>,
        })
        return `Job scheduled: ${job.name} (id: ${job.id.slice(0, 8)}) — fires at ${job.schedule_at}`
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'cancel_job': {
      const cancelled = cancelJob(input.id as string)
      return cancelled
        ? `Job ${(input.id as string).slice(0, 8)} cancelled.`
        : `Job not found or already fired/cancelled.`
    }
    case 'list_jobs': {
      const jobs = listJobs()
      if (jobs.length === 0) return 'No scheduled jobs.'
      return jobs
        .map((j) => `[${j.id.slice(0, 8)}] ${j.name} — ${j.status} — fires: ${j.schedule_at} (${j.payload_type})`)
        .join('\n')
    }
    default:
      return `Unknown tool: ${name}`
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────────────

export function createMainLoop(opts: {
  config: KoshiConfig
  router: ReturnType<typeof createRouter>
  getModel: (name: string) => ModelPlugin
  sessionManager: ReturnType<typeof createSessionManager>
  promptBuilder: ReturnType<typeof createPromptBuilder>
  memory: ReturnType<typeof createMemory>
  agentManager: ReturnType<typeof createAgentManager>
  getChannel: (name: string) => ChannelPlugin | undefined
}) {
  const { config, router, getModel, sessionManager, promptBuilder, memory, agentManager, getChannel } = opts
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false
  let sessionTokensIn = 0
  let sessionTokensOut = 0
  let sessionCostUsd = 0

  // Ensure main session exists
  try {
    sessionManager.createSession({ id: MAIN_SESSION_ID, model: config.agent.model, type: 'main' })
  } catch {
    // Already exists — fine
  }

  async function tick(): Promise<void> {
    // Flush any notifications that arrived while idle
    if (!processing) flushNotifications()

    if (processing) return
    processing = true

    try {
      const batch = router.nextBatch()
      if (!batch) return

      // Extract user message from batch
      const userContent = batch.messages.map((m) => m.payload).join('\n')
      if (!userContent.trim()) return

      // Slash commands — handled before model call
      if (userContent.trim() === '/clear') {
        sessionManager.clearHistory(MAIN_SESSION_ID)
        const ch = getChannel(batch.channel)
        if (ch) await ch.send(batch.conversation, { content: '🧹 Session cleared.', streaming: false })
        log.info('Session cleared by user')
        return
      }

      const tickStart = Date.now()
      const contextLimit = getContextLimit(config.agent.model, config.agent.contextLimit)

      const emitActivity = (state: WsActivityUpdate['state'], extra?: Partial<WsActivityUpdate>) => {
        broadcast({
          type: 'activity',
          state,
          model: config.agent.model,
          session: MAIN_SESSION_ID,
          elapsed: Math.round((Date.now() - tickStart) / 1000),
          tokensIn: sessionTokensIn,
          tokensOut: sessionTokensOut,
          costUsd: sessionCostUsd,
          contextLimit,
          agents: agentManager.getRunningCount(),
          ...extra,
        })
      }

      emitActivity('thinking')
      log.info('Processing message', { channel: batch.channel, length: userContent.length })

      // Store user message in session
      sessionManager.addMessage(MAIN_SESSION_ID, 'user', userContent)

      // Check if compaction is needed before getting history
      const compactionThreshold = config.agent.compactionThreshold ?? 0.7
      const preHistory = sessionManager.getHistory(MAIN_SESSION_ID)
      const preChars = estimateMessagesChars(preHistory)
      const preContextTokens = Math.ceil(preChars / 4)
      if (preContextTokens / contextLimit > compactionThreshold && preHistory.length > 4) {
        log.info('Context usage high, compacting', { tokens: preContextTokens, limit: contextLimit })
        const modelName = config.agent.model
        const compactionModel = getModel(modelName)
        await compactSession({
          sessionManager,
          model: compactionModel,
          sessionId: MAIN_SESSION_ID,
          targetTokens: Math.floor(contextLimit * 0.5),
        })
      }

      // Get session history
      const history = sessionManager.getHistory(MAIN_SESSION_ID)

      // Query memory for relevant context
      const memories = memory.query(userContent, 5)

      // Build system prompt
      const allTools = [...MAIN_TOOLS, ...MEMORY_TOOLS, ...SKILL_TOOLS, ...CRON_TOOLS]

      // Match skills against user message and auto-load content
      const skillMatches = matchSkills(userContent)
      const loadedSkills: { name: string; content: string }[] = []
      if (skillMatches.length > 0) {
        log.info('Skills matched', { matches: skillMatches.map((s) => s.name) })
        for (const match of skillMatches) {
          const content = getSkillContent(match.name)
          if (content) loadedSkills.push({ name: match.name, content })
        }
      }

      const systemPrompt = promptBuilder.build({ memories, tools: allTools, skillMatches, loadedSkills })

      // Log prompt if debug enabled
      if (config.debug?.logPrompts) {
        const { mkdirSync, writeFileSync } = await import('node:fs')
        const dir = '/tmp/koshi-prompts'
        mkdirSync(dir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        writeFileSync(`${dir}/${ts}.md`, systemPrompt, 'utf-8')
        log.info('Prompt logged', { path: `${dir}/${ts}.md` })
      }

      // Build messages for model
      const modelMessages: SessionMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ]

      // Estimate context usage
      const contextChars = estimateMessagesChars(modelMessages)
      const contextTokens = Math.ceil(contextChars / 4)
      const contextPercent = Math.round((contextTokens / contextLimit) * 100)
      emitActivity('thinking', { contextTokens, contextPercent })

      // Get the model and channel
      const modelName = config.agent.model
      const model = getModel(modelName)
      const replyChannel = batch.channel
      const channel = getChannel(replyChannel)

      // Agent loop — may do multiple rounds if tools are called
      let fullContent = ''

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await model.complete(modelMessages, allTools)

        // Track cumulative token usage
        if (response.usage) {
          sessionTokensIn += response.usage.inputTokens
          sessionTokensOut += response.usage.outputTokens
          sessionCostUsd += response.usage.costUsd ?? 0
        }

        if (response.content) {
          fullContent += response.content
        }

        // If no tool calls, we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break
        }

        log.info('Tool calls', {
          count: response.toolCalls.length,
          tools: response.toolCalls.map((t) => t.name).join(', '),
        })
        emitActivity('tool_call', { tool: response.toolCalls.map((t) => t.name).join(', ') })

        // Add assistant message with tool calls to conversation
        modelMessages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        })

        // Execute each tool and add results
        for (const tc of response.toolCalls) {
          const result = executeTool(tc, memory, agentManager, router, batch, sessionManager)
          log.info('Tool result', { tool: tc.name, resultLength: result.length })
          modelMessages.push({
            role: 'tool',
            content: result,
            toolCalls: [{ id: tc.id, name: tc.name, input: {} }],
          })
        }
      }

      // Stream final content to channel (if we have text to send)
      if (channel && fullContent) {
        await channel.send(batch.conversation, {
          content: fullContent,
          streaming: false,
        })
      }

      // Store assistant response in session
      if (fullContent) {
        sessionManager.addMessage(MAIN_SESSION_ID, 'assistant', fullContent)
      }

      // Post-response memory extraction — cheap background call
      if (userContent && fullContent) {
        const recentExchange = `User: ${userContent}\nAssistant: ${fullContent}`
        const extractPrompt = `You are a memory extraction system. Given this conversation exchange, extract any facts, decisions, preferences, or context worth remembering for future conversations. Include who, what, when, why, how.

If there is NOTHING worth storing (casual chat, greetings, trivial exchanges), respond with exactly: NOTHING

Otherwise respond with a JSON array of objects: [{"content": "fact to remember", "source": "conversation"}]

Exchange:
${recentExchange.slice(0, 2000)}`
        try {
          const subModel = config.agent.subAgentModel
            ? getModel(config.agent.subAgentModel)
            : getModel(modelName)
          const extractResult = await subModel.complete(
            [{ role: 'user', content: extractPrompt }],
            [],
          )
          const body = extractResult.content?.trim() ?? ''
          if (body && body !== 'NOTHING') {
            try {
              const items = JSON.parse(body) as { content: string; source?: string }[]
              for (const item of items) {
                memory.store(item.content, item.source ?? 'conversation')
              }
              if (items.length > 0) {
                log.info('Memory extracted', { count: items.length })
              }
            } catch {
              // Model didn't return valid JSON — store as single memory if it looks useful
              if (body.length > 20 && body.length < 500) {
                memory.store(body, 'conversation')
                log.info('Memory extracted', { count: 1, raw: true })
              }
            }
          }
        } catch (err) {
          log.warn('Memory extraction failed', { error: err instanceof Error ? err.message : String(err) })
        }
      }

      emitActivity('idle', { contextTokens, contextPercent })
      flushNotifications()
      log.info('Response sent', { channel: replyChannel, length: fullContent.length })
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error('Main loop error', { error: errorMsg })
      // Show error to user in TUI — flush immediately since there's no response to wait for
      broadcast({ type: 'assistant_done', content: `⚠️ Error: ${errorMsg.slice(0, 300)}` })
      broadcast({
        type: 'activity',
        state: 'idle',
        model: config.agent.model,
        session: MAIN_SESSION_ID,
        tokensIn: sessionTokensIn,
        tokensOut: sessionTokensOut,
        costUsd: sessionCostUsd,
        agents: agentManager.getRunningCount(),
      })
      flushNotifications()
    } finally {
      processing = false
    }
  }

  return {
    start(): void {
      if (timer) return
      const interval = config.buffer?.batchWindowMs ?? 500
      timer = setInterval(() => tick(), interval)
      log.info('Main loop started')
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      log.info('Main loop stopped')
    },
  }
}
