import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { sessionSummaries, sessionTrace } from "./fixtures.ts";

const { createOpenCode } = await import("../src/sources/opencode.ts");

// Minimal OpenCode-shaped store: only the columns the adapter reads.
function openCodeDb() {
  const src = new Database(":memory:");
  src.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const ins = (table: string, row: Record<string, unknown>) =>
    src.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`)
      .run(...Object.values(row).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)));
  return { src, ins };
}

const t0 = 1_756_000_000_000;

test("opencode: root session with tools, error, child thread and completed turn", async () => {
  const { src, ins } = openCodeDb();
  ins("session", { id: "ses_1", parent_id: null, directory: "/work/app", title: "Add tests", time_created: t0, time_updated: t0 + 10 });
  ins("message", { id: "msg_u", session_id: "ses_1", time_created: t0, time_updated: t0,
    data: { role: "user", time: { created: t0 } } });
  ins("part", { id: "prt_u", message_id: "msg_u", session_id: "ses_1", time_created: t0, time_updated: t0,
    data: { type: "text", text: "add tests" } });
  ins("message", { id: "msg_a", session_id: "ses_1", time_created: t0 + 1, time_updated: t0 + 9,
    data: { role: "assistant", parentID: "msg_u", modelID: "m", cost: 0.02, finish: "stop",
      tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } },
      time: { created: t0 + 1, completed: t0 + 9 } } });
  ins("part", { id: "prt_t1", message_id: "msg_a", session_id: "ses_1", time_created: t0 + 2, time_updated: t0 + 3,
    data: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: { command: "ls" }, output: "ok", time: { end: t0 + 3 } } } });
  ins("part", { id: "prt_t2", message_id: "msg_a", session_id: "ses_1", time_created: t0 + 4, time_updated: t0 + 5,
    data: { type: "tool", tool: "read", callID: "c2", state: { status: "error", input: {}, error: "no such file", time: { end: t0 + 5 } } } });
  ins("part", { id: "prt_x", message_id: "msg_a", session_id: "ses_1", time_created: t0 + 6, time_updated: t0 + 6,
    data: { type: "text", text: "Added." } });
  // child session spawned by a task tool
  ins("session", { id: "ses_child", parent_id: "ses_1", directory: "/work/app", title: "explore", time_created: t0 + 2, time_updated: t0 + 8 });
  ins("message", { id: "msg_cu", session_id: "ses_child", time_created: t0 + 2, time_updated: t0 + 2,
    data: { role: "user", time: { created: t0 + 2 } } });
  ins("message", { id: "msg_ca", session_id: "ses_child", time_created: t0 + 3, time_updated: t0 + 8,
    data: { role: "assistant", parentID: "msg_cu", tokens: { input: 1, output: 1 }, time: { created: t0 + 3, completed: t0 + 8 }, finish: "stop" } });
  ins("part", { id: "prt_c", message_id: "msg_ca", session_id: "ses_child", time_created: t0 + 4, time_updated: t0 + 4,
    data: { type: "text", text: "found it" } });

  const source = createOpenCode(src);
  await source.poll();
  await source.poll(); // idempotent

  const all = sessionSummaries().filter((s) => s.source === "opencode");
  assert.equal(all.length, 1);
  const s = all[0];
  assert.equal(s.id, "ses_1");
  assert.equal(s.agent_name, "app");
  assert.equal(s.turn_count, 1);
  assert.equal(s.tool_calls, 2);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.subagents, 1);
  assert.equal(s.input_tokens, 151);
  assert.equal(s.output_tokens, 26);
  assert.equal(s.running, 0);
  assert.equal(s.total_seconds, 0);

  const t = sessionTrace("ses_1");
  assert.deepEqual(t.turns.map((x: any) => [x.id, x.status]), [["oc:msg_u", "done"]]);
  const child = t.events.find((e) => e.id === "oc:msg_ca")!;
  assert.equal(child.thread_id, "ses_child");
  assert.equal(child.turn_id, "oc:msg_u");
  assert.equal(t.events.find((e) => e.type === "turn.done")!.raw.state.metrics.totalCostInUsd, 0.02);
  assert.equal(t.events.find((e) => e.type === "thread.created")!.raw.title, "explore");
  assert.equal(t.events.find((e) => e.id === "oc:msg_a")!.raw.toolCalls.length, 2);

  // In-place mutation of the assistant message is picked up on the next poll.
  src.prepare(`UPDATE part SET data = json_set(data, '$.text', 'Added and verified.'), time_updated = ? WHERE id = 'prt_x'`).run(t0 + 20);
  await source.poll();
  assert.equal(sessionTrace("ses_1").events.find((e) => e.id === "oc:msg_a")!.raw.content, "Added and verified.");
});

test("opencode: turn stays running until the last reply completes", async () => {
  const { src, ins } = openCodeDb();
  ins("session", { id: "ses_2", parent_id: null, directory: "/w/x", title: "t", time_created: t0, time_updated: t0 });
  ins("message", { id: "msg_u2", session_id: "ses_2", time_created: t0, time_updated: t0, data: { role: "user", time: { created: t0 } } });
  ins("message", { id: "msg_a2", session_id: "ses_2", time_created: t0 + 1, time_updated: t0 + 1,
    data: { role: "assistant", parentID: "msg_u2", tokens: {}, time: { created: t0 + 1 } } });
  const source = createOpenCode(src);
  await source.poll();
  assert.equal(sessionSummaries().find((s) => s.id === "ses_2")!.running, 1);

  src.prepare(`UPDATE message SET data = json_set(data, '$.error', json('{"name":"UnknownError","data":{"message":"quota"}}')), time_updated = ? WHERE id = 'msg_a2'`).run(t0 + 2);
  await source.poll();
  const turn = sessionTrace("ses_2").turns[0] as any;
  assert.equal(turn.status, "error");
  assert.equal(turn.error, "quota");
});

test("opencode: a new prompt closes a turn that never finished", async () => {
  const { src, ins } = openCodeDb();
  ins("session", { id: "ses_3", parent_id: null, directory: "/w/y", title: "t", time_created: t0, time_updated: t0 });
  ins("message", { id: "msg_u3", session_id: "ses_3", time_created: t0, time_updated: t0, data: { role: "user", time: { created: t0 } } });
  ins("message", { id: "msg_a3", session_id: "ses_3", time_created: t0 + 1, time_updated: t0 + 1,
    data: { role: "assistant", parentID: "msg_u3", tokens: {}, finish: "tool-calls", time: { created: t0 + 1, completed: t0 + 2 } } });
  ins("message", { id: "msg_u3b", session_id: "ses_3", time_created: t0 + 5, time_updated: t0 + 5, data: { role: "user", time: { created: t0 + 5 } } });
  const source = createOpenCode(src);
  await source.poll();
  const turns = sessionTrace("ses_3").turns as any[];
  assert.deepEqual(turns.map((t) => [t.id, t.status]), [["oc:msg_u3", "done"], ["oc:msg_u3b", "running"]]);
  assert.equal(turns[0].completed_at, new Date(t0 + 1).toISOString());
});
