import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { applySchema } from './schema.js'

export function initDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'koshi.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  applySchema(db)
  return db
}

export function closeDatabase(db: Database.Database): void {
  db.close()
}
