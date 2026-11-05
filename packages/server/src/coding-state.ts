export type CodingState = "active" | "waiting" | "blocked" | "done" | "stale" | "unknown";

const STALE_AFTER_MS = 15 * 60 * 1000;

export function codingStateFor(
  row: { latest_turn_status?: unknown; pending_approvals?: unknown; updated_at?: unknown },
  now = Date.now(),
): { coding_state: CodingState; state_reason: string | null } {
  if (Number(row.pending_approvals ?? 0) > 0) return { coding_state: "waiting", state_reason: "approval" };

  const status = typeof row.latest_turn_status === "string" ? row.latest_turn_status : null;
  if (status === "running") {
    const updated = typeof row.updated_at === "string" ? Date.parse(row.updated_at) : Number.NaN;
    if (!Number.isFinite(updated) || now - updated > STALE_AFTER_MS)
      return { coding_state: "stale", state_reason: "no-recent-activity" };
    return { coding_state: "active", state_reason: null };
  }
  if (status === "error") return { coding_state: "blocked", state_reason: "turn-error" };
  if (status === "done" || status === "cancelled") return { coding_state: "done", state_reason: null };
  return { coding_state: "unknown", state_reason: status ? "unexpected-status" : "no-turns" };
}
