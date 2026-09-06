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
  created_by TEXT,
  source TEXT DEFAULT 'trueforge'
);
CREATE TABLE IF NOT EXISTS turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT,
  completed_at TEXT,
  status TEXT,
  error TEXT,
  ingested INTEGER DEFAULT 0,
  pending_actions INTEGER DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE IF NOT EXISTS cursors (
  source TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (source, key)
);
`);

// Migrations for databases created before these columns existed.
for (const sql of [
  `ALTER TABLE turns ADD COLUMN pending_actions INTEGER DEFAULT 0`,
  `ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'trueforge'`,
]) {
  try {
    db.exec(sql);
  } catch {
    // column already exists
  }
}

export const upsertSession = db.prepare(`
  INSERT INTO sessions (id, agent_name, title, created_at, updated_at, created_by, source)
  VALUES (@id, @agent_name, @title, @created_at, @updated_at, @created_by, @source)
  ON CONFLICT(id) DO UPDATE SET title=@title, updated_at=MAX(COALESCE(updated_at,''), @updated_at)
`);

export const sessionSource = db.prepare(`SELECT source FROM sessions WHERE id = ?`);

const getCursorStmt = db.prepare(`SELECT state FROM cursors WHERE source = ? AND key = ?`);
const setCursorStmt = db.prepare(
  `INSERT INTO cursors (source, key, state) VALUES (?, ?, ?)
   ON CONFLICT(source, key) DO UPDATE SET state=excluded.state`,
);
export function getCursor<T>(source: string, key: string): T | undefined {
  const row = getCursorStmt.get(source, key) as { state: string } | undefined;
  return row ? JSON.parse(row.state) : undefined;
}
export function setCursor(source: string, key: string, state: unknown) {
  setCursorStmt.run(source, key, JSON.stringify(state));
}

// Newest turn that had started by `iso`; used to attach subagent events to
// the parent turn that was open when the subagent was spawned.
const turnAtStmt = db.prepare(
  `SELECT id FROM turns WHERE session_id = ? AND created_at <= ? ORDER BY created_at DESC, id DESC LIMIT 1`,
);
export function turnAt(sessionId: string, iso: string): string | undefined {
  return (turnAtStmt.get(sessionId, iso) as { id: string } | undefined)?.id;
}

// Local harnesses never write a terminal marker when their process is killed
// mid-turn, so a turn idle for 30 minutes is closed as done. Adapters reopen
// it if records arrive later (a long tool run writes nothing meanwhile).
const sweepStmt = db.prepare(`
  UPDATE turns SET status = 'done',
    completed_at = (SELECT updated_at FROM sessions s WHERE s.id = turns.session_id)
  WHERE status = 'running'
    AND session_id IN (
      SELECT id FROM sessions
      WHERE source != 'trueforge' AND strftime('%s','now') - strftime('%s', updated_at) > 1800
    )
`);
export function sweepStaleTurns() {
  return sweepStmt.run().changes;
}

export const upsertTurn = db.prepare(`
  INSERT INTO turns (id, session_id, created_at, completed_at, status, error, ingested, pending_actions)
  VALUES (@id, @session_id, @created_at, @completed_at, @status, @error, @ingested, @pending_actions)
  ON CONFLICT(id) DO UPDATE SET completed_at=@completed_at, status=@status, error=@error, ingested=@ingested, pending_actions=@pending_actions
`);

export const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO events (id, session_id, turn_id, thread_id, type, created_at, raw)
  VALUES (@id, @session_id, @turn_id, @thread_id, @type, @created_at, @raw)
`);

// For sources that mutate records in place after first write (OpenCode).
export const upsertEvent = db.prepare(`
  INSERT INTO events (id, session_id, turn_id, thread_id, type, created_at, raw)
  VALUES (@id, @session_id, @turn_id, @thread_id, @type, @created_at, @raw)
  ON CONFLICT(id) DO UPDATE SET raw=excluded.raw, created_at=excluded.created_at
`);

// TrueForge wraps MCP tool failures as a content string starting with {"error"
// (prefix match, not %error%, so tool output that merely quotes an error is
// not flagged). Other adapters set a normalized raw.error flag instead.
// `s` is the sessions row of the enclosing query.
const TOOL_ERROR = `e.type = 'tool.response' AND (json_extract(e.raw,'$.error') = 1 OR (s.source = 'trueforge' AND json_extract(e.raw,'$.content') LIKE '{"error"%'))`;

// Per-session rollup: turn counts/status, duration, tokens, tool calls.
export function sessionSummaries() {
  return db
    .prepare(
      `
    SELECT s.*,
      (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id) AS turn_count,
      (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'error') AS error_turns,
      (SELECT MAX(t.status='running') FROM turns t WHERE t.session_id = s.id) AS running,
      -- A turn paused on approval reports status 'done'; only the newest turn's
      -- pending actions are still actionable (a resolution creates a new turn).
      (SELECT t.pending_actions FROM turns t WHERE t.session_id = s.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) AS pending_approvals,
      (SELECT e.created_at FROM events e
       WHERE e.session_id = s.id AND e.type = 'tool.approval_required'
       AND e.turn_id = (SELECT t2.id FROM turns t2 WHERE t2.session_id = s.id AND t2.pending_actions > 0 ORDER BY t2.created_at DESC, t2.id DESC LIMIT 1)
       ORDER BY e.created_at ASC LIMIT 1) AS approval_since,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'tool.response') AS tool_calls,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND ${TOOL_ERROR}) AS tool_errors,
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
    // Order by created_at like the ingest fetch, id as tie-breaker (ids are
    // time-sortable ULIDs today, but that is not part of the API contract).
    // Untimestamped events sort last instead of jumping to the front.
    .prepare(`SELECT id, turn_id, thread_id, type, created_at, raw FROM events WHERE session_id = ? ORDER BY created_at IS NULL, created_at, id`)
    .all(sessionId) as { id: string; turn_id: string; thread_id: string | null; type: string; created_at: string | null; raw: string }[];
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
      SUM(
        ((SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status='error') > 0)
        OR
        ((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND ${TOOL_ERROR}) > 0)
      ) AS sessions_with_errors
    FROM sessions s GROUP BY agent_name ORDER BY sessions DESC
  `,
    )
    .all();
}
