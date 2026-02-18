import type { ChannelPlugin, KoshiConfig, MessageBatch, RouteMatch } from '../types.js'
import type { createBuffer } from './buffer.js'

export interface SpawnIntent {
  template: string
  task: string
  batch: MessageBatch
}

function matchesRule(match: RouteMatch, batch: MessageBatch): boolean {
  if (match.channel && batch.channel !== match.channel) return false
  if (match.from) {
    const senders = new Set(batch.messages.map((m) => m.sender))
    if (!senders.has(match.from)) return false
  }
  if (match.event) {
    // event matching against payload — check if any message payload contains the event
    const hasEvent = batch.messages.some((m) => m.payload === match.event)
    if (!hasEvent) return false
  }
  return true
}

function interpolate(template: string, batch: MessageBatch): string {
  return template.replace(/\{([^}]+)\}/g, (_, path: string) => {
    const parts = path.split('.')
    // Resolve against the first message in the batch
    const msg = batch.messages[0] as unknown as Record<string, unknown>
    let val: unknown = msg
    for (const p of parts) {
      if (val == null || typeof val !== 'object') return `{${path}}`
      val = (val as Record<string, unknown>)[p]
    }
    return val != null ? String(val) : `{${path}}`
  })
}

export function createRouter(config: KoshiConfig, buffer: ReturnType<typeof createBuffer>) {
  const channels = new Map<string, ChannelPlugin>()
  const mainQueue: MessageBatch[] = []
  const spawnIntents: SpawnIntent[] = []
  let timer: ReturnType<typeof setInterval> | null = null

  function route(): void {
    const batches = buffer.getUnrouted()

    for (const batch of batches) {
      const ids = batch.messages.map((m) => m.id)
      let matched = false

      for (const rule of config.routes) {
        if (!matchesRule(rule.match, batch)) continue
        matched = true

        if ('forward' in rule.action) {
          mainQueue.push(batch)
        } else if ('spawn' in rule.action) {
          const { template, task } = rule.action.spawn
          spawnIntents.push({
            template,
            task: interpolate(task, batch),
            batch,
          })
        }
        // 'drop' — just mark routed, do nothing

        buffer.markRouted(ids)
        break
      }

      if (!matched) {
        // Default: forward to main
        mainQueue.push(batch)
        buffer.markRouted(ids)
      }
    }
  }

  return {
    registerChannel(name: string, channel: ChannelPlugin): void {
      channels.set(name, channel)
    },

    start(): void {
      if (timer) return
      const interval = config.buffer?.batchWindowMs ?? 500
      timer = setInterval(() => route(), interval)
    },

    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },

    route,

    nextBatch(): MessageBatch | null {
      return mainQueue.shift() ?? null
    },

    getSpawnIntents(): SpawnIntent[] {
      return spawnIntents.splice(0)
    },
  }
}
