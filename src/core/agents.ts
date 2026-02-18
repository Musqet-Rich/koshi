import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import type {
  AgentResult,
  KoshiConfig,
  ModelPlugin,
  SessionMessage,
  SpawnOptions,
  TokenUsage,
  Tool,
  ToolCall,
} from '../types.js'
import { createLogger } from './logger.js'
import type { createMemory } from './memory.js'
import type { createPromptBuilder } from './prompt.js'
import type { createSessionManager } from './sessions.js'

const execAsync = promisify(execCb)
const log = createLogger('agents')
const MAX_ITERATIONS = 20
const EXEC_TIMEOUT_MS = 30_000
const MAX_OUTPUT_CHARS = 10_000

// ─── Sub-agent Tools ─────────────────────────────────────────────────────────

const SUBAGENT_TOOLS: Tool[] = [
  {
    name: 'exec',
    description:
      'Execute a shell command. Use for web requests (curl), file operations, code execution, etc. Commands run in a sandboxed workspace. Timeout: 30s.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
        cwd: { type: 'string', description: 'Working directory (optional)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write content to a file. Use this for large outputs (file contents, long results, etc.) instead of returning them directly. Write to /tmp/koshi-agent/ and return the file path in your final response.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path to write to (e.g. /tmp/koshi-agent/result.md)' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store a result or finding in long-term memory so the main agent can access it later.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to store' },
        tags: { type: 'string', description: 'Comma-separated tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_query',
    description: 'Search memory for relevant context.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
]

async function executeSubagentTool(
  tc: ToolCall,
  memory: ReturnType<typeof createMemory>,
  workspacePath: string,
): Promise<string> {
  switch (tc.name) {
    case 'exec': {
      const command = tc.input.command as string
      const cwd = (tc.input.cwd as string) || workspacePath
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, PATH: process.env.PATH },
        })
        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n--- stderr ---\n' : '') + stderr
        if (!output) output = '(no output)'
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)'
        }
        return output
      } catch (err) {
        const e = err as { code?: number; killed?: boolean; stdout?: string; stderr?: string; message?: string }
        if (e.killed) return 'Command timed out after 30s'
        let output = ''
        if (e.stdout) output += e.stdout
        if (e.stderr) output += (output ? '\n--- stderr ---\n' : '') + e.stderr
        if (!output) output = e.message ?? 'Command failed'
        if (output.length > MAX_OUTPUT_CHARS) {
          output = output.slice(0, MAX_OUTPUT_CHARS) + '\n... (truncated)'
        }
        return `Exit code ${e.code ?? 'unknown'}:\n${output}`
      }
    }
    case 'write_file': {
      const filePath = tc.input.path as string
      const content = tc.input.content as string
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      try {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, content, 'utf-8')
        return `Written ${content.length} bytes to ${filePath}`
      } catch (err) {
        return `Failed to write file: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case 'memory_store': {
      const content = tc.input.content as string
      const tags = (tc.input.tags as string) ?? undefined
      const id = memory.store(content, 'sub-agent', tags)
      return `Stored memory #${id}`
    }
    case 'memory_query': {
      const query = tc.input.query as string
      const limit = (tc.input.limit as number) ?? 5
      const results = memory.query(query, limit)
      if (results.length === 0) return 'No memories found.'
      return results.map((r) => `[id:${r.id}] ${r.content}${r.tags ? ` (tags: ${r.tags})` : ''}`).join('\n')
    }
    default:
      return `Unknown tool: ${tc.name}`
  }
}

// ─── Agent Manager ───────────────────────────────────────────────────────────

interface RunningAgent {
  id: string
  task: string
  startedAt: number
  model: string
}

