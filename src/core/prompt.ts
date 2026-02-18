import type { KoshiConfig, MemoryResult, Tool } from '../types.js'
import { getSkillIndex } from './skills.js'

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
          "## Your Architecture\nYou are a coordinator. You have limited direct capabilities — no web access, no file system writes, no shell. But you have SUB-AGENTS that can do all of this. This is your superpower, not a limitation.\n\nSub-agents have: shell access, curl/wget, file I/O, full internet access. They are your hands. You are the brain. When the user asks you to do something you cannot do directly, ALWAYS spawn a sub-agent. Never say 'I can\\'t do that' — say nothing and spawn the agent.\n\n## Tool Use\nALWAYS use the right tool directly. Do NOT generate text before a tool call — call the tool first, then respond based on the result.\n- Reminders/scheduling → schedule_job, cancel_job, list_jobs\n- Memory → memory_store, memory_query\n- Skills → load_skill, create_skill, update_skill\n- Fetch URLs, read web pages, run commands, write files → spawn_agent\n- Check agent results → list_agents, read_file\n\nNever describe what you would do. Never list options for the user. Never say 'I can\\'t'. Act.\n\n## Memory\nAlways store relevant information — facts, preferences, decisions, context, summaries, anything that might be useful later. Never ask whether to store it. Memory scoring handles relevance over time; you just capture everything. Store the who, where, why, how & when. Reinforce or demote memories based on their usefulness when they are recalled.\n\nWhen answering from recalled memories, acknowledge it naturally — e.g. 'From what I remember...' or 'You mentioned before that...' or 'Last time you told me...'. This builds trust and lets the user know their information was retained. Never pretend you always knew something — be honest about where the knowledge came from.\n\n## Self-Improvement\nIf you find yourself doing the same type of task more than twice, use create_skill to teach yourself how to handle it next time. Skills compound — the more you create, the better you get.\n\nDon\\'t propose creating a skill — just create it. Don\\'t ask if you should store a memory — just store it. Don\\'t describe what you learned — act on it immediately. If you realise you made a mistake, fix the behaviour right now: store the lesson AND create a skill to prevent it happening again. Self-improvement is not a suggestion — it\\'s your job.",
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

      // Always include skill index (live, includes runtime-created skills)
      const currentSkills = getSkillIndex()
      if (currentSkills.length > 0) {
        sections.push(
          `## Available Skills\n${currentSkills.map((s) => `- **${s.name}**: ${s.description}`).join('\n')}\n\nUse the \`load_skill\` tool to load full instructions for any skill when needed.`,
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
