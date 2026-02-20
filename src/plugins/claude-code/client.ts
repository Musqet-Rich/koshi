import { spawn } from 'node:child_process'
import type { ModelResponse, SessionMessage, StreamChunk, TokenUsage, Tool } from '../../types.js'

export interface ClaudeCodeOptions {
  bin: string
  model: string
  messages: SessionMessage[]
  tools?: Tool[]
  skipPermissions: boolean
}

/**
 * Build the prompt string from session messages.
 * System messages become a preamble, then user/assistant messages are interleaved.
 * Claude Code's -p flag takes a single prompt string.
 */
function buildPrompt(messages: SessionMessage[]): { systemPrompt: string | undefined; userPrompt: string } {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  const nonSystemMsgs = messages.filter((m) => m.role !== 'system')

  const systemPrompt = systemMsgs.length ? systemMsgs.map((m) => m.content).join('\n\n') : undefined

  // For the user prompt, take the last user message as the primary prompt.
  // Include prior context as conversation history.
  const parts: string[] = []
  for (const msg of nonSystemMsgs) {
    if (msg.role === 'user') {
      parts.push(msg.content)
    } else if (msg.role === 'assistant') {
      parts.push(`[Previous assistant response]: ${msg.content}`)
    } else if (msg.role === 'tool') {
      parts.push(`[Tool result]: ${msg.content}`)
    }
  }

  return { systemPrompt, userPrompt: parts.join('\n\n') }
}

function buildArgs(opts: ClaudeCodeOptions, systemPrompt: string | undefined): string[] {
  const args = ['--print', '--output-format', 'json', '--model', opts.model]

  if (opts.skipPermissions) {
    args.push('--dangerously-skip-permissions')
  }

  if (systemPrompt) {
    args.push('--system-prompt', systemPrompt)
  }

  // Claude Code doesn't support passing tools via CLI — it has its own built-in tools.
  // For Koshi's purposes, we rely on Claude Code's native tool execution.

  return args
}

/**
 * Run Claude Code CLI in non-interactive mode and return the full response.
 */
export async function claudeCodeComplete(opts: ClaudeCodeOptions): Promise<ModelResponse> {
  const { systemPrompt, userPrompt } = buildPrompt(opts.messages)
  const args = buildArgs(opts, systemPrompt)

  return new Promise<ModelResponse>((resolve, reject) => {
    const proc = spawn(opts.bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    // Send the prompt via stdin
    proc.stdin.write(userPrompt)
    proc.stdin.end()

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`Claude Code exited with code ${code}: ${stderr}`))
        return
      }

      try {
        const result = JSON.parse(stdout)

        if (result.is_error) {
          reject(new Error(`Claude Code error: ${result.result}`))
          return
        }

        const usage: TokenUsage | undefined = result.usage
          ? {
              inputTokens: result.usage.input_tokens ?? 0,
              outputTokens: result.usage.output_tokens ?? 0,
              model: opts.model,
              costUsd: result.total_cost_usd ?? 0,
            }
          : undefined

        resolve({
          content: result.result ?? '',
          usage,
          stopReason: result.stop_reason ?? undefined,
        })
      } catch (_err) {
        reject(new Error(`Failed to parse Claude Code output: ${stdout.slice(0, 200)}`))
      }
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude Code: ${err.message}`))
    })
  })
}

/**
 * Run Claude Code CLI with streaming JSON output.
 */
export async function* claudeCodeStream(opts: ClaudeCodeOptions): AsyncIterable<StreamChunk> {
  const { systemPrompt, userPrompt } = buildPrompt(opts.messages)
  const args = buildArgs(opts, systemPrompt)
  // Switch to streaming output
  const streamArgs = args.map((a) => (a === 'json' ? 'stream-json' : a))

  const proc = spawn(opts.bin, streamArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  })

  proc.stdin.write(userPrompt)
  proc.stdin.end()

  let buffer = ''

  const chunks: StreamChunk[] = []
  let done = false
  let error: Error | null = null

  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString()
    // stream-json outputs one JSON object per line
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed)
        if (event.type === 'assistant') {
          // Text content from assistant
          if (event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                chunks.push({ type: 'text', text: block.text })
              }
            }
          }
        } else if (event.type === 'result') {
          // Final result
          if (event.usage) {
            chunks.push({
              type: 'usage',
              usage: {
                inputTokens: event.usage.input_tokens ?? 0,
                outputTokens: event.usage.output_tokens ?? 0,
                model: opts.model,
                costUsd: event.total_cost_usd ?? 0,
              },
            })
          }
          chunks.push({ type: 'stop', stopReason: event.stop_reason ?? 'end_turn' })
        }
      } catch {
        // Skip unparseable lines
      }
    }
  })

  proc.stderr.on('data', () => {
    // Ignore stderr for now
  })

  proc.on('error', (err) => {
    error = err
    done = true
  })

  proc.on('close', () => {
    done = true
  })

  // Yield chunks as they arrive
  while (!done || chunks.length > 0) {
    if (chunks.length > 0) {
      const chunk = chunks.shift()
      if (chunk) yield chunk
    } else if (!done) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  if (error) {
    throw error
  }
}
