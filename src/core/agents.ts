import type { KoshiConfig, SpawnOptions, AgentResult, ToolCall, TokenUsage, SessionMessage } from '../types.js'
import type { createSessionManager } from './sessions.js'
import type { createPromptBuilder } from './prompt.js'
import type { createMemory } from './memory.js'
import type Database from 'better-sqlite3'
import type { ModelPlugin } from '../types.js'

const MAX_ITERATIONS = 20

export function createAgentManager(opts: {
  config: KoshiConfig
  getModel: (name: string) => ModelPlugin
  sessionManager: ReturnType<typeof createSessionManager>
  promptBuilder: ReturnType<typeof createPromptBuilder>
  memory: ReturnType<typeof createMemory>
  db: Database.Database
}) {
  const { config, getModel, sessionManager, promptBuilder, memory } = opts
  const running = new Set<string>()

  return {
    async spawn(options: SpawnOptions): Promise<AgentResult> {
      const maxConcurrent = config.agents?.maxConcurrent ?? 3
      if (running.size >= maxConcurrent) {
        return {
          agentRunId: crypto.randomUUID(),
          status: 'failed',
          error: `Concurrency limit reached (${maxConcurrent})`,
        }
      }

      const agentRunId = crypto.randomUUID()
      running.add(agentRunId)

      // Resolve template
      let modelName = options.model ?? config.agent.model
      let timeout = options.timeout ?? config.agents?.defaultTimeout ?? 300
      const tools = options.tools ?? []

      if (options.template && config.templates[options.template]) {
        const tpl = config.templates[options.template]
        if (!options.model) modelName = tpl.model
        if (!options.timeout && tpl.timeout) timeout = tpl.timeout
        if (!options.tools) tools.push(...tpl.tools)
      }

      // Timeout setup
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true }, timeout * 1000)

      try {
        // Create ephemeral session
        const sessionId = sessionManager.createSession({
          model: modelName,
          type: 'sub-agent',
        })

        // Query memory for context
        const memories = memory.query(options.task, 5)

        // Build system prompt
        const systemPrompt = promptBuilder.build({
          memories,
          activeContext: options.task,
        })

        // Get model
        const model = getModel(modelName)

        // Build initial messages
        const messages: SessionMessage[] = [
          { role: 'user', content: systemPrompt },
        ]

        const totalUsage: TokenUsage = {
          inputTokens: 0,
          outputTokens: 0,
          model: modelName,
          agentRunId,
        }

        let lastContent = ''

        // Agent loop
        for (let i = 0; i < MAX_ITERATIONS; i++) {
          if (timedOut) {
            running.delete(agentRunId)
            clearTimeout(timer)
            memory.store(
              `Agent ${agentRunId} timed out on task: ${options.task}`,
              'agent',
              'agent,timeout',
            )
            return { agentRunId, status: 'timed_out', usage: totalUsage }
          }

          const response = await model.complete(messages)

          // Accumulate usage
          if (response.usage) {
            totalUsage.inputTokens += response.usage.inputTokens
            totalUsage.outputTokens += response.usage.outputTokens
          }

          lastContent = response.content ?? ''

          // Store assistant message
          sessionManager.addMessage(
            sessionId,
            'assistant',
            response.content ?? '',
            response.toolCalls ? JSON.stringify(response.toolCalls) : undefined,
          )

          // If no tool calls, we're done
          if (!response.toolCalls || response.toolCalls.length === 0) {
            break
          }

          // Stub-execute tool calls
          for (const tc of response.toolCalls) {
            console.log(`[agent:${agentRunId}] Tool call: ${tc.name}(${JSON.stringify(tc.input)})`)
            const stubResult = `Tool "${tc.name}" not yet implemented (POC stub)`

            // Add tool result as message
            messages.push({
              role: 'assistant',
              content: response.content ?? '',
              toolCalls: response.toolCalls,
            })
            messages.push({
              role: 'tool',
              content: JSON.stringify({ toolUseId: tc.id, content: stubResult }),
            })
          }
        }

        clearTimeout(timer)
        running.delete(agentRunId)

        // Store result as memory
        const summary = lastContent.slice(0, 500)
        memory.store(
          `Agent completed task: ${options.task}\nResult: ${summary}`,
          'agent',
          'agent,result',
        )

        return {
          agentRunId,
          status: 'completed',
          result: lastContent,
          usage: totalUsage,
        }
      } catch (err) {
        clearTimeout(timer)
        running.delete(agentRunId)
        const error = err instanceof Error ? err.message : String(err)
        return {
          agentRunId,
          status: 'failed',
          error,
        }
      }
    },

    getRunningCount(): number {
      return running.size
    },

    getRunning(): string[] {
      return [...running]
    },
  }
}
