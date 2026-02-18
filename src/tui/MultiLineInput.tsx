import { Text, useStdin } from 'ink'
import { useEffect, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  onExit?: () => void
  onScrollUp?: () => void
  onScrollDown?: () => void
  focus?: boolean
}

export function MultiLineInput({ value, onChange, onSubmit, onExit, onScrollUp, onScrollDown, focus = true }: Props) {
  const { stdin, setRawMode } = useStdin()
  const [cursorVisible, setCursorVisible] = useState(true)

  // Use refs to avoid re-registering the stdin listener on every keystroke
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onSubmitRef = useRef(onSubmit)
  onSubmitRef.current = onSubmit
  const onExitRef = useRef(onExit)
  onExitRef.current = onExit
  const onScrollUpRef = useRef(onScrollUp)
  onScrollUpRef.current = onScrollUp
  const onScrollDownRef = useRef(onScrollDown)
  onScrollDownRef.current = onScrollDown

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

    const processPlain = (data: string, startVal: string): string => {
      let val = startVal
      let i = 0
      while (i < data.length) {
        const code = data.charCodeAt(i)

        if (code === 0x1b) {
          // Skip CSI sequences: ESC [ ... final_byte
          if (i + 1 < data.length && data[i + 1] === '[') {
            let j = i + 2
            // Skip parameter and intermediate bytes (0x20-0x3f)
            while (j < data.length && data.charCodeAt(j) >= 0x20 && data.charCodeAt(j) <= 0x3f) j++
            if (j < data.length) j++ // skip final byte
            i = j
          } else {
            // Alt+key or other ESC sequences — skip 2 bytes
            i += 2
          }
          continue
        }

        if (code === 0x0d || code === 0x0a) {
          // Plain Enter = submit
          if (val.trim()) {
            onSubmitRef.current(val)
            return ''
          }
          i++
          continue
        }

        if (code === 0x7f || code === 0x08) {
          val = val.slice(0, -1)
        } else if (code === 0x03 || code === 0x04) {
          onExitRef.current?.()
          return val
        } else if (code === 0x15) {
          // Ctrl+U — clear input
          val = ''
        } else if (code >= 0x20) {
          val += data[i]
        }

        i++
      }
      return val
    }

    const flush = () => {
      if (!buf) return
      const data = buf
      buf = ''

      const SHIFT_ENTER = '\x1b[27;2;13~'
      const PAGE_UP = '\x1b[5~'
      const PAGE_DOWN = '\x1b[6~'
      let val = valueRef.current

      // Handle scroll keys
      if (data.includes(PAGE_UP)) {
        onScrollUpRef.current?.()
        const cleaned = data.replaceAll(PAGE_UP, '')
        if (!cleaned) return
        buf = cleaned
        flush()
        return
      }
      if (data.includes(PAGE_DOWN)) {
        onScrollDownRef.current?.()
        const cleaned = data.replaceAll(PAGE_DOWN, '')
        if (!cleaned) return
        buf = cleaned
        flush()
        return
      }

      if (data.includes(SHIFT_ENTER)) {
        const parts = data.split(SHIFT_ENTER)
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) {
            val = processPlain(parts[i], val)
          }
          if (i < parts.length - 1) {
            val += '\n'
          }
        }
        onChangeRef.current(val)
        return
      }

      const newVal = processPlain(data, val)
      // If processPlain triggered submit, value was cleared to ''
      if (newVal !== val || newVal === '') {
        onChangeRef.current(newVal)
      }
    }

    const onData = (data: Buffer) => {
      buf += data.toString('utf-8')
      if (bufTimer) clearTimeout(bufTimer)
      bufTimer = setTimeout(flush, 5)
    }

    stdin.on('data', onData)
    return () => {
      stdin.off('data', onData)
      if (bufTimer) clearTimeout(bufTimer)
      setRawMode(false)
    }
  }, [focus, stdin, setRawMode])

  const cursor = cursorVisible ? '█' : ' '

  return (
    <Text wrap="wrap">
      {value}
      {cursor}
    </Text>
  )
}
