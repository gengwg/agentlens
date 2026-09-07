import type { Database } from "better-sqlite3";
import { userInfo } from "node:os";
import { basename } from "node:path";
import { db, getCursor, insertEvent, setCursor, turnAt, upsertEvent, upsertSession } from "../db.js";
import { usageOf } from "./emit.js";
import type { Source } from "./types.js";
import { maskText } from "../redact-secrets.js";

// OpenCode keeps its state in SQLite (session / message / part tables, JSON in
// `data`). Rows are updated in place while a step runs, so events are upserted
// and the cursor overlaps by a few seconds. Child sessions (parent_id set) are
// shown as subagent threads of the parent.

const SOURCE = "opencode";
const OVERLAP_MS = 5000;
const MAX_TOOL_OUTPUT = 64 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();

const insertTurn = db.prepare(
  `INSERT OR IGNORE INTO turns (id, session_id, created_at, status, ingested) VALUES (?, ?, ?, 'running', 1)`,
);
const setTurnState = db.prepare(`UPDATE turns SET status = ?, completed_at = ?, error = ? WHERE id = ?`);
// A new prompt aborts whatever was still running; OpenCode leaves no marker.
const closeEarlier = db.prepare(`
  UPDATE turns SET status = 'done',
    completed_at = COALESCE((SELECT MAX(created_at) FROM events e WHERE e.turn_id = turns.id), ?)
  WHERE session_id = ? AND status = 'running' AND created_at < ?
`);
const touchSession = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ? AND updated_at < ?`);

type Row = { id: string; session_id: string; time_created: number; time_updated: number; data: any };

export function createOpenCode(src: Database): Source {
  // No index on time_updated in OpenCode's schema; a full scan of a few
  // thousand rows every tick is fine for a local DB.
  const changedSessions = src.prepare(
    `SELECT id, parent_id, directory, title, time_created, time_updated FROM session WHERE time_updated > ?`,
  );
  // Time order matters: a parent's user message must create its turn before
  // replies (and child-session messages) attach to it.
  const changedMessages = src.prepare(
    `SELECT id, time_updated FROM message WHERE id IN (
       SELECT id FROM message WHERE time_updated > ?
       UNION SELECT message_id FROM part WHERE time_updated > ?)
     ORDER BY time_created, id`,
  );
  const getMessage = src.prepare(`SELECT id, session_id, time_created, time_updated, data FROM message WHERE id = ?`);
  const getParts = src.prepare(`SELECT id, time_created, time_updated, data FROM part WHERE message_id = ? ORDER BY time_created, id`);
  const getSession = src.prepare(`SELECT id, parent_id FROM session WHERE id = ?`);
  const repliesTo = src.prepare(
    `SELECT data FROM message WHERE session_id = ? AND json_extract(data,'$.parentID') = ? ORDER BY time_created`,
  );
  const maxTs = src.prepare(
    `SELECT MAX(t) AS t FROM (SELECT MAX(time_updated) t FROM session UNION ALL SELECT MAX(time_updated) FROM message UNION ALL SELECT MAX(time_updated) FROM part)`,
  );

  // Child sessions can nest; events always land on the root session.
  function rootOf(id: string): string | undefined {
    const start = id;
    for (let i = 0; i < 10; i++) {
      const s = getSession.get(id) as { id: string; parent_id: string | null } | undefined;
      if (!s) return undefined;
      if (!s.parent_id) return s.id;
      id = s.parent_id;
    }
    console.error(`opencode: session ${start} nests deeper than 10 parents; skipped`);
    return undefined;
  }

  // Returns false when the row must be retried next tick.
  function ingestMessage(id: string): boolean {
    const m = getMessage.get(id) as Row | undefined;
    if (!m) return true;
    const data = JSON.parse(m.data);
    const sessionId = rootOf(m.session_id);
    if (!sessionId) return true;
    const threadId = sessionId === m.session_id ? null : m.session_id;
    const parts = (getParts.all(m.id) as Row[]).map((p) => ({ ...p, data: JSON.parse(p.data) }));
    const text = parts.filter((p) => p.data.type === "text").map((p) => p.data.text).join("\n");
    const at = iso(data.time?.created ?? m.time_created);

    if (data.role === "user") {
      if (threadId) return true; // a child session's prompt is the parent's task call
      closeEarlier.run(at, sessionId, at);
      insertTurn.run(`oc:${m.id}`, sessionId, at);
      upsertEvent.run({
        id: `oc:${m.id}`,
        session_id: sessionId,
        turn_id: `oc:${m.id}`,
        thread_id: null,
        type: "turn.created",
        created_at: at,
        raw: JSON.stringify({ input: [{ type: "user.message", content: text }] }),
      });
      touchSession.run(at, sessionId, at);
      return true;
    }

    const turnId = threadId ? turnAt(sessionId, at) : `oc:${data.parentID}`;
    if (!turnId) return false; // parent turn not ingested yet, retry next tick
    const tools = parts.filter((p) => p.data.type === "tool");
    const tk = data.tokens ?? {};
    upsertEvent.run({
      id: `oc:${m.id}`,
      session_id: sessionId,
      turn_id: turnId,
      thread_id: threadId,
      type: "model.message",
      created_at: at,
      raw: JSON.stringify({
        content: text,
        toolCalls: tools.map((p) => ({
          id: p.data.callID,
          function: { name: p.data.tool, arguments: JSON.stringify(p.data.state?.input ?? {}) },
        })),
        usage: usageOf({
          input: tk.input,
          output: (tk.output ?? 0) + (tk.reasoning ?? 0),
          cacheRead: tk.cache?.read,
          cacheWrite: tk.cache?.write,
        }),
        model: data.modelID,
        cost: data.cost,
      }),
    });
    for (const p of tools) {
      const st = p.data.state ?? {};
      if (st.status !== "completed" && st.status !== "error") continue;
      upsertEvent.run({
        id: `oc:${p.id}`,
        session_id: sessionId,
        turn_id: turnId,
        thread_id: threadId,
        type: "tool.response",
        created_at: iso(st.time?.end ?? p.time_updated),
        raw: JSON.stringify({
          content: String(st.output ?? st.error ?? "").slice(0, MAX_TOOL_OUTPUT),
          toolCallId: p.data.callID,
          error: st.status === "error",
        }),
      });
    }
    const last = iso(data.time?.completed ?? m.time_updated);
    touchSession.run(last, sessionId, last);
    if (!threadId) updateTurn(sessionId, data.parentID);
    return true;
  }

  // Turn status derives from every assistant reply to the user message.
  function updateTurn(sessionId: string, userMsgId: string) {
    const replies = (repliesTo.all(sessionId, userMsgId) as { data: string }[]).map((r) => JSON.parse(r.data));
    if (replies.length === 0) return;
    const latest = replies[replies.length - 1];
    const failed = replies.find((r) => r.error);
    let status = "running";
    let message: string | null = null;
    if (failed) {
      status = failed.error.name === "MessageAbortedError" ? "cancelled" : "error";
      message = status === "error" ? (failed.error.data?.message ?? failed.error.name) : null;
    } else if (latest.time?.completed && latest.finish !== "tool-calls") {
      status = "done";
    }
    if (status === "running") return;
    const completed = iso(Math.max(...replies.map((r) => r.time?.completed ?? r.time?.created ?? 0)));
    setTurnState.run(status, completed, maskText(message), `oc:${userMsgId}`);
    const cost = replies.reduce((n, r) => n + (r.cost ?? 0), 0);
    insertEvent.run({
      id: `oc:${userMsgId}:done`,
      session_id: sessionId,
      turn_id: `oc:${userMsgId}`,
      thread_id: null,
      type: "turn.done",
      created_at: completed,
      raw: JSON.stringify({ state: { status, message, metrics: { totalCostInUsd: cost } } }),
    });
  }

  async function poll() {
    const cursor = getCursor<{ ts: number }>(SOURCE, "db") ?? { ts: 0 };
    const since = cursor.ts - OVERLAP_MS;
    const sessions = changedSessions.all(since) as any[];
    const messages = changedMessages.all(since, since) as { id: string; time_updated: number }[];
    // Rows deferred this tick hold the cursor back so they are seen again.
    let holdBack = Infinity;

    db.transaction(() => {
      for (const s of sessions.filter((s) => !s.parent_id)) {
        upsertSession.run({
          id: s.id,
          agent_name: s.directory ? basename(s.directory) : SOURCE,
          title: s.title,
          created_at: iso(s.time_created),
          updated_at: iso(s.time_updated),
          created_by: userInfo().username,
          source: SOURCE,
          cwd: s.directory,
        });
      }
      for (const m of messages) {
        if (!ingestMessage(m.id)) holdBack = Math.min(holdBack, m.time_updated);
      }
      for (const s of sessions.filter((s) => s.parent_id)) {
        const root = rootOf(s.id);
        const at = iso(s.time_created);
        const turnId = root && turnAt(root, at);
        if (!turnId) {
          holdBack = Math.min(holdBack, s.time_updated);
          continue;
        }
        insertEvent.run({
          id: `oc:thread:${s.id}`,
          session_id: root,
          turn_id: turnId,
          thread_id: s.id,
          type: "thread.created",
          created_at: at,
          raw: JSON.stringify({ title: s.title, threadId: s.id }),
        });
      }
      const t = (maxTs.get() as { t: number | null }).t;
      if (t != null) setCursor(SOURCE, "db", { ts: Math.min(t, holdBack - 1) });
    })();
  }

  return { name: SOURCE, poll, status: () => ({ ok: true, detail: src.name }) };
}
