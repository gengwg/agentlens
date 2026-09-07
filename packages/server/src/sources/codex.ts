import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { db, getCursor, setCursor, upsertEvent } from "../db.js";
import { readNewLines } from "./claude-code.js";
import { MAX_TOOL_OUTPUT, closeOpenTurns, closeTurn, ensureSession, openTurn, putEvent, textOf, touch, usageOf } from "./emit.js";
import type { Source } from "./types.js";

// Experimental: OpenAI Codex CLI rollouts, ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
// Lines are {timestamp, type: session_meta | response_item | event_msg | turn_context, payload}.
// Written from the public format, not yet validated against real logs.

const SOURCE = "codex";
type FileState = { offset: number; session_id?: string; turn_id?: string; n: number; last_model?: string };

export function ingestRecords(fileId: string, records: any[], state: FileState) {
  let last: string | undefined;
  for (const r of records) {
    const at = r.timestamp ?? null;
    if (at) last = at;
    const p = r.payload ?? {};
    if (r.type === "session_meta") {
      const id = (state.session_id = String(p.id ?? fileId));
      ensureSession({ id, source: SOURCE, cwd: p.cwd, agent_name: p.cwd ? basename(p.cwd) : SOURCE, created_at: p.timestamp ?? at ?? new Date().toISOString() });
      continue;
    }
    const sid = (state.session_id ??= fileId);
    const eid = () => `codex:${sid}:${state.n++}`;
    if (r.type === "response_item") {
      if (p.type === "message" && p.role === "user") {
        const text = textOf(p.content);
        // Codex injects environment and instruction blocks as user messages.
        if (!text || text.startsWith("<")) continue;
        ensureSession({ id: sid, source: SOURCE, agent_name: SOURCE, created_at: at ?? new Date().toISOString(), title: text.slice(0, 80) });
        closeOpenTurns(sid, at);
        state.turn_id = eid();
        openTurn(state.turn_id, sid, at);
        putEvent({ id: eid(), session_id: sid, turn_id: state.turn_id, type: "turn.created", created_at: at,
          raw: { input: [{ type: "user.message", content: text }] } });
      } else if (!state.turn_id) {
        continue;
      } else if (p.type === "message" && p.role === "assistant") {
        state.last_model = eid();
        putEvent({ id: state.last_model, session_id: sid, turn_id: state.turn_id, type: "model.message", created_at: at,
          raw: { content: textOf(p.content), toolCalls: [] } });
      } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
        state.last_model = eid();
        const args = p.arguments ?? p.input ?? JSON.stringify(p.action ?? {});
        putEvent({ id: state.last_model, session_id: sid, turn_id: state.turn_id, type: "model.message", created_at: at,
          raw: { content: "", toolCalls: [{ id: p.call_id, function: { name: p.name ?? p.type, arguments: typeof args === "string" ? args : JSON.stringify(args) } }] } });
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
        const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output ?? "");
        putEvent({ id: eid(), session_id: sid, turn_id: state.turn_id, type: "tool.response", created_at: at,
          raw: { content: out.slice(0, MAX_TOOL_OUTPUT), toolCallId: p.call_id, error: /exit code: [1-9]|error/i.test(out.slice(0, 200)) && /"exit_code":\s*[1-9]|exited with|Error:/.test(out) } });
      }
    } else if (r.type === "event_msg" && state.turn_id) {
      if (p.type === "token_count" && state.last_model) {
        const u = p.info?.last_token_usage ?? p.info?.total_token_usage ?? p;
        const row = db.prepare(`SELECT raw FROM events WHERE id = ?`).get(state.last_model) as { raw: string } | undefined;
        if (row) {
          const raw = JSON.parse(row.raw);
          raw.usage = usageOf({ input: u.input_tokens, output: (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0), cacheRead: u.cached_input_tokens });
          upsertEvent.run({ id: state.last_model, session_id: sid, turn_id: state.turn_id, thread_id: null, type: "model.message", created_at: at, raw: JSON.stringify(raw) });
        }
      } else if (p.type === "task_complete" || p.type === "turn_aborted") {
        const status = p.type === "task_complete" ? "done" : "cancelled";
        closeTurn(state.turn_id, status, at);
        putEvent({ id: eid(), session_id: sid, turn_id: state.turn_id, type: "turn.done", created_at: at, raw: { state: { status } } });
        state.turn_id = undefined;
      } else if (p.type === "error") {
        closeTurn(state.turn_id, "error", at, p.message ?? "error");
      }
    }
  }
  if (state.session_id && last) touch(state.session_id, last);
}

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith(".jsonl")) yield p;
  }
}

export function createCodex(home: string): Source {
  const dir = join(home, "sessions");
  let detail = dir;
  async function poll() {
    let files = 0;
    for (const path of walk(dir)) {
      files++;
      try {
        const state = getCursor<FileState>(SOURCE, path) ?? { offset: 0, n: 0 };
        const { lines, offset } = readNewLines(path, state.offset);
        if (offset < state.offset) Object.assign(state, { offset: 0, n: 0, turn_id: undefined, session_id: undefined });
        if (!lines.length) continue;
        const recs = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
        const fileId = basename(path, ".jsonl").replace(/^rollout-/, "");
        db.transaction(() => {
          ingestRecords(fileId, recs, state);
          state.offset = offset;
          setCursor(SOURCE, path, state);
        })();
      } catch (err) {
        console.error(`codex: ${basename(path)}: ${(err as Error).message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    detail = `${dir} (${files} rollouts)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
