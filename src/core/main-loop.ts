// Main agent loop — polls router for batches, sends to model, routes responses back

import type { ChannelPlugin, KoshiConfig, ModelPlugin, SessionMessage, Tool, ToolCall } from '../types.js'
import { createLogger } from './logger.js'
import type { createMemory } from './memory.js'
import type { createPromptBuilder } from './prompt.js'
import type { createRouter } from './router.js'
import type { createSessionManager } from './sessions.js'

const log = createLogger('main-loop')

const MAIN_SESSION_ID = 'main'
const MAX_TOOL_ROUNDS = 10

// ─── Tool Definitions ────────────────────────────────────────────────────────

const MEMORY_TOOLS: Tool[] = [
  {
    name: 'memory_query',
    description: 'Search your memory for relevant information. Returns ranked results.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query — keywords work best' },
        limit: { type: 'number', description: 'Max results to return (default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store something in long-term memory. Use for facts, preferences, or anything worth remembering across conversations.',
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
    description: 'Mark a memory as useful — increases its ranking in future searches. Call this when a recalled memory was helpful.',
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
    description: 'Mark a memory as less useful — decreases its ranking. Call this when a recalled memory was irrelevant or outdated.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Memory ID to demote' },
      },
      required: ['id'],
    },
  },
]

// ─── Tool Execution ──────────────────────────────────────────────────────────

function executeTool(
  toolCall: ToolCall,
  memory: ReturnType<typeof createMemory>,
): string {
  const { name, input } = toolCall

  switch (name) {
    case 'memory_query': {
      const query = input.query as string
      const limit = (input.limit as number) ?? 5
      const results = memory.query(query, limit)
      if (results.length === 0) return 'No memories found.'
      return results
        .map((r) => `[id:${r.id}] ${r.content}${r.tags ? ` (tags: ${r.tags})` : ''}`)
        .join('\n')
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
  getChannel: (name: string) => ChannelPlugin | undefined
}) {
  const { config, router, getModel, sessionManager, promptBuilder, memory, getChannel } = opts
  let timer: ReturnType<typeof setInterval> | null = null
  let processing = false

  // Ensure main session exists
  try {
    sessionManager.createSession({ id: MAIN_SESSION_ID, model: config.agent.model, type: 'main' })
  } catch {
    // Already exists — fine
  }

  async function tick(): Promise<void> {
    if (processing) return
    processing = true

    try {
      const batch = router.nextBatch()
      if (!batch) return

      // Extract user message from batch
      const userContent = batch.messages.map((m) => m.payload).join('\n')
      if (!userContent.trim()) return

      log.info('Processing message', { channel: batch.channel, length: userContent.length })

      // Store user message in session
      sessionManager.addMessage(MAIN_SESSION_ID, 'user', userContent)

      // Get session history
      const history = sessionManager.getHistory(MAIN_SESSION_ID)

      // Query memory for relevant context
      const memories = memory.query(userContent, 5)

      // Build system prompt
      const systemPrompt = promptBuilder.build({ memories, tools: MEMORY_TOOLS })

      // Build messages for model
      const modelMessages: SessionMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ]

      // Get the model and channel
      const modelName = config.agent.model
      const model = getModel(modelName)
      const replyChannel = batch.channel
      const channel = getChannel(replyChannel)

      // Agent loop — may do multiple rounds if tools are called
      let fullContent = ''

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await model.complete(modelMessages, MEMORY_TOOLS)

        if (response.content) {
          fullContent += response.content
        }

        // If no tool calls, we're done
        if (!response.toolCalls || response.toolCalls.length === 0) {
          break
        }

        log.info('Tool calls', { count: response.toolCalls.length, tools: response.toolCalls.map((t) => t.name).join(', ') })

        // Add assistant message with tool calls to conversation
        modelMessages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
        })

        // Execute each tool and add results
        for (const tc of response.toolCalls) {
          const result = executeTool(tc, memory)
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

      log.info('Response sent', { channel: replyChannel, length: fullContent.length })
    } catch (err) {
      log.error('Main loop error', { error: err instanceof Error ? err.message : err })
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
