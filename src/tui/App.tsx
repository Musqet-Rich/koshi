import { Box, Text, useApp, useStdout } from 'ink'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WebSocket from 'ws'
import { MultiLineInput } from './MultiLineInput.js'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Activity {
  state: 'idle' | 'thinking' | 'tool_call' | 'streaming'
  tool?: string
  elapsed?: number
  model?: string
  session?: string
  tokensIn?: number
  tokensOut?: number
  agents?: number
}

interface Props {
  port: number
  session: string
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Count how many terminal rows a message will occupy */
function messageRows(msg: Message, cols: number): number {
  const prefix = msg.role === 'user' ? '> ' : '  '
  const prefixLen = prefix.length
  const available = Math.max(cols - prefixLen, 20)
  const lines = msg.content.split('\n')
  let total = 0
  for (const line of lines) {
    total += Math.max(1, Math.ceil((line.length || 1) / available))
  }
  return total
}

export function App({ port, session }: Props) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [serverName, setServerName] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [activity, setActivity] = useState<Activity>({ state: 'idle' })
  const [spinnerIdx, setSpinnerIdx] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  const rows = stdout?.rows ?? 24
  const cols = stdout?.columns ?? 80

  // Spinner animation
  useEffect(() => {
    if (activity.state === 'idle') return
    const t = setInterval(() => setSpinnerIdx((i) => (i + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(t)
  }, [activity.state])

  // Reserve: 1 status + 1 separator + 1 separator + input lines
  const inputLineCount = Math.max(1, input.split('\n').length)
  const chatHeight = Math.max(rows - 3 - inputLineCount, 3)

  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/tui`)
    wsRef.current = ws

    ws.on('open', () => setStatus('connected'))

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (msg.type === 'status') {
          setServerName(msg.name ?? 'koshi')
        } else if (msg.type === 'assistant_chunk') {
          setStreaming(true)
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant' && streaming) {
              return [...prev.slice(0, -1), { role: 'assistant', content: last.content + msg.text }]
            }
            return [...prev, { role: 'assistant', content: msg.text }]
          })
        } else if (msg.type === 'assistant_done') {
          setStreaming(false)
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { role: 'assistant', content: msg.content }]
            }
            return [...prev, { role: 'assistant', content: msg.content }]
          })
        } else if (msg.type === 'activity') {
          setActivity({
            state: msg.state,
            tool: msg.tool,
            elapsed: msg.elapsed,
            model: msg.model,
            session: msg.session,
            tokensIn: msg.tokensIn,
            tokensOut: msg.tokensOut,
            agents: msg.agents,
          })
        }
      } catch {}
    })

    ws.on('close', () => setStatus('disconnected'))
    ws.on('error', () => setStatus('disconnected'))

    return () => {
      ws.close()
    }
  }, [port, streaming])

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim()
      if (!trimmed || !wsRef.current || status !== 'connected') return

      setMessages((prev) => [...prev, { role: 'user', content: trimmed }])
      setInput('')

      wsRef.current.send(
        JSON.stringify({
          type: 'user_message',
          content: trimmed,
          conversation: session,
        }),
      )
    },
    [status, session],
  )

  // Calculate which messages fit in the chat area (bottom-up)
  const visible = useMemo(() => {
    let usedRows = 0
    const result: Message[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const needed = messageRows(messages[i], cols) + 1 // +1 for gap between messages
      if (usedRows + needed > chatHeight && result.length > 0) break
      result.unshift(messages[i])
      usedRows += needed
    }
    return result
  }, [messages, chatHeight, cols])

  const statusColor = status === 'connected' ? 'green' : status === 'connecting' ? 'yellow' : 'red'
  const separator = '─'.repeat(Math.min(cols, 120))

  // Build activity status line
  const activityLabel = (() => {
    const s = activity.state
    if (s === 'idle') return 'idle'
    if (s === 'thinking') return 'thinking'
    if (s === 'tool_call') return activity.tool ? `tool: ${activity.tool}` : 'tool call'
    if (s === 'streaming') return 'streaming'
    return s
  })()

  const spinner = activity.state !== 'idle' ? SPINNER_FRAMES[spinnerIdx] : '●'
  const spinnerColor = activity.state !== 'idle' ? 'cyan' : statusColor
  const elapsedStr = activity.elapsed != null && activity.state !== 'idle' ? ` • ${activity.elapsed}s` : ''
  const agentsStr = activity.agents ? ` • ${activity.agents} agent${activity.agents > 1 ? 's' : ''}` : ''

  return (
    <Box flexDirection="column" height={rows}>
      {/* Status bar */}
      <Box>
        <Text color={spinnerColor}>
          {spinner} {activityLabel}
          {elapsedStr}
        </Text>
        <Text> | </Text>
        <Text color={statusColor}>{status}</Text>
        <Text> </Text>
        <Text dimColor>{serverName || 'koshi'}</Text>
        <Text> | </Text>
        <Text dimColor>session:{session}</Text>
        {activity.model && <Text> | </Text>}
        {activity.model && <Text dimColor>{activity.model}</Text>}
        {agentsStr && <Text dimColor>{agentsStr}</Text>}
      </Box>
      <Box>
        <Text dimColor>{separator}</Text>
      </Box>

      {/* Messages — fixed height, bottom-aligned */}
      <Box flexDirection="column" height={chatHeight} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-end">
          {visible.map((msg, i) => (
            <Box key={`${msg.role}-${i}-${msg.content.length}`} paddingBottom={i < visible.length - 1 ? 0 : 0}>
              <Text wrap="wrap" color={msg.role === 'user' ? 'blue' : 'white'}>
                {msg.role === 'user' ? '> ' : '  '}
                {msg.content}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Input area */}
      <Box>
        <Text dimColor>{separator}</Text>
      </Box>
      <Box>
        <Text color="blue">&gt; </Text>
        <MultiLineInput value={input} onChange={setInput} onSubmit={handleSubmit} onExit={exit} />
      </Box>
    </Box>
  )
}
