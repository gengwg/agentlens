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
  raw TEXT NOT NULL,
  seq INTEGER
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
  `ALTER TABLE events ADD COLUMN seq INTEGER`,
]) {
  try {
    db.exec(sql);
  } catch {
    // column already exists
  }
}

// `seq` is bumped on every event write, insert or update, so a shipper can ask
// for what changed since it last looked. created_at cannot answer that: it
// comes from the harness log, so it can arrive out of order, and a source that
// corrects a record in place (OpenCode) keeps the original timestamp.
db.exec(`CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq)`);
db.exec(`UPDATE events SET seq = rowid WHERE seq IS NULL`);
const NEXT_SEQ = `(SELECT IFNULL(MAX(seq), 0) + 1 FROM events)`;

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
  INSERT OR IGNORE INTO events (id, session_id, turn_id, thread_id, type, created_at, raw, seq)
  VALUES (@id, @session_id, @turn_id, @thread_id, @type, @created_at, @raw, ${NEXT_SEQ})
`);

// For sources that mutate records in place after first write (OpenCode).
export const upsertEvent = db.prepare(`
  INSERT INTO events (id, session_id, turn_id, thread_id, type, created_at, raw, seq)
  VALUES (@id, @session_id, @turn_id, @thread_id, @type, @created_at, @raw, ${NEXT_SEQ})
  ON CONFLICT(id) DO UPDATE SET raw=excluded.raw, created_at=excluded.created_at, seq=${NEXT_SEQ}
