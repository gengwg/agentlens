import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRow } from "../src/retries.ts";
import { findRetries, fleetRetries, rollupRetries, seedSession, serverOf, sessionRetries, toolCallsOf } from "./fixtures.ts";

type Call = [id: string, name: string, args: unknown];

const msg = (thread: string | null, ...calls: Call[]): ToolRow => ({
  type: "model.message",
  thread_id: thread,
  created_at: null,
  calls: JSON.stringify(calls.map(([id, name, args]) => ({ id, function: { name, arguments: args } }))),
  call_id: null,
  failed: 0,
});
const res = (callId: string, failed: boolean): ToolRow => ({
  type: "tool.response",
  thread_id: null,
  created_at: null,
  calls: null,
  call_id: callId,
  failed: failed ? 1 : 0,
});
const retries = (rows: ToolRow[]) => findRetries("s", toolCallsOf(rows));

test("a failed call retried with the same args that then works", () => {
  const r = retries([
    msg(null, ["c1", "Bash", '{"cmd":"ls"}']),
    res("c1", true),
    msg(null, ["c2", "Bash", '{ "cmd": "ls" }']),
    res("c2", false),
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].failedCallId, "c1");
  assert.equal(r[0].retryCallId, "c2");
  assert.equal(r[0].sameArgs, true);
  assert.equal(r[0].recovered, true);
});

test("other tools in between still count, but only inside the window", () => {
  const inside = retries([
    msg(null, ["c1", "Read", "{}"]),
    res("c1", true),
    msg(null, ["c2", "Grep", "{}"]),
    msg(null, ["c3", "Glob", "{}"]),
    msg(null, ["c4", "Read", "{}"]),
  ]);
  assert.deepEqual(inside.map((r) => r.retryCallId), ["c4"]);

  const outside = retries([
    msg(null, ["c1", "Read", "{}"]),
    res("c1", true),
    msg(null, ["c2", "Grep", "{}"]),
    msg(null, ["c3", "Glob", "{}"]),
    msg(null, ["c4", "Bash", "{}"]),
    msg(null, ["c5", "Read", "{}"]),
  ]);
  assert.deepEqual(outside, []);
});

test("a call in the same message as the failure is not its retry", () => {
  const r = retries([msg(null, ["c1", "Read", "{}"], ["c2", "Read", "{}"]), res("c1", true), res("c2", false)]);
  assert.deepEqual(r, []);
});

test("a call issued before the failure came back is not its retry", () => {
  // Claude Code writes one record per tool_use, so parallel calls land in separate rows.
  const r = retries([msg(null, ["c1", "Bash", "{}"]), msg(null, ["c2", "Bash", "{}"]), res("c1", true), res("c2", false)]);
  assert.deepEqual(r, []);
});

test("a call with no name or no id is skipped", () => {
  const rows: ToolRow[] = [
    { ...msg(null), calls: JSON.stringify([{ id: "c1", function: { arguments: "{}" } }, { function: { name: "Bash" } }]) },
    res("c1", true),
    msg(null, ["c2", "Bash", "{}"]),
  ];
  assert.deepEqual(toolCallsOf(rows).map((c) => c.id), ["c2"]);
  assert.deepEqual(retries(rows), []);
});

test("another thread is not a retry", () => {
  const r = retries([msg("main", ["c1", "Bash", "{}"]), res("c1", true), msg("t1:sub", ["c2", "Bash", "{}"]), res("c2", false)]);
  assert.deepEqual(r, []);
});

test("a chain of failures yields one retry per failure", () => {
  const r = retries([
    msg(null, ["c1", "Bash", "{}"]),
    res("c1", true),
    msg(null, ["c2", "Bash", "{}"]),
    res("c2", true),
    msg(null, ["c3", "Bash", "{}"]),
    res("c3", false),
  ]);
  assert.deepEqual(
    r.map((x) => [x.failedCallId, x.retryCallId, x.recovered]),
    [
      ["c1", "c2", false],
      ["c2", "c3", true],
    ],
  );
});

test("a retry with no response yet is pending", () => {
  const r = retries([msg(null, ["c1", "Bash", "{}"]), res("c1", true), msg(null, ["c2", "Bash", "{}"])]);
  assert.equal(r.length, 1);
  assert.equal(r[0].recovered, null);
});

