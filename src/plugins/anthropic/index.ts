import type {
  KoshiContext,
  KoshiContextWithExtras,
  KoshiPlugin,
  ModelPlugin,
  ModelResponse,
  PluginConfig,
  SessionMessage,
  StreamChunk,
  TokenUsage,
  Tool,
} from '../../types.js'
import { createAnthropicClient } from './client.js'

const plugin: KoshiPlugin = {
  name: '@koshi/anthropic',
  version: '0.0.1',

  async init(koshi: KoshiContext, config: PluginConfig) {
    const apiKey = config.apiKey as string
    if (!apiKey) throw new Error('@koshi/anthropic: apiKey is required')

    const client = createAnthropicClient(apiKey)

    // Find all named models that use this plugin
    const models = koshi.config.models
    for (const [name, modelConfig] of Object.entries(models)) {
      if (modelConfig.plugin !== config.name) continue

      const key = modelConfig.apiKey ?? apiKey
      const modelClient = key === apiKey ? client : createAnthropicClient(key)

      const modelPlugin: ModelPlugin = {
        async complete(messages: SessionMessage[], tools?: Tool[]): Promise<ModelResponse> {
          const systemMsgs = messages.filter((m) => m.role === 'system')
          const nonSystemMsgs = messages.filter((m) => m.role !== 'system')
          const system = systemMsgs.map((m) => m.content).join('\n\n') || undefined
          const response = await modelClient.complete({
            model: modelConfig.model,
            messages: nonSystemMsgs,
            tools,
            system,
          })
          if (response.usage) await recordUsage(koshi, response.usage)
          return response
        },

        async *stream(messages: SessionMessage[], tools?: Tool[]): AsyncIterable<StreamChunk> {
          let usage: TokenUsage | undefined
          const systemMsgs = messages.filter((m) => m.role === 'system')
          const nonSystemMsgs = messages.filter((m) => m.role !== 'system')
          const system = systemMsgs.map((m) => m.content).join('\n\n') || undefined
          for await (const chunk of modelClient.stream({
            model: modelConfig.model,
            messages: nonSystemMsgs,
            tools,
            system,
          })) {
            if (chunk.type === 'usage') {
              usage = chunk.usage
            }
            yield chunk
          }
          if (usage) await recordUsage(koshi, usage)
        },
      }

      // Register on the context so other parts of Koshi can look up models by name
      const ctx = koshi as KoshiContextWithExtras
      ctx.models = ctx.models ?? {}
      ctx.models[name] = modelPlugin
    }
  },
}

async function recordUsage(koshi: KoshiContext, usage: TokenUsage): Promise<void> {
  try {
    const db = (koshi as KoshiContextWithExtras).db as import('better-sqlite3').Database | undefined
    if (!db) return
    db.prepare(
      `INSERT INTO token_usage (agent_run_id, session_id, input_tokens, output_tokens, model, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      usage.agentRunId ?? null,
      usage.sessionId ?? null,
      usage.inputTokens,
      usage.outputTokens,
      usage.model,
      usage.costUsd ?? null,
    )
  } catch {
    // Don't fail the request if usage tracking fails
  }
}

export default plugin
