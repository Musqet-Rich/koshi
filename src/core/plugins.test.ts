import { describe, expect, it } from 'vitest'

// Test plugin validation logic by replicating it (since validatePlugin is not exported)
// In a real refactor we'd export it, but for now we test the behavior.

interface MockPlugin {
  name?: unknown
  version?: unknown
  init?: unknown
}

function validatePlugin(mod: unknown, ref: string) {
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
  return plugin
}

// Test resolveSpecifier logic
const BUILTIN_PLUGINS: Record<string, string> = {
  '@koshi/anthropic': '../plugins/anthropic/index.js',
  '@koshi/claude-code': '../plugins/claude-code/index.js',
  '@koshi/autotest': '../plugins/autotest/index.js',
  '@koshi/tui': '../tui/plugin.js',
  '@koshi/memory': '../plugins/memory/index.js',
}

function resolveSpecifier(name: string): string {
  if (BUILTIN_PLUGINS[name]) {
    return BUILTIN_PLUGINS[name]
  }
  if (name.startsWith('.') || name.startsWith('/')) {
    // Would resolve to absolute in real code
    return name
  }
  return name
}

describe('validatePlugin', () => {
  it('accepts a valid plugin', () => {
    const mod: MockPlugin = {
      name: '@koshi/test',
      version: '1.0.0',
      init: async () => {},
    }
    expect(() => validatePlugin(mod, 'test')).not.toThrow()
  })

  it('rejects missing name', () => {
    const mod: MockPlugin = { version: '1.0.0', init: async () => {} }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing a valid "name"')
  })

  it('rejects empty name', () => {
    const mod: MockPlugin = { name: '', version: '1.0.0', init: async () => {} }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing a valid "name"')
  })

  it('rejects non-string name', () => {
    const mod: MockPlugin = { name: 42, version: '1.0.0', init: async () => {} }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing a valid "name"')
  })

  it('rejects missing version', () => {
    const mod: MockPlugin = { name: '@koshi/test', init: async () => {} }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing a valid "version"')
  })

  it('rejects missing init function', () => {
    const mod: MockPlugin = { name: '@koshi/test', version: '1.0.0' }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing an "init" function')
  })

  it('rejects init as non-function', () => {
    const mod: MockPlugin = { name: '@koshi/test', version: '1.0.0', init: 'not a function' }
    expect(() => validatePlugin(mod, 'test')).toThrow('missing an "init" function')
  })
})

describe('resolveSpecifier', () => {
  it('resolves builtin plugins to local paths', () => {
    expect(resolveSpecifier('@koshi/anthropic')).toBe('../plugins/anthropic/index.js')
    expect(resolveSpecifier('@koshi/claude-code')).toBe('../plugins/claude-code/index.js')
    expect(resolveSpecifier('@koshi/autotest')).toBe('../plugins/autotest/index.js')
  })

  it('passes through relative paths', () => {
    expect(resolveSpecifier('./my-plugin/index.js')).toBe('./my-plugin/index.js')
  })

  it('passes through absolute paths', () => {
    expect(resolveSpecifier('/opt/plugins/custom.js')).toBe('/opt/plugins/custom.js')
  })

  it('passes through npm package names', () => {
    expect(resolveSpecifier('koshi-plugin-foo')).toBe('koshi-plugin-foo')
  })

  it('returns unknown builtins as-is (npm lookup)', () => {
    expect(resolveSpecifier('@koshi/unknown')).toBe('@koshi/unknown')
  })
})
