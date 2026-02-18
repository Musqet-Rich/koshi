// Main agent loop — polls router for batches, sends to model, routes responses back

import type { KoshiConfig, ModelPlugin, SessionMessage, ChannelPlugin } from '../types.js'
import type { createRouter } from './router.js'
import type { createSessionManager } from './sessions.js'
import type { createPromptBuilder } from './prompt.js'
import type { createMemory } from './memory.js'
import { createLogger } from './logger.js'

const log = createLogger('main-loop')

const MAIN_SESSION_ID = 'main'

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
      const userContent = batch.messages.map(m => m.payload).join('\n')
      if (!userContent.trim()) return

      log.info('Processing message', { channel: batch.channel, length: userContent.length })

      // Store user message in session
      sessionManager.addMessage(MAIN_SESSION_ID, 'user', userContent)

      // Get session history
      const history = sessionManager.getHistory(MAIN_SESSION_ID)

      // Query memory for relevant context
      const memories = memory.query(userContent, 5)

      // Build system prompt
      const systemPrompt = promptBuilder.build({ memories })

      // Build messages for model
      const modelMessages: SessionMessage[] = [
        { role: 'system', content: systemPrompt },
        ...history.map(m => ({ role: m.role, content: m.content })),
      ]

      // Get the model
      const modelName = config.agent.model
      const model = getModel(modelName)

      // Try streaming first, fall back to complete
      const replyChannel = batch.channel
      const channel = getChannel(replyChannel)

      let fullContent = ''

      try {
        for await (const chunk of model.stream(modelMessages)) {
          if (chunk.type === 'text' && chunk.text) {
            fullContent += chunk.text
            // Send streaming chunk to channel
            if (channel) {
              await channel.send(batch.conversation, {
                content: chunk.text,
                streaming: true,
              })
            }
          }
        }
      } catch {
        // Streaming not supported, fall back to complete
        log.debug('Streaming failed, falling back to complete')
        const response = await model.complete(modelMessages)
        fullContent = response.content ?? ''
      }

      // Send final message
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
      // Poll at same rate as router batch window
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
