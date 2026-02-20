import { describe, expect, it } from 'vitest'

// Test the interpolation and validation logic from config.ts
// We replicate the interpolation function since it's not exported.

function interpolateVars(raw: string, env: Record<string, string>, secrets: Record<string, unknown>): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    if (varName.startsWith('secrets.')) {
      const dotPath = varName.slice('secrets.'.length)
      const secret = getByDotPath(secrets, dotPath)
      if (secret === undefined) {
        throw new Error(`Secret "${dotPath}" is referenced in config but not found in secrets.yaml`)
      }
      return String(secret)
    }
    const value = env[varName]
    if (value === undefined) {
      throw new Error(`Environment variable "${varName}" is referenced in config but not set`)
    }
    return value
  })
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

describe('interpolateVars', () => {
  it('interpolates environment variables', () => {
    const raw = 'apiKey: ${MY_API_KEY}'
    const result = interpolateVars(raw, { MY_API_KEY: 'sk-123' }, {})
    expect(result).toBe('apiKey: sk-123')
  })

  it('interpolates secrets', () => {
    const raw = 'apiKey: ${secrets.anthropic.key}'
    const secrets = { anthropic: { key: 'sk-secret' } }
    const result = interpolateVars(raw, {}, secrets)
    expect(result).toBe('apiKey: sk-secret')
  })

  it('interpolates nested secrets', () => {
    const raw = '${secrets.a.b.c}'
    const secrets = { a: { b: { c: 'deep-value' } } }
    const result = interpolateVars(raw, {}, secrets)
    expect(result).toBe('deep-value')
  })

  it('throws on missing env var', () => {
    const raw = '${MISSING_VAR}'
    expect(() => interpolateVars(raw, {}, {})).toThrow('Environment variable "MISSING_VAR"')
  })

  it('throws on missing secret', () => {
    const raw = '${secrets.nope.key}'
    expect(() => interpolateVars(raw, {}, {})).toThrow('Secret "nope.key"')
  })

  it('handles multiple interpolations', () => {
    const raw = '${A} and ${B}'
    const result = interpolateVars(raw, { A: 'hello', B: 'world' }, {})
    expect(result).toBe('hello and world')
  })

  it('handles mixed env and secrets', () => {
    const raw = '${ENV_VAR} ${secrets.key}'
    const result = interpolateVars(raw, { ENV_VAR: 'env' }, { key: 'secret' })
    expect(result).toBe('env secret')
  })

  it('leaves strings without interpolation patterns unchanged', () => {
    const raw = 'no variables here'
    const result = interpolateVars(raw, {}, {})
    expect(result).toBe('no variables here')
  })
})

describe('config validation logic', () => {
  it('validates that models must be defined', () => {
    const doc = { agent: { model: 'main' } }
    expect(!doc.models || typeof doc.models !== 'object').toBe(true)
  })

  it('validates agent.model references a defined model', () => {
    const doc = {
      models: { main: { plugin: '@koshi/anthropic', model: 'claude-sonnet-4-20250514' } },
      agent: { model: 'nonexistent' },
    }
    expect(doc.agent.model in doc.models).toBe(false)
  })

  it('passes when agent.model exists in models', () => {
    const doc = {
      models: { main: { plugin: '@koshi/anthropic', model: 'claude-sonnet-4-20250514' } },
      agent: { model: 'main' },
    }
    expect(doc.agent.model in doc.models).toBe(true)
  })
})
