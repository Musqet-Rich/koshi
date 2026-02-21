import type Database from 'better-sqlite3'
import type { AgentResultRow, CreateTaskOptions, Task, TaskFilter } from '../types.js'

function rowToTask(row: Record<string, unknown>): Task {
  return {
    id: row.id as number,
    projectId: (row.project_id as string) ?? undefined,
    title: row.title as string,
    context: (row.context as string) ?? undefined,
    skill: (row.skill as string) ?? undefined,
    dependsOn: JSON.parse((row.depends_on as string) || '[]') as number[],
    status: row.status as Task['status'],
    agentResultId: (row.agent_result_id as number) ?? undefined,
    createdAt: row.created_at as string,
  }
}

function rowToAgentResult(row: Record<string, unknown>): AgentResultRow {
  return {
    id: row.id as number,
    taskId: (row.task_id as number) ?? undefined,
    skillUsed: (row.skill_used as string) ?? undefined,
    output: row.output as string,
    memoryIds: JSON.parse((row.memory_ids as string) || '[]') as number[],
    createdAt: row.created_at as string,
  }
}

export function createTaskManager(db: Database.Database) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO tasks (title, project_id, context, skill, depends_on, status)
      VALUES (@title, @project_id, @context, @skill, @depends_on, @status)
    `),
    get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    getReady: db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM tasks AS dep
        WHERE dep.id IN (SELECT value FROM json_each(tasks.depends_on))
        AND dep.status != 'completed'
      )
    `),
    insertAgentResult: db.prepare(`
      INSERT INTO agent_results (task_id, skill_used, output, memory_ids)
      VALUES (@task_id, @skill_used, @output, @memory_ids)
    `),
    getAgentResult: db.prepare('SELECT * FROM agent_results WHERE id = ?'),
    getAgentResultsByTask: db.prepare('SELECT * FROM agent_results WHERE task_id = ? ORDER BY created_at'),
  }

  return {
    create(opts: CreateTaskOptions): number {
      const result = stmts.insert.run({
        title: opts.title,
        project_id: opts.projectId ?? null,
        context: opts.context ?? null,
        skill: opts.skill ?? null,
        depends_on: JSON.stringify(opts.dependsOn ?? []),
        status: opts.status ?? 'pending',
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
      if (filter?.projectId) {
        conditions.push('project_id = @project_id')
        params.project_id = filter.projectId
      }
      if (filter?.skill) {
        conditions.push('skill = @skill')
        params.skill = filter.skill
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
      changes: Partial<Pick<Task, 'status' | 'agentResultId'>>,
    ): void {
      const sets: string[] = []
      const params: Record<string, unknown> = { id }

      if (changes.status !== undefined) {
        sets.push('status = @status')
        params.status = changes.status
      }
      if (changes.agentResultId !== undefined) {
        sets.push('agent_result_id = @agent_result_id')
        params.agent_result_id = changes.agentResultId
      }

      if (sets.length === 0) return
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
    },

    getReady(): Task[] {
      const rows = stmts.getReady.all() as Record<string, unknown>[]
      return rows.map(rowToTask)
    },

    recordAgentResult(
      result: { task_id?: number; skill_used?: string; output: string; memory_ids?: number[] },
    ): number {
      const res = stmts.insertAgentResult.run({
        task_id: result.task_id ?? null,
        skill_used: result.skill_used ?? null,
        output: result.output,
        memory_ids: JSON.stringify(result.memory_ids ?? []),
      })
      return res.lastInsertRowid as number
    },

    getAgentResult(id: number): AgentResultRow | null {
      const row = stmts.getAgentResult.get(id) as Record<string, unknown> | undefined
      return row ? rowToAgentResult(row) : null
    },

    getAgentResultsByTask(taskId: number): AgentResultRow[] {
      return (stmts.getAgentResultsByTask.all(taskId) as Record<string, unknown>[]).map(rowToAgentResult)
    },
  }
}
