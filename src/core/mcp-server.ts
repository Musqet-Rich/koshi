#!/usr/bin/env node
/**
 * Koshi MCP Server — exposes Koshi's native tools to Claude Code via stdio.
 * Spawned by Claude Code as a child process. Calls back to Koshi's HTTP API
 * for actual tool execution.
 *
 * Usage: node dist/core/mcp-server.js [--port 3200]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const KOSHI_PORT = process.env.KOSHI_PORT ?? '3200'
const KOSHI_URL = `http://127.0.0.1:${KOSHI_PORT}`

async function callKoshi(toolName: string, input: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${KOSHI_URL}/api/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool: toolName, input }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Koshi tool call failed (${res.status}): ${text}`)
  }
  const data = (await res.json()) as { result: string }
  return data.result
}

const server = new McpServer({
  name: 'koshi-tools',
  version: '0.0.1',
})

// ─── Memory Tools ────────────────────────────────────────────────────────────

server.tool(
  'memory_query',
  'Search memory for relevant information. Use keywords and synonyms only — no filler words.',
  {
    query: z.string().describe('Keywords and synonyms only — no filler words or punctuation'),
    limit: z.number().optional().describe('Max results to return (default 5)'),
  },
  async ({ query, limit }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('memory_query', { query, limit }) }],
  }),
)

server.tool(
  'memory_store',
  'Store something in long-term memory. Use for facts, preferences, or anything worth remembering.',
  {
    content: z.string().describe('What to remember'),
    tags: z.string().optional().describe('Comma-separated tags for categorisation'),
  },
  async ({ content, tags }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('memory_store', { content, tags }) }],
  }),
)

server.tool(
  'memory_reinforce',
  'Mark a memory as useful — increases its ranking in future searches.',
  {
    id: z.number().describe('Memory ID to reinforce'),
  },
  async ({ id }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('memory_reinforce', { id }) }],
  }),
)

server.tool(
  'memory_demote',
  'Mark a memory as less useful — decreases its ranking.',
  {
    id: z.number().describe('Memory ID to demote'),
  },
  async ({ id }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('memory_demote', { id }) }],
  }),
)

server.tool(
  'memory_update',
  'Update an existing memory in place — correct outdated facts without re-storing.',
  {
    id: z.number().describe('Memory ID to update'),
    content: z.string().describe('New content for the memory'),
    tags: z.string().optional().describe('New comma-separated tags'),
  },
  async ({ id, content, tags }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('memory_update', { id, content, tags }) }],
  }),
)

// ─── Scheduling Tools ────────────────────────────────────────────────────────

server.tool(
  'schedule_job',
  'Schedule a timed job. For reminders use payload_type "notify", for background work use "spawn".',
  {
    name: z.string().describe('Short human-readable name for the job'),
    schedule_at: z.string().describe('ISO 8601 timestamp when the job should fire'),
    payload_type: z.enum(['notify', 'spawn']).describe('Job type'),
    payload: z.record(z.string(), z.unknown()).describe('Job payload — { message } for notify, { task } for spawn'),
  },
  async ({ name, schedule_at, payload_type, payload }) => ({
    content: [
      {
        type: 'text' as const,
        text: await callKoshi('schedule_job', { name, schedule_at, payload_type, payload }),
      },
    ],
  }),
)

server.tool(
  'cancel_job',
  'Cancel a pending scheduled job by ID.',
  {
    id: z.string().describe('Job ID to cancel'),
  },
  async ({ id }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('cancel_job', { id }) }],
  }),
)

server.tool(
  'list_jobs',
  'List all scheduled jobs with their status.',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: await callKoshi('list_jobs', {}) }],
  }),
)

// ─── Skill Tools ─────────────────────────────────────────────────────────────

server.tool(
  'load_skill',
  'Load the full instructions for a skill by name.',
  {
    name: z.string().describe('Skill name to load'),
  },
  async ({ name }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('load_skill', { name }) }],
  }),
)

server.tool(
  'create_skill',
  'Create a new skill to teach yourself how to handle a recurring pattern.',
  {
    name: z.string().describe('Short kebab-case identifier'),
    description: z.string().describe('One sentence explaining what the skill covers'),
    triggers: z.array(z.string()).describe('Keywords/phrases that should activate this skill'),
    content: z.string().describe('Full recipe in markdown'),
  },
  async ({ name, description, triggers, content }) => ({
    content: [
      { type: 'text' as const, text: await callKoshi('create_skill', { name, description, triggers, content }) },
    ],
  }),
)

server.tool(
  'update_skill',
  'Update an existing agent-created skill.',
  {
    name: z.string().describe('Skill name to update'),
    description: z.string().optional().describe('New description'),
    triggers: z.array(z.string()).optional().describe('New triggers array'),
    content: z.string().optional().describe('New content'),
  },
  async ({ name, description, triggers, content }) => ({
    content: [
      { type: 'text' as const, text: await callKoshi('update_skill', { name, description, triggers, content }) },
    ],
  }),
)

server.tool(
  'list_skills',
  'List all available skills with their metadata (name, description, triggers, tools, source). Returns a concise index without full skill content.',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: await callKoshi('list_skills', {}) }],
  }),
)

// ─── Agent Tools ─────────────────────────────────────────────────────────────

server.tool(
  'spawn_agent',
  'Spawn a background sub-agent for complex work requiring shell/file/web access.',
  {
    task: z.string().describe('Clear description of what the agent should do'),
    model: z.string().optional().describe('Model to use (optional)'),
    timeout: z.number().optional().describe('Timeout in seconds (default 300)'),
  },
  async ({ task, model, timeout }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('spawn_agent', { task, model, timeout }) }],
  }),
)

server.tool(
  'list_agents',
  'List running and recently completed sub-agents.',
  {},
  async () => ({
    content: [{ type: 'text' as const, text: await callKoshi('list_agents', {}) }],
  }),
)

server.tool(
  'read_file',
  'Read a file from disk (e.g. sub-agent output files).',
  {
    path: z.string().describe('File path to read'),
  },
  async ({ path }) => ({
    content: [{ type: 'text' as const, text: await callKoshi('read_file', { path }) }],
  }),
)

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`)
  process.exit(1)
})
