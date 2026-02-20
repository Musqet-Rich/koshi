import { resolve } from 'node:path'
import type { KoshiConfig, KoshiContext, KoshiPlugin } from '../types.js'

/**
 * Validate that an imported module looks like a KoshiPlugin.
 */
function validatePlugin(mod: unknown, ref: string): KoshiPlugin {
  const plugin = mod as Record<string, unknown>
  if (typeof plugin.name !== 'string' || !plugin.name) {
    throw new Error(`Plugin "${ref}" is missing a valid "name" string`)
  }
  if (typeof plugin.version !== 'string' || !plugin.version) {
    throw new Error(`Plugin "${ref}" is missing a valid "version" string`)
  }
  if (typeof plugin.init !== 'function') {
    throw new Error(`Plugin "${ref}" is missing an "init" function`)
  }
  return plugin as unknown as KoshiPlugin
}

// Built-in plugins bundled with Koshi
const BUILTIN_PLUGINS: Record<string, string> = {
  '@koshi/anthropic': '../plugins/anthropic/index.js',
  '@koshi/claude-code': '../plugins/claude-code/index.js',
  '@koshi/autotest': '../plugins/autotest/index.js',
  '@koshi/tui': '../tui/plugin.js',
  '@koshi/memory': '../plugins/memory/index.js',
}

/**
 * Resolve an import specifier — built-ins map to local paths,
 * local paths get resolved to absolute, npm package names are used as-is.
 */
function resolveSpecifier(name: string): string {
  if (BUILTIN_PLUGINS[name]) {
    return BUILTIN_PLUGINS[name]
  }
  if (name.startsWith('.') || name.startsWith('/')) {
    return resolve(name)
  }
  return name
}

/**
 * Load and initialise all plugins from config.
 * Plugins are loaded in order, validated, and init() is called sequentially.
 * Shutdown hooks are registered on the Fastify instance in reverse order.
 */
export async function loadPlugins(config: KoshiConfig, context: KoshiContext): Promise<KoshiPlugin[]> {
  const plugins: KoshiPlugin[] = []
  const fastify = context.fastify as {
    log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
    addHook: (hook: string, fn: () => Promise<void>) => void
  }

  for (const pluginConfig of config.plugins) {
    const ref = pluginConfig.name

    // Import the module
    let mod: unknown
    try {
      const specifier = resolveSpecifier(ref)
      const imported = await import(specifier)
      // Support both default export and named/module.exports
      mod = imported.default ?? imported
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to import plugin "${ref}": ${msg}`)
    }

    // Validate
    const plugin = validatePlugin(mod, ref)

    // Initialise
    try {
      await plugin.init(context, pluginConfig)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Plugin "${ref}" (${plugin.name}@${plugin.version}) init failed: ${msg}`)
    }

    fastify.log.info(`Loaded plugin: ${plugin.name}@${plugin.version}`)
    plugins.push(plugin)
  }

  // Register shutdown hook — call shutdown() in reverse order
  fastify.addHook('onClose', async () => {
    for (let i = plugins.length - 1; i >= 0; i--) {
      const plugin = plugins[i]
      const shutdown = (plugin as unknown as Record<string, unknown>).shutdown
      if (typeof shutdown === 'function') {
        try {
          await (shutdown as () => Promise<void>).call(plugin)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fastify.log.error(`Plugin "${plugin.name}" shutdown error: ${msg}`)
        }
      }
    }
  })

  return plugins
}
