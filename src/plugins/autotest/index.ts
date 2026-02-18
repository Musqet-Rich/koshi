import type { KoshiPlugin, KoshiContext, ChannelPlugin, IncomingMessage, OutgoingMessage, PluginConfig } from '../../types.js'

interface AutotestPlugin extends KoshiPlugin, ChannelPlugin {
  inject(message: string, opts?: { sender?: string; conversation?: string }): Promise<void>
  getResponses(): Array<{ content: string; conversation?: string }>
  waitForResponse(timeoutMs?: number): Promise<string>
}

const responses: Array<{ content: string; conversation?: string }> = []
let waiters: Array<{ resolve: (content: string) => void; reject: (err: Error) => void }> = []

const plugin: AutotestPlugin = {
  name: '@koshi/autotest',
  version: '0.0.1',

  async init(_context: KoshiContext, _config: PluginConfig) {
    // Nothing to register yet — router sets onMessage
  },

  async connect() {
    // No-op
  },

  async disconnect() {
    // No-op
  },

  async inject(message: string, opts?: { sender?: string; conversation?: string }): Promise<void> {
    const msg: IncomingMessage = {
      channel: 'autotest',
      sender: opts?.sender ?? 'test-user',
      conversation: opts?.conversation ?? 'test',
      payload: message,
    }
    if (this.onMessage) {
      this.onMessage(msg)
    }
  },

  getResponses(): Array<{ content: string; conversation?: string }> {
    const result = [...responses]
    responses.length = 0
    return result
  },

  async waitForResponse(timeoutMs = 30_000): Promise<string> {
    // If there's already a response queued, return it immediately
    if (responses.length > 0) {
      return responses.shift()!.content
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve)
        if (idx !== -1) waiters.splice(idx, 1)
        reject(new Error(`autotest: no response within ${timeoutMs}ms`))
      }, timeoutMs)

      waiters.push({
        resolve: (content: string) => {
          clearTimeout(timer)
          resolve(content)
        },
        reject,
      })
    })
  },

  async send(_target: string, message: OutgoingMessage): Promise<void> {
    const entry = { content: message.content, conversation: _target || undefined }

    // If someone is waiting, resolve them first
    if (waiters.length > 0) {
      const waiter = waiters.shift()!
      waiter.resolve(entry.content)
    } else {
      responses.push(entry)
    }
  },

  onMessage: null,
}

export default plugin
