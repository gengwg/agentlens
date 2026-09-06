import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { agentSummaries, db, sessionSource, sessionSummaries, sessionTrace } from "./db.js";
import { closeTurn, ensureSession, openTurn, putEvent, touch } from "./sources/emit.js";
import { active } from "./sources/index.js";
import { client, trueforgeOk } from "./sources/trueforge.js";

export const app = new Hono();
// Local demo tool: only the dashboard (and same-origin/non-browser clients,
// which send no Origin) may call the API cross-origin.
const ALLOWED_ORIGINS = (process.env.AGENTLENS_CORS_ORIGIN ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim());
app.use("*", cors({ origin: (o) => (ALLOWED_ORIGINS.includes(o) ? o : null) }));

app.get("/api/agents", (c) => c.json(agentSummaries()));
app.get("/api/reports", (c) =>
  c.json(db.prepare(`SELECT * FROM reports ORDER BY id DESC`).all()),
);
app.get("/api/sessions", (c) => c.json(sessionSummaries()));
app.get("/api/sessions/:id", (c) => c.json(sessionTrace(c.req.param("id"))));
app.get("/api/sources", (c) => c.json(active.map((s) => ({ name: s.name, ...s.status() }))));

// Generic ingest for harnesses without a file adapter: any client posts
// sessions, turns, and events already in the normalized vocabulary. Idempotent
// by id, so shippers can resend. See README "Bring your own harness".
app.post("/api/ingest", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const source = typeof body?.source === "string" && /^[a-z0-9][a-z0-9_.-]{0,31}$/i.test(body.source) ? body.source : null;
  if (!source) return c.json({ error: "source is required (letters, digits, - _ .)" }, 400);
  const sessions: any[] = body.sessions ?? [];
  const turns: any[] = body.turns ?? [];
  const events: any[] = body.events ?? [];
  const bad = [...sessions, ...turns, ...events].find((x) => !x || typeof x.id !== "string" || !x.id);
  if (bad !== undefined) return c.json({ error: "every session, turn, and event needs a string id" }, 400);
  try {
    db.transaction(() => {
      for (const s of sessions) {
        ensureSession({ id: s.id, source, agent_name: String(s.agent_name ?? source), title: s.title ?? null,
          created_at: s.created_at ?? new Date().toISOString(), updated_at: s.updated_at });
        if (s.updated_at) touch(s.id, s.updated_at);
      }
      for (const t of turns) {
        if (typeof t.session_id !== "string") throw new Error(`turn ${t.id}: session_id is required`);
        openTurn(t.id, t.session_id, t.created_at ?? new Date().toISOString());
        if (t.status && t.status !== "running") closeTurn(t.id, String(t.status), t.completed_at ?? null, t.error ?? null);
      }
      for (const e of events) {
        if (typeof e.session_id !== "string" || typeof e.turn_id !== "string" || typeof e.type !== "string")
          throw new Error(`event ${e.id}: session_id, turn_id and type are required`);
        putEvent({ id: e.id, session_id: e.session_id, turn_id: e.turn_id, thread_id: e.thread_id ?? null, type: e.type,
          created_at: e.created_at ?? null, raw: e.raw ?? {} });
        if (e.created_at) touch(e.session_id, e.created_at);
      }
    })();
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  return c.json({ sessions: sessions.length, turns: turns.length, events: events.length });
});

const isTrueforge = (id: string) =>
  (sessionSource.get(id) as { source: string } | undefined)?.source === "trueforge";

// Live tail: proxy TrueForge's per-turn SSE stream to the browser. Other
// sources have no push API; the dashboard's poll covers them. Not gated on
// trueforgeOk(): a 404 is fatal for EventSource, a failed subscribe is not.
app.get("/api/sessions/:id/turns/:turnId/live", (c) => {
  if (!isTrueforge(c.req.param("id"))) return c.json({ error: "live tail is TrueForge-only" }, 404);
  return streamSSE(c, async (stream) => {
    const events = await client.sessions.subscribeToTurn(
      c.req.param("id"),
      c.req.param("turnId"),
    );
    for await (const ev of events) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
      if ((ev as any).type === "turn.done") break;
    }
  });
});

// Kick off the investigator agent on a suspect session.
app.post("/api/investigate", async (c) => {
  if (!trueforgeOk()) return c.json({ error: "TrueForge not reachable" }, 503);
  const { session_id } = await c.req.json().catch(() => ({}) as any);
  const { data: session } = await client.sessions.create({
    agent: { name: "investigator" },
  });
  const prompt = session_id
    ? `Investigate session ${session_id}. Use get_session_trace first.`
    : "Triage the fleet: call list_problem_sessions, investigate the worst offenders in parallel with subagents, then produce one incident report.";
  const { data: turn } = await client.sessions.createTurn(session.id, {
    input: [{ type: "user.message", content: prompt }],
  });
  return c.json({ session_id: session.id, turn_id: turn.id });
});

// Approve or deny the investigator's pending tool call (human-in-the-loop gate).
app.post("/api/sessions/:id/approve", async (c) => {
  if (!trueforgeOk()) return c.json({ error: "TrueForge not reachable" }, 503);
  let body: { tool_call_id?: string; thread_id?: string; allow?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body?.tool_call_id) return c.json({ error: "tool_call_id is required" }, 400);
  const { data: turn } = await client.sessions.createTurn(c.req.param("id"), {
    input: [
      {
        type: "user.tool_approval",
        toolCallId: body.tool_call_id,
        threadId: body.thread_id ?? "main",
        approval: { status: body.allow === true ? "allow" : "deny" },
      },
    ],
  });
  return c.json({ turn_id: turn.id });
});
