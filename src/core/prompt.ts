import type { KoshiConfig, MemoryResult, Tool } from '../types.js'

interface SkillRef {
  name: string
  description: string
}

interface LoadedSkill {
  name: string
  content: string
}

export function createPromptBuilder(config: KoshiConfig) {
  let _skillIndex: SkillRef[] = []

  return {
    /** Set the global skill index (called once on boot) */
    setSkillIndex(index: SkillRef[]): void {
      _skillIndex = index
    },

    build(
      opts: {
        memories?: MemoryResult[]
        tools?: Tool[]
        activeContext?: string
        skillMatches?: SkillRef[]
        loadedSkills?: LoadedSkill[]
      } = {},
    ): string {
      const sections: string[] = [config.identity.soul]

      // Current time — essential for scheduling
      sections.push(`## Current Time\n${new Date().toISOString()} (UTC)`)

      // Tools are passed via the API's native tool mechanism — don't list them in the prompt.
      // Just reinforce that the model should use them.
      if (opts.tools && opts.tools.length > 0) {
        sections.push(
          "## Tool Use\nYou have tools available via function calling. ALWAYS use the right tool directly:\n- Reminders/scheduling → schedule_job, cancel_job, list_jobs\n- Memory → memory_store, memory_query\n- Skills → load_skill, create_skill, update_skill\n- Complex multi-step work → spawn_agent (only when simpler tools won't do)\n\nNever describe what you would do — call the tool. Act, don't narrate. Do NOT generate text before a tool call — call the tool first, then respond based on the result. Bad: 'Let me check... [tool call]'. Good: [tool call] then respond with the answer.\n\n## Memory\nUse memory_store to record facts, preferences, decisions, and context that will be relevant in future conversations. Store the who, where, why, how & when. Reinforce or demote memories based on their usefulness when they are recalled.\n\nWhen answering from recalled memories, acknowledge it naturally — e.g. 'From what I remember...' or 'You mentioned before that...' or 'Last time you told me...'. This builds trust and lets the user know their information was retained. Never pretend you always knew something — be honest about where the knowledge came from.",
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

      // Auto-inject matched skill content directly into the prompt
      if (opts.loadedSkills && opts.loadedSkills.length > 0) {
        const skillSections = opts.loadedSkills.map((s) => `### ${s.name}\n${s.content}`).join('\n\n')
        sections.push(`## Active Skills\n${skillSections}`)
      } else if (opts.skillMatches && opts.skillMatches.length > 0) {
        const list = opts.skillMatches.map((s) => `${s.name}: ${s.description}`).join(', ')
        sections.push(
          `## Skill Hint\nThe following skills may be relevant to this request: ${list}. Use the \`load_skill\` tool to load the full instructions if needed.`,
        )
      }

      return sections.join('\n\n')
    },
  }
}
