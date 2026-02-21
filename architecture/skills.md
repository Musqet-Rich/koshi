# Skills

## What Skills Are

Skills are markdown recipes that define specialist capabilities. Each skill is a self-contained document: a YAML frontmatter header declaring metadata, followed by a markdown body containing step-by-step instructions, constraints, and examples.

Skills serve two purposes:

1. **Domain knowledge** -- the instructions an agent follows to handle a specific task type.
2. **Tool scope** -- the frontmatter declares which tools the agent is permitted to use. See [agents.md](./agents.md#skill-defined-tool-scope) for how this is structurally enforced on sub-agents.

Creating a new specialist is writing a markdown file. No code, no deployment, no restart.

## Dual Source

Skills come from two places:

| Source | Location | Managed by | Mutable via tools |
|--------|----------|------------|-------------------|
| **File-based** | `~/.config/koshi/skills/*.md` | Human | No |
| **DB-based** | `skills` table in SQLite | Agent | Yes |

On boot, both sources are loaded and merged into a single in-memory index. **File skills win on name collision** -- if a file skill and a DB skill share a name, the DB skill is ignored. This gives the human final authority: to override an agent-created skill, write a file with the same name.

### Seeding

On first boot, if the external skills directory (`~/.config/koshi/skills/`) does not exist, it is created and seeded from the repo's `skills/` directory. This provides sensible defaults out of the box.

## Frontmatter Format

```yaml
---
name: code-review
description: Review code changes for correctness, style, and potential issues
triggers:
  - review
  - code review
  - PR review
tools:
  - Read
  - Grep
  - Glob
  - Bash
model: opus
---
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Kebab-case identifier. Must be unique across both sources. |
| `description` | `string` | Yes | One sentence. This is what appears in the [skill index](./system-prompt.md#4-available-skills) -- the only thing the coordinator sees. |
| `triggers` | `string[]` | Yes | Keywords or phrases that activate this skill (see [discovery](#discovery-and-triggering)). |
| `tools` | `string[]` | No | Permitted tools for the sub-agent. Defines the entire tool scope. See [agents.md](./agents.md#skill-defined-tool-scope). |
| `model` | `string` | No | Named model reference (from `koshi.yaml` `models:` section). Defaults to `agent.model` if omitted. See [agents.md](./agents.md#model-selection). |

The body after the frontmatter is the full recipe -- step-by-step instructions, constraints, examples. This content is loaded only when the skill is activated, never pre-loaded into every turn.

## DB Schema

```sql
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings
  content TEXT NOT NULL,                 -- markdown body (no frontmatter)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

DB skills store the body content directly. File skills store frontmatter + body in the `.md` file; the frontmatter is parsed at load time.

## Discovery and Triggering

When a user message arrives, the skills system scans all trigger phrases against the message text using **word-boundary, case-insensitive regex matching**:

```ts
// For each skill, for each trigger phrase:
const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const re = new RegExp(`\\b${escaped}\\b`, 'i')
re.test(userMessage)
```

This means:
- `"remind"` matches "remind me tomorrow" but not "reminded" (word boundary).
- `"code review"` matches "can you do a code review" (multi-word triggers work).
- Matching is case-insensitive.
- Special regex characters in triggers are escaped, so triggers are always literal.

## How Skills Appear in Context

Skills surface in the [system prompt](./system-prompt.md) at two levels:

### 1. Skill Index (always present)

Every turn, the full skill index -- name and description for every loaded skill -- is included in the system prompt:

```
## Available Skills
- **reminders**: Set reminders and scheduled notifications for the user
- **math-calculations**: Run mathematical calculations using a shell environment
- **summarize-article-url**: Fetch and summarize a web article from a given URL

Use the `load_skill` tool to load full instructions for any skill when needed.
```

This costs minimal tokens. The coordinator sees what is available without loading full recipes.

### 2. Active Skills (on trigger match)

When the trigger scan finds matches, the **full skill content** is auto-injected into the system prompt for that turn under an `## Active Skills` section. The agent gets the complete recipe without needing to call `load_skill`.

If triggers match but the content cannot be loaded (edge case), a `## Skill Hint` fallback is shown instead, listing matched skill names with a prompt to call `load_skill`.

### 3. Manual Loading

The agent can call `load_skill` at any time to pull full content for a skill by name, regardless of whether triggers matched. This is useful when the agent recognises a relevant skill that the trigger scan missed.

## Skills as Agent Specialisation

> **Status: Decided, Not Yet Built.** The specialist agent model is designed but not yet implemented. See [agents.md](./agents.md) for the full design.

In the [specialist agent model](./agents.md), a skill defines the complete identity of a sub-agent:

- **Tool scope** -- the `tools` array in frontmatter is the sub-agent's entire tool set. Tools not listed are not registered in the agent's session. This is structural enforcement, not a prompt instruction. See [agents.md](./agents.md#skill-defined-tool-scope).
- **Domain knowledge** -- the skill body is loaded into the sub-agent's [worker prompt](./agents.md#sub-agent-prompt), giving it step-by-step instructions for its task type.
- **Model selection** -- the `model` field determines which model runs the sub-agent.

The coordinator never loads full skill content into its own context. It sees the index, delegates by skill name, and the spawn infrastructure handles the rest.

## Skill Lifecycle

Skills improve through use:

1. **Encounter pattern** -- the agent handles a task type for the first time.
2. **Create skill** -- after handling it, the agent recognises this will recur and calls `create_skill`.
3. **Use skill** -- next time the pattern appears, triggers match and the skill is loaded automatically.
4. **Discover gaps** -- the skill misses a step or handles an edge case poorly.
5. **Update skill** -- the agent calls `update_skill` to refine the recipe.
6. **Compound** -- over time, skills become more complete and reliable.

The system prompt enforces this directly: "Same task type more than twice -- create a skill. Don't propose it -- create it."

## Automatic Skill Creation

After each exchange, a background extraction call analyses the conversation for:

1. **Memories** worth storing (facts, decisions, task patterns).
2. **Skill candidates** based on repeated patterns.

The extraction prompt includes prior related memories from the [memory system](./memory.md). When the same task type appears **3+ times** (including the current exchange), the extraction system outputs a skill definition, and the main loop auto-creates it via `createSkill`.

This is the "3+ repetitions" rule: encounter a pattern once, it is a memory. Encounter it twice, the extraction system notes the repetition. Encounter it a third time, a skill is auto-created -- no agent decision required.

Auto-created skills go into the DB (not files), so the human can always override them with a file-based skill of the same name.

## Tool Interface

Five tools for skill management:

### `load_skill`

Load the full instructions for a skill by name. Returns the markdown body content.

```ts
load_skill({ name: "code-review" })
// → "## How to review code\n1. Check for..."
```

### `create_skill`

Create a new skill in the DB. Fails if a file-based skill with the same name exists, or if a DB skill with the same name already exists (use `update_skill` instead).

```ts
create_skill({
  name: "deploy-check",
  description: "Pre-deployment verification checklist",
  triggers: ["deploy", "deployment", "release", "ship"],
  content: "## Steps\n1. Run tests\n2. Check staging..."
})
```

### `update_skill`

Update an existing DB skill. Supports partial updates -- only provided fields are changed. Cannot modify file-based skills.

```ts
update_skill({
  name: "deploy-check",
  triggers: ["deploy", "deployment", "release", "ship", "go live"],
  content: "## Steps\n1. Run tests\n2. Check staging\n3. Verify rollback plan..."
})
```

### `delete_skill`

Delete a DB skill. Cannot delete file-based skills -- those are human-managed.

```ts
delete_skill({ name: "deploy-check" })
```

### `list_skills`

List all skills with metadata (name, description, triggers, tools, source). Returns the full index without skill body content. Useful for inspecting what is available, including runtime-created skills.

```ts
list_skills()
// → [{ name: "reminders", description: "Set reminders...", triggers: [...], tools: [...], source: "file" }, ...]
```

The skill index is also always present in the [system prompt](./system-prompt.md#4-available-skills), but `list_skills` provides additional detail (triggers, tools, source) that the prompt index omits.

## Shipped Skills

Koshi ships with default skills in the repo's `skills/` directory, seeded to the external directory on first boot:

| Skill | Triggers | Purpose |
|-------|----------|---------|
| `reminders` | remind, reminder, schedule, timer, cron, ... | Set reminders and scheduled notifications |
| `summarize-article-url` | summarize, article, url, tldr, ... | Fetch and summarize web articles |
| `math-calculations` | calculate, math, compute, formula, ... | Run calculations via shell |
| `skill-writing` | skill, learn, teach, pattern, recipe, ... | Meta-skill: how to create and update skills |

## Cross-References

- [agents.md](./agents.md) -- how skills define specialist agents (tool scope, model selection, worker prompts)
- [memory.md](./memory.md) -- how repeated patterns are detected via memory recall during extraction
- [system-prompt.md](./system-prompt.md) -- how the skill index and active skills appear in the prompt
- [overview.md](./overview.md) -- named model system referenced by the `model` frontmatter field
