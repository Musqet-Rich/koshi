import type { KoshiConfig, MemoryResult, Tool } from '../types.js'

export function createPromptBuilder(config: KoshiConfig) {
  return {
    build(opts: { memories?: MemoryResult[]; tools?: Tool[]; activeContext?: string } = {}): string {
      const sections: string[] = [config.identity.soul]

      // Tools are passed via the API's native tool mechanism — don't list them in the prompt.
      // Just reinforce that the model should use them.
      if (opts.tools && opts.tools.length > 0) {
        sections.push(
          "## Tool Use\nYou have tools available via function calling. ALWAYS use them when asked to perform actions. Never describe what you would do — call the tool. For example, if asked to create a file, call spawn_agent with a clear task. If asked about past work, call memory_query. Act, don't narrate.\n\n## Memory\nUse memory_store to record facts, preferences, decisions, and context that will be relevant in future conversations. Store the who, where, why, how & when. Reinforce or demote memories based on their usefulness when they are recalled.",
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
