import Database from "better-sqlite3";

export const db = new Database(process.env.AGENTLENS_DB ?? "agentlens.db");
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_name TEXT,
  title TEXT,
  created_at TEXT,
  updated_at TEXT,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT,
  completed_at TEXT,
  status TEXT,
  error TEXT,
  ingested INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT,
  raw TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
`);

export const upsertSession = db.prepare(`
  INSERT INTO sessions (id, agent_name, title, created_at, updated_at, created_by)
  VALUES (@id, @agent_name, @title, @created_at, @updated_at, @created_by)
  ON CONFLICT(id) DO UPDATE SET title=@title, updated_at=@updated_at
`);

export const upsertTurn = db.prepare(`
  INSERT INTO turns (id, session_id, created_at, completed_at, status, error, ingested)
  VALUES (@id, @session_id, @created_at, @completed_at, @status, @error, @ingested)
  ON CONFLICT(id) DO UPDATE SET completed_at=@completed_at, status=@status, error=@error, ingested=@ingested
`);

export const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, session_id, turn_id, thread_id, type, created_at, raw)
  VALUES (@id, @session_id, @turn_id, @thread_id, @type, @created_at, @raw)
`);

// Per-session rollup: turn counts/status, duration, tokens, tool calls.
export function sessionSummaries() {
  return db
    .prepare(
      `
    SELECT s.*,
      (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
      (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'error') AS error_turns,
      (SELECT MAX(t.status='running') FROM turns t WHERE t.session_id = s.id) AS running,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'tool.response') AS tool_calls,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'thread.created') AS subagents,
      (SELECT SUM(json_extract(e.raw,'$.usage.inputTokens')) FROM events e WHERE e.session_id = s.id AND e.type='model.message') AS input_tokens,
      (SELECT SUM(json_extract(e.raw,'$.usage.outputTokens')) FROM events e WHERE e.session_id = s.id AND e.type='model.message') AS output_tokens,
      (SELECT SUM(strftime('%s', t.completed_at) - strftime('%s', t.created_at)) FROM turns t WHERE t.session_id = s.id AND t.completed_at IS NOT NULL) AS total_seconds
    FROM sessions s
    ORDER BY s.updated_at DESC
  `,
    )
    .all() as Record<string, unknown>[];
}

export function sessionTrace(sessionId: string) {
  const session = db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId);
  const turns = db
    .prepare(`SELECT * FROM turns WHERE session_id = ? ORDER BY created_at`)
    .all(sessionId);
  const events = db
    .prepare(`SELECT id, turn_id, thread_id, type, created_at, raw FROM events WHERE session_id = ? ORDER BY id`)
    .all(sessionId) as { raw: string }[];
  return {
    session,
    turns,
    events: events.map((e) => ({ ...e, raw: JSON.parse(e.raw) })),
  };
}

export function agentSummaries() {
  return db
    .prepare(
      `
    SELECT agent_name,
      COUNT(*) AS sessions,
      SUM((SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status='error') > 0) AS sessions_with_errors
    FROM sessions s GROUP BY agent_name ORDER BY sessions DESC
  `,
    )
    .all();
}
