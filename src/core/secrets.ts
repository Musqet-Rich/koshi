import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'

function getSecretsPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(configHome, 'koshi', 'secrets.yaml')
}

function readSecretsFile(): Record<string, unknown> {
  const p = getSecretsPath()
  if (!existsSync(p)) return {}
  try {
    const doc = parse(readFileSync(p, 'utf-8'))
    return doc && typeof doc === 'object' ? doc : {}
  } catch {
    return {}
  }
}

function writeSecretsFile(data: Record<string, unknown>): void {
  const p = getSecretsPath()
  const dir = dirname(p)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(p, stringify(data), { mode: 0o600 })
}

function getByDotPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setByDotPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

function unsetByDotPath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.')
  let current: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) return
    current = current[part] as Record<string, unknown>
  }
  delete current[parts[parts.length - 1]]
}

export function redactValue(value: string): string {
  if (value.length > 10) return `${value.slice(0, 6)}****`
  return '****'
}

export function loadSecrets(): Record<string, unknown> {
  return readSecretsFile()
}

export function getSecret(dotPath: string): unknown {
  return getByDotPath(readSecretsFile(), dotPath)
}

export function setSecret(dotPath: string, value: string): void {
  const data = readSecretsFile()
  setByDotPath(data, dotPath, value)
  writeSecretsFile(data)
}

export function unsetSecret(dotPath: string): void {
  const data = readSecretsFile()
  unsetByDotPath(data, dotPath)
  writeSecretsFile(data)
}

function collectKeys(obj: Record<string, unknown>, prefix: string): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = []
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object') {
      results.push(...collectKeys(v as Record<string, unknown>, fullKey))
    } else {
      results.push({ key: fullKey, value: redactValue(String(v)) })
    }
  }
  return results
}

export function listSecrets(): Array<{ key: string; value: string }> {
  return collectKeys(readSecretsFile(), '')
}
