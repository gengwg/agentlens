import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { db, getCursor, insertEvent, setCursor, turnAt, upsertSession, upsertTurn } from "../db.js";
import type { Source } from "./types.js";

// Claude Code writes ~/.claude/projects/<encoded-cwd>/<session>.jsonl, one JSON
// record per line, append-only. Subagent transcripts live next to it under
// <session>/subagents/agent-<id>.jsonl. Records are translated into the same
// event vocabulary TrueForge produces so the store and UI need no changes.

const SOURCE = "claude-code";
const MAX_TOOL_OUTPUT = 64 * 1024;

export type FileState = {
  offset: number;
  turn_id?: string;
  turn_at?: string;
  msg_id?: string;
  usage_due?: boolean;
  title?: string;
  first_prompt?: string;
  started?: boolean;
};

export type Ctx = {
  sessionId: string;
  // null for the main transcript, agent id for a subagent file
  threadId: string | null;
  threadTitle?: string;
};

// Forked/resumed sessions copy the parent's records verbatim (same uuids), so
// ids are namespaced by session. promptId is not unique per prompt either.
const eid = (ctx: Ctx, key: string) => `cc:${ctx.sessionId}:${key}`;

export function readNewLines(path: string, offset: number): { lines: string[]; offset: number } {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0;
    if (size === offset) return { lines: [], offset };
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    // Leave a trailing partial line (no newline yet) for the next read.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return { lines: [], offset };
    const lines = buf.subarray(0, end).toString("utf8").split("\n").filter(Boolean);
    return { lines, offset: offset + end + 1 };
  } finally {
    closeSync(fd);
  }
}

const sessionExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
const touchSession = db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ? AND updated_at < ?`);
const setTitle = db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`);
const closeTurn = db.prepare(
  `UPDATE turns SET status = CASE WHEN status = 'error' THEN 'error' ELSE ? END, completed_at = ? WHERE id = ?`,
);
// A turn ended by the next prompt (no turn_duration record) ends at its last
// event, not at the prompt, so idle time is not counted as duration.
const closeAtLastEvent = db.prepare(`
  UPDATE turns SET status = CASE WHEN status = 'error' THEN 'error' ELSE 'done' END,
    completed_at = COALESCE((SELECT MAX(created_at) FROM events e WHERE e.turn_id = turns.id), ?)
  WHERE id = ?
`);
const failTurn = db.prepare(`UPDATE turns SET status = 'error', error = ? WHERE id = ?`);
const turnStatus = db.prepare(`SELECT status FROM turns WHERE id = ?`);

const textOf = (content: any): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
};

// Slash commands arrive as XML-ish blocks; show "/name args" instead.
const titleOf = (text: string): string => {
  const m = text.match(/^<command-name>([^<]*)<\/command-name>/);
  if (!m) return text.slice(0, 80);
  const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1].trim();
  return `${m[1].trim()}${args ? ` ${args}` : ""}`.slice(0, 80);
};

const isPrompt = (r: any) =>
  r.type === "user" &&
  !r.isCompactSummary &&
  !r.isSidechain &&
  !(Array.isArray(r.message?.content) && r.message.content.some((b: any) => b.type === "tool_result"));

function event(ctx: Ctx, turnId: string, id: string, type: string, at: string | null, raw: unknown) {
  insertEvent.run({
    id,
    session_id: ctx.sessionId,
    turn_id: turnId,
    thread_id: ctx.threadId,
    type,
    created_at: at,
    raw: JSON.stringify(raw),
  });
}

function openTurn(ctx: Ctx, state: FileState, key: string, at: string | null) {
  state.turn_id = eid(ctx, key);
  state.turn_at = at ?? undefined;
  upsertTurn.run({
    id: state.turn_id,
    session_id: ctx.sessionId,
    created_at: at,
    completed_at: null,
    status: "running",
    error: null,
    ingested: 1,
    pending_actions: 0,
  });
}

