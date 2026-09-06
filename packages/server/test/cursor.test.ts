import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSummaries, sessionTrace } from "./fixtures.ts";

const { createCursor } = await import("../src/sources/cursor.ts");

test("cursor: transcript plus meta maps to timed turns and tool calls", async () => {
  const home = mkdtempSync(join(tmpdir(), "cursor-"));
  const chat = "c1";
  const tdir = join(home, "projects", "home-me-probe", "agent-transcripts", chat);
  const mdir = join(home, "chats", "wshash", chat);
  mkdirSync(tdir, { recursive: true });
  mkdirSync(mdir, { recursive: true });
  const T0 = 1_788_713_800_000;
  writeFileSync(join(mdir, "meta.json"), JSON.stringify({ schemaVersion: 1, createdAtMs: T0, updatedAtMs: T0 + 20_000, cwd: "/home/me/probe", hasConversation: true }));
  writeFileSync(join(tdir, `${chat}.jsonl`), [
    { role: "user", message: { content: [{ type: "text", text: "run ls" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Running." }, { type: "tool_use", name: "Shell", input: { command: "ls" } }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    { type: "turn_ended", status: "success" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  const src = createCursor(home);
  await src.poll();
  await src.poll();
  const s = sessionSummaries().find((x) => x.id === chat)!;
  assert.equal(s.source, "cursor");
  assert.equal(s.agent_name, "probe");
  assert.equal(s.title, "run ls");
  assert.equal(s.turn_count, 1);
  assert.equal(s.running, 0);
  assert.equal(s.total_seconds, 20);
  const t = sessionTrace(chat);
  assert.deepEqual(t.events.map((e) => e.type), ["turn.created", "model.message", "model.message", "turn.done"]);
  assert.equal(t.events[1].raw.toolCalls[0].function.name, "Shell");
  // interpolated times keep transcript order
  const times = t.events.map((e) => e.created_at!);
  assert.deepEqual([...times].sort(), times);
});