test("changed arguments are not sameArgs", () => {
  const r = retries([msg(null, ["c1", "Read", { path: "a" }]), res("c1", true), msg(null, ["c2", "Read", { path: "b" }])]);
  assert.equal(r.length, 1);
  assert.equal(r[0].sameArgs, false);
});

test("serverOf reads Claude Code MCP names", () => {
  assert.equal(serverOf("mcp__kubecon__search_sessions"), "kubecon");
  assert.equal(serverOf("Bash"), null);
  assert.equal(serverOf("mcp__x"), null);
});

test("rollup counts failures, retries and sessions per tool", () => {
  const a = toolCallsOf([
    msg(null, ["a1", "Bash", '{"cmd":"x"}']),
    res("a1", true),
    msg(null, ["a2", "Bash", '{"cmd":"y"}']),
    res("a2", false),
    msg(null, ["a3", "Bash", '{"cmd":"z"}']),
    res("a3", true),
  ]);
  const b = toolCallsOf([msg(null, ["b1", "Bash", '{"cmd":"x"}']), res("b1", true), msg(null, ["b2", "Bash", '{"cmd":"x"}'])]);
  const stats = rollupRetries([
    { sessionId: "A", calls: a },
    { sessionId: "B", calls: b },
  ]);
  assert.deepEqual(stats, [{ tool: "Bash", server: null, failures: 3, retried: 2, sameArgs: 1, recovered: 1, sessions: 2 }]);
});

const call = (id: string, tool: string, args = "{}") => ({ toolCalls: [{ id, function: { name: tool, arguments: args } }] });

test("a declined call is not a failure, so re-asking is not a retry", () => {
  seedSession("rt-denied", {
    source: "claude-code",
    events: [
      { id: "rtd1", type: "model.message", raw: call("c1", "Bash") },
      { id: "rtd2", type: "tool.response", raw: { toolCallId: "c1", content: "Permission for this action was denied by the hook", error: true } },
      { id: "rtd3", type: "model.message", raw: call("c2", "Bash") },
      { id: "rtd4", type: "tool.response", raw: { toolCallId: "c2", content: "ok" } },
    ],
  });
  assert.deepEqual(sessionRetries("rt-denied"), []);
});

test("a failed response with no toolCallId is skipped", () => {
  seedSession("rt-noid", {
    source: "claude-code",
    events: [
      { id: "rtn1", type: "model.message", raw: call("c1", "NoIdTool") },
      { id: "rtn2", type: "tool.response", raw: { content: "boom", error: true } },
      { id: "rtn3", type: "tool.response", raw: { toolCallId: "c1", content: "boom", error: true } },
      { id: "rtn4", type: "model.message", raw: call("c2", "NoIdTool") },
      { id: "rtn5", type: "tool.response", raw: { toolCallId: "c2", content: "ok" } },
    ],
  });
  const row = fleetRetries("2026-01-01T00:00:00Z").find((s) => s.tool === "NoIdTool");
  assert.equal(row?.failures, 1);
  assert.equal(row?.retried, 1);
});

test("fleetRetries only looks at sessions updated since the cutoff", () => {
  for (const [id, updated_at] of [
    ["rt-old", "2026-09-01T00:00:00Z"],
    ["rt-new", "2026-10-20T00:00:00Z"],
  ]) {
    seedSession(id, {
      source: "claude-code",
      updated_at,
      events: [
        { id: `${id}-1`, type: "model.message", raw: call("c1", "CutoffTool") },
        { id: `${id}-2`, type: "tool.response", raw: { toolCallId: "c1", content: "boom", error: true } },
        { id: `${id}-3`, type: "model.message", raw: call("c2", "CutoffTool") },
      ],
    });
  }
  const row = fleetRetries("2026-10-01T00:00:00Z").find((s) => s.tool === "CutoffTool");
  assert.equal(row?.sessions, 1);
});

test("thread_id from the event decides the thread", () => {
  seedSession("rt-thread", {
    source: "claude-code",
    events: [
      { id: "rtt1", type: "model.message", raw: call("c1", "Bash") },
      { id: "rtt2", type: "tool.response", raw: { toolCallId: "c1", content: "boom", error: true } },
      { id: "rtt3", type: "model.message", thread_id: "t1:sub", raw: call("c2", "Bash") },
    ],
  });
  assert.deepEqual(sessionRetries("rt-thread"), []);
});
