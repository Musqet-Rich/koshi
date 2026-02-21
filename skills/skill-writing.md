---
name: skill-writing
description: How to create and update skills that teach you new capabilities
triggers: [skill, learn, teach, pattern, recipe, workflow, "how to handle", "new skill"]
tools: [create_skill, update_skill, list_skills]
---

## Creating Skills

You can create skills to teach yourself how to handle recurring patterns. Skills are reusable recipes that get loaded when relevant.

### When to create a skill
- You encounter a task pattern that will recur
- The user teaches you a specific workflow
- You discover a better way to handle something

### How to create a skill
Use the `create_skill` tool with:
- **name**: short, kebab-case identifier (e.g. "code-review", "deploy-check")
- **description**: one sentence explaining what the skill covers (this is shown in the skill index)
- **triggers**: array of keywords/phrases that should activate this skill
- **content**: the full recipe in markdown — step-by-step instructions, constraints, examples

### Writing good skill content
- Be specific and actionable — steps, not concepts
- Include constraints (what NOT to do)
- Include common patterns and examples
- Keep it focused — one skill per task type
- Write as instructions to yourself: "1. Do X, 2. Check Y, 3. Never Z"

### Updating skills
Use `update_skill` to refine a skill you created. You cannot modify file-based skills (those are human-managed).

### Skill lifecycle
1. Encounter pattern → create skill
2. Use skill → discover gaps → update skill
3. Over time, skills compound — you get better at recurring tasks
