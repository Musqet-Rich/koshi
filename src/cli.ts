#!/usr/bin/env node
// Koshi CLI

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function printHelp(): void {
  console.log(`koshi v${getVersion()}

Usage: koshi <command>

Commands:
  start              Start the Koshi daemon
  tui                Open the terminal UI
  set <key> <value>  Set a secret (dot notation, e.g. anthropic.apiKey)
  get [key]          Show a secret (redacted) or list all secrets
  unset <key>        Remove a secret

Options:
  --version   Show version
  --help      Show this help message`)
}

const args = process.argv.slice(2)
const command = args[0]

if (args.includes('--version') || args.includes('-v')) {
  console.log(getVersion())
  process.exit(0)
}

if (args.includes('--help') || args.includes('-h') || !command) {
  printHelp()
  process.exit(0)
}

if (command === 'start') {
  const { main } = await import('./core/index.js')
  await main()
} else if (command === 'tui') {
  const portArg = args[1] ?? '3000'
  const port = parseInt(portArg, 10)
  const { startTui } = await import('./tui/index.js')
  startTui(port)
} else if (command === 'set') {
  const key = args[1]
  const value = args[2]
  if (!key || !value) {
    console.error('Usage: koshi set <key> <value>')
    process.exit(1)
  }
  const { setSecret } = await import('./core/secrets.js')
  setSecret(key, value)
  console.log(`Set ${key}`)
} else if (command === 'get') {
  const key = args[1]
  if (key) {
    const { getSecret, redactValue } = await import('./core/secrets.js')
    const val = getSecret(key)
    if (val === undefined) {
      console.error(`Secret "${key}" not found`)
      process.exit(1)
    }
    console.log(`${key}: ${redactValue(String(val))}`)
  } else {
    const { listSecrets } = await import('./core/secrets.js')
    const secrets = listSecrets()
    if (secrets.length === 0) {
      console.log('No secrets configured')
    } else {
      for (const { key: k, value: v } of secrets) {
        console.log(`${k}: ${v}`)
      }
    }
  }
} else if (command === 'unset') {
  const key = args[1]
  if (!key) {
    console.error('Usage: koshi unset <key>')
    process.exit(1)
  }
  const { unsetSecret } = await import('./core/secrets.js')
  unsetSecret(key)
  console.log(`Removed ${key}`)
} else {
  console.error(`Unknown command: ${command}`)
  printHelp()
  process.exit(1)
}
