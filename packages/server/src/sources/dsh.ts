import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { db, getCursor, setCursor } from "../db.js";
import { MAX_TOOL_OUTPUT, closeTurn, ensureSession, iso, openTurn, putEvent, textOf, touch } from "./emit.js";
import type { Source } from "./types.js";

// dsh writes ~/.dsh/sessions/<encoded-cwd>/session-<id>/session.jsonl.zstd:
// one zstd frame per JSONL record, appended as the session runs.

const SOURCE = "dsh";
const MAGIC = 0xfd2fb528;

// Node's zstd decoder stops at the first frame, so split on frame magics and
// decode each. A magic inside compressed data makes a chunk fail to decode; it
// is then merged with the next chunk. A trailing partial frame is left alone.
export function decompressFrames(buf: Buffer): string {
  const out: Buffer[] = [];
  let start = 0;
  const tryFlush = (end: number) => {
    try {
      out.push(zstdDecompressSync(buf.subarray(start, end)));
      start = end;
    } catch {
      // not a frame boundary; keep accumulating
    }
  };
  for (let i = 4; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === MAGIC) tryFlush(i);
  tryFlush(buf.length);
  return Buffer.concat(out).toString("utf8");
}

type FileState = { size: number; lines: number; turn_id?: string; cwd?: string; created_at?: string };

export function ingestRecords(sessionId: string, records: any[], state: FileState) {
  const eid = (seq: number | string) => `dsh:${sessionId}:${seq}`;
  let last: string | undefined;
  for (const r of records) {
    const at = r.time != null ? iso(r.time) : r.createdAt != null ? iso(r.createdAt) : null;
    if (at) last = at;
    const d = r.data ?? {};
    switch (r.type) {
      case "session":
        // Sessions are listed once they have a prompt; dsh writes a header
        // for every launch, prompted or not.
        state.cwd = r.cwd;
        state.created_at = at ?? undefined;
        break;
      case "session/title":
        if (d.title) db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(d.title, sessionId);
        break;
      case "turn/start":
        state.turn_id = eid(`t${d.turn}`);
        openTurn(state.turn_id, sessionId, at!);
        break;
      case "user/message":
        if (!state.turn_id) break;
        ensureSession({
          id: sessionId,
          source: SOURCE,
          agent_name: state.cwd ? basename(state.cwd) : SOURCE,
          title: textOf(d.content).slice(0, 80),
          created_at: state.created_at ?? at ?? iso(Date.now()),
        });
        putEvent({ id: eid(r.seq), session_id: sessionId, turn_id: state.turn_id, type: "turn.created", created_at: at,
          raw: { input: [{ type: "user.message", content: textOf(d.content) }] } });
        break;
      case "assistant/message": {
        if (!state.turn_id) break;
        const blocks: any[] = d.message?.content ?? [];
        putEvent({ id: eid(r.seq), session_id: sessionId, turn_id: state.turn_id, type: "model.message", created_at: at,
          raw: {
            content: blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n"),
            toolCalls: blocks.filter((b) => b.type === "tool-call").map((b) => ({
              id: b.id, function: { name: b.name, arguments: typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? {}) },
            })),
            usage: d.usage ? { inputTokens: d.usage.inputTokens ?? 0, outputTokens: d.usage.outputTokens ?? 0 } : undefined,
          } });
        break;
      }
      case "tool/result": {
        if (!state.turn_id) break;
        const blocks: any[] = d.message?.content ?? [];
        blocks.filter((b) => b.type === "tool-result").forEach((b, i) =>
          putEvent({ id: eid(i ? `${r.seq}:${i}` : r.seq), session_id: sessionId, turn_id: state.turn_id!, type: "tool.response", created_at: at,
            raw: { content: textOf(b.content).slice(0, MAX_TOOL_OUTPUT), toolCallId: b.toolCallId, error: b.isError === true } }));
        break;
      }
      case "turn/end": {
        if (!state.turn_id) break;
        const kind = d.reason?.kind;
        const status = kind === "completed" ? "done" : kind === "interrupted" ? "cancelled" : "error";
        closeTurn(state.turn_id, status, at, status === "error" ? (d.reason?.message ?? kind ?? null) : null);
        putEvent({ id: eid(r.seq), session_id: sessionId, turn_id: state.turn_id, type: "turn.done", created_at: at, raw: { state: { status } } });
        state.turn_id = undefined;
        break;
      }
    }
  }
  if (last) touch(sessionId, last);
}

export function createDsh(home: string): Source {
  const dir = join(home, "sessions");
  let detail = dir;
  async function poll() {
    let files = 0;
    for (const proj of readdirSync(dir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      for (const sess of readdirSync(join(dir, proj.name), { withFileTypes: true })) {
        if (!sess.isDirectory() || !sess.name.startsWith("session-")) continue;
        const path = join(dir, proj.name, sess.name, "session.jsonl.zstd");
        const sessionId = sess.name.slice("session-".length);
        files++;
        try {
          const size = statSync(path).size;
          const state = getCursor<FileState>(SOURCE, path) ?? { size: 0, lines: 0 };
          if (size === state.size) continue;
          if (size < state.size) Object.assign(state, { size: 0, lines: 0, turn_id: undefined });
          const lines = decompressFrames(readFileSync(path)).split("\n").filter(Boolean);
          const fresh = lines.slice(state.lines).flatMap((l) => {
            try { return [JSON.parse(l)]; } catch { return []; }
          });
          db.transaction(() => {
            ingestRecords(sessionId, fresh, state);
            state.size = size;
            state.lines = lines.length;
            setCursor(SOURCE, path, state);
          })();
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`dsh: ${sessionId}: ${(err as Error).message}`);
        }
        await new Promise((r) => setImmediate(r));
      }
    }
    detail = `${dir} (${files} sessions)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
