#!/usr/bin/env node
// Koshi CLI

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

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
  start       Start the Koshi daemon

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
} else {
  console.error(`Unknown command: ${command}`)
  printHelp()
  process.exit(1)
}
