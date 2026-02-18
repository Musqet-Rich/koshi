# Task Management

## Design

Tasks are built into core. No external dependencies. Tasks are created by the main thread, by routing rules, or by cron — then agents are spawned to work them.

A task is the durable record. An agent is a transient run against it.

## Schema

```sql
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',      -- open, in_progress, done, failed
  priority TEXT DEFAULT 'normal',  -- low, normal, high, critical
  template TEXT,                   -- agent template to use (coder, researcher, etc.)
  source TEXT,                     -- who created it: 'agent', 'route', 'cron', 'cli'
  route_match TEXT,                -- if created by routing rule, the rule that matched
  agent_run_id TEXT,              -- UUID of current/last agent run
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  result TEXT                      -- what the agent produced
);
```

## Lifecycle

### Agent-created task

```
task_create("Fix lint errors", template: "coder", priority: "high")
    │
    ▼
Status: open
    │
    ▼ (main thread spawns agent)
Status: in_progress, agent_run_id: <uuid>, started_at: now
    │
    ├── Agent succeeds → status: done, result: "Fixed 12 errors, committed abc123"
    │
    └── Agent fails/times out → status: failed
            │
            ▼ (main thread can retry)
        New agent_run_id, status: in_progress again
```

### Route-created task

```
Incoming message matches routing rule
    │
    ▼
Router auto-creates task (source: 'route', route_match: 'pr-review')
    │
    ▼
Router auto-spawns agent (if rule specifies autoRun)
    │
    ▼
Status: in_progress — main agent never involved
    │
    ├── Agent succeeds → status: done, result stored as memory
    │
    └── Agent fails → status: failed, main agent notified
```

Routing rules in `koshi.yaml`:
```yaml
routes:
  - match:
      channel: github-webhooks
      event: pull_request
      action: opened
    action:
      spawn:
        template: reviewer
        task: "Review PR #{{number}}: {{title}}"
        autoRun: true
```

This means the router is a task creator alongside the main agent and cron. The main agent can write new routing rules, effectively building automation pipelines without being in the loop for every event.

## Main Thread Tools

```ts
task_create({
  title: "Fix lint errors in webhook.ts",
  description: "Run pnpm lint, fix all errors, commit",
  template: "coder",
  priority: "high"
})

task_list({
  status: "open",           // filter by status
  priority: "high"          // filter by priority
})

task_update({
  id: 1,
  status: "done",
  result: "Fixed and committed"
})
```

## Auto-execution

When a task is created (by any source), it can be:

1. **Execute immediately** — spawn an agent right away (`autoRun: true`)
2. **Queue for later** — leave it open, pick up on next cron/heartbeat cycle
3. **Manual** — wait for the user to say "work on task #3"

```ts
// Create and execute immediately
task_create({
  title: "Review PR #1061",
  template: "reviewer",
  autoRun: true
})

// Create and queue
task_create({
  title: "Upgrade dependencies",
  template: "coder",
  priority: "low"
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
      template: "researcher"
      autoRun: true
```

## Relationship to Memory

When a task completes, the result is automatically stored as a memory:
- Content: task title + result summary
- Source: "task"
- Tags: extracted from title + description

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

Tasks can depend on other tasks. A task is only ready to run when all its dependencies are done.

```sql
-- Array stored as JSON
blocked_by TEXT DEFAULT '[]'    -- e.g. '[1, 3, 7]'
```

This enables wave execution — the main thread queries for unblocked tasks and runs them in parallel:

```sql
SELECT * FROM tasks
WHERE status = 'open'
AND NOT EXISTS (
  SELECT 1 FROM tasks AS dep
  WHERE dep.id IN (SELECT value FROM json_each(tasks.blocked_by))
  AND dep.status != 'done'
)
ORDER BY priority DESC;
```

Wave 1: tasks with no deps → Wave 2: tasks whose deps completed in wave 1 → etc.

## Projects / Epics

Tasks can be grouped under a project for bigger plans:

```sql
project TEXT                    -- optional grouping key e.g. "api-integration"
```

Find all tasks in a project: `task_list({ project: "api-integration" })`

This replaces plan files — the project is just a label, the tasks ARE the plan. The main thread can create a whole project's worth of tasks with dependencies in one go.

## Run History

Every agent run is logged, not just the last:

```sql
CREATE TABLE task_runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  agent_run_id TEXT NOT NULL,     -- UUID
  template TEXT,
  model TEXT,
  status TEXT,                    -- completed, failed, timed_out
  started_at DATETIME,
  finished_at DATETIME,
  result TEXT,
  error TEXT                      -- if failed
);
```

A task might take 3 attempts before it succeeds. The history shows why — what failed, what changed, what worked.

## CLI

Tasks are manageable from the command line:

```bash
koshi task add "Upgrade dependencies" --priority low --template coder
koshi task list                        # all open tasks
koshi task list --project myproject     # project-scoped
koshi task list --source route          # show only route-created tasks
koshi task show 3                      # detail + run history
koshi task run 3                       # manually trigger
```

## Live Progress

Sub-agent streaming output is available to the main thread and the user in real time. In the TUI, task progress shows inline in conversation when the agent reports back, or the user can ask "what's happening with task #3?" and the main thread checks the running agent's stream.

Channel plugins can also deliver task notifications — e.g. a Nostr DM when a critical task completes.
