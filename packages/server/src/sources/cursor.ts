import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { db, getCursor, setCursor } from "../db.js";
import { closeTurn, ensureSession, iso, openTurn, putEvent, textOf, touch } from "./emit.js";
import type { Source } from "./types.js";

// Cursor Agent CLI writes ~/.cursor/projects/<encoded-cwd>/agent-transcripts/<chat>/<chat>.jsonl:
// {role, message:{content:[{type:"text"}|{type:"tool_use",name,input}]}} lines and
// {type:"turn_ended", status}. Lines carry no timestamps; ~/.cursor/chats/*/<chat>/meta.json
// has createdAtMs/updatedAtMs/cwd/title, so event times are interpolated
// between those two. Tool results and token usage are not recorded.

const SOURCE = "cursor";
type Meta = { createdAtMs?: number; updatedAtMs?: number; cwd?: string; title?: string };

export function ingestTranscript(chatId: string, lines: any[], meta: Meta) {
  if (!lines.length) return;
  const eid = (i: number | string) => `cursor:${chatId}:${i}`;
  const t0 = meta.createdAtMs ?? Date.now();
  const t1 = meta.updatedAtMs ?? t0;
  const at = (i: number) => iso(t0 + ((t1 - t0) * i) / Math.max(lines.length - 1, 1));
  const firstUser = lines.find((l) => l.role === "user");
  ensureSession({ id: chatId, source: SOURCE, cwd: meta.cwd, agent_name: meta.cwd ? basename(meta.cwd) : SOURCE,
    title: meta.title ?? (firstUser ? textOf(firstUser.message?.content).slice(0, 80) : null), created_at: iso(t0), updated_at: iso(t1) });
  let turn: string | undefined;
  lines.forEach((l, i) => {
    if (l.role === "user") {
      if (turn) closeTurn(turn, "done", null);
      turn = eid(`t${i}`);
      openTurn(turn, chatId, at(i));
      putEvent({ id: eid(i), session_id: chatId, turn_id: turn, type: "turn.created", created_at: at(i),
        raw: { input: [{ type: "user.message", content: textOf(l.message?.content) }] } });
    } else if (!turn) {
      return;
    } else if (l.role === "assistant") {
      const blocks: any[] = Array.isArray(l.message?.content) ? l.message.content : [];
      putEvent({ id: eid(i), session_id: chatId, turn_id: turn, type: "model.message", created_at: at(i),
        raw: {
          content: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
          toolCalls: blocks.filter((b) => b.type === "tool_use").map((b, j) => ({ id: b.id ?? `${i}.${j}`, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })),
        } });
    } else if (l.type === "turn_ended") {
      const status = l.status === "success" ? "done" : l.status === "cancelled" || l.status === "aborted" ? "cancelled" : "error";
      closeTurn(turn, status, at(i), status === "error" ? String(l.status) : null);
      putEvent({ id: eid(i), session_id: chatId, turn_id: turn, type: "turn.done", created_at: at(i), raw: { state: { status } } });
      turn = undefined;
    }
  });
  touch(chatId, iso(t1));
}

function findMeta(home: string, chatId: string): Meta {
  const chats = join(home, "chats");
  try {
    for (const ws of readdirSync(chats)) {
      const p = join(chats, ws, chatId, "meta.json");
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
    }
  } catch {
    // no chats dir
  }
  return {};
}

export function createCursor(home: string): Source {
  const projects = join(home, "projects");
  let detail = projects;
  async function poll() {
    let n = 0;
    for (const proj of readdirSync(projects, { withFileTypes: true })) {
      const dir = join(projects, proj.name, "agent-transcripts");
      if (!proj.isDirectory() || !existsSync(dir)) continue;
      for (const chat of readdirSync(dir)) {
        const path = join(dir, chat, `${chat}.jsonl`);
        if (!existsSync(path)) continue;
        n++;
        try {
          const size = statSync(path).size;
          const meta = findMeta(home, chat);
          const key = `${size}:${meta.updatedAtMs ?? 0}`;
          if (getCursor<string>(SOURCE, path) === key) continue;
          const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
          db.transaction(() => {
            ingestTranscript(chat, lines, meta);
            setCursor(SOURCE, path, key);
          })();
        } catch (err) {
          console.error(`cursor: ${chat}: ${(err as Error).message}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    }
    detail = `${projects} (${n} chats)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
