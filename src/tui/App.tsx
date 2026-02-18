import { Box, Text, useApp, useInput, useStdout } from 'ink'
import TextInput from 'ink-text-input'
import { useCallback, useEffect, useRef, useState } from 'react'
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

  // Show last N messages that fit in terminal
  const maxVisible = Math.max(rows - 5, 3)
  const visible = messages.slice(-maxVisible)

  const statusColor = status === 'connected' ? 'green' : status === 'connecting' ? 'yellow' : 'red'

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
        <Text dimColor>{'─'.repeat(Math.min(stdout?.columns ?? 80, 120))}</Text>
      </Box>

      {/* Messages */}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((msg, i) => (
          <Box key={`${msg.role}-${msg.content.slice(0, 20)}-${i}`} marginBottom={0}>
            <Text color={msg.role === 'user' ? 'blue' : 'white'}>
              {msg.role === 'user' ? '> ' : '  '}
              {msg.content}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Input */}
      <Box>
        <Text dimColor>{'─'.repeat(Math.min(stdout?.columns ?? 80, 120))}</Text>
      </Box>
      <Box>
        <Text color="blue">&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  )
}
