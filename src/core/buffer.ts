import type Database from 'better-sqlite3'
import type { BufferedMessage, MessageBatch } from '../types.js'

export const Priority = {
  USER_DM: 10,
  WEBHOOK: 50,
  NOTIFICATION: 100,
} as const

export function createBuffer(db: Database.Database) {
  const insertStmt = db.prepare(
    `INSERT INTO buffer (channel, sender, conversation, payload, received_at, priority, routed)
     VALUES (@channel, @sender, @conversation, @payload, @receivedAt, @priority, 0)`,
  )

  const getUnroutedStmt = db.prepare(
    `SELECT id, channel, sender, conversation, payload, received_at, priority, routed
     FROM buffer WHERE routed = 0 ORDER BY priority ASC, id ASC`,
  )

  const markRoutedStmt = db.prepare(`UPDATE buffer SET routed = 1 WHERE id = ?`)

  const cleanupStmt = db.prepare(`DELETE FROM buffer WHERE routed = 1 AND received_at < ?`)

  return {
    insert(msg: {
      channel: string
      sender?: string
      conversation?: string
      payload: string
      priority?: number
    }): number {
      const result = insertStmt.run({
        channel: msg.channel,
        sender: msg.sender ?? null,
        conversation: msg.conversation ?? null,
        payload: msg.payload,
        receivedAt: Date.now(),
        priority: msg.priority ?? Priority.NOTIFICATION,
      })
      return Number(result.lastInsertRowid)
    },

    getUnrouted(): MessageBatch[] {
      const rows = getUnroutedStmt.all() as Array<{
        id: number
        channel: string
        sender: string
        conversation: string
        payload: string
        received_at: number
        priority: number
        routed: number
      }>

      const groups = new Map<string, BufferedMessage[]>()

      for (const row of rows) {
        const key = `${row.conversation ?? ''}\0${row.channel}`
        const msg: BufferedMessage = {
          id: row.id,
          channel: row.channel,
          sender: row.sender,
          conversation: row.conversation,
          payload: row.payload,
          receivedAt: String(row.received_at),
          priority: row.priority,
          routed: row.routed === 1,
        }
        const arr = groups.get(key)
        if (arr) {
          arr.push(msg)
        } else {
          groups.set(key, [msg])
        }
      }

      const batches: MessageBatch[] = []
      for (const msgs of groups.values()) {
        batches.push({
          channel: msgs[0].channel,
          conversation: msgs[0].conversation,
          messages: msgs,
        })
      }

      return batches
    },

    markRouted(ids: number[]): void {
      const txn = db.transaction((ids: number[]) => {
        for (const id of ids) {
          markRoutedStmt.run(id)
        }
      })
      txn(ids)
    },

    cleanup(retentionDays: number): number {
      const cutoff = Date.now() - retentionDays * 86400000
      const result = cleanupStmt.run(cutoff)
      return result.changes
    },
  }
}
