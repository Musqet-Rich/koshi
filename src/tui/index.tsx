// Koshi TUI — terminal chat interface

import React from 'react'
import { render } from 'ink'
import { App } from './App.js'

export function startTui(port = 3100): void {
  const session = 'tui'
  render(<App port={port} session={session} />)
}
