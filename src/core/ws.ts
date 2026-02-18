// WebSocket handler for TUI client connections

import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import type { WebSocket } from 'ws'
import type { KoshiConfig, KoshiContext } from '../types.js'
import { createLogger } from './logger.js'

const log = createLogger('ws')

// ─── Message Types ───────────────────────────────────────────────────────────

export interface WsStatusMessage {
  type: 'status'
  name: string
  uptime: number
}

export interface WsUserMessage {
  type: 'user_message'
  content: string
  conversation?: string
}

export interface WsAssistantChunk {
  type: 'assistant_chunk'
  text: string
  conversation?: string
}

export interface WsAssistantDone {
  type: 'assistant_done'
  content: string
  conversation?: string
}

export type WsIncoming = WsUserMessage
export type WsOutgoing = WsStatusMessage | WsAssistantChunk | WsAssistantDone

// ─── Client tracking ─────────────────────────────────────────────────────────

const clients = new Set<WebSocket>()

export function getClients(): ReadonlySet<WebSocket> {
  return clients
}

export function broadcast(message: WsOutgoing): void {
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(data)
    }
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

let tuiContext: KoshiContext | null = null

export function setTuiContext(ctx: KoshiContext): void {
  tuiContext = ctx
}

export async function registerWebSocket(fastify: FastifyInstance, config: KoshiConfig): Promise<void> {
  await fastify.register(websocket)

  fastify.get('/ws/tui', { websocket: true }, (socket, _req) => {
    clients.add(socket)
    log.info('TUI client connected', { total: clients.size })

    // Send status on connect
    const status: WsStatusMessage = {
      type: 'status',
      name: config.name,
      uptime: process.uptime(),
    }
    socket.send(JSON.stringify(status))

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as WsIncoming
        if (msg.type === 'user_message') {
          log.debug('Received user_message', { content: msg.content?.slice(0, 80) })
          // Route to TUI channel plugin if available
          const tuiChannel = tuiContext ? (tuiContext as any)._tuiChannel : null
          if (tuiChannel && typeof tuiChannel.handleUserMessage === 'function') {
            tuiChannel.handleUserMessage(msg)
          } else {
            log.warn('No TUI channel plugin registered — message not routed')
          }
        } else {
          log.warn('Unknown WS message type', { type: (msg as any).type })
        }
      } catch (err) {
        log.warn('Invalid WS message', { error: err instanceof Error ? err.message : err })
      }
    })

    socket.on('close', () => {
      clients.delete(socket)
      log.info('TUI client disconnected', { total: clients.size })
    })

    socket.on('error', (err) => {
      log.warn('WS client error', { error: err.message })
      clients.delete(socket)
    })
  })

  log.info('WebSocket registered at /ws/tui')
}
