import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { db, getCursor, setCursor } from "../db.js";
import { MAX_TOOL_OUTPUT, closeTurn, ensureSession, openTurn, putEvent, textOf, touch, usageOf } from "./emit.js";
import type { Source } from "./types.js";

// Experimental: Gemini CLI chats under ~/.gemini/tmp/<project>/chats/.
// Current versions write session-*.jsonl: a header line {sessionId, startTime,
// lastUpdated} followed by patch lines that $set fields, messages included.
// Older versions wrote one session-*.json document. Both are read here; the
// file is re-read whenever it changes and events are upserted.
//
// Verified against a real (failed) run: header and user message shape. Gemini
// CLI refuses individual accounts since June 2026, so the assistant, tool and
// token fields below are still from the published format, not observed.

const SOURCE = "gemini";

type Msg = { id: string; timestamp: string; type: string; content?: unknown; tokens?: any; model?: string; toolCalls?: any[] };

export function ingestSession(doc: any, projectName: string) {
  const sid: string = doc.sessionId;
  const msgs: Msg[] = doc.messages ?? [];
  if (!sid || !msgs.length) return;
  const firstUser = msgs.find((m) => m.type === "user");
  ensureSession({ id: sid, source: SOURCE, agent_name: projectName, title: firstUser ? textOf(firstUser.content).slice(0, 80) : null,
    created_at: doc.startTime ?? msgs[0].timestamp, updated_at: doc.lastUpdated ?? msgs[msgs.length - 1].timestamp });
  let turn: string | undefined;
  let lastAssistant: Msg | undefined;
  const finish = (status: string, at: string) => {
    if (!turn) return;
    closeTurn(turn, status, at);
    putEvent({ id: `${turn}:done`, session_id: sid, turn_id: turn, type: "turn.done", created_at: at, raw: { state: { status } } });
  };
  for (const m of msgs) {
    if (m.type === "user") {
      if (turn) finish("done", lastAssistant?.timestamp ?? m.timestamp);
      turn = `gemini:${sid}:${m.id}`;
      lastAssistant = undefined;
      openTurn(turn, sid, m.timestamp);
      putEvent({ id: turn, session_id: sid, turn_id: turn, type: "turn.created", created_at: m.timestamp,
        raw: { input: [{ type: "user.message", content: textOf(m.content) }] } });
      continue;
    }
    if (!turn || m.type !== "gemini") continue;
    lastAssistant = m;
    const calls = m.toolCalls ?? [];
    putEvent({ id: `gemini:${sid}:${m.id}`, session_id: sid, turn_id: turn, type: "model.message", created_at: m.timestamp,
      raw: {
        content: textOf(m.content),
        toolCalls: calls.map((c) => ({ id: c.id, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        usage: m.tokens ? usageOf({ input: m.tokens.input, output: (m.tokens.output ?? 0) + (m.tokens.thoughts ?? 0), cacheRead: m.tokens.cached }) : undefined,
        model: m.model,
      } });
    for (const c of calls) {
      if (c.result === undefined && c.status !== "error") continue;
      putEvent({ id: `gemini:${sid}:${c.id}`, session_id: sid, turn_id: turn, type: "tool.response", created_at: c.timestamp ?? m.timestamp,
        raw: { content: textOf(c.result).slice(0, MAX_TOOL_OUTPUT), toolCallId: c.id, error: c.status === "error" } });
    }
  }
  // The final turn is done once the model has answered without pending calls.
  // It ends when the session was last written, which is at or after the reply.
  const pending = (lastAssistant?.toolCalls ?? []).some((c) => c.result === undefined && c.status !== "error");
  const endedAt = [doc.lastUpdated, lastAssistant?.timestamp].filter(Boolean).sort().pop();
  if (turn && lastAssistant && !pending) finish("done", endedAt);
  touch(sid, doc.lastUpdated ?? msgs[msgs.length - 1].timestamp);
}

// ~/.gemini/projects.json maps project paths to the hashes used under tmp/.
function projectNames(home: string): Record<string, string> {
  try {
    const projects = JSON.parse(readFileSync(join(home, "projects.json"), "utf8")).projects ?? {};
    return Object.fromEntries(Object.entries(projects).map(([path, hash]) => [String(hash), basename(path)]));
  } catch {
    return {};
  }
}

// A .jsonl chat is a header plus $set patches; fold them into one document.
export function readChat(text: string, ext: string): any {
  if (ext === ".json") return JSON.parse(text);
  const doc: any = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial trailing line
    }
    Object.assign(doc, rec.$set ?? rec);
  }
  delete doc.$set;
  return doc;
}

export function createGemini(home: string): Source {
  const tmp = join(home, "tmp");
  let detail = tmp;
  async function poll() {
    const names = projectNames(home);
    let files = 0;
    for (const proj of readdirSync(tmp, { withFileTypes: true })) {
      const chats = join(tmp, proj.name, "chats");
      if (!proj.isDirectory() || !existsSync(chats)) continue;
      for (const f of readdirSync(chats)) {
        const ext = f.endsWith(".jsonl") ? ".jsonl" : f.endsWith(".json") ? ".json" : null;
        if (!ext) continue;
        const path = join(chats, f);
        files++;
        try {
          const st = statSync(path);
          const key = `${st.size}:${st.mtimeMs}`;
          if (getCursor<string>(SOURCE, path) === key) continue;
          const doc = readChat(readFileSync(path, "utf8"), ext);
          db.transaction(() => {
            ingestSession(doc, names[proj.name] ?? proj.name);
            setCursor(SOURCE, path, key);
          })();
        } catch (err) {
          console.error(`gemini: ${f}: ${(err as Error).message}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    }
    detail = `${tmp} (${files} chats)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
