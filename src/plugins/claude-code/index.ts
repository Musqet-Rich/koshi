import type {
  KoshiContext,
  KoshiContextWithExtras,
  KoshiPlugin,
  ModelPlugin,
  ModelResponse,
  PluginConfig,
  SessionMessage,
  StreamChunk,
  Tool,
} from '../../types.js'
import { claudeCodeComplete, claudeCodeStream } from './client.js'

const plugin: KoshiPlugin = {
  name: '@koshi/claude-code',
  version: '0.0.1',

  async init(koshi: KoshiContext, config: PluginConfig) {
    const cliBin = (config.bin as string) ?? 'claude'
    const skipPermissions = (config.skipPermissions as boolean) ?? true
    const pluginRef = config.name

    // Find all named models that use this plugin
    const models = koshi.config.models
    for (const [name, modelConfig] of Object.entries(models)) {
      if (modelConfig.plugin !== pluginRef) continue

      const modelPlugin: ModelPlugin = {
        async complete(messages: SessionMessage[], tools?: Tool[]): Promise<ModelResponse> {
          const response = await claudeCodeComplete({
            bin: cliBin,
            model: modelConfig.model,
            messages,
            tools,
            skipPermissions,
          })
          if (response.usage) await recordUsage(koshi, response.usage)
          return response
        },

        async *stream(messages: SessionMessage[], tools?: Tool[]): AsyncIterable<StreamChunk> {
          for await (const chunk of claudeCodeStream({
            bin: cliBin,
            model: modelConfig.model,
            messages,
            tools,
            skipPermissions,
          })) {
            yield chunk
          }
        },
      }

      const ctx = koshi as KoshiContextWithExtras
      ctx.models = ctx.models ?? {}
      ctx.models[name] = modelPlugin
    }
  },
}

async function recordUsage(
  koshi: KoshiContext,
  usage: { inputTokens: number; outputTokens: number; model: string; costUsd?: number },
): Promise<void> {
  try {
    const db = (koshi as KoshiContextWithExtras).db as import('better-sqlite3').Database | undefined
    if (!db) return
    db.prepare(
      `INSERT INTO token_usage (agent_run_id, session_id, input_tokens, output_tokens, model, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(null, null, usage.inputTokens, usage.outputTokens, usage.model, usage.costUsd ?? null)
  } catch {
    // Don't fail the request if usage tracking fails
  }
}

export default plugin
