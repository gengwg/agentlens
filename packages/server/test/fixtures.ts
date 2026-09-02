// Owns every src import so AGENTLENS_DB is set before db.ts opens a handle.
process.env.AGENTLENS_DB = ":memory:";

export const { db, agentSummaries, sessionSummaries, sessionTrace, upsertSession, upsertTurn, insertEvent } =
  await import("../src/db.ts");
export const { app } = await import("../src/api.ts");
export const { turnRow } = await import("../src/collector.ts");

type TurnSpec = {
  id: string;
  status?: string;
  created_at?: string;
  completed_at?: string | null;
  error?: string | null;
  pending_actions?: number;
};

type EventSpec = {
  id: string;
  turn_id?: string;
  type: string;
  created_at?: string | null;
  raw?: unknown;
};

export function seedSession(
  id: string,
  opts: { agent?: string; turns?: TurnSpec[]; events?: EventSpec[] } = {},
) {
  upsertSession.run({
    id,
    agent_name: opts.agent ?? "demo",
    title: `session ${id}`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    created_by: "test",
  });
  for (const t of opts.turns ?? []) {
    upsertTurn.run({
      session_id: id,
      created_at: "2026-09-01T00:00:00Z",
      completed_at: null,
      status: "done",
      error: null,
      ingested: 1,
      pending_actions: 0,
      ...t,
    });
  }
  for (const e of opts.events ?? []) {
    insertEvent.run({
      session_id: id,
      turn_id: e.turn_id ?? "t1",
      thread_id: null,
      created_at: "2026-09-01T00:00:00Z",
      ...e,
      raw: JSON.stringify(e.raw ?? {}),
    });
  }
}
