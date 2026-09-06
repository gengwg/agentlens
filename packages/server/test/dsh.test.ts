import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { sessionSummaries, sessionTrace } from "./fixtures.ts";

const { createDsh, decompressFrames } = await import("../src/sources/dsh.ts");

// Synthetic dsh records; one zstd frame per line, as dsh writes them.
const frame = (r: unknown) => zstdCompressSync(Buffer.from(JSON.stringify(r) + "\n"));
const T0 = 1_756_000_000_000;
const recs = [
  { type: "session", version: 1, id: "s1", createdAt: T0, cwd: "/work/svc", delegationDepth: 0 },
  { type: "turn/start", seq: 1, time: T0 + 100, data: { turn: 1 } },
  { type: "user/message", seq: 2, time: T0 + 100, data: { role: "user", content: [{ type: "text", text: "fix it" }] } },
  { type: "assistant/message", seq: 3, time: T0 + 2000, data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 40 },
    message: { role: "assistant", content: [{ type: "reasoning", text: "..." }, { type: "text", text: "Running" }, { type: "tool-call", id: "c1", name: "bash", arguments: "{\"cmd\":\"ls\"}" }] } } },
  { type: "tool/call", seq: 4, time: T0 + 2001, data: { turn: 1, step: 1, callId: "c1", name: "bash", arguments: "{}" } },
  { type: "tool/result", seq: 5, time: T0 + 2500, data: { turn: 1, step: 1, message: { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", content: "boom", isError: true }] } } },
  { type: "session/title", seq: 6, time: T0 + 2600, data: { title: "Fix it", source: { kind: "llm" } } },
  { type: "turn/end", seq: 7, time: T0 + 3000, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "turn/start", seq: 8, time: T0 + 9000, data: { turn: 2 } },
  { type: "user/message", seq: 9, time: T0 + 9000, data: { role: "user", content: [{ type: "text", text: "again" }] } },
];

test("dsh: a header-only session is not listed", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-"));
  const dir = join(home, "sessions", "-w-", "session-empty");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl.zstd"), frame(recs[0]));
  await createDsh(home).poll();
  assert.equal(sessionSummaries().find((x) => x.id === "empty"), undefined);
});

test("decompressFrames decodes concatenated frames and leaves a partial tail", () => {
  const full = Buffer.concat(recs.slice(0, 3).map(frame));
  assert.equal(decompressFrames(full).split("\n").filter(Boolean).length, 3);
  const partial = Buffer.concat([full, frame(recs[3]).subarray(0, 10)]);
  assert.equal(decompressFrames(partial).split("\n").filter(Boolean).length, 3);
});

test("dsh: sessions, turns, tool errors, tokens and live append", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-"));
  const dir = join(home, "sessions", "-work-svc-", "session-s1");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "session.jsonl.zstd");
  writeFileSync(path, Buffer.concat(recs.slice(0, 8).map(frame)));
  const src = createDsh(home);
  await src.poll();
  let s = sessionSummaries().find((x) => x.id === "s1")!;
  assert.equal(s.source, "dsh");
  assert.equal(s.agent_name, "svc");
  assert.equal(s.title, "Fix it");
  assert.equal(s.turn_count, 1);
  assert.equal(s.running, 0);
  assert.equal(s.tool_calls, 1);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.input_tokens, 500);
  assert.equal(s.total_seconds, 3);
  const t = sessionTrace("s1");
  assert.deepEqual(t.events.map((e) => e.type), ["turn.created", "model.message", "tool.response", "turn.done"]);
  assert.equal(t.events[1].raw.toolCalls[0].function.name, "bash");

  appendFileSync(path, Buffer.concat(recs.slice(8).map(frame)));
  await src.poll();
  s = sessionSummaries().find((x) => x.id === "s1")!;
  assert.equal(s.turn_count, 2);
  assert.equal(s.running, 1);
  await src.poll(); // unchanged file, no-op
  assert.equal(sessionTrace("s1").events.length, 5);
});