`);

// TrueForge wraps MCP tool failures as a content string starting with {"error"
// (prefix match, not %error%, so tool output that merely quotes an error is
// not flagged). Other adapters set a normalized raw.error flag instead.
// A tool the user declined is a choice, not a failure, so those are excluded.
// `s` is the sessions row of the enclosing query.
const DENIED = `(json_extract(e.raw,'$.content') LIKE '%Permission for this action was denied%'
  OR json_extract(e.raw,'$.content') LIKE '%doesn''t want to proceed%'
  OR json_extract(e.raw,'$.content') LIKE '%[Request interrupted%'
  OR json_extract(e.raw,'$.content') LIKE '%rejected%')`;
const TOOL_ERROR = `e.type = 'tool.response'
  AND (json_extract(e.raw,'$.error') = 1 OR (s.source = 'trueforge' AND json_extract(e.raw,'$.content') LIKE '{"error"%'))
  AND NOT ${DENIED}`;

// A fleet of a few thousand sessions makes the unfiltered rollup slow and the
// response large, so the table asks for one page and the server does the
// matching. `filter` uses EXISTS rather than the computed columns below, which
// would force the rollup over every session before discarding most of them.
const MATCH = {
  errors: `EXISTS (SELECT 1 FROM turns t WHERE t.session_id = s.id AND t.status = 'error')`,
  toolErrors: `EXISTS (SELECT 1 FROM events e WHERE e.session_id = s.id AND ${TOOL_ERROR})`,
  approval: `(SELECT t.pending_actions FROM turns t WHERE t.session_id = s.id ORDER BY t.created_at DESC, t.id DESC LIMIT 1) > 0`,
} as const;

// Recency buries the interesting sessions once a cron job is in the fleet, so a
// session can also be ranked by how much it looks like it went wrong. Weights
// are blunt on purpose: a failed turn dominates, repeated tool failures matter
// next, then a long stall inside the session, then an unusual number of tool
// calls per turn (the shape of a loop). Each term is capped so one signal cannot
// swamp the rest, and every part reuses the predicates the UI already uses.
const PROBLEM_SCORE = `
  (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status = 'error') * 50
  + MIN((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND ${TOOL_ERROR}), 20) * 5
  + MIN(COALESCE((SELECT MAX(gap) FROM (
      SELECT strftime('%s', e.created_at) - LAG(strftime('%s', e.created_at)) OVER (ORDER BY e.created_at) gap
      FROM events e WHERE e.session_id = s.id AND e.created_at IS NOT NULL)), 0) / 60, 30)
  + MIN(MAX((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'tool.response')
      / MAX((SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id), 1) - 10, 0), 30)`;

export type SessionQuery = {
  limit?: number;
  q?: string;
  filter?: keyof typeof MATCH | null;
  sort?: "recent" | "score";
};

function where(opts: SessionQuery) {
  const parts: string[] = [];
  if (opts.q) parts.push(`(s.id LIKE @like OR s.agent_name LIKE @like OR s.title LIKE @like OR s.source LIKE @like)`);
  if (opts.filter && MATCH[opts.filter]) parts.push(MATCH[opts.filter]);
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", like: `%${opts.q ?? ""}%` };
}

export function sessionCount(opts: SessionQuery = {}) {
  const w = where(opts);
  return (db.prepare(`SELECT COUNT(*) n FROM sessions s ${w.sql}`).get({ like: w.like }) as { n: number }).n;
}

// Tokens that went in, however the adapter reported them: rows written before
// cache was split out folded it into inputTokens, so summing all three keeps
// the number continuous across that change.
const TOKENS_IN = `COALESCE(json_extract(e.raw,'$.usage.inputTokens'),0)
  + COALESCE(json_extract(e.raw,'$.usage.cacheReadTokens'),0)
  + COALESCE(json_extract(e.raw,'$.usage.cacheWriteTokens'),0)`;

// Per-session rollup: turn counts/status, duration, tokens, tool calls.
export function sessionSummaries(opts: SessionQuery = {}) {
  const w = where(opts);
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
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'tool.response' AND ${DENIED}) AS tool_denials,
      (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.type = 'thread.created') AS subagents,
      (SELECT SUM(${TOKENS_IN}) FROM events e WHERE e.session_id = s.id AND e.type='model.message') AS input_tokens,
      (SELECT SUM(json_extract(e.raw,'$.usage.outputTokens')) FROM events e WHERE e.session_id = s.id AND e.type='model.message') AS output_tokens,
      (SELECT SUM(strftime('%s', t.completed_at) - strftime('%s', t.created_at)) FROM turns t WHERE t.session_id = s.id AND t.completed_at IS NOT NULL) AS total_seconds,
      ${PROBLEM_SCORE} AS problem_score
    FROM sessions s
    ${w.sql}
    ORDER BY ${opts.sort === "score" ? "problem_score DESC, s.updated_at DESC" : "s.updated_at DESC"}
    ${opts.limit ? "LIMIT @limit" : ""}
  `,
    )
    .all({ like: w.like, ...(opts.limit ? { limit: opts.limit } : {}) }) as Record<string, unknown>[];
}

// The header stats cover the whole fleet, so they are aggregates rather than a
// sum over the page the table happens to be showing.
export function fleetTotals() {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number | null }).n ?? 0;
  return {
    sessions: one(`SELECT COUNT(*) n FROM sessions`),
    errors: one(`SELECT COUNT(DISTINCT session_id) n FROM turns WHERE status = 'error'`),
    toolErrors: one(`SELECT COUNT(DISTINCT e.session_id) n FROM events e JOIN sessions s ON s.id = e.session_id WHERE ${TOOL_ERROR}`),
    approvals: one(`SELECT COUNT(*) n FROM sessions s WHERE ${MATCH.approval}`),
    tools: one(`SELECT COUNT(*) n FROM events WHERE type = 'tool.response'`),
    tokens: one(`SELECT SUM(${TOKENS_IN}) + SUM(COALESCE(json_extract(e.raw,'$.usage.outputTokens'),0)) n
      FROM events e WHERE e.type = 'model.message'`),
  };
}

