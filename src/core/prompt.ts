import type { KoshiConfig, MemoryResult, Tool } from '../types.js'

export function createPromptBuilder(config: KoshiConfig) {
  return {
    build(opts: { memories?: MemoryResult[]; tools?: Tool[]; activeContext?: string } = {}): string {
      const sections: string[] = [config.identity.soul]

      if (opts.tools && opts.tools.length > 0) {
        sections.push(
          `## Tools\nYou have tools available. USE THEM — don't describe what you would do, actually do it by calling the tools. When asked to perform actions (create files, search, spawn agents, etc.), call the appropriate tool immediately.\n\n${opts.tools.map((t) => `- **${t.name}**: ${t.description}`).join('\n')}`,
        )
      }

      if (opts.memories && opts.memories.length > 0) {
        sections.push(
          `## Relevant Context\n${opts.memories.map((m) => `- [${m.source ?? 'unknown'}] ${m.content}`).join('\n')}`,
        )
      }

      if (opts.activeContext) {
        sections.push(`## Current Task\n${opts.activeContext}`)
      }

      return sections.join('\n\n')
    },
  }
}
