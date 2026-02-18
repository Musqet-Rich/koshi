// Koshi (骨子) — core daemon entry point

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import type { ChannelPlugin, KoshiConfig, KoshiContext, ModelPlugin } from '../types.js'
import { createAgentManager } from './agents.js'
import { createBuffer } from './buffer.js'
import { loadConfig } from './config.js'
import { closeDatabase, initDatabase } from './db.js'
import { createLogger, fastifyLogger, setLogLevel } from './logger.js'
import { createMainLoop } from './main-loop.js'
import { createMemory } from './memory.js'
import { loadPlugins } from './plugins.js'
import { createPromptBuilder } from './prompt.js'
import { createRouter } from './router.js'
import { createSessionManager } from './sessions.js'
import { createTaskManager } from './tasks.js'
import { registerWebSocket, setTuiContext } from './ws.js'

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

  let config: KoshiConfig
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
  const _taskManager = createTaskManager(db)
  const buffer = createBuffer(db)
  const router = createRouter(config, buffer)

  // 5. Set up Fastify
  // biome-ignore lint/suspicious/noExplicitAny: Fastify's logger type is complex; our adapter is compatible at runtime
  const fastify = Fastify({ loggerInstance: fastifyLogger as any })

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
  const channelMap = new Map<string, ChannelPlugin>()
  try {
    const plugins = await loadPlugins(config, context)
    log.info(`Loaded ${plugins.length} plugin(s)`)

    // Register channel plugins with router
    for (const plugin of plugins) {
      const ch = plugin as unknown as ChannelPlugin
      if (typeof ch.connect === 'function' && typeof ch.send === 'function') {
        router.registerChannel(plugin.name, ch)
        channelMap.set(plugin.name, ch)
        // Also map short channel names (e.g. 'tui' for '@koshi/tui')
        const shortName = plugin.name.replace(/^@koshi\//, '')
        channelMap.set(shortName, ch)

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
    if (!model)
      throw new Error(`Model "${name}" not registered. Available: ${Object.keys(context.models).join(', ') || 'none'}`)
    return model
  }

  // 9. Initialize agent manager
  const _agentManager = createAgentManager({
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

  // 10b. Start main agent loop
  const mainLoop = createMainLoop({
    config,
    router,
    getModel,
    sessionManager,
    promptBuilder,
    memory,
    getChannel: (name: string) => channelMap.get(name),
  })
  mainLoop.start()

  // 11. Buffer cleanup interval (daily)
  const cleanupTimer = setInterval(() => {
    const cleaned = buffer.cleanup(config.buffer.retentionDays)
    if (cleaned > 0) log.info(`Buffer cleanup: removed ${cleaned} old messages`)
  }, 86400000)

  // 12. Register WebSocket
  setTuiContext(context)
  await registerWebSocket(fastify, config)

  // 13. Start Fastify
  const host = '0.0.0.0'
  const port = 3200
  try {
    await fastify.listen({ host, port })
    log.info(`Server listening on ${host}:${port}`)
  } catch (err) {
    log.error(`Failed to start server: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  // 14. Graceful shutdown
  const shutdown = async (signal: string) => {
    log.info(`Received ${signal}, shutting down...`)
    clearInterval(cleanupTimer)
    mainLoop.stop()
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
