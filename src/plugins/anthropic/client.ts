import Anthropic from '@anthropic-ai/sdk'
import type { ModelResponse, SessionMessage, StreamChunk, TokenUsage, Tool, ToolCall } from '../../types.js'

// Cost per million tokens: [input, output]
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-opus-4-20250514': [15, 75],
  'claude-sonnet-4-20250514': [3, 15],
  'claude-haiku-4-5-20251001': [1, 5],
  'claude-haiku-3-20250307': [0.25, 1.25],
}

function estimateCost(model: string, input: number, output: number): number {
  const costs = Object.entries(MODEL_COSTS).find(([k]) => model.includes(k))?.[1] ?? [3, 15]
  return (input * costs[0] + output * costs[1]) / 1_000_000
}

function mapTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }))
}

function mapMessages(messages: SessionMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      // Tool results go as user messages with tool_result content blocks
      return {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: m.toolCalls?.[0]?.id ?? '',
            content: m.content,
          },
        ],
      }
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content: Anthropic.ContentBlockParam[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      return { role: 'assistant' as const, content }
    }
    return { role: m.role as 'user' | 'assistant', content: m.content }
  })
}

function extractToolCalls(content: Anthropic.ContentBlock[]): ToolCall[] {
  return content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> }))
}

const MAX_RETRIES = 3
const RETRY_DELAYS = [1000, 3000, 8000]

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isRetryable =
        err instanceof Error && (err.message.includes('529') || err.message.includes('overloaded') || err.message.includes('500'))
      if (!isRetryable || attempt === MAX_RETRIES) throw err
      const delay = RETRY_DELAYS[attempt] ?? 8000
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw new Error('Unreachable')
}

export function createAnthropicClient(apiKey: string) {
  const client = new Anthropic({ apiKey })

  return {
    async complete(opts: {
      model: string
      system?: string
      messages: SessionMessage[]
      tools?: Tool[]
      maxTokens?: number
    }): Promise<ModelResponse> {
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: mapMessages(opts.messages),
        ...(opts.system && { system: opts.system }),
        ...(opts.tools?.length && { tools: mapTools(opts.tools) }),
      }

      const response = await withRetry(() => client.messages.create(params))

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      const toolCalls = extractToolCalls(response.content)
      const usage: TokenUsage = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        model: opts.model,
        costUsd: estimateCost(opts.model, response.usage.input_tokens, response.usage.output_tokens),
      }

      return {
        content: text,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage,
        stopReason: response.stop_reason ?? undefined,
      }
    },

    async *stream(opts: {
      model: string
      system?: string
      messages: SessionMessage[]
      tools?: Tool[]
      maxTokens?: number
    }): AsyncIterable<StreamChunk> {
      const params: Anthropic.MessageCreateParams = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        messages: mapMessages(opts.messages),
        ...(opts.system && { system: opts.system }),
        ...(opts.tools?.length && { tools: mapTools(opts.tools) }),
      }

      const stream = client.messages.stream(params)
      let currentToolCall: { id: string; name: string } | null = null
      let toolInput = ''

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'tool_use') {
            currentToolCall = { id: block.id, name: block.name }
            toolInput = ''
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            toolInput += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolCall) {
            yield {
              type: 'tool_use',
              toolCall: {
                id: currentToolCall.id,
                name: currentToolCall.name,
                input: JSON.parse(toolInput || '{}'),
              },
            }
            currentToolCall = null
            toolInput = ''
          }
        } else if (event.type === 'message_delta') {
          const stopReason = event.delta.stop_reason
          if (stopReason) {
            yield { type: 'stop', stopReason }
          }
        } else if (event.type === 'message_start') {
          // usage from message_start
        }
      }

      const finalMessage = await stream.finalMessage()
      yield {
        type: 'usage',
        usage: {
          inputTokens: finalMessage.usage.input_tokens,
          outputTokens: finalMessage.usage.output_tokens,
          model: opts.model,
          costUsd: estimateCost(opts.model, finalMessage.usage.input_tokens, finalMessage.usage.output_tokens),
        },
      }
    },
  }
}
