import type Database from 'better-sqlite3'

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_hit_at DATETIME,
  score INTEGER DEFAULT 0,
  session_id TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  source,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags, source) VALUES (new.id, new.content, new.tags, new.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, source) VALUES ('delete', old.id, old.content, old.tags, old.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags, source) VALUES ('delete', old.id, old.content, old.tags, old.source);
  INSERT INTO memories_fts(rowid, content, tags, source) VALUES (new.id, new.content, new.tags, new.source);
END;

CREATE TABLE IF NOT EXISTS memories_archive (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_hit_at DATETIME,
  score INTEGER DEFAULT 0,
  session_id TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  template TEXT,
  source TEXT,
  route_match TEXT,
  agent_run_id TEXT,
  project TEXT,
  blocked_by TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  completed_at DATETIME,
  result TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  agent_run_id TEXT NOT NULL,
  template TEXT,
  model TEXT,
  status TEXT,
  started_at DATETIME,
  finished_at DATETIME,
  result TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME,
  model TEXT,
  type TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS buffer (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  sender TEXT,
  conversation TEXT,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  priority INTEGER DEFAULT 50,
  routed INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_buffer_unrouted ON buffer(routed, priority DESC, received_at);
CREATE INDEX IF NOT EXISTS idx_buffer_conversation ON buffer(conversation, received_at);
CREATE INDEX IF NOT EXISTS idx_buffer_retention ON buffer(routed, received_at);

CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY,
  agent_run_id TEXT,
  session_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  model TEXT,
  cost_usd REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`

export function applySchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)
}
