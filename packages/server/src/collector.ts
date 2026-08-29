import { TrueForge } from "@truefoundry/trueforge-sdk";
import { db, insertEvent, upsertSession, upsertTurn } from "./db.js";

export const TRUEFORGE_URL = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
export const client = new TrueForge({ baseUrl: TRUEFORGE_URL });

const getIngested = db.prepare(`SELECT ingested FROM turns WHERE id = ?`);

async function ingestTurn(sessionId: string, turn: any) {
  const state = turn.state ?? {};
  const terminal = state.status && state.status !== "running";
  const already = getIngested.get(turn.id) as { ingested: number } | undefined;

  upsertTurn.run({
    id: turn.id,
    session_id: sessionId,
    created_at: turn.createdAt,
    completed_at: state.completedAt ?? null,
    status: state.status ?? "running",
    error: state.status === "error" ? (state.message ?? null) : null,
    ingested: already?.ingested ?? 0,
  });

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
    upsertTurn.run({
      id: turn.id,
      session_id: sessionId,
      created_at: turn.createdAt,
      completed_at: state.completedAt ?? null,
      status: state.status,
      error: state.status === "error" ? (state.message ?? null) : null,
      ingested: 1,
    });
  });
  write();
}

export async function pollOnce() {
  const sessions = await client.sessions.list();
  for await (const s of sessions) {
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
