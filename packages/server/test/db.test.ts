import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSummaries, db, seedSession, sessionSummaries, sessionTrace, sweepStaleTurns, upsertEvent } from "./fixtures.ts";

const summary = (id: string) => sessionSummaries().find((s) => s.id === id)!;

test("pending_approvals reflects only the newest turn", () => {
  seedSession("s-approval", {
    turns: [
      { id: "t1", created_at: "2026-09-01T00:00:00Z", pending_actions: 1 },
      { id: "t2", created_at: "2026-09-01T00:01:00Z", pending_actions: 0 },
    ],
  });
  assert.equal(summary("s-approval").pending_approvals, 0);

  seedSession("s-waiting", {
    turns: [
      { id: "t3", created_at: "2026-09-01T00:00:00Z", pending_actions: 0 },
      { id: "t4", created_at: "2026-09-01T00:01:00Z", pending_actions: 2 },
    ],
  });
  assert.equal(summary("s-waiting").pending_approvals, 2);
});

test("declined tools count as denials, not errors", () => {
  seedSession("s-denied", {
    source: "claude-code",
    events: [
      { id: "d1", type: "tool.response", raw: { content: "Permission for this action was denied by the hook", error: true } },
      { id: "d2", type: "tool.response", raw: { content: "The user doesn't want to proceed with this tool use.", error: true } },
      { id: "d3", type: "tool.response", raw: { content: "ENOENT: no such file", error: true } },
    ],
  });
  const s = summary("s-denied");
  assert.equal(s.tool_calls, 3);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.tool_denials, 2);
});

test("agentSummaries separates failed turns from tool errors", () => {
  seedSession("s-agg-fail", { agent: "agg", turns: [{ id: "af1", status: "error" }] });
  seedSession("s-agg-tool", { agent: "agg", events: [{ id: "at1", type: "tool.response", raw: { content: "boom", error: true } }] });
  const row = agentSummaries().find((a: any) => a.agent_name === "agg") as any;
  assert.equal(row.sessions, 2);
  assert.equal(row.sessions_with_errors, 1);
  assert.equal(row.sessions_with_tool_errors, 1);
});

test("tool_errors counts only content with an error prefix", () => {
  seedSession("s-tools", {
    events: [
      { id: "e1", type: "tool.response", raw: { content: '{"error":"boom"}' } },
      { id: "e2", type: "tool.response", raw: { content: 'log line mentioning {"error"' } },
      { id: "e3", type: "tool.response", raw: { content: "ok" } },
    ],
  });
  const s = summary("s-tools");
  assert.equal(s.tool_calls, 3);
  assert.equal(s.tool_errors, 1);
});

test("total_seconds ignores turns that never completed", () => {
  seedSession("s-duration", {
    turns: [
      {
        id: "t5",
        created_at: "2026-09-01T00:00:00Z",
        completed_at: "2026-09-01T00:00:30Z",
      },
      { id: "t6", created_at: "2026-09-01T00:01:00Z", status: "running" },
    ],
  });
  const s = summary("s-duration");
  assert.equal(s.total_seconds, 30);
  assert.equal(s.running, 1);
  assert.equal(s.turn_count, 2);
});

test("error turns and token usage roll up per session", () => {
  seedSession("s-rollup", {
    turns: [
      { id: "t7", status: "error", error: "kaboom" },
      { id: "t8", status: "done" },
    ],
    events: [
      { id: "e4", type: "model.message", raw: { usage: { inputTokens: 10, outputTokens: 5 } } },
      { id: "e5", type: "model.message", raw: { usage: { inputTokens: 7, outputTokens: 3 } } },
      { id: "e6", type: "thread.created", raw: {} },
    ],
  });
  const s = summary("s-rollup");
  assert.equal(s.error_turns, 1);
  assert.equal(s.input_tokens, 17);
  assert.equal(s.output_tokens, 8);
  assert.equal(s.subagents, 1);
});

test("trace events sort by time with untimestamped events last", () => {
  seedSession("s-trace", {
    turns: [{ id: "t9" }],
    events: [
      { id: "e8", type: "turn.done", created_at: "2026-09-01T00:00:02Z" },
      { id: "e9", type: "model.message", created_at: null },
      { id: "e7", type: "turn.created", created_at: "2026-09-01T00:00:01Z" },
    ],
  });
  const trace = sessionTrace("s-trace");
  assert.deepEqual(
    trace.events.map((e: any) => e.id),
    ["e7", "e8", "e9"],
  );
  assert.deepEqual(trace.events[0].raw, {});
  assert.equal((trace.session as any).id, "s-trace");
  assert.equal(trace.turns.length, 1);
});

