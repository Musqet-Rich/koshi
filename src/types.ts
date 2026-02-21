// ─── Config ──────────────────────────────────────────────────────────────────

export interface KoshiConfig {
  name: string
  identity: {
    soul: string
  }
  models: Record<string, ModelConfig>
  agent: {
    model: string
    subAgentModel?: string
    contextLimit?: number
    compactionThreshold?: number
  }
  plugins: PluginConfig[]
  routes: RouteRule[]
  templates: Record<string, AgentTemplate>
  buffer: {
    retentionDays: number
    batchWindowMs: number
  }
  memory: {
    backend: string
    reinforceWeight?: number
    demoteWeight?: number
    maxSize?: string
    maxEntries?: number
    pruneSchedule?: string
    prunePercent?: number
  }
  sessions: {
    maxMessages?: number
    maxTokens?: number
  }
  cron: CronJobConfig[]
  agents?: {
    maxConcurrent?: number
    defaultTimeout?: number
  }
  dataPath?: string
  skillsPath?: string
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
  debug?: {
    logPrompts?: boolean
  }
}

export interface ModelConfig {
  plugin: string
  model: string
  apiKey?: string
  endpoint?: string
}

export interface PluginConfig {
  name: string
  [key: string]: unknown
}

// ─── Plugins ─────────────────────────────────────────────────────────────────

export interface KoshiContext {
  fastify: unknown
  router: unknown
  memory: unknown
  buffer: unknown
  config: KoshiConfig
}

/** Extended context with runtime fields added by plugins */
export interface KoshiContextWithExtras extends KoshiContext {
  _tuiChannel?: unknown
  db?: unknown
  models?: Record<string, ModelPlugin>
}

export interface KoshiPlugin {
  name: string
  version: string
  init(koshi: KoshiContext, config: PluginConfig): Promise<void>
}

export interface ChannelPlugin extends KoshiPlugin {
  connect(): Promise<void>
  disconnect(): Promise<void>
  send(target: string, message: OutgoingMessage): Promise<void>
  onMessage: ((msg: IncomingMessage) => void) | null
}

export interface ModelPlugin {
  complete(messages: SessionMessage[], tools?: Tool[]): Promise<ModelResponse>
  stream(messages: SessionMessage[], tools?: Tool[]): AsyncIterable<StreamChunk>
}

export interface MemoryPlugin extends KoshiPlugin {
  store(content: string, source: string, tags: string, sessionId?: string): Promise<number>
  query(query: MemoryQuery): Promise<MemoryResult[]>
  reinforce(id: number): void
  demote(id: number): void
  forget(id: number): void
  prune(maxSize: number, prunePercent: number): Promise<number>
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface IncomingMessage {
  channel: string
  sender: string
  conversation: string
  payload: string
  priority?: number
}

export interface BufferedMessage {
  id: number
  channel: string
  sender: string
  conversation: string
  payload: string
  receivedAt: string
  priority: number
  routed: boolean
}

export interface MessageBatch {
  channel: string
  conversation: string
  messages: BufferedMessage[]
}

export interface OutgoingMessage {
  content: string
  streaming?: boolean
  metadata?: Record<string, unknown>
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export interface RouteMatch {
  channel?: string
  event?: string
  action?: string
  from?: string
}

export type RouteAction = { forward: string } | { spawn: SpawnRouteAction } | { drop: true }

export interface SpawnRouteAction {
  template: string
  task: string
  autoRun?: boolean
}

export interface RouteRule {
  match: RouteMatch
  action: RouteAction
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'blocked' | 'running' | 'completed' | 'failed'

export interface Task {
  id: number
  projectId?: string
  title: string
  context?: string
  skill?: string
  dependsOn: number[]
  status: TaskStatus
  agentResultId?: number
  createdAt: string
}

/** Raw SQLite row shape for the tasks table. */
export interface TaskRow {
  id: number
  project_id: string | null
  title: string
  context: string | null
  skill: string | null
  depends_on: string
  status: string
  agent_result_id: number | null
  created_at: string
}

export interface CreateTaskOptions {
  title: string
  projectId?: string
  context?: string
  skill?: string
  dependsOn?: number[]
  status?: TaskStatus
}

export interface TaskFilter {
  status?: TaskStatus
  projectId?: string
  skill?: string
}

// ─── Agent Results ──────────────────────────────────────────────────────────

export interface AgentResultRow {
  id: number
  taskId?: number
  skillUsed?: string
  output: string
  memoryIds: number[]
  createdAt: string
}

// ─── Narratives ─────────────────────────────────────────────────────────────

export interface Narrative {
  id: number
  summary: string
  memoryIds: number[]
  previousNarrativeId: number | null
  topic: string | null
  createdAt: string
}

/** Raw SQLite row shape for the narratives table. */
export interface NarrativeRow {
  id: number
  summary: string
  memory_ids: string
  previous_narrative_id: number | null
  topic: string | null
  created_at: string
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: number
  content: string
  source?: string
  tags?: string
  createdAt: string
  lastHitAt?: string
  score: number
  sessionId?: string
}

export interface MemoryQuery {
  query: string
  limit?: number
}

export interface MemoryResult {
  id: number
  content: string
  source?: string
  tags?: string
  score: number
  rank: number
  finalRank?: number
}

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  model?: string
  type: 'main' | 'sub-agent'
}

export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  createdAt?: string
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export interface AgentTemplate {
  tools: string[]
  model: string
  timeout?: number
  exec?: {
    allowlist?: string[]
  }
  files?: {
    extraPaths?: string[]
  }
}

export interface SpawnOptions {
  task: string
  template?: string
  model?: string
  tools?: string[]
  timeout?: number
}

export interface AgentResult {
  agentRunId: string
  taskId?: number
  status: 'completed' | 'failed' | 'timed_out'
  result?: string
  error?: string
  usage?: TokenUsage
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  toolUseId: string
  content: string
  isError?: boolean
}

// ─── Model Response ──────────────────────────────────────────────────────────

export interface ModelResponse {
  content: string
  toolCalls?: ToolCall[]
  usage?: TokenUsage
  stopReason?: string
}

export interface StreamChunk {
  type: 'text' | 'tool_use' | 'usage' | 'stop'
  text?: string
  toolCall?: ToolCall
  usage?: TokenUsage
  stopReason?: string
}

// ─── Token Usage ─────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  model: string
  costUsd?: number
  agentRunId?: string
  sessionId?: string
  createdAt?: string
}

// ─── Cron ────────────────────────────────────────────────────────────────────

export interface CronJobConfig {
  name: string
  schedule: string
  task: {
    title: string
    template?: string
    autoRun?: boolean
  }
}

export interface CronJob {
  name: string
  schedule: string
  task: CronJobConfig['task']
  stop(): void
}
