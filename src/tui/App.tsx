import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import WebSocket from 'ws'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  port: number
  session: string
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

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
  const wsRef = useRef<WebSocket | null>(null)

  const rows = stdout?.rows ?? 24
  const cols = stdout?.columns ?? 80

  // Reserve: 1 status + 1 separator + 1 separator + 1 input = 4 lines
  const chatHeight = Math.max(rows - 4, 3)

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
        }
      } catch {}
    })

    ws.on('close', () => setStatus('disconnected'))
    ws.on('error', () => setStatus('disconnected'))

    return () => {
      ws.close()
    }
  }, [port, streaming])

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') exit()
    if (key.ctrl && ch === 'd') exit()
  })

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

  return (
    <Box flexDirection="column" height={rows}>
      {/* Status bar */}
      <Box>
        <Text color={statusColor}>● {status}</Text>
        <Text> </Text>
        <Text dimColor>{serverName || 'koshi'}</Text>
        <Text> </Text>
        <Text dimColor>session:{session}</Text>
        {streaming && <Text color="cyan"> ▍</Text>}
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
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}
