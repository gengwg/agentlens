import assert from "node:assert/strict";
import { test } from "node:test";
import { agentSummaries, seedSession, sessionSummaries, sessionTrace } from "./fixtures.ts";

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

test("agentSummaries counts sessions and those with errors", () => {
  seedSession("s-a1", { agent: "investigator", turns: [{ id: "ta1", status: "error" }] });
  seedSession("s-a2", { agent: "investigator", turns: [{ id: "ta2" }] });
  const investigator = (agentSummaries() as any[]).find((a) => a.agent_name === "investigator");
  assert.equal(investigator.sessions, 2);
  assert.equal(investigator.sessions_with_errors, 1);
});
