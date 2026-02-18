// Koshi (骨子) — core daemon entry point

import Fastify from 'fastify'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { loadConfig } from './config.js'
import { initDatabase, closeDatabase } from './db.js'
import { createLogger, setLogLevel, fastifyLogger } from './logger.js'
import { loadPlugins } from './plugins.js'
import { createBuffer } from './buffer.js'
import { createRouter } from './router.js'
import { createMemory } from './memory.js'
import { createSessionManager } from './sessions.js'
import { createPromptBuilder } from './prompt.js'
import { createTaskManager } from './tasks.js'
import { createAgentManager } from './agents.js'
import type { KoshiContext, ModelPlugin, ChannelPlugin } from '../types.js'

const log = createLogger('core')

export async function main(): Promise<void> {
  // 1. Load config
  let configPath = resolve('koshi.yaml')
  if (!existsSync(configPath)) {
    configPath = resolve('koshi.example.yaml')
    if (!existsSync(configPath)) {
      log.error('No koshi.yaml or koshi.example.yaml found. Create one and try again.')
      process.exit(1)
    }
    log.warn('koshi.yaml not found, falling back to koshi.example.yaml')
  }

  let config
  try {
    config = loadConfig(configPath)
  } catch (err) {
    log.error(`Failed to load config: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // 2. Set log level
  setLogLevel(config.logLevel ?? 'info')

  log.info(`Starting ${config.name}`, { dataPath: config.dataPath })

  // 3. Initialize database
  const dataPath = resolve(config.dataPath ?? './data')
  const db = initDatabase(dataPath)
  log.info('Database initialized', { path: dataPath })

  // 4. Initialize core systems
  const memory = createMemory(db)
  const sessionManager = createSessionManager(db)
  const promptBuilder = createPromptBuilder(config)
  const taskManager = createTaskManager(db)
  const buffer = createBuffer(db)
  const router = createRouter(config, buffer)

  // 5. Set up Fastify
  const fastify = Fastify({ logger: fastifyLogger as any })

  // Health endpoint
  fastify.get('/health', async () => ({
    status: 'ok',
    name: config.name,
    uptime: process.uptime(),
  }))

  // 6. Build context for plugins
  const models: Record<string, ModelPlugin> = {}

  const context: KoshiContext & { db: typeof db; models: typeof models } = {
    fastify: fastify as unknown,
    router: router as unknown,
    memory: memory as unknown,
    buffer: buffer as unknown,
    config,
    db,
    models,
  }

  // 7. Load plugins
  try {
    const plugins = await loadPlugins(config, context)
    log.info(`Loaded ${plugins.length} plugin(s)`)

    // Register channel plugins with router
    for (const plugin of plugins) {
      const ch = plugin as unknown as ChannelPlugin
      if (typeof ch.connect === 'function' && typeof ch.send === 'function') {
        router.registerChannel(plugin.name, ch)

        // Wire incoming messages to buffer
        ch.onMessage = (msg) => {
          buffer.insert({
            channel: msg.channel,
            sender: msg.sender,
            conversation: msg.conversation,
            payload: msg.payload,
            priority: msg.priority,
          })
        }

        try {
          await ch.connect()
          log.info(`Channel connected: ${plugin.name}`)
        } catch (err) {
          log.warn(`Channel ${plugin.name} failed to connect: ${err instanceof Error ? err.message : err}`)
        }
      }
    }
  } catch (err) {
    log.error(`Plugin loading failed: ${err instanceof Error ? err.message : err}`)
    // Continue without plugins — allows basic health check
  }

  // 8. Model lookup helper
  const getModel = (name: string): ModelPlugin => {
    const model = context.models[name]
    if (!model) throw new Error(`Model "${name}" not registered. Available: ${Object.keys(context.models).join(', ') || 'none'}`)
    return model
  }

  // 9. Initialize agent manager
  const agentManager = createAgentManager({
    config,
    getModel,
    sessionManager,
    promptBuilder,
    memory,
    db,
  })

  // 10. Start router
  router.start()
  log.info('Router started', { batchWindowMs: config.buffer.batchWindowMs })

  // 11. Buffer cleanup interval (daily)
  const cleanupTimer = setInterval(() => {
    const cleaned = buffer.cleanup(config.buffer.retentionDays)
    if (cleaned > 0) log.info(`Buffer cleanup: removed ${cleaned} old messages`)
  }, 86400000)

  // 12. Start Fastify
  const host = '0.0.0.0'
  const port = 3100
  try {
    await fastify.listen({ host, port })
    log.info(`Server listening on ${host}:${port}`)
  } catch (err) {
    log.error(`Failed to start server: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // 13. Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`)
    clearInterval(cleanupTimer)
    router.stop()
    try {
      await fastify.close()
    } catch {}
    closeDatabase(db)
    log.info('Shutdown complete')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Run if executed directly (not when imported by CLI)
const isDirectRun = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts')
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
  })
}
