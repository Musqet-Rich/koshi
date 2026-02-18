import { createLogger } from '../core/logger.js'
import type { WsUserMessage } from '../core/ws.js'
import { broadcast } from '../core/ws.js'
import type {
  ChannelPlugin,
  IncomingMessage,
  KoshiContext,
  KoshiContextWithExtras,
  KoshiPlugin,
  OutgoingMessage,
  PluginConfig,
} from '../types.js'

const log = createLogger('tui-channel')

export interface TuiChannelPlugin extends KoshiPlugin, ChannelPlugin {
  handleUserMessage(msg: WsUserMessage): void
}

const plugin: TuiChannelPlugin = {
  name: '@koshi/tui',
  version: '0.0.1',

  async init(context: KoshiContext, _config: PluginConfig) {
    ;(context as KoshiContextWithExtras)._tuiChannel = this
    log.info('TUI channel plugin initialized')
  },

  async connect() {
    log.info('TUI channel connected (WebSocket-backed)')
  },

  async disconnect() {
    log.info('TUI channel disconnected')
  },

  async send(target: string, message: OutgoingMessage): Promise<void> {
    if (message.streaming) {
      broadcast({
        type: 'assistant_chunk',
        text: message.content,
        conversation: target || undefined,
      })
    } else {
      broadcast({
        type: 'assistant_done',
        content: message.content,
        conversation: target || undefined,
      })
    }
  },

  handleUserMessage(msg: WsUserMessage): void {
    if (!this.onMessage) {
      log.warn('No onMessage handler registered — message dropped')
      return
    }

    const incoming: IncomingMessage = {
      channel: 'tui',
      sender: 'tui-user',
      conversation: msg.conversation ?? 'tui',
      payload: msg.content,
    }
    this.onMessage(incoming)
  },

  onMessage: null,
}

export default plugin
