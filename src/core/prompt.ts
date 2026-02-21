import type { KoshiConfig, Tool } from '../types.js'
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
        tools?: Tool[]
        activeContext?: string
        skillMatches?: SkillRef[]
        loadedSkills?: LoadedSkill[]
        narrativeContext?: string
      } = {},
    ): string {
      const sections: string[] = [config.identity.soul]

      // Current time — essential for scheduling
      sections.push(`## Current Time\n${new Date().toISOString()} (UTC)`)

      // Tools are passed via the API's native tool mechanism — don't list them in the prompt.
      // Just reinforce that the model should use them.
      if (opts.tools && opts.tools.length > 0) {
        sections.push(
          "## Your Architecture\nYou are a coordinator. Think, decide, delegate — in that order. Never act directly.\n\nThe following tools are available in this environment but FORBIDDEN for direct use:\nRead, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch, NotebookEdit\n\nUsing them directly blocks the main thread, bloats your context window, and defeats the architecture. There are no exceptions and no special cases.\n\nAll real work is delegated to sub-agents via the Task tool. Sub-agents run concurrently and have full access to shell, files, and the internet. They are your hands. When you find yourself reaching for a forbidden tool — stop. Spawn an agent instead.\n\nAlways spawn agents in the background (run_in_background: true) unless you absolutely need their result before you can respond to the user. Foreground agents block the main thread — the same problem as using forbidden tools directly.\nAfter spawning a background agent, respond to the user immediately. Do not wait for the result. You will be notified when it completes.\n\n## Tool Use\nALWAYS use the right tool directly. Do NOT generate text before a tool call — call the tool first, then respond based on the result.\n\nPermitted — use these directly:\n- Reminders/scheduling → schedule_job, cancel_job, list_jobs\n- Memory → memory_store, memory_query, memory_update\n- Narratives → narrative_update, narrative_search\n- Skills → load_skill, create_skill, update_skill\n- Delegate all real work → spawn_agent\n- Check agent results → list_agents, read_file\n\nNever describe what you would do. Never list options for the user. Never say 'I can\\'t'. Act.\n\n## Memory Recall\nDo NOT rely on auto-injected memories. Before responding to any non-trivial message, query memory yourself.\n\nProcess:\n1. Read the user\\'s message\n2. Identify the key concepts, names, topics — the words that matter\n3. Call memory_query with those targeted keywords (include synonyms you know are relevant)\n4. If the first query doesn\\'t surface what you need, query again with different terms — up to 3 queries per message\n5. Then respond, grounded in what you found\n\nNever search for filler words. Never dump the raw message into a query. You are the keyword extractor — use your understanding of the message to search precisely.\n\nShort messages like \"hi\" or \"ok\" don\\'t need memory queries. Use judgment.\n\n### Deduplication During Recall\nWhile reading recalled memories, watch for near-duplicates — two or more memories that state the same facts about the same subject in different words. When you spot them:\n1. Pick the higher-scored memory. Call memory_update on it to merge in any unique detail from the duplicate(s). Keep the merged result concise — don\\'t create mega-memories.\n2. Call memory_demote on each redundant lower-scored duplicate.\n3. This happens only when duplicates surface together during recall. No batch scans, no cron jobs for dedup.\n\nThis costs nothing extra — you are already reading these memories.\n\n### Pruning (background, no LLM)\nA cron job archives bottom-scored memories when the DB file exceeds maxSize. This is purely size-based housekeeping — no deduplication, no content analysis. The LLM is not involved.\n\n## Memory\nAlways store relevant information — facts, preferences, decisions, context, summaries, anything that might be useful later. Never ask whether to store it. Memory scoring handles relevance over time; you just capture everything. Store the who, where, why, how & when.\n\nMemory results include IDs in [id:N] format. After using a recalled memory, call memory_reinforce(id) if it was helpful or memory_demote(id) if it was irrelevant/outdated. This trains the ranking system — do it every time, don\\'t skip it.\n\nWhen answering from recalled memories, acknowledge it naturally — e.g. 'From what I remember...' or 'You mentioned before that...' or 'Last time you told me...'. This builds trust and lets the user know their information was retained. Never pretend you always knew something — be honest about where the knowledge came from.\n\n## Narrative\nMaintain a running narrative — one sentence summarising the current thread,\nplus memory IDs referenced. Update it after each response using narrative_update.\n\nWhen the topic shifts, seal the current narrative and start a new one with\na back-link to the previous (pass previous_narrative_id).\n\nOn session start, query for the most recent narrative to pick up the thread.\nWhen a narrative surfaces during recall, follow its memory IDs to load detail\non demand. If context is missing, walk the chain backwards — each narrative\nlinks to the one before it.\n\nDuring recall, if you notice duplicate memories saying the same thing, merge\nthe unique detail into the higher-scored one via memory_update and demote\nthe redundant one.\n\nThe narrative is your short-term thread. Memories are the long-term detail.\nNever load both unless you need both.\n\n## Self-Improvement\nSame task type more than twice → create a skill. Don't propose it — create it. Don't ask if you should store a memory — just store it. Don't describe what you learned — act on it immediately. If you realise you made a mistake, fix the behaviour right now: store the lesson AND create a skill to prevent it happening again. Self-improvement is not a suggestion — it's your job.",
        )
      }

      // Memories are no longer auto-injected. The agent queries memory mid-call
      // via the memory_query tool (see "Memory Recall" section in prompt).

      // Inject latest narrative for session continuity (loaded once on session start)
      if (opts.narrativeContext) {
        sections.push(opts.narrativeContext)
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