// One pass per series for the Prometheus endpoint. Grouped by source, agent and
// model only: labelling by session or turn would make the cardinality unbounded.
// Reuses TOOL_ERROR/DENIED so a tool error counts the same here as in the UI.
export function fleetMetrics() {
  const rows = <T>(sql: string) => db.prepare(sql).all() as T[];
  return {
    sessions: rows<{ source: string; agent: string; n: number }>(
      `SELECT source, COALESCE(agent_name,'?') agent, COUNT(*) n FROM sessions GROUP BY source, agent`,
    ),
    turns: rows<{ source: string; agent: string; n: number; errors: number; running: number }>(`
      SELECT s.source, COALESCE(s.agent_name,'?') agent, COUNT(*) n,
        SUM(t.status = 'error') errors, SUM(t.status = 'running') running
      FROM turns t JOIN sessions s ON s.id = t.session_id GROUP BY s.source, agent`),
    tools: rows<{ source: string; agent: string; total: number; errors: number; denied: number }>(`
      SELECT s.source, COALESCE(s.agent_name,'?') agent, COUNT(*) total,
        SUM(CASE WHEN ${TOOL_ERROR} THEN 1 ELSE 0 END) errors,
        SUM(CASE WHEN ${DENIED} THEN 1 ELSE 0 END) denied
      FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.type = 'tool.response' GROUP BY s.source, agent`),
    // Split out for Grafana, since cache reads are most of the volume and a
    // fraction of the price.
    tokens: rows<{ source: string; agent: string; model: string; input: number; output: number; cache_read: number; cache_write: number }>(`
      SELECT s.source, COALESCE(s.agent_name,'?') agent,
        COALESCE(json_extract(e.raw,'$.model'),'unknown') model,
        COALESCE(SUM(json_extract(e.raw,'$.usage.inputTokens')), 0) input,
        COALESCE(SUM(json_extract(e.raw,'$.usage.outputTokens')), 0) output,
        COALESCE(SUM(json_extract(e.raw,'$.usage.cacheReadTokens')), 0) cache_read,
        COALESCE(SUM(json_extract(e.raw,'$.usage.cacheWriteTokens')), 0) cache_write
      FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.type = 'model.message' GROUP BY s.source, agent, model`),
    // OpenCode reports cost twice, per message and again summed on turn.done, so
    // a session takes its turn totals when it has them and its message costs
    // otherwise. Only what a harness reports is counted; nothing is priced here.
    cost: rows<{ source: string; agent: string; usd: number }>(`
      SELECT source, agent, SUM(usd) usd FROM (
        SELECT s.source source, COALESCE(s.agent_name,'?') agent,
          COALESCE(
            NULLIF((SELECT SUM(json_extract(e.raw,'$.state.metrics.totalCostInUsd'))
                    FROM events e WHERE e.session_id = s.id AND e.type = 'turn.done'), 0),
            (SELECT SUM(json_extract(e.raw,'$.cost'))
             FROM events e WHERE e.session_id = s.id AND e.type = 'model.message'),
            0) usd
        FROM sessions s
      ) GROUP BY source, agent`),
    approvals: rows<{ source: string; n: number }>(
      `SELECT source, COUNT(*) n FROM sessions s WHERE ${MATCH.approval} GROUP BY source`,
    ),
    // Cumulative bucket counts, which is the shape a Prometheus histogram wants.
    duration: rows<{ source: string; le1: number; le5: number; le15: number; le60: number; le300: number; total: number; sum: number }>(`
      SELECT s.source,
        SUM(d <= 1) le1, SUM(d <= 5) le5, SUM(d <= 15) le15, SUM(d <= 60) le60, SUM(d <= 300) le300,
        COUNT(*) total, COALESCE(SUM(d), 0) sum
      FROM (SELECT session_id, strftime('%s', completed_at) - strftime('%s', created_at) d
            FROM turns WHERE completed_at IS NOT NULL) x
      JOIN sessions s ON s.id = x.session_id GROUP BY s.source`),
  };
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
      SUM((SELECT COUNT(*) FROM turns t WHERE t.session_id = s.id AND t.status='error') > 0) AS sessions_with_errors,
      SUM((SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND ${TOOL_ERROR}) > 0) AS sessions_with_tool_errors
    FROM sessions s GROUP BY agent_name ORDER BY sessions DESC
  `,
    )
    .all();
}
