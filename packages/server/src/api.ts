import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { client } from "./collector.js";
import { agentSummaries, db, sessionSummaries, sessionTrace } from "./db.js";

export const app = new Hono();
// Local demo tool: only the dashboard (and same-origin/non-browser clients,
// which send no Origin) may call the API cross-origin.
const ALLOWED_ORIGINS = (process.env.AGENTLENS_CORS_ORIGIN ?? "http://localhost:5173").split(",");
app.use("*", cors({ origin: (o) => (ALLOWED_ORIGINS.includes(o) ? o : null) }));

app.get("/api/agents", (c) => c.json(agentSummaries()));
app.get("/api/reports", (c) =>
  c.json(db.prepare(`SELECT * FROM reports ORDER BY id DESC`).all()),
);
app.get("/api/sessions", (c) => c.json(sessionSummaries()));
app.get("/api/sessions/:id", (c) => c.json(sessionTrace(c.req.param("id"))));

// Live tail: proxy TrueForge's per-turn SSE stream to the browser.
app.get("/api/sessions/:id/turns/:turnId/live", (c) =>
  streamSSE(c, async (stream) => {
    const events = await client.sessions.subscribeToTurn(
      c.req.param("id"),
      c.req.param("turnId"),
    );
    for await (const ev of events) {
      await stream.writeSSE({ data: JSON.stringify(ev) });
      if ((ev as any).type === "turn.done") break;
    }
  }),
);

// Kick off the investigator agent on a suspect session.
app.post("/api/investigate", async (c) => {
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
  const { tool_call_id, thread_id, allow } = await c.req.json();
  const { data: turn } = await client.sessions.createTurn(c.req.param("id"), {
    input: [
      {
        type: "user.tool_approval",
        toolCallId: tool_call_id,
        threadId: thread_id,
        approval: { status: allow ? "allow" : "deny" },
      },
    ],
  });
  return c.json({ turn_id: turn.id });
});