// Pure mapping layer: applies parsed records to the store, mutating `state`.
// The caller wraps it in a transaction together with the cursor write.
export function ingestRecords(ctx: Ctx, records: any[], state: FileState) {
  let lastAt: string | undefined;
  for (const r of records) {
    if (r.timestamp) lastAt = r.timestamp;
    const at = r.timestamp ?? null;

    if (r.type === "ai-title" || r.type === "custom-title") {
      state.title = r.aiTitle ?? r.customTitle ?? state.title;
      if (state.title && sessionExists.get(ctx.sessionId)) setTitle.run(state.title, ctx.sessionId);
      continue;
    }

    if (isPrompt(r)) {
      if (ctx.threadId) continue; // the subagent's own prompt is the parent's tool call
      // isMeta marks injected content (skills, caveats) inside a turn, but
      // remote-control sessions flag real prompts the same way, so it only
      // matters while a turn is open.
      if (r.isMeta && state.turn_id) continue;
      const text = textOf(r.message?.content);
      if (text.startsWith("<local-command")) continue;
      if (text.startsWith("[Request interrupted by user")) {
        if (state.turn_id) closeTurn.run("cancelled", at, state.turn_id);
        state.turn_id = undefined;
        continue;
      }
      if (state.turn_id) closeAtLastEvent.run(at, state.turn_id);
      state.first_prompt ??= titleOf(text);
      openTurn(ctx, state, r.uuid, at);
      event(ctx, state.turn_id!, eid(ctx, r.uuid), "turn.created", at, {
        input: [{ type: "user.message", content: text }],
      });
      continue;
    }

    if (r.type !== "assistant" && r.type !== "user" && !(r.type === "system" && r.subtype === "turn_duration")) continue;
    // Model output with no open turn (continuation after compaction, records
    // the harness did not mark as a prompt): open a turn so nothing is lost.
    if (!state.turn_id) {
      if (r.type === "system") continue;
      openTurn(ctx, state, r.uuid, at);
    }
    const turnId = state.turn_id!;

    if (r.type === "assistant") {
      const m = r.message ?? {};
      const blocks: any[] = Array.isArray(m.content) ? m.content : [];
      // One API message is split across several records (thinking, text,
      // tool_use), each repeating the same usage. Count it once, on the first
      // record that renders (thinking-only records are skipped).
      if (m.id !== state.msg_id) {
        state.msg_id = m.id;
        state.usage_due = true;
      }
      const content = textOf(blocks);
      const toolCalls = blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      if (!content && toolCalls.length === 0) continue;
      // Sessions appear once the model has replied; a transcript holding only
      // local slash commands (/clear, /mcp ...) is not a session worth listing.
      if (!ctx.threadId && !sessionExists.get(ctx.sessionId)) {
        upsertSession.run({
          id: ctx.sessionId,
          agent_name: r.cwd ? basename(r.cwd) : SOURCE,
          title: state.title ?? state.first_prompt ?? null,
          created_at: state.turn_at ?? at,
          updated_at: at,
          created_by: userInfo().username,
          source: SOURCE,
        });
      }
      const u = m.usage;
      const raw: any = { content, toolCalls, model: m.model };
      if (state.usage_due && u) {
        raw.usage = {
          inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
          outputTokens: u.output_tokens ?? 0,
        };
        state.usage_due = false;
      }
      if (r.isApiErrorMessage && !ctx.threadId) failTurn.run(content.slice(0, 500), turnId);
      event(ctx, turnId, eid(ctx, r.uuid), "model.message", at, raw);
      continue;
    }

    if (r.type === "user") {
      const blocks: any[] = Array.isArray(r.message?.content) ? r.message.content : [];
      blocks
        .filter((b) => b.type === "tool_result")
        .forEach((b, i) => {
          event(ctx, turnId, eid(ctx, i ? `${r.uuid}:${i}` : r.uuid), "tool.response", at, {
            content: textOf(b.content).slice(0, MAX_TOOL_OUTPUT),
            toolCallId: b.tool_use_id,
            error: b.is_error === true,
          });
        });
      continue;
    }

    if (r.type === "system" && r.subtype === "turn_duration" && !ctx.threadId) {
      closeTurn.run("done", at, turnId);
      const status = (turnStatus.get(turnId) as { status: string } | undefined)?.status ?? "done";
      event(ctx, turnId, eid(ctx, r.uuid), "turn.done", at, { state: { status, durationMs: r.durationMs } });
      state.turn_id = undefined;
    }
  }
  if (lastAt) touchSession.run(lastAt, ctx.sessionId, lastAt);
}

function parseLines(lines: string[], path: string): any[] {
  const out: any[] = [];
  let bad = 0;
  for (const l of lines) {
    try {
      out.push(JSON.parse(l));
    } catch {
      bad++;
    }
  }
  if (bad) console.error(`claude-code: ${bad} unparseable line(s) in ${basename(path)}`);
  return out;
}

function ingestFile(path: string, ctx: Ctx) {
  const state: FileState = getCursor<FileState>(SOURCE, path) ?? { offset: 0 };
  const { lines, offset } = readNewLines(path, state.offset);
  if (offset < state.offset) Object.assign(state, { offset: 0, turn_id: undefined, msg_id: undefined, usage_due: false, started: false });
  if (lines.length === 0) return;
  const records = parseLines(lines, path);

  if (ctx.threadId && !state.turn_id) {
    // Attach the subagent to whichever parent turn was open when it started.
    const firstAt = records.find((r) => r.timestamp)?.timestamp;
    const parentTurn = firstAt && turnAt(ctx.sessionId, firstAt);
    if (!parentTurn) return; // parent not ingested yet, retry next tick
    state.turn_id = parentTurn;
  }

  db.transaction(() => {
    if (ctx.threadId && !state.started) {
      const at = records.find((r) => r.timestamp)?.timestamp ?? null;
      event(ctx, state.turn_id!, eid(ctx, `thread:${ctx.threadId}`), "thread.created", at, {
        title: ctx.threadTitle ?? ctx.threadId,
        threadId: ctx.threadId,
      });
      state.started = true;
    }
    ingestRecords(ctx, records, state);
    state.offset = offset;
    setCursor(SOURCE, path, state);
  })();
}

function subagentTitle(metaPath: string, agentId: string): string {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return meta.description ?? meta.agentType ?? agentId;
  } catch {
    return agentId;
  }
}

export function createClaudeCode(projectsDir: string): Source {
  let detail = projectsDir;
  async function poll() {
    let files = 0;
    for (const proj of readdirSync(projectsDir, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = join(projectsDir, proj.name);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        files++;
        const sessionId = f.slice(0, -".jsonl".length);
        ingestFile(join(dir, f), { sessionId, threadId: null });
        const subDir = join(dir, sessionId, "subagents");
        if (existsSync(subDir)) {
          for (const sf of readdirSync(subDir)) {
            if (!sf.startsWith("agent-") || !sf.endsWith(".jsonl")) continue;
            const agentId = sf.slice("agent-".length, -".jsonl".length);
            ingestFile(join(subDir, sf), {
              sessionId,
              threadId: agentId,
              threadTitle: subagentTitle(join(subDir, `agent-${agentId}.meta.json`), agentId),
            });
          }
        }
        // Yield so the first full-history ingest does not stall the API.
        await new Promise((r) => setImmediate(r));
      }
    }
    detail = `${projectsDir} (${files} sessions)`;
  }
  return { name: SOURCE, poll, status: () => ({ ok: true, detail }) };
}
