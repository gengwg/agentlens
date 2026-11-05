import { createHash } from "node:crypto";
import { db, sessionTrace } from "./db.js";

export type InvestigationKind = "fleet" | "session";
export type SnapshotRecord = { id: string; session_id: string; revision: number };
export type PreparedInvestigation = SnapshotRecord & {
  investigation_id: string;
  kind: InvestigationKind;
  prompt: string;
};
export type InvestigationResult = {
  investigation_id: string;
  session_id: string;
  turn_id: string;
  snapshot_id?: string;
  deduplicated: boolean;
};

type InvestigationClient = {
  sessions: {
    create(input: { agent: { name: string } }): Promise<{ data: { id: string } }>;
    createTurn(sessionId: string, input: { input: { type: "user.message"; content: string }[] }): Promise<{ data: { id: string } }>;
  };
};

type LaunchRow = {
  id: string;
  trueforge_session_id: string | null;
  trueforge_turn_id: string | null;
};

const idFor = (namespace: string, parts: (string | number)[]) =>
  createHash("sha256").update([namespace, ...parts].join("\0")).digest("hex");

function revisionOf(sessionId?: string) {
  const row = (sessionId
    ? db.prepare(`SELECT IFNULL(MAX(seq), 0) AS revision FROM events WHERE session_id = ?`).get(sessionId)
    : db.prepare(`SELECT IFNULL(MAX(seq), 0) AS revision FROM events`).get()) as { revision: number };
  return row.revision;
}

export function ensureSnapshot(sessionId: string): SnapshotRecord {
  return db.transaction(() => {
    const revision = revisionOf(sessionId);
    const id = idFor("snapshot", [sessionId, revision]);
    const existing = db.prepare(`SELECT id, session_id, revision FROM investigation_snapshots WHERE id = ?`).get(id) as SnapshotRecord | undefined;
    if (existing) return existing;
    // The stored rows are already secret-masked. Persist the projection itself:
    // a later in-place update gets a new seq and cannot rewrite this evidence.
    const snapshot = sessionTrace(sessionId, revision);
    db.prepare(`INSERT INTO investigation_snapshots (id, session_id, revision, snapshot) VALUES (?, ?, ?, ?)`)
      .run(id, sessionId, revision, JSON.stringify(snapshot));
    return { id, session_id: sessionId, revision };
  })();
}

export function readSnapshot(id: string) {
  const row = db.prepare(`SELECT id, session_id, revision, snapshot FROM investigation_snapshots WHERE id = ?`).get(id) as
    | (SnapshotRecord & { snapshot: string })
    | undefined;
  return row ? { ...row, snapshot: JSON.parse(row.snapshot) as ReturnType<typeof sessionTrace> } : undefined;
}

export function prepareInvestigation(kind: InvestigationKind, targetSessionId?: string): PreparedInvestigation {
  return db.transaction(() => {
    const snapshot = kind === "session" ? ensureSnapshot(targetSessionId!) : undefined;
    const revision = snapshot?.revision ?? revisionOf();
    const target = snapshot?.session_id ?? targetSessionId ?? "";
    const id = idFor("investigation", [kind, target, revision]);
    db.prepare(`INSERT OR IGNORE INTO investigations (id, kind, target_session_id, revision) VALUES (?, ?, ?, ?)`)
      .run(id, kind, target || null, revision);
    const prompt = snapshot
      ? `Investigation ${id}. Investigate session ${target} using snapshot ${snapshot.id}. Call get_session_trace with session_id and snapshot_id, then publish an incident report with investigation_id ${id}.`
      : `Investigation ${id}. Triage the fleet: call list_problem_sessions, investigate the worst offenders in parallel with subagents using each session's snapshot_id, then produce one incident report with investigation_id ${id}.`;
    return { id: snapshot?.id ?? "", session_id: target, revision, investigation_id: id, kind, prompt };
  })();
}

function launchRow(id: string) {
  return db.prepare(`SELECT id, trueforge_session_id, trueforge_turn_id FROM investigations WHERE id = ?`).get(id) as LaunchRow | undefined;
}

export function investigationById(id: string) {
  return launchRow(id);
}

const launching = new Map<string, Promise<InvestigationResult>>();

export async function launchInvestigation(kind: InvestigationKind, targetSessionId: string | undefined, client: InvestigationClient): Promise<InvestigationResult> {
  const prepared = prepareInvestigation(kind, targetSessionId);
  const existing = launchRow(prepared.investigation_id);
  if (existing?.trueforge_session_id && existing.trueforge_turn_id) {
    return { investigation_id: prepared.investigation_id, session_id: existing.trueforge_session_id, turn_id: existing.trueforge_turn_id, snapshot_id: prepared.id || undefined, deduplicated: true };
  }
  const pending = launching.get(prepared.investigation_id);
  if (pending) return { ...(await pending), deduplicated: true };

  const run = (async (): Promise<InvestigationResult> => {
    let row = launchRow(prepared.investigation_id)!;
    let trueforgeSessionId = row.trueforge_session_id;
    if (!trueforgeSessionId) {
      const { data: session } = await client.sessions.create({ agent: { name: "investigator" } });
      trueforgeSessionId = session.id;
      db.prepare(`UPDATE investigations SET trueforge_session_id = ? WHERE id = ?`).run(trueforgeSessionId, prepared.investigation_id);
    }
    row = launchRow(prepared.investigation_id)!;
    if (row.trueforge_turn_id) {
      return { investigation_id: prepared.investigation_id, session_id: trueforgeSessionId, turn_id: row.trueforge_turn_id, snapshot_id: prepared.id || undefined, deduplicated: true };
    }
    const { data: turn } = await client.sessions.createTurn(trueforgeSessionId, {
      input: [{ type: "user.message", content: prepared.prompt }],
    });
    db.prepare(`UPDATE investigations SET trueforge_turn_id = ? WHERE id = ?`).run(turn.id, prepared.investigation_id);
    return { investigation_id: prepared.investigation_id, session_id: trueforgeSessionId, turn_id: turn.id, snapshot_id: prepared.id || undefined, deduplicated: false };
  })();
  launching.set(prepared.investigation_id, run);
  try {
    return await run;
  } finally {
    launching.delete(prepared.investigation_id);
  }
}
