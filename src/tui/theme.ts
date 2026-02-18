import type { EditorTheme, SelectListTheme } from '@mariozechner/pi-tui'
import chalk from 'chalk'

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text)

export const theme = {
  accent: fg('#F6C453'),
  dim: fg('#7B7F87'),
  user: fg('#5B9BD5'),
  assistant: (text: string) => text,
  system: fg('#E8C553'),
  error: fg('#F97066'),
  border: fg('#3C414B'),
  bold: (text: string) => chalk.bold(text),
}

const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => fg('#F6C453')(text),
  selectedText: (text) => chalk.bold(fg('#F6C453')(text)),
  description: (text) => fg('#7B7F87')(text),
  scrollInfo: (text) => fg('#7B7F87')(text),
  noMatch: (text) => fg('#7B7F87')(text),
}

export const editorTheme: EditorTheme = {
  borderColor: (text) => fg('#3C414B')(text),
  selectList: selectListTheme,
}
