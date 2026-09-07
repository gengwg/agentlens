import { hostname } from "node:os";
import { db, getCursor, setCursor } from "./db.js";

// Ship session metadata to another AgentLens (see README "Shared server").
// Content never leaves the machine: prompts, replies, tool output, tool
// arguments and titles are dropped here, not at the far end. What travels is
// shape and timing: agent, turn boundaries and status, tool names, token
// counts, error flags.

const HOST = process.env.AGENTLENS_HOST_NAME ?? hostname();
const SHIP_TITLES = process.env.AGENTLENS_SHIP_TITLES === "1";

type Row = Record<string, any>;

// Keep only the fields that carry no user content.
export function redact(type: string, raw: any): unknown {
  switch (type) {
    case "turn.created":
      return { input: [{ type: "user.message", content: "" }] };
    case "model.message":
      return {
        content: "",
        toolCalls: (raw.toolCalls ?? []).map((c: any) => ({
          id: c.id,
          function: { name: c.function?.name ?? c.toolInfo?.name, arguments: "" },
        })),
        usage: raw.usage,
        model: raw.model,
      };
    case "tool.response":
      return { content: "", toolCallId: raw.toolCallId, error: raw.error === true };
    case "thread.created":
      return { title: "subagent", threadId: raw.threadId };
    case "turn.done":
      return { state: { status: raw.state?.status, metrics: raw.state?.metrics } };
    default:
      return {};
  }
}

export function collect(since: string): { sessions: Row[]; turns: Row[]; events: Row[]; watermark: string } {
  // Turns are few and their status changes, so a changed session resends all of
  // them; events are append-only and a long session has thousands, so only the
  // ones written since the last pass go (null timestamps always do).
  const sessions = db
    .prepare(`SELECT * FROM sessions WHERE updated_at > ? ORDER BY updated_at`)
    .all(since) as Row[];
  const ids = sessions.map((s) => s.id);
  if (!ids.length) return { sessions: [], turns: [], events: [], watermark: since };
  const list = ids.map(() => "?").join(",");
  const turns = db.prepare(`SELECT * FROM turns WHERE session_id IN (${list})`).all(...ids) as Row[];
  const events = db
    .prepare(
      `SELECT id, session_id, turn_id, thread_id, type, created_at, raw FROM events
       WHERE session_id IN (${list}) AND (created_at > ? OR created_at IS NULL)`,
    )
    .all(...ids, since) as Row[];
  return {
    sessions: sessions.map((s) => ({
      id: `${HOST}:${s.id}`,
      // The machine is part of the agent so one fleet view can separate them.
      agent_name: `${HOST}/${s.agent_name ?? "?"}`,
      title: SHIP_TITLES ? s.title : null,
      created_at: s.created_at,
      updated_at: s.updated_at,
    })),
    turns: turns.map((t) => ({
      id: `${HOST}:${t.id}`,
      session_id: `${HOST}:${t.session_id}`,
      created_at: t.created_at,
      completed_at: t.completed_at,
      status: t.status,
      // An error message is model or tool text; only the fact travels.
      error: t.error ? "error" : null,
    })),
    events: events.map((e) => ({
      id: `${HOST}:${e.id}`,
      session_id: `${HOST}:${e.session_id}`,
      turn_id: `${HOST}:${e.turn_id}`,
      thread_id: e.thread_id,
      type: e.type,
      created_at: e.created_at,
      raw: redact(e.type, JSON.parse(e.raw)),
    })),
    watermark: sessions[sessions.length - 1].updated_at,
  };
}

// One session's history can be tens of thousands of events; send in chunks so
// a first pass is not a single enormous request.
const CHUNK = 5000;

async function post(url: string, body: unknown) {
  const res = await fetch(new URL("/api/ingest", url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function shipOnce(url: string, source: string) {
  const key = `ship:${url}`;
  const { since } = getCursor<{ since: string }>("ship", key) ?? { since: "" };
  const { sessions, turns, events, watermark } = collect(since);
  if (!sessions.length) return { sessions: 0, turns: 0, events: 0 };
  // Sessions and turns first, so every event has somewhere to land.
  await post(url, { source, sessions, turns, events: events.slice(0, CHUNK) });
  for (let i = CHUNK; i < events.length; i += CHUNK)
    await post(url, { source, events: events.slice(i, i + CHUNK) });
  setCursor("ship", key, { since: watermark });
  return { sessions: sessions.length, turns: turns.length, events: events.length };
}

// `agentlens ship --to <url> [--once] [--interval 60]`
export async function shipMain(argv: string[]) {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const url = arg("--to") ?? process.env.AGENTLENS_SHIP_TO;
  if (!url) {
    console.error("usage: agentlens ship --to http://host:8788 [--once] [--interval 60] [--source name]");
    process.exit(2);
  }
  const source = arg("--source") ?? "shipped";
  const seconds = Number(arg("--interval") ?? 60);
  if (!Number.isFinite(seconds) || seconds < 1) {
    console.error(`ship: --interval must be a number of seconds, got "${arg("--interval")}"`);
    process.exit(2);
  }
  const every = seconds * 1000;
  const run = async () => {
    try {
      const sent = await shipOnce(url, source);
      if (sent.sessions) console.log(`shipped ${sent.sessions} sessions, ${sent.turns} turns, ${sent.events} events to ${url}`);
    } catch (err) {
      console.error(`ship: ${(err as Error).message}`);
    }
  };
  await run();
  if (argv.includes("--once")) return;
  console.log(`shipping metadata to ${url} every ${every / 1000}s (content stays local)`);
  setInterval(run, every);
}
