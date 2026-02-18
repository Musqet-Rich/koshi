import type { KoshiConfig, MemoryResult, Tool } from '../types.js'

interface SkillRef {
  name: string
  description: string
}

export function createPromptBuilder(config: KoshiConfig) {
  let _skillIndex: SkillRef[] = []

  return {
    /** Set the global skill index (called once on boot) */
    setSkillIndex(index: SkillRef[]): void {
      _skillIndex = index
    },

    build(
      opts: { memories?: MemoryResult[]; tools?: Tool[]; activeContext?: string; skillMatches?: SkillRef[] } = {},
    ): string {
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

      // Always include skill index
      if (_skillIndex.length > 0) {
        sections.push(
          `## Available Skills\n${_skillIndex.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}\n\nUse the \`load_skill\` tool to load full instructions for any skill when needed.`,
        )
      }

      // Append matched skills hint
      if (opts.skillMatches && opts.skillMatches.length > 0) {
        const list = opts.skillMatches.map((s) => `${s.name}: ${s.description}`).join(', ')
        sections.push(
          `## Skill Hint\nThe following skills may be relevant to this request: ${list}. Use the \`load_skill\` tool to load the full instructions if needed.`,
        )
      }

      return sections.join('\n\n')
    },
  }
}
