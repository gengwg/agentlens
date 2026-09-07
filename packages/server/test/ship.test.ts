import assert from "node:assert/strict";
import { test } from "node:test";
import { seedSession } from "./fixtures.ts";

process.env.AGENTLENS_HOST_NAME = "testbox";
const { collect, redact } = await import("../src/ship.ts");

test("redact keeps shape and drops every piece of content", () => {
  const model = redact("model.message", {
    content: "here is the secret plan",
    toolCalls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"cat /etc/passwd"}' } }],
    usage: { inputTokens: 100, outputTokens: 5 },
    model: "some-model",
  }) as any;
  assert.equal(model.content, "");
  assert.equal(model.toolCalls[0].function.name, "bash");
  assert.equal(model.toolCalls[0].function.arguments, "");
  assert.deepEqual(model.usage, { inputTokens: 100, outputTokens: 5 });

  const tool = redact("tool.response", { content: "root:x:0:0", toolCallId: "c1", error: true }) as any;
  assert.equal(tool.content, "");
  assert.equal(tool.error, true);

  const created = redact("turn.created", { input: [{ type: "user.message", content: "my prompt" }] }) as any;
  assert.equal(created.input[0].content, "");

  assert.equal((redact("thread.created", { title: "read the private repo" }) as any).title, "subagent");
  assert.equal((redact("turn.done", { state: { status: "error", message: "stack trace" } }) as any).state.message, undefined);

  const json = JSON.stringify([model, tool, created]);
  for (const secret of ["secret plan", "/etc/passwd", "root:x", "my prompt"]) assert.ok(!json.includes(secret), secret);
});

test("collect namespaces ids by host, keeps titles local, and tracks a watermark", () => {
  seedSession("s-ship", {
    agent: "myrepo",
    updated_at: "2026-09-02T00:00:00Z",
    turns: [{ id: "t-ship", status: "error", error: "boom: /home/me/secret.ts" }],
    events: [{ id: "e-ship", turn_id: "t-ship", type: "model.message", raw: { content: "text", usage: { inputTokens: 9, outputTokens: 1 } } }],
  });
  const b = collect("2026-08-01T00:00:00Z");
  const s = b.sessions.find((x: any) => x.id === "testbox:s-ship") as any;
  assert.equal(s.agent_name, "testbox/myrepo");
  assert.equal(s.title, null, "titles are prompt text and stay local");
  const t = b.turns.find((x: any) => x.id === "testbox:t-ship") as any;
  assert.equal(t.session_id, "testbox:s-ship");
  assert.equal(t.status, "error");
  assert.equal(t.error, "error", "only the fact of an error travels");
  const e = b.events.find((x: any) => x.id === "testbox:e-ship") as any;
  assert.equal(e.turn_id, "testbox:t-ship");
  assert.equal(e.raw.content, "");
  assert.equal(e.raw.usage.inputTokens, 9);
  assert.equal(b.watermark, "2026-09-02T00:00:00Z");
  assert.ok(!JSON.stringify(b).includes("secret.ts"));

  // Nothing newer than the watermark: an empty batch, watermark unchanged.
  const empty = collect("2026-09-30T00:00:00Z");
  assert.equal(empty.sessions.length, 0);
  assert.equal(empty.watermark, "2026-09-30T00:00:00Z");
});

test("collect resends a changed session's turns but only its new events", () => {
  seedSession("s-incr", {
    updated_at: "2026-09-03T00:00:10Z",
    turns: [{ id: "t-incr" }],
    events: [
      { id: "old-1", turn_id: "t-incr", type: "model.message", created_at: "2026-09-03T00:00:01Z" },
      { id: "old-2", turn_id: "t-incr", type: "tool.response", created_at: "2026-09-03T00:00:02Z" },
      { id: "new-1", turn_id: "t-incr", type: "model.message", created_at: "2026-09-03T00:00:09Z" },
    ],
  });
  const b = collect("2026-09-03T00:00:05Z");
  assert.ok(b.sessions.some((x: any) => x.id === "testbox:s-incr"));
  assert.ok(b.turns.some((x: any) => x.id === "testbox:t-incr"), "turns resend so status changes land");
  const ids = b.events.filter((e: any) => e.session_id === "testbox:s-incr").map((e: any) => e.id);
  assert.deepEqual(ids, ["testbox:new-1"], "only events written since the watermark");
});
