import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSummaries, sessionTrace } from "./fixtures.ts";

const { createAntigravity } = await import("../src/sources/antigravity.ts");
const T = (s: number) => `2026-09-06T16:57:${String(s).padStart(2, "0")}Z`;
const step = (i: number, type: string, extra: Record<string, unknown>, s = i) =>
  JSON.stringify({ type, status: "DONE", source: type === "USER_INPUT" ? "USER_EXPLICIT" : "MODEL", step_index: i, created_at: T(s), ...extra }) + "\n";

test("antigravity: transcript maps to turn, tool call, tool output, completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "agy-"));
  const logs = join(home, "brain", "conv-1", ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(home, "history.jsonl"), JSON.stringify({ conversationId: "conv-1", display: "x", timestamp: 1, workspace: "/work/probe" }) + "\n");
  const path = join(logs, "transcript.jsonl");
  writeFileSync(path,
    step(0, "USER_INPUT", { content: "run ls then say done" }) +
    step(1, "PLANNER_RESPONSE", { thinking: "...", tool_calls: [{ name: "run_command", args: { CommandLine: "ls" } }] }, 1) +
    step(2, "GENERIC", { content: "a.txt b.txt" }, 2));
  const src = createAntigravity(home);
  await src.poll();
  let s = sessionSummaries().find((x) => x.id === "conv-1")!;
  assert.equal(s.source, "antigravity");
  assert.equal(s.agent_name, "probe");
  assert.equal(s.title, "run ls then say done");
  assert.equal(s.running, 1, "still running until the model answers");
  assert.equal(s.tool_calls, 1);

  appendFileSync(path, step(3, "PLANNER_RESPONSE", { content: "Done." }, 5));
  await src.poll();
  s = sessionSummaries().find((x) => x.id === "conv-1")!;
  assert.equal(s.running, 0);
  assert.equal(s.total_seconds, 5);
  const t = sessionTrace("conv-1");
  assert.deepEqual(t.events.map((e) => e.type), ["turn.created", "model.message", "tool.response", "model.message", "turn.done"]);
  assert.equal(t.events[1].raw.toolCalls[0].function.name, "run_command");
  await src.poll(); // unchanged
  assert.equal(sessionTrace("conv-1").events.length, 5);
});