test("approval_since returns the earliest approval_required event for the newest pending turn", () => {
  seedSession("s-age", {
    turns: [
      { id: "t10", created_at: "2026-09-01T00:00:00Z", pending_actions: 1 },
      { id: "t11", created_at: "2026-09-01T00:01:00Z", pending_actions: 2 },
    ],
    events: [
      { id: "e10", turn_id: "t11", type: "tool.approval_required", created_at: "2026-09-01T00:02:00Z" },
      { id: "e11", turn_id: "t11", type: "tool.approval_required", created_at: "2026-09-01T00:03:00Z" },
      { id: "e12", turn_id: "t10", type: "tool.approval_required", created_at: "2026-09-01T00:00:30Z" },
    ],
  });
  const s = summary("s-age");
  assert.equal(s.pending_approvals, 2);
  assert.equal(s.approval_since, "2026-09-01T00:02:00Z");

  seedSession("s-no-age", {
    turns: [{ id: "t12", created_at: "2026-09-01T00:00:00Z", pending_actions: 0 }],
    events: [{ id: "e13", turn_id: "t12", type: "tool.approval_required", created_at: "2026-09-01T00:00:30Z" }],
  });
  assert.equal(summary("s-no-age").pending_approvals, 0);
  assert.equal(summary("s-no-age").approval_since, null);
});

test("agentSummaries counts sessions and those with errors", () => {
  seedSession("s-a1", { agent: "investigator", turns: [{ id: "ta1", status: "error" }] });
  seedSession("s-a2", { agent: "investigator", turns: [{ id: "ta2" }] });
  const investigator = (agentSummaries() as any[]).find((a) => a.agent_name === "investigator");
  assert.equal(investigator.sessions, 2);
  assert.equal(investigator.sessions_with_errors, 1);
});

test("agentSummaries reports tool-error sessions separately from failed turns", () => {
  seedSession("s-toolerr", {
    agent: "flaky-agent",
    turns: [{ id: "tf1" }],
    events: [{ id: "ef1", type: "tool.response", raw: { content: '{"error":"down"}' } }],
  });
  const flaky = (agentSummaries() as any[]).find((a) => a.agent_name === "flaky-agent");
  assert.equal(flaky.sessions, 1);
  assert.equal(flaky.sessions_with_errors, 0, "no turn failed");
  assert.equal(flaky.sessions_with_tool_errors, 1);
});

test("source defaults to trueforge and is returned in summaries", () => {
  seedSession("s-src-default");
  seedSession("s-src-cc", { source: "claude-code" });
  assert.equal(summary("s-src-default").source, "trueforge");
  assert.equal(summary("s-src-cc").source, "claude-code");
});

test("the {\"error\" prefix heuristic applies to TrueForge sessions only", () => {
  seedSession("s-prefix-cc", { source: "claude-code", events: [{ id: "pc1", type: "tool.response", raw: { content: '{"error":"quoted"}' } }] });
  assert.equal(summary("s-prefix-cc").tool_errors, 0);
});

test("upsertSession never rewinds updated_at", () => {
  seedSession("s-rewind", { updated_at: "2026-09-01T00:05:00Z" });
  seedSession("s-rewind", { updated_at: "2026-09-01T00:01:00Z" });
  assert.equal(summary("s-rewind").updated_at, "2026-09-01T00:05:00Z");
});

test("tool_errors honors the normalized error flag", () => {
  seedSession("s-flag", {
    events: [
      { id: "f1", type: "tool.response", raw: { content: "ENOENT", error: true } },
      { id: "f2", type: "tool.response", raw: { content: "fine", error: false } },
    ],
  });
  assert.equal(summary("s-flag").tool_errors, 1);
});

test("upsertEvent replaces raw for mutated records", () => {
  seedSession("s-upsert", { events: [{ id: "m1", type: "model.message", raw: { content: "a" } }] });
  upsertEvent.run({ id: "m1", session_id: "s-upsert", turn_id: "t1", thread_id: null, type: "model.message",
    created_at: "2026-09-01T00:00:01Z", raw: JSON.stringify({ content: "b" }) });
  assert.equal(sessionTrace("s-upsert").events[0].raw.content, "b");
});

test("sweepStaleTurns closes idle running turns of local sources only", () => {
  seedSession("s-stale-cc", { source: "claude-code", updated_at: "2026-09-01T00:00:00Z", turns: [{ id: "st1", status: "running" }] });
  seedSession("s-stale-tf", { source: "trueforge", updated_at: "2026-09-01T00:00:00Z", turns: [{ id: "st2", status: "running" }] });
  seedSession("s-fresh-cc", { source: "claude-code", updated_at: new Date().toISOString(), turns: [{ id: "st3", status: "running" }] });
  sweepStaleTurns();
  const status = (id: string) => (db.prepare(`SELECT status, completed_at FROM turns WHERE id = ?`).get(id) as any);
  assert.deepEqual(status("st1"), { status: "done", completed_at: "2026-09-01T00:00:00Z" });
  assert.equal(status("st2").status, "running");
  assert.equal(status("st3").status, "running");
});
