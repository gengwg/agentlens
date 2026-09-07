import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { db, getCursor, setCursor } from "../db.js";
import { MAX_TOOL_OUTPUT, closeTurn, ensureSession, openTurn, putEvent, textOf, touch } from "./emit.js";
import type { Source } from "./types.js";

// Antigravity CLI (agy) writes one conversation per directory under
// ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl:
// steps {type, status, source, step_index, created_at, content | thinking |
// tool_calls[{name,args}]}. No token usage is recorded. history.jsonl maps a
// conversation to its workspace path.

const SOURCE = "antigravity";
type FileState = { size: number; lines: number; turn_id?: string };

export function ingestSteps(sessionId: string, steps: any[], state: FileState, workspace?: string) {
  const eid = (i: number | string) => `agy:${sessionId}:${i}`;
  let last: string | undefined;
  let lastPlanner: any;
  for (const s of steps) {
    const at: string | null = s.created_at ?? null;
    if (at) last = at;
    if (s.type === "USER_INPUT") {
      const text = textOf(s.content);
      ensureSession({ id: sessionId, source: SOURCE, agent_name: workspace ? basename(workspace) : SOURCE, title: text.slice(0, 80), created_at: at ?? new Date().toISOString() });
      if (state.turn_id) closeTurn(state.turn_id, "done", null);
      state.turn_id = eid(`t${s.step_index}`);
      openTurn(state.turn_id, sessionId, at!);
      putEvent({ id: eid(s.step_index), session_id: sessionId, turn_id: state.turn_id, type: "turn.created", created_at: at,
        raw: { input: [{ type: "user.message", content: text }] } });
      lastPlanner = undefined;
    } else if (!state.turn_id) {
      continue;
    } else if (s.type === "PLANNER_RESPONSE") {
      lastPlanner = s;
      putEvent({ id: eid(s.step_index), session_id: sessionId, turn_id: state.turn_id, type: "model.message", created_at: at,
        raw: {
          content: textOf(s.content ?? ""),
          toolCalls: (s.tool_calls ?? []).map((c: any, i: number) => ({ id: `${s.step_index}.${i}`, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        } });
    } else if (s.type !== "CHECKPOINT" && s.type !== "CONVERSATION_HISTORY" && (s.content != null || s.status === "ERROR")) {
      // Tool execution steps (GENERIC, RUN_COMMAND, ...) carry the output.
      putEvent({ id: eid(s.step_index), session_id: sessionId, turn_id: state.turn_id, type: "tool.response", created_at: at,
        raw: { content: textOf(s.content ?? "").slice(0, MAX_TOOL_OUTPUT), error: s.status === "ERROR" } });
    }
  }
  // A final text-only planner step means the model answered; otherwise the
  // turn stays running until the next input or the stale sweep.
  if (state.turn_id && lastPlanner && lastPlanner.content && !(lastPlanner.tool_calls ?? []).length && lastPlanner.status === "DONE") {
    closeTurn(state.turn_id, "done", lastPlanner.created_at ?? null);
    putEvent({ id: eid(`${lastPlanner.step_index}:done`), session_id: sessionId, turn_id: state.turn_id, type: "turn.done", created_at: lastPlanner.created_at ?? null, raw: { state: { status: "done" } } });
    state.turn_id = undefined;
  }
  if (last) touch(sessionId, last);
}

// history.jsonl covers interactive runs; conversation_summaries.db has a row per
// conversation the CLI summarized (workspace_uris is a JSON list of file:// URIs).
// Neither covers every run: on a machine with three conversations only one had a
// row, and the others record their workspace nowhere on disk, so they fall back
// to the source name.
function workspaces(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const dbPath = join(home, "conversation_summaries.db");
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      for (const r of db.prepare(`SELECT conversation_id, workspace_uris FROM conversation_summaries`).all() as any[]) {
        try {
          const uri = JSON.parse(r.workspace_uris)[0];
          if (uri) out[r.conversation_id] = uri.startsWith("file://") ? fileURLToPath(uri) : uri;
        } catch {
          // unparseable row
        }
      }
      db.close();
    } catch {
      // schema drift; history.jsonl still applies
    }
  }
  try {
    for (const line of readFileSync(join(home, "history.jsonl"), "utf8").split("\n")) {
      try {
        const r = JSON.parse(line);
        if (r.conversationId && r.workspace) out[r.conversationId] = r.workspace;
      } catch {
        // partial line
      }
    }
  } catch {
    // no history yet
  }
  return out;
}

export function createAntigravity(home: string): Source {
  const brain = join(home, "brain");
  let detail = brain;
  async function poll() {
    const ws = workspaces(home);
    let n = 0;
    for (const conv of readdirSync(brain, { withFileTypes: true })) {
      if (!conv.isDirectory()) continue;
      const path = join(brain, conv.name, ".system_generated", "logs", "transcript.jsonl");
      if (!existsSync(path)) continue;
      n++;
      try {
        const size = statSync(path).size;
        const state = getCursor<FileState>(SOURCE, path) ?? { size: 0, lines: 0 };
        if (size === state.size) continue;
        // Turn status depends on the last step, so re-read the whole file (small).
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        const steps = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
        db.transaction(() => {
          ingestSteps(conv.name, steps, { ...state, turn_id: undefined }, ws[conv.name]);
          setCursor(SOURCE, path, { size, lines: lines.length });
        })();
      } catch (err) {
        console.error(`antigravity: ${conv.name}: ${(err as Error).message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    detail = `${brain} (${n} conversations)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
