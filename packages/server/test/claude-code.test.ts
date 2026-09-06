import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { db, sessionSummaries, sessionTrace } from "./fixtures.ts";

const { ingestRecords, readNewLines } = await import("../src/sources/claude-code.ts");

// Synthetic records in the Claude Code JSONL shape; no real transcript data.
const T = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}.000Z`;
const base = { sessionId: "cc-s1", cwd: "/work/proj", version: "2.1.0" };
const user = (uuid: string, s: number, content: any, extra = {}) => ({
  ...base, type: "user", uuid, timestamp: T(s), promptId: `p-${uuid}`, message: { role: "user", content }, ...extra,
});
const assistant = (uuid: string, s: number, msgId: string, block: any) => ({
  ...base, type: "assistant", uuid, timestamp: T(s),
  message: { id: msgId, role: "assistant", model: "m", content: [block],
    usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } },
});

const records = [
  user("u1", 0, "fix the bug"),
  assistant("a1", 1, "msg1", { type: "thinking", thinking: "..." }),
  assistant("a2", 2, "msg1", { type: "text", text: "Looking." }),
  assistant("a3", 3, "msg1", { type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }),
  user("u2", 4, [{ type: "tool_result", tool_use_id: "tu1", content: "boom", is_error: true }]),
  user("u3", 5, [{ type: "text", text: "injected skill" }], { isMeta: true }),
  assistant("a4", 6, "msg2", { type: "text", text: "Done." }),
  { ...base, type: "system", subtype: "turn_duration", uuid: "sys1", timestamp: T(7), durationMs: 7000 },
  { type: "ai-title", sessionId: "cc-s1", aiTitle: "Bug fix" },
  user("u4", 8, "thanks, one more"),
];

test("claude-code: maps a transcript into turns and events", () => {
  const state = { offset: 0 };
  db.transaction(() => ingestRecords({ sessionId: "cc-s1", threadId: null }, records, state))();

  const s = sessionSummaries().find((x) => x.id === "cc-s1")!;
  assert.equal(s.source, "claude-code");
  assert.equal(s.agent_name, "proj");
  assert.equal(s.title, "Bug fix");
  assert.equal(s.turn_count, 2);
  assert.equal(s.tool_calls, 1);
  assert.equal(s.tool_errors, 1);
  // usage repeated on 3 records of msg1 counts once: (10+90) + (10+90)
  assert.equal(s.input_tokens, 200);
  assert.equal(s.output_tokens, 10);
  assert.equal(s.running, 1);
  assert.equal(s.updated_at, T(8));

  const t = sessionTrace("cc-s1");
  assert.deepEqual(t.turns.map((x: any) => [x.id, x.status, x.completed_at]), [
    ["cc:cc-s1:u1", "done", T(7)],
    ["cc:cc-s1:u4", "running", null],
  ]);
  const types = t.events.map((e) => e.type);
  assert.deepEqual(types, ["turn.created", "model.message", "model.message", "tool.response", "model.message", "turn.done", "turn.created"]);
  const call = t.events.find((e) => e.id === "cc:cc-s1:a3")!;
  assert.equal(call.raw.toolCalls[0].function.name, "Bash");
  assert.equal(call.raw.usage, undefined);
  // thinking-only record a1 is skipped; its usage rides on the first rendered record
  assert.equal(t.events.find((e) => e.id === "cc:cc-s1:a1"), undefined);
  assert.equal(t.events.find((e) => e.id === "cc:cc-s1:a2")!.raw.usage.inputTokens, 100);
  assert.equal(t.events.find((e) => e.type === "turn.done")!.raw.state.durationMs, 7000);

  // Replaying the same records is a no-op.
  db.transaction(() => ingestRecords({ sessionId: "cc-s1", threadId: null }, records, { offset: 0 }))();
  assert.equal(sessionTrace("cc-s1").events.length, 7);
});

test("claude-code: slash-command prompts become readable titles", () => {
  const recs = [
    { ...user("c1", 0, "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>PR 24</command-args>"), sessionId: "cc-s5" },
    { ...assistant("c2", 1, "mc1", { type: "text", text: "ok" }), sessionId: "cc-s5" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s5", threadId: null }, recs, { offset: 0 }))();
  assert.equal(sessionSummaries().find((x) => x.id === "cc-s5")!.title, "/review PR 24");
});

test("claude-code: interrupted prompt cancels the open turn without a new one", () => {
  const state = { offset: 0 };
  const recs = [
    { ...user("i1", 0, "go"), sessionId: "cc-s2" },
    { ...user("i2", 1, "[Request interrupted by user]"), sessionId: "cc-s2" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s2", threadId: null }, recs, state))();
  const t = sessionTrace("cc-s2");
  assert.equal(t.turns.length, 1);
  assert.equal((t.turns[0] as any).status, "cancelled");
});

test("claude-code: isMeta prompt after a closed turn starts a turn; orphan output opens one", () => {
  const recs = [
    { ...user("q1", 0, "hi"), sessionId: "cc-s4" },
    { ...assistant("q2", 1, "mq1", { type: "text", text: "hello" }), sessionId: "cc-s4" },
    { ...base, sessionId: "cc-s4", type: "system", subtype: "turn_duration", uuid: "q3", timestamp: T(2), durationMs: 1 },
    { ...user("q4", 3, "remote prompt", { isMeta: true }), sessionId: "cc-s4" },
    { ...assistant("q5", 4, "mq2", { type: "text", text: "reply" }), sessionId: "cc-s4" },
    { ...base, sessionId: "cc-s4", type: "system", subtype: "turn_duration", uuid: "q6", timestamp: T(5), durationMs: 1 },
    { ...assistant("q7", 6, "mq3", { type: "text", text: "continues after compaction" }), sessionId: "cc-s4" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s4", threadId: null }, recs, { offset: 0 }))();
  const t = sessionTrace("cc-s4");
  assert.deepEqual(t.turns.map((x: any) => [x.id, x.status]), [
    ["cc:cc-s4:q1", "done"],
    ["cc:cc-s4:q4", "done"],
    ["cc:cc-s4:q7", "running"],
  ]);
  // q7's implicit predecessor close: none here, but a prompt-closed turn ends at its last event
  const recs2 = [
    { ...user("r1", 0, "a"), sessionId: "cc-s6" },
    { ...assistant("r2", 1, "mr1", { type: "text", text: "b" }), sessionId: "cc-s6" },
    { ...user("r3", 30, "c"), sessionId: "cc-s6" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s6", threadId: null }, recs2, { offset: 0 }))();
  assert.equal((sessionTrace("cc-s6").turns[0] as any).completed_at, T(1));
  assert.equal(t.events.filter((e) => e.type === "model.message").length, 3);
});

test("claude-code: compact summaries do not open turns; swept turns reopen on new output", () => {
  const recs = [
    { ...user("k1", 0, "go"), sessionId: "cc-s7" },
    { ...assistant("k2", 1, "mk1", { type: "text", text: "working" }), sessionId: "cc-s7" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s7", threadId: null }, recs, { offset: 0 }))();
  // simulate the stale sweep closing the turn during a long tool run
  db.prepare(`UPDATE turns SET status='done', completed_at=? WHERE id='cc:cc-s7:k1'`).run(T(1));
  const more = [
    { ...user("k3", 2, [{ type: "tool_result", tool_use_id: "x", content: "late result" }]), sessionId: "cc-s7" },
  ];
  const state = { offset: 0, turn_id: "cc:cc-s7:k1", msg_id: "mk1" };
  db.transaction(() => ingestRecords({ sessionId: "cc-s7", threadId: null }, more, state))();
  assert.deepEqual(db.prepare(`SELECT status, completed_at FROM turns WHERE id='cc:cc-s7:k1'`).get(), { status: "running", completed_at: null });

  const summary = [
    { ...user("k4", 5, "summary of earlier work", { isCompactSummary: true }), sessionId: "cc-s8" },
    { ...user("k5", 6, "real prompt"), sessionId: "cc-s8" },
    { ...assistant("k6", 7, "mk6", { type: "text", text: "hi" }), sessionId: "cc-s8" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s8", threadId: null }, summary, { offset: 0 }))();
  assert.deepEqual(sessionTrace("cc-s8").turns.map((t: any) => t.id), ["cc:cc-s8:k5"]);
});

test("claude-code: a resumed subagent follows the parent turn that resumed it", () => {
  const parent = [
    { ...user("p1", 0, "first"), sessionId: "cc-s9" },
    { ...assistant("p2", 1, "mp1", { type: "text", text: "spawning" }), sessionId: "cc-s9" },
    { ...user("p3", 10, "second"), sessionId: "cc-s9" },
    { ...assistant("p4", 11, "mp2", { type: "text", text: "resuming agent" }), sessionId: "cc-s9" },
  ];
  db.transaction(() => ingestRecords({ sessionId: "cc-s9", threadId: null }, parent, { offset: 0 }))();
  const sub = [
    user("s1", 2, "task one"),
    assistant("s2", 3, "ms1", { type: "text", text: "done one" }),
    user("s3", 12, "task two"),
    assistant("s4", 13, "ms2", { type: "text", text: "done two" }),
  ].map((r) => ({ ...r, sessionId: "cc-s9" }));
  db.transaction(() => ingestRecords({ sessionId: "cc-s9", threadId: "agentZ" }, sub, { offset: 0, turn_id: "cc:cc-s9:p1" }))();
  const t = sessionTrace("cc-s9");
  assert.equal(t.events.find((e) => e.id === "cc:cc-s9:s2")!.turn_id, "cc:cc-s9:p1");
  assert.equal(t.events.find((e) => e.id === "cc:cc-s9:s4")!.turn_id, "cc:cc-s9:p3");
});

test("claude-code: subagent records land on the parent turn as a thread", () => {
  db.transaction(() => ingestRecords({ sessionId: "cc-s3", threadId: null }, [user("m1", 0, "do it")], { offset: 0 }))();
  const sub = [
    user("s1", 1, "subagent prompt"),
    assistant("s2", 2, "msgS", { type: "text", text: "sub result" }),
  ];
  db.transaction(() =>
    ingestRecords({ sessionId: "cc-s3", threadId: "agent1" }, sub, { offset: 0, turn_id: "cc:cc-s3:m1" }),
  )();
  const t = sessionTrace("cc-s3");
  const ev = t.events.find((e) => e.id === "cc:cc-s3:s2")!;
  assert.equal(ev.thread_id, "agent1");
  assert.equal(ev.turn_id, "cc:cc-s3:m1");
  assert.equal(t.events.filter((e) => e.type === "turn.created").length, 1);
});

test("readNewLines leaves a trailing partial line for the next read", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentlens-"));
  const p = join(dir, "s.jsonl");
  writeFileSync(p, '{"a":1}\n{"b":2}\n{"c":');
  let r = readNewLines(p, 0);
  assert.deepEqual(r.lines, ['{"a":1}', '{"b":2}']);
  assert.equal(r.offset, 16);
  appendFileSync(p, '3}\n');
  r = readNewLines(p, r.offset);
  assert.deepEqual(r.lines, ['{"c":3}']);
  assert.equal(readNewLines(p, r.offset).lines.length, 0);
});
