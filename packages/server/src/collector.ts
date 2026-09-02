import { TrueForge } from "@truefoundry/trueforge-sdk";
import { db, insertEvent, upsertSession, upsertTurn } from "./db.js";

export const TRUEFORGE_URL = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
export const client = new TrueForge({ baseUrl: TRUEFORGE_URL });

const getIngested = db.prepare(`SELECT ingested FROM turns WHERE id = ?`);

export function turnRow(sessionId: string, turn: any, ingested: number) {
  const state = turn.state ?? {};
  return {
    id: turn.id,
    session_id: sessionId,
    created_at: turn.createdAt,
    completed_at: state.completedAt ?? null,
    status: state.status ?? "running",
    error: state.status === "error" ? (state.message ?? null) : null,
    ingested,
    pending_actions: state.requiredActions?.length ?? 0,
  };
}

async function ingestTurn(sessionId: string, turn: any) {
  const state = turn.state ?? {};
  const terminal = state.status && state.status !== "running";
  const already = getIngested.get(turn.id) as { ingested: number } | undefined;

  upsertTurn.run(turnRow(sessionId, turn, already?.ingested ?? 0));

  // Event logs exist only for terminal turns; fetch once.
  if (!terminal || already?.ingested) return;
  const events = await client.sessions.listTurnEvents(sessionId, turn.id, { order: "asc" });
  const rows: any[] = [];
  for await (const ev of events) rows.push(ev);
  const write = db.transaction(() => {
    for (const ev of rows) {
      insertEvent.run({
        id: ev.id,
        session_id: sessionId,
        turn_id: turn.id,
        thread_id: ev.threadId ?? null,
        type: ev.type,
        created_at: ev.createdAt ?? null,
        raw: JSON.stringify(ev),
      });
    }
    upsertTurn.run(turnRow(sessionId, turn, 1));
  });
  write();
}

const getStored = db.prepare(`SELECT updated_at FROM sessions WHERE id = ?`);
const getOpenTurns = db.prepare(
  `SELECT 1 FROM turns WHERE session_id = ? AND (status = 'running' OR ingested = 0) LIMIT 1`,
);

export async function pollOnce() {
  const sessions = await client.sessions.list();
  for await (const s of sessions) {
    const stored = getStored.get(s.id) as { updated_at: string | null } | undefined;
    // Incremental: skip re-scanning sessions whose TrueForge updated_at is
    // unchanged since the last poll, unless a turn is still running or its
    // events were never ingested. Turns parked on an approval gate are static
    // until resolved, and resolving always creates a new turn (bumping
    // updated_at), so they can skip too. DB timestamps are ISO strings, SDK
    // ones may be Date objects - compare epoch ms.
    const unchanged =
      stored?.updated_at != null && Date.parse(stored.updated_at) === new Date(s.updatedAt).getTime();
    if (unchanged && !getOpenTurns.get(s.id)) continue;
    upsertSession.run({
      id: s.id,
      agent_name: (s.agent as any)?.name ?? "(inline)",
      title: s.title,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      created_by: s.createdBy,
    });
    // Isolate failures per session/turn so one bad session can't starve the rest.
    try {
      const turns = await client.sessions.listTurns(s.id);
      for await (const t of turns) {
        try {
          await ingestTurn(s.id, t);
        } catch (err) {
          console.error(`collector: turn ${t.id}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error(`collector: session ${s.id}:`, (err as Error).message);
    }
  }
}

export function startCollector(intervalMs = 3000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await pollOnce();
    } catch (err) {
      console.error("collector:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
