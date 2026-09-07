import { userInfo } from "node:os";
import { db, upsertEvent, upsertSession } from "../db.js";

// Small write helpers shared by adapters that produce the normalized
// vocabulary directly (dsh, codex, gemini, roo, the ingest API).

export const MAX_TOOL_OUTPUT = 64 * 1024;

const sessionExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
const setTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ? AND (title IS NULL OR title = '')`);
const touchStmt = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ? AND updated_at < ?`);
const openTurnStmt = db.prepare(
  `INSERT OR IGNORE INTO turns (id, session_id, created_at, status, ingested) VALUES (?, ?, ?, 'running', 1)`,
);
const closeTurnStmt = db.prepare(
  `UPDATE turns SET status = ?, completed_at = COALESCE(?, (SELECT MAX(created_at) FROM events e WHERE e.turn_id = turns.id)), error = ? WHERE id = ?`,
);
const closeOpenTurnsStmt = db.prepare(`
  UPDATE turns SET status = 'done',
    completed_at = (SELECT MAX(created_at) FROM events e WHERE e.turn_id = turns.id)
  WHERE session_id = ? AND status = 'running' AND created_at < ?
`);

export function ensureSession(s: {
  id: string;
  source: string;
  agent_name: string;
  title?: string | null;
  created_at: string;
  updated_at?: string;
  cwd?: string | null;
  branch?: string | null;
}) {
  if (sessionExists.get(s.id)) {
    if (s.title) setTitle.run(s.title, s.id);
    return;
  }
  upsertSession.run({
    id: s.id,
    agent_name: s.agent_name,
    title: s.title ?? null,
    created_at: s.created_at,
    updated_at: s.updated_at ?? s.created_at,
    created_by: userInfo().username,
    source: s.source,
    cwd: s.cwd,
    branch: s.branch,
  });
}

export const touch = (sessionId: string, at: string) => touchStmt.run(at, sessionId, at);
export const openTurn = (id: string, sessionId: string, at: string) => openTurnStmt.run(id, sessionId, at);
export const closeTurn = (id: string, status: string, at: string | null, error: string | null = null) =>
  closeTurnStmt.run(status, at, error, id);
// Harnesses without a terminal marker: a new prompt ends whatever was running.
export const closeOpenTurns = (sessionId: string, before: string) => closeOpenTurnsStmt.run(sessionId, before);

export function putEvent(e: {
  id: string;
  session_id: string;
  turn_id: string;
  thread_id?: string | null;
  type: string;
  created_at: string | null;
  raw: unknown;
}) {
  upsertEvent.run({
    id: e.id,
    session_id: e.session_id,
    turn_id: e.turn_id,
    thread_id: e.thread_id ?? null,
    type: e.type,
    created_at: e.created_at,
    raw: JSON.stringify(e.raw),
  });
}

export const iso = (ms: number | string | Date) => new Date(ms).toISOString();

// Cache reads cost a fraction of fresh input and cache writes cost more, so the
// three are kept apart instead of summed into one number; folding them together
// makes cost impossible to work out later. A total is input + output + cache.
// Rows written before this split folded cache into inputTokens, so that total
// stays continuous across the change.
export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export const usageOf = (u: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): Usage => {
  const out: Usage = { inputTokens: u.input ?? 0, outputTokens: u.output ?? 0 };
  if (u.cacheRead) out.cacheReadTokens = u.cacheRead;
  if (u.cacheWrite) out.cacheWriteTokens = u.cacheWrite;
  return out;
};
// Flatten message content (string, or an array of blocks) to display text.
// Images become a placeholder; thinking/reasoning blocks are dropped.
export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return content
    .map((b: any) => {
      if (typeof b === "string") return b;
      if (b?.type === "image") return "[image]";
      if (b?.type === "thinking" || b?.type === "reasoning") return "";
      const t = b?.text ?? b?.content ?? "";
      return typeof t === "string" ? t : JSON.stringify(t);
    })
    .filter(Boolean)
    .join("\n");
};
