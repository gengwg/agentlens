import assert from "node:assert/strict";
import { test } from "node:test";
import { db, sessionSummaries, sessionTrace } from "./fixtures.ts";

const { ingestRecords } = await import("../src/sources/codex.ts");
const T = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}.000Z`;
const item = (s: number, payload: any) => ({ timestamp: T(s), type: "response_item", payload });
const ev = (s: number, payload: any) => ({ timestamp: T(s), type: "event_msg", payload });

test("codex: rollout maps to a turn with tools, tokens and completion", () => {
  const recs = [
    { timestamp: T(0), type: "session_meta", payload: { id: "cx1", timestamp: T(0), cwd: "/work/api" } },
    item(1, { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }] }),
    item(1, { type: "message", role: "user", content: [{ type: "input_text", text: "add a test" }] }),
    item(2, { type: "function_call", name: "shell", arguments: "{\"command\":[\"ls\"]}", call_id: "c1" }),
    item(3, { type: "function_call_output", call_id: "c1", output: "{\"output\":\"a.ts\",\"metadata\":{\"exit_code\":0}}" }),
    item(4, { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added." }] }),
    ev(4, { type: "token_count", info: { last_token_usage: { input_tokens: 900, cached_input_tokens: 100, output_tokens: 50 } } }),
    ev(5, { type: "task_complete" }),
  ];
  db.transaction(() => ingestRecords("file1", recs, { offset: 0, n: 0 }))();
  const s = sessionSummaries().find((x) => x.id === "cx1")!;
  assert.equal(s.source, "codex");
  assert.equal(s.agent_name, "api");
  assert.equal(s.title, "add a test");
  assert.equal(s.turn_count, 1);
  assert.equal(s.tool_calls, 1);
  assert.equal(s.tool_errors, 0);
  assert.equal(s.input_tokens, 1000);
  assert.equal(s.output_tokens, 50);
  assert.equal(s.running, 0);
  const t = sessionTrace("cx1");
  assert.deepEqual(t.events.map((e) => e.type), ["turn.created", "model.message", "tool.response", "model.message", "turn.done"]);
  assert.equal(t.events[1].raw.toolCalls[0].function.name, "shell");
});

test("codex: a second prompt closes an unfinished turn", () => {
  const recs = [
    { timestamp: T(0), type: "session_meta", payload: { id: "cx2", timestamp: T(0), cwd: "/w" } },
    item(1, { type: "message", role: "user", content: [{ type: "input_text", text: "one" }] }),
    item(2, { type: "message", role: "assistant", content: [{ type: "output_text", text: "working" }] }),
    item(9, { type: "message", role: "user", content: [{ type: "input_text", text: "two" }] }),
  ];
  db.transaction(() => ingestRecords("file2", recs, { offset: 0, n: 0 }))();
  const turns = sessionTrace("cx2").turns as any[];
  assert.deepEqual(turns.map((t) => t.status), ["done", "running"]);
  assert.equal(turns[0].completed_at, T(2));
});
