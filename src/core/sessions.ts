import type Database from 'better-sqlite3'
import type { Session, SessionMessage } from '../types.js'

export function createSessionManager(db: Database.Database) {
  const stmts = {
    insertSession: db.prepare('INSERT INTO sessions (id, model, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    getSession: db.prepare(
      'SELECT id, created_at as createdAt, updated_at as updatedAt, model, type FROM sessions WHERE id = ?',
    ),
    touchSession: db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?'),
    insertMessage: db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    getHistory: db.prepare(
      'SELECT role, content, tool_calls as toolCalls, created_at as createdAt FROM messages WHERE session_id = ? ORDER BY created_at ASC',
    ),
    getHistoryLimit: db.prepare(
      'SELECT role, content, tool_calls as toolCalls, created_at as createdAt FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?',
    ),
    pruneMessages: db.prepare(
      'DELETE FROM messages WHERE session_id = ? AND id NOT IN (SELECT id FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?)',
    ),
  }

  return {
    createSession(opts?: { id?: string; model?: string; type?: string }): string {
      const id = opts?.id ?? crypto.randomUUID()
      const now = new Date().toISOString()
      stmts.insertSession.run(id, opts?.model ?? null, opts?.type ?? 'main', now, now)
      return id
    },

    addMessage(sessionId: string, role: string, content: string, toolCalls?: string): void {
      const now = new Date().toISOString()
      stmts.insertMessage.run(sessionId, role, content, toolCalls ?? null, now)
      stmts.touchSession.run(now, sessionId)
    },

    getHistory(sessionId: string, limit?: number): SessionMessage[] {
      const rows = limit
        ? (stmts.getHistoryLimit.all(sessionId, limit) as Array<Record<string, unknown>>)
        : (stmts.getHistory.all(sessionId) as Array<Record<string, unknown>>)
      return rows.map((r) => ({
        role: r.role as SessionMessage['role'],
        content: r.content as string,
        toolCalls: r.toolCalls ? JSON.parse(r.toolCalls as string) : undefined,
        createdAt: r.createdAt as string,
      }))
    },

    clearHistory(sessionId: string): void {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId)
    },

    pruneSession(sessionId: string, maxMessages: number): number {
      const result = stmts.pruneMessages.run(sessionId, sessionId, maxMessages)
      return result.changes
    },

    touch(sessionId: string): void {
      stmts.touchSession.run(new Date().toISOString(), sessionId)
    },

    getSession(sessionId: string): Session | null {
      const row = stmts.getSession.get(sessionId) as Record<string, unknown> | undefined
      if (!row) return null
      return {
        id: row.id as string,
        createdAt: row.createdAt as string,
        updatedAt: row.updatedAt as string,
        model: row.model as string | undefined,
        type: row.type as Session['type'],
      }
    },
  }
}
