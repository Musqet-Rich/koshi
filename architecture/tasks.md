# Task Management

## Design

Tasks are built into core. No external dependencies. Tasks are created by the planning agent, by [routing rules](./overview.md#routing-rules), or by cron — then [agents](./agents.md) are spawned to work them.

A task is the durable record. An agent is a transient run against it.

## Schema

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

## Lifecycle

### Agent-created task

```
spawn_agent(task_id: 5)
    │
    ▼
Status: pending
    │
    ▼ (coordinator dispatches)
Status: running
    │
    ├── Agent succeeds → status: completed, agent_result_id → agent_results row
    │
    └── Agent fails/times out → status: failed
            │
            ▼ (coordinator can retry)
        New agent run, status: running again
```

### Route-created task

```
Incoming message matches routing rule
    │
    ▼
Router auto-creates task (skill from rule, context from message)
    │
    ▼
Router auto-spawns agent (if rule specifies autoRun)
    │
    ▼
Status: running — coordinator never involved
    │
    ├── Agent succeeds → status: completed, result in agent_results
    │
    └── Agent fails → status: failed, coordinator notified
```

[Routing rules](./overview.md#routing-rules) in `koshi.yaml`:
```yaml
routes:
  - match:
      channel: github-webhooks
      event: pull_request
      action: opened
    action:
      spawn:
        skill: code-review
        task: "Review PR #{{number}}: {{title}}"
        autoRun: true
```

This means the [router](./buffer.md#routing) is a task creator alongside the coordinator and cron. The coordinator can write new routing rules, effectively building automation pipelines without being in the loop for every event.

## Coordinator Tools

```ts
task_list({
  status: "pending",           // filter by status
  project_id: "api-refactor"   // filter by project
})

task_update({
  id: 5,
  status: "completed"
})
```

Note: Task creation is normally done by the planning agent (which writes task rows with `context`, `skill`, `depends_on`). The coordinator dispatches tasks by ID via `spawn_agent(task_id: N)`. See [agents.md](./agents.md#planning-agent-as-context-compiler) for the planning workflow.

## Auto-execution

When a task is created (by any source), it can be:

1. **Execute immediately** — spawn an agent right away (`autoRun: true`)
2. **Queue for later** — leave it pending, pick up on next cron/heartbeat cycle
3. **Manual** — wait for the user to say "work on task #3"

```ts
// Planned task — dispatched by coordinator from the dependency graph
spawn_agent(task_id: 5)   // reads context, skill, etc. from the task row

// Ad-hoc task — coordinator spawns directly
spawn_agent({
  task: "Review PR #1061",
  skill: "code-review"
})
```

## Cron Integration

Cron jobs can create tasks on a schedule:

```yaml
cron:
  - name: morning-briefing
    schedule: "30 7 * * *"
    task:
      title: "Publish morning briefing"
      skill: "morning-briefing"
      autoRun: true
```

## Relationship to [Memory](./memory.md)

When a task completes, the coordinator curates the result — storing key findings as [memories](./memory.md) with full provenance:
- Content: task title + result summary
- Source: `agent` (see [narrative.md](./narrative.md#provenance-tags-full-set) for the full tag taxonomy)
- Tags: extracted from title + context
- task_id: links back to the originating task

This means completed work is searchable in memory. "What did I do about lint errors?" → finds the task result.

## What This Replaces

| OpenClaw | Koshi |
|----------|-------|
| External Kanban API | Built-in SQLite table |
| HEARTBEAT.md polling instructions | Cron + task queue |
| Beads (`bd`) CLI | Native task tools |
| Plan files in ~/shared/projects/ | Task descriptions + memory |
| Sub-agent session management | Ephemeral agent runs |

One system instead of five.

## Dependencies

Tasks can depend on other tasks. A task is only ready to run when all its dependencies are completed.

```sql
-- JSON array of task IDs this task depends on
depends_on TEXT NOT NULL DEFAULT '[]'    -- e.g. '[1, 3, 7]'
```

This enables wave execution — the coordinator queries for unblocked tasks and runs them in parallel:

```sql
SELECT * FROM tasks
WHERE status = 'pending'
AND NOT EXISTS (
  SELECT 1 FROM tasks AS dep
  WHERE dep.id IN (SELECT value FROM json_each(tasks.depends_on))
  AND dep.status != 'completed'
);
```

Wave 1: tasks with no deps → Wave 2: tasks whose deps completed in wave 1 → etc.

## Projects / Epics

Tasks are grouped under a project for bigger plans:

```sql
project_id TEXT NOT NULL        -- groups tasks into a job, e.g. "api-integration"
```

Find all tasks in a project: `task_list({ project_id: "api-integration" })`

This replaces plan files — the project is just a label, the tasks ARE the plan. The planning agent creates a whole project's worth of tasks with dependencies in one go.

## Run History

Every agent run is logged, not just the last:

Run history is captured in the [`agent_results`](./agents.md#agent-results--durability) table. Each completed agent writes its output there, linked back to the task via `task_id`. The coordinator can see the full history of attempts for any task.

A task might take 3 attempts before it succeeds. The history shows why — what failed, what changed, what worked.

## CLI

Tasks are manageable from the command line:

```bash
koshi task list                            # all pending tasks
koshi task list --project myproject        # project-scoped
koshi task list --status running           # filter by status
koshi task show 3                          # detail + agent results
koshi task run 3                           # manually trigger
```

## Live Progress

[Sub-agent](./agents.md) streaming output is available to the coordinator and the user in real time. In the TUI, task progress shows inline in conversation when the agent reports back, or the user can ask "what's happening with task #3?" and the coordinator checks the running agent's stream.

Channel plugins can also deliver task notifications — e.g. a Nostr DM when a critical task completes.
