-- Koshi SQLite Schema

CREATE TABLE IF NOT EXISTS narratives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  memory_ids TEXT NOT NULL DEFAULT '[]',
  previous_narrative_id INTEGER REFERENCES narratives(id),
  topic TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS narratives_fts USING fts5(
  summary,
  topic,
  content=narratives,
  content_rowid=id
);

-- Narratives FTS sync triggers
CREATE TRIGGER IF NOT EXISTS narratives_ai AFTER INSERT ON narratives BEGIN
  INSERT INTO narratives_fts(rowid, summary, topic) VALUES (new.id, new.summary, new.topic);
END;

CREATE TRIGGER IF NOT EXISTS narratives_ad AFTER DELETE ON narratives BEGIN
  INSERT INTO narratives_fts(narratives_fts, rowid, summary, topic) VALUES ('delete', old.id, old.summary, old.topic);
END;

CREATE TRIGGER IF NOT EXISTS narratives_au AFTER UPDATE ON narratives BEGIN
  INSERT INTO narratives_fts(narratives_fts, rowid, summary, topic) VALUES ('delete', old.id, old.summary, old.topic);
  INSERT INTO narratives_fts(rowid, summary, topic) VALUES (new.id, new.summary, new.topic);
END;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_hit_at DATETIME,
  score INTEGER DEFAULT 0,
  session_id TEXT,
  narrative_id INTEGER REFERENCES narratives(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  source,
  content='memories',
  content_rowid='id'
);

-- Memories FTS sync triggers
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  tags TEXT,
  created_at DATETIME,
  last_hit_at DATETIME,
  score INTEGER DEFAULT 0,
  session_id TEXT,
  archived_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_archive_original_id ON memories_archive(original_id);
CREATE INDEX IF NOT EXISTS idx_archive_archived_at ON memories_archive(archived_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_archive_fts USING fts5(
  content,
  tags,
  source,
  content='memories_archive',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_archive_ai AFTER INSERT ON memories_archive BEGIN
  INSERT INTO memories_archive_fts(rowid, content, tags, source) VALUES (new.id, new.content, new.tags, new.source);
END;

CREATE TRIGGER IF NOT EXISTS memories_archive_ad AFTER DELETE ON memories_archive BEGIN
  INSERT INTO memories_archive_fts(memories_archive_fts, rowid, content, tags, source) VALUES ('delete', old.id, old.content, old.tags, old.source);
END;

DROP TABLE IF EXISTS task_runs;
DROP TABLE IF EXISTS agent_results;
DROP TABLE IF EXISTS tasks;

CREATE TABLE IF NOT EXISTS agent_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id),
  skill_used TEXT,
  output TEXT NOT NULL,
  memory_ids TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  title TEXT NOT NULL,
  context TEXT,
  skill TEXT,
  depends_on TEXT DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'blocked', 'running', 'completed', 'failed')),
  agent_result_id INTEGER REFERENCES agent_results(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
