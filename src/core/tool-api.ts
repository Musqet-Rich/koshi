/**
 * HTTP API for tool execution — used by the MCP server to call Koshi tools.
 * POST /api/tools/call { tool: string, input: Record<string, unknown> }
 */

import type { FastifyInstance } from 'fastify'
import type { ToolCall } from '../types.js'
import type { createAgentManager } from './agents.js'
import type { createMemory } from './memory.js'
import type { createRouter } from './router.js'
import type { createSessionManager } from './sessions.js'
import { createLogger } from './logger.js'

const log = createLogger('tool-api')

interface ToolApiDeps {
  memory: ReturnType<typeof createMemory>
  agentManager?: ReturnType<typeof createAgentManager>
  router?: ReturnType<typeof createRouter>
  sessionManager?: ReturnType<typeof createSessionManager>
  executeTool: (toolCall: ToolCall) => string
}

export function registerToolApi(fastify: FastifyInstance, deps: ToolApiDeps): void {
  fastify.post('/api/tools/call', async (request, reply) => {
    const body = request.body as { tool?: string; input?: Record<string, unknown> }

    if (!body?.tool) {
      return reply.status(400).send({ error: 'Missing "tool" field' })
    }

    const toolCall: ToolCall = {
      id: `mcp-${Date.now()}`,
      name: body.tool,
      input: body.input ?? {},
    }

    try {
      const result = deps.executeTool(toolCall)
      log.info('MCP tool call', { tool: body.tool, resultLength: result.length })
      return reply.send({ result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.error('MCP tool call failed', { tool: body.tool, error: msg })
      return reply.status(500).send({ error: msg })
    }
  })

  log.info('Tool API registered at /api/tools/call')
}
