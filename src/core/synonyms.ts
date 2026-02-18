// Built-in synonym map for common tech terms
// Used by memory.ts to expand search queries before FTS5 lookup

// Internal storage: each word maps to its full synonym group (including itself)
const synonymMap = new Map<string, Set<string>>()

function registerGroup(words: string[]): void {
  const group = new Set(words)
  for (const word of words) {
    synonymMap.set(word, group)
  }
}

// Built-in synonym groups
const BUILTIN_GROUPS: string[][] = [
  ['api', 'interface', 'endpoint'],
  ['auth', 'authentication', 'authorization', 'authn', 'authz'],
  ['db', 'database', 'sqlite', 'postgres'],
  ['deploy', 'deployment', 'release', 'ship'],
  ['test', 'testing', 'spec', 'e2e'],
  ['bug', 'error', 'issue', 'defect'],
  ['config', 'configuration', 'settings', 'yaml'],
  ['build', 'compile', 'bundle', 'transpile'],
  ['git', 'commit', 'branch', 'merge', 'pr', 'pull request'],
  ['webhook', 'hook', 'callback'],
  ['cron', 'schedule', 'scheduled', 'timer'],
  ['plugin', 'extension', 'addon', 'module'],
  ['memory', 'remember', 'recall', 'context'],
  ['route', 'routing', 'dispatch', 'match'],
  ['buffer', 'queue', 'pending'],
]

for (const group of BUILTIN_GROUPS) {
  registerGroup(group)
}

/**
 * Expand a query string: each word gets its synonyms OR'd together.
 * e.g. "api auth" → "(api OR interface OR endpoint) (auth OR authentication OR authorization OR authn OR authz)"
 */
export function expandSynonyms(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean)
  return words
    .map((word) => {
      const group = synonymMap.get(word.toLowerCase())
      if (!group || group.size <= 1) return word
      const members = Array.from(group)
      return `(${members.join(' OR ')})`
    })
    .join(' ')
}

/**
 * Add a synonym group at runtime. Merges with any existing group the word belongs to.
 */
export function addSynonyms(word: string, synonyms: string[]): void {
  const allWords = [word, ...synonyms].map((w) => w.toLowerCase())
  // Collect any existing groups these words belong to
  const merged = new Set<string>()
  for (const w of allWords) {
    merged.add(w)
    const existing = synonymMap.get(w)
    if (existing) {
      for (const e of existing) merged.add(e)
    }
  }
  // Point all words to the merged group
  for (const w of merged) {
    synonymMap.set(w, merged)
  }
}

/**
 * Get current synonym map for debugging/export.
 */
export function getSynonymMap(): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [word, group] of synonymMap) {
    result[word] = Array.from(group)
  }
  return result
}
