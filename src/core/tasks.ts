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
    failureReason: (row.failure_reason as string) ?? undefined,
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

  /** Collect all task IDs that transitively depend on the given task ID */
  function collectDownstream(failedId: number): number[] {
    // Get all non-terminal tasks that have dependencies
    const allTasks = db
      .prepare(`SELECT id, depends_on FROM tasks WHERE status IN ('pending', 'blocked', 'running')`)
      .all() as Array<{ id: number; depends_on: string }>

    // Build a reverse adjacency: for each task, which tasks depend on it
    const dependents = new Map<number, number[]>()
    for (const t of allTasks) {
      const deps: number[] = JSON.parse(t.depends_on || '[]')
      for (const dep of deps) {
        if (!dependents.has(dep)) dependents.set(dep, [])
        dependents.get(dep)!.push(t.id)
      }
    }

    // BFS from failedId to find all transitive dependents
    const visited = new Set<number>()
    const queue = [failedId]
    while (queue.length > 0) {
      const current = queue.shift()!
      const children = dependents.get(current) ?? []
      for (const child of children) {
        if (!visited.has(child)) {
          visited.add(child)
          queue.push(child)
        }
      }
    }
    return Array.from(visited)
  }

  /**
   * Detect whether adding `dependsOn` edges to a new/proposed task would
   * create a circular dependency in the task graph.
   *
   * Uses DFS three-color marking on the full dependency graph (including the
   * candidate's proposed edges) to detect any cycle reachable from the
   * candidate node.
   *
   * Returns the cycle path as an array of task IDs if a cycle is found, or
   * null if no cycle exists.
   */
  function detectCycle(candidateId: number, dependsOn: number[]): number[] | null {
    if (dependsOn.length === 0) return null

    // Self-dependency is always a cycle
    for (const dep of dependsOn) {
      if (dep === candidateId) return [candidateId, candidateId]
    }

    // Load all non-terminal tasks and build adjacency list (task -> tasks it depends on)
    const allTasks = db
      .prepare(`SELECT id, depends_on FROM tasks WHERE status IN ('pending', 'blocked', 'running')`)
      .all() as Array<{ id: number; depends_on: string }>

    const graph = new Map<number, number[]>()
    for (const t of allTasks) {
      graph.set(t.id, JSON.parse(t.depends_on || '[]') as number[])
    }

    // Add the candidate's proposed edges
    graph.set(candidateId, dependsOn)

    // DFS with three-color marking to detect cycles reachable from candidateId.
    // WHITE (not in sets) = unvisited, GRAY (in visiting) = on current DFS path,
    // BLACK (in visited) = fully explored, no cycle through this node.
    const visiting = new Set<number>() // gray — on current DFS stack
    const visited = new Set<number>()  // black — fully explored

    function dfs(node: number, path: number[]): number[] | null {
      if (visiting.has(node)) {
        // Found a back-edge — extract the cycle from the path
        const cycleStart = path.indexOf(node)
        return path.slice(cycleStart).concat(node)
      }
      if (visited.has(node)) return null

      visiting.add(node)
      path.push(node)

      const deps = graph.get(node) ?? []
      for (const dep of deps) {
        const cycle = dfs(dep, path)
        if (cycle) return cycle
      }

      path.pop()
      visiting.delete(node)
      visited.add(node)
      return null
    }

    return dfs(candidateId, [])
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

    /**
     * Propagate failure: when a task fails, mark all downstream dependents
     * (direct and transitive) as 'failed' with a failure_reason noting which
     * upstream task caused the cascade. Returns the list of task IDs that
     * were cascade-failed.
     */
    propagateFailure(failedTaskId: number): number[] {
      const failedTask = stmts.get.get(failedTaskId) as Record<string, unknown> | undefined
      const failedTitle = failedTask ? (failedTask.title as string) : `#${failedTaskId}`

      const downstream = collectDownstream(failedTaskId)
      if (downstream.length === 0) return []

      const updateStmt = db.prepare(
        `UPDATE tasks SET status = 'failed', failure_reason = ? WHERE id = ?`,
      )
      const cascadeFailed: number[] = []
      for (const id of downstream) {
        const reason = `Upstream task #${failedTaskId} ("${failedTitle}") failed`
        updateStmt.run(reason, id)
        cascadeFailed.push(id)
      }
      return cascadeFailed
    },

    /**
     * Check whether creating a task with the given dependsOn edges would
     * introduce a circular dependency. Returns the cycle path if a cycle
     * would be created, or null if safe.
     *
     * Call this BEFORE inserting the task. Pass the candidate task ID
     * (use a placeholder like -1 for tasks that don't exist yet).
     */
    detectCycle(candidateId: number, dependsOn: number[]): number[] | null {
      return detectCycle(candidateId, dependsOn)
    },

    /**
     * Recover orphaned tasks on startup.
     * Any task with status='running' was mid-execution when the process died.
     * Reset them to 'pending' so they can be re-dispatched.
     * Returns the list of recovered task IDs.
     */
    recoverOrphanedTasks(): Array<{ id: number; title: string }> {
      const rows = db
        .prepare(`SELECT id, title FROM tasks WHERE status = 'running'`)
        .all() as Array<{ id: number; title: string }>

      if (rows.length === 0) return []

      const resetStmt = db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`)
      for (const row of rows) {
        resetStmt.run(row.id)
      }

      return rows
    },

    /**
     * Unblock tasks whose dependencies are all resolved (completed or failed).
     * A blocked task should become 'pending' when every dependency has reached
     * a terminal state (completed) so it can be dispatched. If any dependency
     * has failed, the blocked task is cascade-failed instead.
     * Returns the list of unblocked task IDs.
     */
    unblockReadyTasks(): Array<{ id: number; title: string }> {
      const blocked = db
        .prepare(`SELECT id, title, depends_on FROM tasks WHERE status = 'blocked'`)
        .all() as Array<{ id: number; title: string; depends_on: string }>

      if (blocked.length === 0) return []

      const unblocked: Array<{ id: number; title: string }> = []
      const updateStmt = db.prepare(`UPDATE tasks SET status = 'pending' WHERE id = ?`)

      for (const task of blocked) {
        const deps: number[] = JSON.parse(task.depends_on || '[]')
        if (deps.length === 0) continue

        const allResolved = deps.every((depId) => {
          const dep = stmts.get.get(depId) as Record<string, unknown> | undefined
          return dep && (dep.status === 'completed' || dep.status === 'failed')
        })
        if (!allResolved) continue

        // Check if any dependency failed — if so, cascade failure
        const anyFailed = deps.some((depId) => {
          const dep = stmts.get.get(depId) as Record<string, unknown> | undefined
          return dep?.status === 'failed'
        })

        if (anyFailed) {
          // Find the first failed dependency for the failure reason
          const failedDepId = deps.find((depId) => {
            const dep = stmts.get.get(depId) as Record<string, unknown> | undefined
            return dep?.status === 'failed'
          })!
          const failedDep = stmts.get.get(failedDepId) as Record<string, unknown>
          const failedTitle = failedDep ? (failedDep.title as string) : `#${failedDepId}`
          db.prepare(`UPDATE tasks SET status = 'failed', failure_reason = ? WHERE id = ?`)
            .run(`Upstream task #${failedDepId} ("${failedTitle}") failed`, task.id)
        } else {
          updateStmt.run(task.id)
          unblocked.push({ id: task.id, title: task.title })
        }
      }

      return unblocked
    },
  }
}
