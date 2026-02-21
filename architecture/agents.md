# Specialist Agent Execution Model

> **Status: Decided, Not Yet Built.** Design document from brainstorming sessions on 2026-02-21. Supersedes the previous agent architecture doc.

## Core Principle

**Agent = Worker + Skill + Tool Scope.**

A sub-agent is not a generic Claude conversation with a task string. It is a specialist — defined by a skill, scoped to a tool set, producing a durable result. The coordinator never acts directly; it thinks, decides, and delegates.

## Three Roles, Clean Separation

| Role | Responsibility |
|------|---------------|
| **Planning agent** | Writes work orders. Decomposes a job into tasks with scoped context for each. |
| **Coordinator** | Dispatches work orders. Reads summaries and IDs, spawns agents, reacts to completions. |
| **Specialists** | Execute work orders. Each gets only its task context, its skill, and its scoped tools. |

## Coordinator (Main Thread)

The coordinator is the user's conversation partner. It never executes work. Its only job is to think, decide, and delegate.

**What the coordinator sees:**

- The [skill index](./system-prompt.md#4-available-skills): name + one-line description for every skill. That is all. Full skill content is never loaded into the coordinator's context.
- [Memory](./memory.md) tools for recall and curation.
- The agent results table for reading completed work.
- The [task dependency graph](./tasks.md#dependencies) for scheduling.

**What the coordinator does NOT do:**

- Execute Claude Code tools like Read, Bash, Grep, etc. These are behaviorally forbidden via the [system prompt](./system-prompt.md#2-architecture--tool-rules) (in the Claude Code/MCP bridge they cannot be structurally removed). Note: `read_file` (an MCP tool for reading agent output files) IS permitted — it is distinct from `Read` (a Claude Code file reading tool).
- Load full skill content. It only sees the index.
- Plan complex jobs directly. For multi-step work, it spawns a planning agent. Planning is delegated work, not coordinator work — planning blocks the thread the same way execution does.
- Load full research or full plans into its own context. It reads summaries and passes pointers.

**Coordinator workflow:**

1. **Receive** — a user message arrives, or a sub-agent completion wakes the coordinator from idle.
2. **Delegate research** — for jobs requiring investigation, spawn a research agent. Its result is stored in the DB.
3. **Delegate planning** — spawn a planning agent, passing a pointer to the research result (not the research itself). The planning agent reads the full research, produces tasks with scoped context for each.
4. **Schedule** — examine the dependency graph, find tasks with no blockers, spawn agents for them in parallel.
5. **React** — when a sub-agent completes, mark the task done, check what is now unblocked, spawn the next batch.
6. **Curate** — read agent results, store important findings as [memories](./memory.md) (linked to the task and result), update the [narrative](./narrative.md).
7. **Respond** — inform the user of progress or final results.

## Context Narrows Down the Tree

Context gets more focused at each level of delegation. This is by design — no agent loads more information than it needs.

| Agent | What it sees |
|-------|-------------|
| **Research agent** | Full raw information — files, web results, codebase content |
| **Planning agent** | Full research output — reads the complete research result to decompose it |
| **Specialists** | Only their slice — the curated brief from the planning agent for their specific task |
| **Coordinator** | Only summaries and IDs — never loads full research, full plans, or specialist contexts |

The coordinator passes **pointers, not payloads**. When it spawns the planning agent, it passes `context: [agent_result:12]` — a reference to the research result. The spawn infrastructure resolves the pointer and injects the content. The coordinator's own context window never holds the research.

## Planning Agent as Context Compiler

The planning agent's job is not just to split work into tasks. It **curates scoped context** for each task.

When the planning agent receives a research result, it:

1. Reads the full research.
2. Decomposes the job into discrete tasks.
3. For each task, writes a **curated brief** — the subset of the research that task needs, plus any additional framing or instructions. This is the task's `context` field.
4. Assigns a skill to each task.
5. Defines dependency relationships between tasks.
6. Writes the task rows to the DB.

The planning agent's skill should define this as part of its output contract: each task must include a title, a context brief, a skill assignment, and dependency declarations.

**The context brief is the planning agent's core deliverable.** A task with a vague context like "implement the auth module" is a failure of planning. A good brief includes the relevant research findings, the specific requirements, the interfaces to conform to, and the constraints that apply — scoped to exactly what this specialist needs.

## Context Lives in the Tasks Table

Context flows through the database, not through the coordinator's context window.

1. The planning agent writes task rows to the `tasks` table, each with a `context` field containing the curated brief.
2. The coordinator spawns agents by task ID: `spawn_agent(task_id: 5)`.
3. The spawn infrastructure reads the task row, pulls the context, loads the skill, builds the prompt.
4. The specialist runs with its scoped context. It never sees the full research or other tasks' contexts.

**The coordinator never touches task context.** It reads task titles, statuses, and dependency edges. The actual content — what each specialist needs to know — passes from the planning agent through the DB to the specialist, bypassing the coordinator entirely.

## Tasks Table Schema

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,           -- groups tasks into a job
  title TEXT NOT NULL,                -- short description
  context TEXT,                       -- planning agent's curated brief for this task
  skill TEXT NOT NULL,                -- which specialist to use
  depends_on TEXT NOT NULL DEFAULT '[]',  -- JSON array of task IDs
  status TEXT NOT NULL DEFAULT 'pending', -- pending | blocked | running | completed | failed
  agent_result_id INTEGER REFERENCES agent_results(id),  -- filled when agent completes
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## Cross-Agent Context Sharing

Sub-agents can reference other agents' outputs without the coordinator loading those outputs.

**Mechanism:** The `context` parameter in a spawn call can include `[agent_result:ID]` references. The spawn infrastructure resolves these — loads the referenced agent result from the DB and injects it into the sub-agent's prompt.

**Example:** After a research agent completes (result ID 12), the coordinator spawns the planning agent:

```
spawn_agent(
  task: "Plan implementation based on research",
  skill: "project-planner",
  context: [agent_result:12]
)
```

The coordinator passes a pointer. The spawn infrastructure loads result 12 and gives the planning agent the full research text. The coordinator's context window never holds the research.

For planned tasks, this is handled automatically — the task row's `context` field already contains the curated brief from the planning agent.

## Spawn Signature

Two modes, depending on whether the task comes from a plan or is ad-hoc:

**Planned tasks** — everything needed is in the task row:

```
spawn_agent(task_id: 5)
```

The spawn infrastructure reads the task row, extracts `context`, `skill`, and any other metadata. One argument, no ambiguity.

**Ad-hoc tasks** — coordinator specifies directly:

```
spawn_agent(
  task: string,       // what to do
  skill: string,      // which specialist
  context?: string,   // optional; may include [agent_result:ID] references
  model?: string,     // optional; overrides the skill's model: field. Normally omitted.
)
```

When `spawn_agent` is called:

1. The spawn system resolves the task — either by reading the task row (planned) or using the provided arguments (ad-hoc).
2. It loads the full skill by name.
3. It reads the `tools` array and `model` from the skill's frontmatter (model defaults to `agent.model` if not specified in the skill; an explicit `model` on the spawn call overrides both).
4. It resolves any `[agent_result:ID]` references in the context, loading the referenced results from the DB.
5. It builds the sub-agent's prompt with the skill content, the task context, and worker rules.
6. It creates a new Claude API conversation with only those tools registered, using the resolved model.
7. The agent runs, completes, and its output is written to the `agent_results` table.

No `tools` parameter on the spawn call. The skill is the single source of truth for what the agent can do.

## Skill-Defined Tool Scope

The skill defines the permitted tools. Period. No coordinator override.

This is structural enforcement: if a tool is not listed in the skill's frontmatter, the sub-agent literally cannot call it. The tool is not registered in the agent's session. There is no "forbidden tools" instruction to ignore — the tool does not exist.

**Why not coordinator-narrowed scope?** A ceiling model (skill defines the max, coordinator narrows per-spawn) was considered and rejected. It introduces judgment calls at spawn time — which tools should the coordinator strip for this particular task? That is unnecessary complexity. If a task needs a different tool set, write a new skill. Skills are cheap.

**Skill frontmatter:**

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

Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Kebab-case identifier |
| `description` | `string` | One sentence — this is what the coordinator sees in the skill index |
| `triggers` | `string[]` | Keywords/phrases that suggest this skill |
| `tools` | `string[]` | Permitted tools for the sub-agent. This is the entire tool set. |

Optional fields:

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Named model to use (references `models:` in `koshi.yaml`). If omitted, defaults to `agent.model` (the main model). Model selection lives in the skill, not on the spawn call. |

The body of the skill markdown file contains the full instructions — domain knowledge, workflow steps, examples. This content is loaded only into the sub-agent's prompt, never the coordinator's.

**Creating a new specialist is writing a markdown file.** No code, no deployment, no restart. The skill registry picks it up immediately. The coordinator sees it in the index on its next turn.

## The Full Workflow

A concrete example of how a complex project flows through the system:

1. **User provides complex project** — e.g., "Refactor the authentication system to support OAuth."
2. **Coordinator spawns research agent** — the research agent investigates the codebase, reads files, gathers raw information. Its output (result ID 12) is written to `agent_results`.
3. **Coordinator reads the executive summary** from result 12 (just enough to know the research succeeded), then spawns the planning agent with `context: [agent_result:12]`.
4. **Planning agent sees the full research.** It decomposes the job into tasks, writing a curated context brief for each. Tasks are written to the `tasks` table.
5. **Coordinator checks the dependency graph.** It finds tasks with no blockers and spawns specialists for each, using `spawn_agent(task_id: N)`.
6. **Each specialist gets only its task context** — the curated brief from the planning agent, the skill instructions, and the scoped tools. It never sees the full research, other tasks' contexts, or the overall plan.
7. **As specialists complete,** the coordinator marks tasks done, checks what is now unblocked, and spawns the next batch.
8. **The coordinator never loads** the full research or the full plan into its own context. It works with summaries, task titles, statuses, and IDs.

## Sub-Agent Prompt

### The Current Bug

Sub-agents currently receive the same system prompt as the coordinator. This includes coordinator-specific instructions like "delegate to spawn_agent" and the forbidden tools list — which directly contradicts the sub-agent's role as a worker that should be using those tools.

### The Fix

An `agentType` parameter in the [prompt builder](./system-prompt.md). Two modes:

- **`coordinator`** — the current prompt: identity, architecture rules, skill index, delegation instructions, forbidden tools.
- **`worker`** — a stripped prompt: identity, the task description, the skill content, and worker rules.

Worker rules are simple:

- You are a specialist. Do the task. Return the result.
- You cannot spawn other agents.
- You cannot write to memory.
- When you are done, your output is your deliverable.

Workers skip the coordinator section entirely. No delegation instructions, no forbidden tools list, no skill index.

## No Memory Pollution

Sub-agents do NOT have access to `memory_store`, `memory_update`, `memory_reinforce`, or `memory_demote` (see [memory tools](./memory.md#tool-interface)). These tools are not registered in worker sessions. This is structural — the tools do not exist in the sub-agent's environment.

This solves the "noisy sub-agent memories" problem by design, not discipline. Sub-agents cannot create low-quality memories because they cannot create memories at all.

Sub-agent output flows through the spawn infrastructure. The coordinator reads the result and curates what is worth keeping — storing key findings as memories with full provenance (linked to the task and the agent result that produced them).

Sub-agents can still read memory via `memory_query` if the skill's tool list includes it. Reading is safe; writing is the problem.

## Agent Results & Durability

### The `agent_results` Table

```sql
CREATE TABLE IF NOT EXISTS agent_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id),    -- nullable; not all agents are part of a task plan
  skill_used TEXT NOT NULL,                 -- which skill was loaded
  output TEXT NOT NULL,                     -- the agent's response text (the deliverable)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER NOT NULL DEFAULT 0,    -- whether the coordinator has read and curated this
  memory_ids TEXT NOT NULL DEFAULT '[]'    -- JSON array of memory IDs the coordinator created from this
);
```

**Durability guarantee:** When a sub-agent completes, its output is written to this table immediately — before any notification is sent. The data survives even if the coordinator never wakes up, the session drops, or the process restarts.

### Wake-Up Mechanism

When a sub-agent completes:

1. Output is written to `agent_results`.
2. A message is sent to the coordinator's [message queue](./buffer.md).
3. The coordinator wakes from idle (event-driven, not polling).
4. The coordinator reads the result, curates it, and checks for newly unblocked tasks.

The coordinator is idle until a message arrives — either from the user or from agent completion. No polling loops. No busy-waiting.

### Session Recovery

On new session start, the coordinator checks for unprocessed results:

```sql
SELECT * FROM agent_results WHERE processed = 0;
```

Any unprocessed results get curated. Any incomplete task graphs get resumed. Nothing falls through the cracks because of a session boundary.

## Task Dependency Graph

For complex work, the coordinator delegates planning to a planning agent. The planning agent produces a set of tasks with dependency relationships, each carrying its own scoped context. The coordinator then schedules execution based on the dependency graph.

### Relational Execution Graph

```
Narrative
  |-- references --> Memory[]
  |     |-- each Memory optionally --> narrative_id (back-link)
  |     |-- each Memory optionally --> task_id (what task produced it)
  |
  |-- references --> Task[]
  |     |-- depends_on --> Task[] (dependency edges)
  |     |-- context: curated brief (from planning agent)
  |     |-- skill: which specialist to use
  |     |-- agent_result_id --> AgentResult (the output)
  |     |-- status: pending | blocked | running | completed | failed
  |
  |-- previous_narrative_id (chain)
```

This graph connects to the narrative system described in [narrative.md](narrative.md). Every piece of data — memories, tasks, agent results, narratives — is linked. From any node, you can traverse to any other.

### Scheduling

The coordinator does not manually sequence tasks. It reads the graph:

1. Find all tasks with status `pending` and no unresolved dependencies.
2. Spawn agents for each one (in parallel, up to the concurrency limit) using `spawn_agent(task_id: N)`.
3. Mark them `running`.
4. When a result comes back, mark the task `completed`, write the result, check what is now unblocked.
5. Repeat until the graph is fully resolved or a task fails.

Failed tasks can block downstream work. The coordinator decides whether to retry, skip, or inform the user.

### Full Provenance Chain

From any single memory, you can reconstruct the full context:

1. **Memory** has `task_id` -- follow to the task that produced it.
2. **Task** has `agent_result_id` -- see the full agent output.
3. **Task** is part of a dependency graph -- see the whole plan.
4. **Memory** has `narrative_id` -- see the reasoning arc that motivated the plan.
5. **Narrative** has `previous_narrative_id` -- walk backwards through the full reasoning history.

Nothing is orphaned. Every fact knows what produced it.

## Concurrency

Multiple agents can run simultaneously. Koshi manages:

- Active agent count (configurable limit).
- Queue if limit exceeded (FIFO within priority).
- Timeout enforcement per agent.
- Result delivery to the durable results table.

```yaml
agents:
  maxConcurrent: 3
  defaultTimeout: 300     # 5 minutes
```

## Model Selection

Models are defined as named entries in `koshi.yaml` and referenced by name. Model selection lives in the skill frontmatter via the `model:` field — this is the primary mechanism. If a skill does not specify a model, the default `agent.model` from `koshi.yaml` is used.

The ad-hoc spawn signature accepts an optional `model` override, but this is intended only for exceptional cases where the coordinator needs to override the skill's default:

```
spawn_agent(
  task: "Review the authentication refactor",
  skill: "code-review",
  model?: "opus"          // optional override; normally omitted — skill's model: field is preferred
)
```

See [overview.md](overview.md) for the named model system.

## What Changed from the Previous Design

| Previous (POC) | New (Specialist Model) |
|-----------------|------------------------|
| Templates define tool sets (`tools: [exec, files]`) | Skills define tool sets in frontmatter |
| Coordinator has forbidden tools list (behavioral); workers also behavioral | Coordinator: behavioral forbidden list (unchanged). Workers: structurally scoped tools (only skill tools registered) |
| `spawn_agent(task, tools, template)` | `spawn_agent(task_id)` for planned; `spawn_agent(task, skill, context?)` for ad-hoc |
| Sub-agents get coordinator prompt | Sub-agents get worker prompt via `agentType` |
| Sub-agents can write memories | Sub-agents have no memory write access |
| Results returned via notification only | Results written to durable `agent_results` table first |
| Flat task list | Task dependency graph with parallel scheduling |
| No session recovery for agent results | Unprocessed results curated on session start |
| Templates are YAML config blocks | Skills are markdown files with frontmatter |
| Context passed as task string | Context curated by planning agent, stored in task row, resolved by spawn infrastructure |
| Coordinator loads full context | Coordinator passes pointers; context narrows down the delegation tree |

Templates are removed. Skills replace them entirely. A skill is both the instructions and the tool scope — there is no separate "tool config" concept.

## Design Principles

1. **Structural over behavioral.** Tool restrictions are enforced by not providing the tools, not by asking nicely. There is no forbidden tools list to ignore — the tool does not exist.

2. **Skills are the registry.** Creating a new specialist is writing a markdown file. No code, no deployment, no restart.

3. **Coordinator never acts.** It thinks, decides, delegates. Even planning is delegated.

4. **Context narrows down the tree.** Research agents load full raw info. Planning agents load full research. Specialists load only their slice. The coordinator loads only summaries and IDs.

5. **Context flows through the DB, not the coordinator.** The planning agent writes curated briefs to task rows. The spawn infrastructure reads them. The coordinator passes pointers, never payloads.

6. **Results are durable.** Agent output hits the database before any notification. Nothing is lost on session drop, process restart, or coordinator timeout.

7. **Event-driven.** The coordinator is idle until a message (user or agent completion) arrives. No polling, no blocking.

8. **Full provenance.** Every piece of data knows what produced it and can be traced back through the execution graph to the original reasoning that motivated it.

9. **No memory pollution.** Sub-agents cannot write to the memory database. The coordinator curates what is worth keeping.

10. **Role separation is absolute.** The planning agent writes the work orders. The coordinator dispatches them. The specialists execute them. Each role handles only what it is qualified for — no role reaches into another's responsibility.

---

> **Note:** This design needs a final evaluation pass for problems before implementation begins. The concepts are internally consistent as documented, but a deliberate review for edge cases, failure modes, and missing interactions should happen before any code is written.
