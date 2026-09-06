import assert from "node:assert/strict";
import { test } from "node:test";
import { db, sessionSummaries, sessionTrace } from "./fixtures.ts";

const { ingestTask } = await import("../src/sources/roo.ts");
const T0 = 1_756_000_000_000;

test("roo-code: XML-protocol task with usage from ui_messages", () => {
  const api = [
    { role: "user", ts: T0, content: [{ type: "text", text: "<task>\nrename foo\n</task>" }, { type: "text", text: "<environment_details>\n# Current Workspace Directory (/work/app) Files\n</environment_details>" }] },
    { role: "assistant", ts: T0 + 1000, content: [{ type: "text", text: "I will read it.\n<read_file>\n<path>foo.ts</path>\n</read_file>" }] },
    { role: "user", ts: T0 + 2000, content: [{ type: "text", text: "[read_file for 'foo.ts'] Result:\nexport const foo = 1" }] },
    { role: "assistant", ts: T0 + 3000, content: [{ type: "text", text: "<attempt_completion>\n<result>Done</result>\n</attempt_completion>" }] },
  ];
  const ui = [
    { ts: T0, type: "say", say: "text", text: "# Current Workspace Directory (/work/app) Files" },
    { ts: T0 + 900, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1000, tokensOut: 30, cacheReads: 200, cost: 0.01 }) },
    { ts: T0 + 2900, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 1200, tokensOut: 10, cost: 0.01 }) },
  ];
  db.transaction(() => ingestTask("roo-code", "1756000000000", api as any, ui))();
  const s = sessionSummaries().find((x) => x.id === "1756000000000")!;
  assert.equal(s.source, "roo-code");
  assert.equal(s.agent_name, "app");
  assert.equal(s.title, "rename foo");
  assert.equal(s.turn_count, 1);
  assert.equal(s.running, 0);
  assert.equal(s.tool_calls, 1);
  assert.equal(s.input_tokens, 2400);
  assert.equal(s.output_tokens, 40);
  const t = sessionTrace("1756000000000");
  const calls = t.events.filter((e) => e.type === "model.message").map((e) => e.raw.toolCalls[0]?.function.name);
  assert.deepEqual(calls, ["read_file", "attempt_completion"]);
  assert.equal(t.events.at(-1)!.type, "turn.done");
});

test("cline: native tool_use blocks and error results", () => {
  const api = [
    { role: "user", ts: T0, content: [{ type: "text", text: "<task>build</task>" }] },
    { role: "assistant", ts: T0 + 1, content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "u1", name: "execute_command", input: { command: "make" } }] },
    { role: "user", ts: T0 + 2, content: [{ type: "tool_result", tool_use_id: "u1", content: "make: *** error", is_error: true }] },
  ];
  db.transaction(() => ingestTask("cline", "task-b", api as any, []))();
  const s = sessionSummaries().find((x) => x.id === "task-b")!;
  assert.equal(s.source, "cline");
  assert.equal(s.tool_errors, 1);
  assert.equal(s.running, 1);
});