export function createAgentManager(opts: {
  config: KoshiConfig
  getModel: (name: string) => ModelPlugin
  sessionManager: ReturnType<typeof createSessionManager>
  promptBuilder: ReturnType<typeof createPromptBuilder>
  memory: ReturnType<typeof createMemory>
  db: Database.Database
}) {
  const { config, getModel, sessionManager, promptBuilder, memory } = opts
  const running = new Map<string, RunningAgent>()
  const completed: Array<{ id: string; task: string; status: string; completedAt: number }> = []

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
      const modelName = options.model ?? config.agent.subAgentModel ?? config.agent.model
      const timeout = options.timeout ?? config.agents?.defaultTimeout ?? 300

      running.set(agentRunId, {
        id: agentRunId,
        task: options.task.slice(0, 100),
        startedAt: Date.now(),
        model: modelName,
      })

      log.info('Spawning sub-agent', { runId: agentRunId.slice(0, 8), task: options.task.slice(0, 80) })

      // Timeout setup
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
      }, timeout * 1000)

      try {
        const sessionId = sessionManager.createSession({ model: modelName, type: 'sub-agent' })
        const memories = memory.query(options.task, 5)

        const basePrompt = promptBuilder.build({
          memories,
          tools: SUBAGENT_TOOLS,
          activeContext: options.task,
        })
        const systemPrompt = `${basePrompt}

## Sub-agent Rules
- You are a background worker. Complete the task and report results clearly.
- For large outputs (file contents, long text, research results), use the write_file tool to write to /tmp/koshi-agent/<descriptive-name>.md, then mention the file path in your final response.
- Your final text response will be passed back to the main agent. Keep it concise but include key findings and any file paths.
- ALWAYS use tools to do work. Never describe what you would do — do it.`

        const model = getModel(modelName)
        const workspacePath = config.dataPath ? config.dataPath : process.cwd()

        const messages: SessionMessage[] = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: options.task },
        ]

        const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, model: modelName, agentRunId }
        let lastContent = ''

        for (let i = 0; i < MAX_ITERATIONS; i++) {
          if (timedOut) {
            running.delete(agentRunId)
            clearTimeout(timer)
            completed.push({
              id: agentRunId,
              task: options.task.slice(0, 100),
              status: 'timed_out',
              completedAt: Date.now(),
            })
            memory.store(`Agent ${agentRunId.slice(0, 8)} timed out on task: ${options.task}`, 'agent', 'agent,timeout')
            return { agentRunId, status: 'timed_out', usage: totalUsage }
          }

          const response = await model.complete(messages, SUBAGENT_TOOLS)

          if (response.usage) {
            totalUsage.inputTokens += response.usage.inputTokens
            totalUsage.outputTokens += response.usage.outputTokens
          }

          lastContent = response.content ?? ''

          sessionManager.addMessage(
            sessionId,
            'assistant',
            response.content ?? '',
            response.toolCalls ? JSON.stringify(response.toolCalls) : undefined,
          )

          if (!response.toolCalls || response.toolCalls.length === 0) break

          log.info('Sub-agent tool calls', {
            runId: agentRunId.slice(0, 8),
            tools: response.toolCalls.map((t) => t.name).join(', '),
          })

          // Add assistant message with tool calls
          messages.push({
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: response.toolCalls,
          })

          // Execute tools and add results
          for (const tc of response.toolCalls) {
            const result = await executeSubagentTool(tc, memory, workspacePath)
            log.info('Sub-agent tool result', {
              runId: agentRunId.slice(0, 8),
              tool: tc.name,
              resultLength: result.length,
            })
            messages.push({
              role: 'tool',
              content: result,
              toolCalls: [{ id: tc.id, name: tc.name, input: {} }],
            })
          }
        }

        clearTimeout(timer)
        running.delete(agentRunId)
        completed.push({
          id: agentRunId,
          task: options.task.slice(0, 100),
          status: 'completed',
          completedAt: Date.now(),
        })

        const summary = lastContent.slice(0, 2000)
        memory.store(`Agent completed task: ${options.task}\nResult: ${summary}`, 'agent', 'agent,result')

        log.info('Sub-agent completed', { runId: agentRunId.slice(0, 8), status: 'completed' })

        return { agentRunId, status: 'completed', result: lastContent, usage: totalUsage }
      } catch (err) {
        clearTimeout(timer)
        running.delete(agentRunId)
        const error = err instanceof Error ? err.message : String(err)
        completed.push({ id: agentRunId, task: options.task.slice(0, 100), status: 'failed', completedAt: Date.now() })
        log.error('Sub-agent failed', { runId: agentRunId.slice(0, 8), error })
        return { agentRunId, status: 'failed', error }
      }
    },

    getRunningCount(): number {
      return running.size
    },

    getRunning(): RunningAgent[] {
      return [...running.values()]
    },

    getCompleted(limit = 10): Array<{ id: string; task: string; status: string; completedAt: number }> {
      return completed.slice(-limit)
    },
  }
}
