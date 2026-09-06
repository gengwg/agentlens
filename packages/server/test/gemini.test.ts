import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sessionSummaries, sessionTrace } from "./fixtures.ts";

const { createGemini } = await import("../src/sources/gemini.ts");
const T = (s: number) => `2026-09-01T00:00:${String(s).padStart(2, "0")}.000Z`;

test("gemini: chat file maps to turns, re-read on change", async () => {
  const home = mkdtempSync(join(tmpdir(), "gemini-"));
  writeFileSync(join(home, "projects.json"), JSON.stringify({ projects: { "/work/web": "h1" } }));
  const chats = join(home, "tmp", "h1", "chats");
  mkdirSync(chats, { recursive: true });
  const path = join(chats, "session-2026-09-01T00-00-abc.json");
  const doc = {
    sessionId: "g1", projectHash: "h1", startTime: T(0), lastUpdated: T(5),
    messages: [
      { id: "m1", timestamp: T(0), type: "user", content: "list files" },
      { id: "m2", timestamp: T(3), type: "gemini", content: "Here", model: "gemini-2.5-pro", tokens: { input: 200, output: 20, cached: 50, thoughts: 5 },
        toolCalls: [{ id: "t1", name: "list_directory", args: { path: "." }, result: "a b", status: "success", timestamp: T(2) },
                    { id: "t2", name: "read_file", args: {}, result: "no such file", status: "error", timestamp: T(2) }] },
    ],
  };
  writeFileSync(path, JSON.stringify(doc));
  const src = createGemini(home);
  await src.poll();
  const s = sessionSummaries().find((x) => x.id === "g1")!;
  assert.equal(s.source, "gemini");
  assert.equal(s.agent_name, "web");
  assert.equal(s.title, "list files");
  assert.equal(s.turn_count, 1);
  assert.equal(s.running, 0);
  assert.equal(s.tool_calls, 2);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.input_tokens, 250);
  assert.equal(s.output_tokens, 25);

  doc.messages.push({ id: "m3", timestamp: T(8), type: "user", content: "thanks" } as any);
  doc.lastUpdated = T(8);
  await new Promise((r) => setTimeout(r, 20));
  writeFileSync(path, JSON.stringify(doc));
  await src.poll();
  const t = sessionTrace("g1");
  assert.equal(t.turns.length, 2);
  assert.equal((t.turns[1] as any).status, "running");
  assert.equal(t.events.filter((e) => e.type === "model.message").length, 1);
});
