import { Text, useStdin } from 'ink'
import { useEffect, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  focus?: boolean
}

export function MultiLineInput({ value, onChange, onSubmit, focus = true }: Props) {
  const { stdin, setRawMode } = useStdin()
  const [cursorVisible, setCursorVisible] = useState(true)

  // Blink cursor
  useEffect(() => {
    const timer = setInterval(() => setCursorVisible((v) => !v), 530)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!focus) return
    setRawMode(true)

    let buf = ''
    let bufTimer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      if (!buf) return
      const data = buf
      buf = ''

      // Shift+Enter: CSI 27;2;13~
      if (data.includes('\x1b[27;2;13~')) {
        const parts = data.split('\x1b[27;2;13~')
        let newVal = value
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) newVal += '\n'
          newVal += parts[i]
        }
        onChange(newVal)
        return
      }

      // Process char by char for escape sequences
      let i = 0
      let newVal = value
      while (i < data.length) {
        const ch = data[i]
        const code = data.charCodeAt(i)

        if (code === 0x1b) {
          // Skip unknown escape sequences
          const end = data.indexOf('~', i)
          if (end !== -1) {
            i = end + 1
            continue
          }
          // Skip CSI sequences ending in letter
          let j = i + 1
          while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
          if (j < data.length) j++ // skip final byte
          i = j
          continue
        }

        if (code === 0x0d || code === 0x0a) {
          // Enter = submit
          onSubmit(newVal)
          return
        }

        if (code === 0x7f || code === 0x08) {
          // Backspace
          newVal = newVal.slice(0, -1)
        } else if (code === 0x03) {
          // Ctrl+C — let Ink handle via useInput in parent
          // Re-emit by writing to process
          return
        } else if (code === 0x15) {
          // Ctrl+U — clear line
          newVal = ''
        } else if (code >= 0x20) {
          newVal += ch
        }

        i++
      }
      onChange(newVal)
    }

    const onData = (data: Buffer) => {
      buf += data.toString('utf-8')
      if (bufTimer) clearTimeout(bufTimer)
      // Small delay to accumulate escape sequences
      bufTimer = setTimeout(flush, 5)
    }

    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      if (bufTimer) clearTimeout(bufTimer)
      setRawMode(false)
    }
  }, [focus, value, onChange, onSubmit, stdin, setRawMode])

  const cursor = cursorVisible ? '█' : ' '

  return (
    <Text wrap="wrap">
      {value}
      {cursor}
    </Text>
  )
}

/** Count the number of terminal rows the input will occupy */
export function inputRows(value: string, cols: number, prefixLen = 2): number {
  const available = Math.max(cols - prefixLen, 20)
  const lines = value.split('\n')
  let total = 0
  for (const line of lines) {
    total += Math.max(1, Math.ceil((line.length + 1 || 1) / available)) // +1 for cursor on last line
  }
  return total
}
