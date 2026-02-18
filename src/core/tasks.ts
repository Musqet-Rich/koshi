import type Database from 'better-sqlite3'
import type { CreateTaskOptions, Task, TaskFilter, TaskRun } from '../types.js'

const PRIORITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
}

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    template: (row.template as string) ?? undefined,
    source: (row.source as Task['source']) ?? undefined,
    routeMatch: (row.route_match as string) ?? undefined,
    agentRunId: (row.agent_run_id as string) ?? undefined,
    project: (row.project as string) ?? undefined,
    blockedBy: JSON.parse((row.blocked_by as string) || '[]') as number[],
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? undefined,
    completedAt: (row.completed_at as string) ?? undefined,
    result: (row.result as string) ?? undefined,
  }
}

function rowToRun(row: Record<string, unknown>): TaskRun {
  return {
    id: row.id as number,
    taskId: row.task_id as number,
    agentRunId: row.agent_run_id as string,
    template: (row.template as string) ?? undefined,
    model: (row.model as string) ?? undefined,
    status: row.status as TaskRun['status'],
    startedAt: row.started_at as string,
    finishedAt: (row.finished_at as string) ?? undefined,
    result: (row.result as string) ?? undefined,
    error: (row.error as string) ?? undefined,
  }
}

export function createTaskManager(db: Database.Database) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (title, description, status, priority, template, source, project, blocked_by)
      VALUES (@title, @description, 'open', @priority, @template, @source, @project, @blocked_by)
    `),
    get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    update: db.prepare('SELECT id FROM tasks WHERE id = ?'),
    getReady: db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS dep
        WHERE dep.id IN (SELECT value FROM json_each(tasks.blocked_by))
        AND dep.status != 'done'
      )
    `),
    insertRun: db.prepare(`
      INSERT INTO task_runs (task_id, agent_run_id, template, model, status, started_at, result, error)
      VALUES (@task_id, @agent_run_id, @template, @model, @status, datetime('now'), @result, @error)
    `),
    updateAgentRunId: db.prepare('UPDATE tasks SET agent_run_id = ? WHERE id = ?'),
    getRuns: db.prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY started_at'),
  }

  return {
    create(opts: CreateTaskOptions): number {
      const result = stmts.insert.run({
        title: opts.title,
        description: opts.description ?? null,
        priority: opts.priority ?? 'normal',
        template: opts.template ?? null,
        source: opts.source ?? null,
        project: opts.project ?? null,
        blocked_by: JSON.stringify(opts.blockedBy ?? []),
      })
      return result.lastInsertRowid as number
    },

    list(filter?: TaskFilter): Task[] {
      const conditions: string[] = []
      const params: Record<string, unknown> = {}

      if (filter?.status) {
        conditions.push('status = @status')
        params.status = filter.status
      }
      if (filter?.priority) {
        conditions.push('priority = @priority')
        params.priority = filter.priority
      }
      if (filter?.project) {
        conditions.push('project = @project')
        params.project = filter.project
      }
      if (filter?.source) {
        conditions.push('source = @source')
        params.source = filter.source
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY created_at DESC`).all(params) as Record<
        string,
        unknown
      >[]
      return rows.map(rowToTask)
    },

    get(id: number): Task | null {
      const row = stmts.get.get(id) as Record<string, unknown> | undefined
      return row ? rowToTask(row) : null
    },

    update(
      id: number,
      changes: Partial<Pick<Task, 'status' | 'priority' | 'result' | 'agentRunId' | 'startedAt' | 'completedAt'>>,
    ): void {
      const sets: string[] = []
      const params: Record<string, unknown> = { id }

      if (changes.status !== undefined) {
        sets.push('status = @status')
        params.status = changes.status
      }
      if (changes.priority !== undefined) {
        sets.push('priority = @priority')
        params.priority = changes.priority
      }
      if (changes.result !== undefined) {
        sets.push('result = @result')
        params.result = changes.result
      }
      if (changes.agentRunId !== undefined) {
        sets.push('agent_run_id = @agent_run_id')
        params.agent_run_id = changes.agentRunId
      }
      if (changes.startedAt !== undefined) {
        sets.push('started_at = @started_at')
        params.started_at = changes.startedAt
      }
      if (changes.completedAt !== undefined) {
        sets.push('completed_at = @completed_at')
        params.completed_at = changes.completedAt
      }

      if (sets.length === 0) return
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
    },

    getReady(): Task[] {
      const rows = stmts.getReady.all() as Record<string, unknown>[]
      return rows
        .sort((a, b) => (PRIORITY_ORDER[b.priority as string] ?? 2) - (PRIORITY_ORDER[a.priority as string] ?? 2))
        .map(rowToTask)
    },

    recordRun(
      taskId: number,
      run: { agent_run_id: string; template?: string; model?: string; status: string; result?: string; error?: string },
    ): number {
      const result = stmts.insertRun.run({
        task_id: taskId,
        agent_run_id: run.agent_run_id,
        template: run.template ?? null,
        model: run.model ?? null,
        status: run.status,
        result: run.result ?? null,
        error: run.error ?? null,
      })
      stmts.updateAgentRunId.run(run.agent_run_id, taskId)
      return result.lastInsertRowid as number
    },

    getRuns(taskId: number): TaskRun[] {
      return (stmts.getRuns.all(taskId) as Record<string, unknown>[]).map(rowToRun)
    },
  }
}
