import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import type { KoshiConfig } from '../types.js'
import { getSecret, loadSecrets } from './secrets.js'

/**
 * Interpolate ${VAR_NAME} and ${secrets.x.y} patterns.
 * Secrets are resolved from ~/.config/koshi/secrets.yaml.
 * Remaining ${...} patterns are resolved from process.env.
 */
function interpolateVars(raw: string): string {
  // Load secrets once for this interpolation pass
  loadSecrets()
  return raw.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    // Check if it's a secrets reference
    if (varName.startsWith('secrets.')) {
      const dotPath = varName.slice('secrets.'.length)
      const secret = getSecret(dotPath)
      if (secret === undefined) {
        throw new Error(`Secret "${dotPath}" is referenced in config but not found in secrets.yaml`)
      }
      return String(secret)
    }
    const value = process.env[varName]
    if (value === undefined) {
      throw new Error(`Environment variable "${varName}" is referenced in config but not set`)
    }
    return value
  })
}

/**
 * Load and validate koshi.yaml, returning a typed KoshiConfig.
 * @param path - Path to koshi.yaml. Defaults to ./koshi.yaml in CWD.
 */
export function loadConfig(path?: string): KoshiConfig {
  const configPath = resolve(path ?? 'koshi.yaml')

  let raw: string
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err: unknown) {
    throw new Error(`Failed to read config file at ${configPath}: ${err instanceof Error ? err.message : err}`)
  }

  // Variable interpolation (env vars + secrets) before YAML parsing
  const interpolated = interpolateVars(raw)
  const doc = parse(interpolated)

  if (!doc || typeof doc !== 'object') {
    throw new Error('Config file is empty or not a valid YAML object')
  }

  // Validate models
  if (!doc.models || typeof doc.models !== 'object' || Object.keys(doc.models).length === 0) {
    throw new Error('Config must define at least one model under "models"')
  }

  // Validate agent.model references a defined model
  const agentModel = doc.agent?.model
  if (!agentModel) {
    throw new Error('Config must define "agent.model"')
  }
  if (!(agentModel in doc.models)) {
    throw new Error(
      `agent.model "${agentModel}" does not match any defined model. Available: ${Object.keys(doc.models).join(', ')}`,
    )
  }

  // Apply defaults
  const config: KoshiConfig = {
    name: doc.name ?? 'koshi',
    identity: doc.identity ?? { soul: '' },
    models: doc.models,
    agent: doc.agent,
    plugins: doc.plugins ?? [],
    routes: doc.routes ?? [],
    templates: doc.templates ?? {},
    buffer: {
      retentionDays: doc.buffer?.retentionDays ?? 7,
      batchWindowMs: doc.buffer?.batchWindowMs ?? 500,
    },
    memory: {
      backend: doc.memory?.backend ?? 'sqlite',
      ...doc.memory,
    },
    sessions: {
      maxMessages: doc.sessions?.maxMessages ?? 200,
      ...doc.sessions,
    },
    cron: doc.cron ?? [],
    agents: doc.agents,
    dataPath: doc.dataPath ?? doc.data ?? './data',
    logLevel: doc.logLevel ?? 'info',
  }

  return config
}
