// Koshi TUI — terminal chat interface using pi-tui

import { Container, Editor, Key, Loader, matchesKey, ProcessTerminal, Text, TUI } from '@mariozechner/pi-tui'
import WebSocket from 'ws'
import { ChatLog } from './chat-log.js'
import { editorTheme, theme } from './theme.js'

interface Activity {
  state: 'idle' | 'thinking' | 'tool_call' | 'streaming'
  tool?: string
  elapsed?: number
  model?: string
  session?: string
  tokensIn?: number
  tokensOut?: number
  costUsd?: number
  contextTokens?: number
  contextLimit?: number
  contextPercent?: number
  agents?: number
}

class KoshiEditor extends Editor {
  onCtrlC?: () => void
  onCtrlD?: () => void

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c')) && this.onCtrlC) {
      this.onCtrlC()
      return
    }
    if (matchesKey(data, Key.ctrl('d')) && this.onCtrlD) {
      this.onCtrlD()
      return
    }
    super.handleInput(data)
  }
}

export function startTui(port = 3200): void {
  const session = 'tui'

  let ws: WebSocket | null = null
  let connected = false
  let serverName = 'koshi'
  let activity: Activity = { state: 'idle' }
  let lastCtrlCAt = 0
  let streamingContent = ''

  // --- TUI layout ---
  const tui = new TUI(new ProcessTerminal())
  const root = new Container()
  const chatLog = new ChatLog()
  const statusContainer = new Container()
  const separator1 = new Text(theme.border('─'.repeat(120)), 1, 0)
  const separator2 = new Text(theme.border('─'.repeat(120)), 1, 0)
  const editor = new KoshiEditor(tui, editorTheme)

  root.addChild(chatLog)
  root.addChild(separator1)
  root.addChild(statusContainer)
  root.addChild(separator2)
  root.addChild(editor)
  tui.addChild(root)
  tui.setFocus(editor)

  // --- Status rendering ---
  let statusText: Text | null = null
  let statusLoader: Loader | null = null
  let statusTimer: NodeJS.Timeout | null = null
  let statusStartedAt: number | null = null

  const formatElapsed = (startMs: number) => {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startMs) / 1000))
    if (totalSeconds < 60) return `${totalSeconds}s`
    const m = Math.floor(totalSeconds / 60)
    const s = totalSeconds % 60
    return `${m}m ${s}s`
  }

  const formatTokenCount = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return String(n)
  }

  const buildStatusSuffix = () => {
    const parts: string[] = []
    parts.push(connected ? 'connected' : 'disconnected')
    parts.push(serverName)
    if (activity.session) parts.push(`session:${activity.session}`)
    if (activity.model) parts.push(activity.model)
    // Context window usage
    if (activity.contextTokens && activity.contextLimit) {
      parts.push(
        `tokens ${formatTokenCount(activity.contextTokens)}/${formatTokenCount(activity.contextLimit)} (${activity.contextPercent ?? 0}%)`,
      )
    } else if (activity.tokensIn || activity.tokensOut) {
      // Cumulative session tokens when no context info
      const total = (activity.tokensIn ?? 0) + (activity.tokensOut ?? 0)
      parts.push(`${formatTokenCount(total)} tokens`)
    }
    // Cost
    if (activity.costUsd && activity.costUsd > 0) {
      parts.push(`$${activity.costUsd.toFixed(2)}`)
    }
    if (activity.agents) parts.push(`${activity.agents} agent${activity.agents > 1 ? 's' : ''}`)
    return parts.join(' | ')
  }

  const renderStatus = () => {
    const isBusy = activity.state !== 'idle'

    if (isBusy) {
      if (!statusStartedAt) statusStartedAt = Date.now()

      // Switch to loader
      if (!statusLoader) {
        statusContainer.clear()
        statusText = null
        statusLoader = new Loader(
          tui,
          (spinner) => theme.accent(spinner),
          (text) => theme.dim(text),
          '',
        )
        statusContainer.addChild(statusLoader)
      }

      const elapsed = formatElapsed(statusStartedAt)
      const stateLabel = activity.state === 'tool_call' && activity.tool ? `tool: ${activity.tool}` : activity.state
      statusLoader.setMessage(`${stateLabel} • ${elapsed} | ${buildStatusSuffix()}`)

      if (!statusTimer) {
        statusTimer = setInterval(() => {
          if (activity.state === 'idle') return
          const el = statusStartedAt ? formatElapsed(statusStartedAt) : '0s'
          const label = activity.state === 'tool_call' && activity.tool ? `tool: ${activity.tool}` : activity.state
          statusLoader?.setMessage(`${label} • ${el} | ${buildStatusSuffix()}`)
        }, 1000)
      }
    } else {
      statusStartedAt = null
      if (statusTimer) {
        clearInterval(statusTimer)
        statusTimer = null
      }
      if (statusLoader) {
        statusLoader.stop()
        statusLoader = null
      }
      statusContainer.clear()
      statusText = new Text(theme.dim(`idle | ${buildStatusSuffix()}`), 1, 0)
      statusContainer.addChild(statusText)
    }
  }

  // --- Editor handlers ---
  editor.onSubmit = (raw: string) => {
    const value = raw.trim()
    editor.setText('')
    if (!value || !ws || !connected) return

    editor.addToHistory(value)
    chatLog.addUser(value)

    ws.send(
      JSON.stringify({
        type: 'user_message',
        content: value,
        conversation: session,
      }),
    )
    tui.requestRender()
  }

  editor.onCtrlC = () => {
    if (editor.getText().trim().length > 0) {
      editor.setText('')
      tui.requestRender()
      return
    }
    const now = Date.now()
    if (now - lastCtrlCAt < 1500) {
      cleanup()
      process.exit(0)
    }
    lastCtrlCAt = now
    chatLog.addSystem('Press Ctrl+C again to exit')
    tui.requestRender()
  }

  editor.onCtrlD = () => {
    cleanup()
    process.exit(0)
  }

  // Backup: catch SIGINT directly in case pi-tui doesn't pass it
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })

  // --- WebSocket ---
  const cleanup = () => {
    if (statusTimer) clearInterval(statusTimer)
    ws?.close()
    tui.stop()
  }

  const connect = () => {
    ws = new WebSocket(`ws://localhost:${port}/ws/tui`)

    ws.on('open', () => {
      connected = true
      chatLog.addSystem('Connected to Koshi')
      renderStatus()
      tui.requestRender()
    })

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'status') {
          serverName = msg.name ?? 'koshi'
          renderStatus()
        } else if (msg.type === 'assistant_chunk') {
          streamingContent += msg.text
          chatLog.updateAssistant(streamingContent)
        } else if (msg.type === 'assistant_done') {
          streamingContent = ''
          chatLog.finalizeAssistant(msg.content)
          activity = { ...activity, state: 'idle' }
          renderStatus()
        } else if (msg.type === 'activity') {
          activity = {
            state: msg.state ?? 'idle',
            tool: msg.tool,
            elapsed: msg.elapsed,
            model: msg.model,
            session: msg.session,
            tokensIn: msg.tokensIn,
            tokensOut: msg.tokensOut,
            costUsd: msg.costUsd,
            contextTokens: msg.contextTokens,
            contextLimit: msg.contextLimit,
            contextPercent: msg.contextPercent,
            agents: msg.agents,
          }
          renderStatus()
        }
        tui.requestRender()
      } catch {
        // ignore parse errors
      }
    })

    ws.on('close', () => {
      connected = false
      chatLog.addSystem('Disconnected from Koshi')
      renderStatus()
      tui.requestRender()
      // Reconnect after delay
      setTimeout(connect, 3000)
    })

    ws.on('error', () => {
      // close event will handle reconnection
    })
  }

  // --- Start ---
  renderStatus()
  tui.start()
  connect()
}
