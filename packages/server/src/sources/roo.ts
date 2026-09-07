import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { db, getCursor, setCursor } from "../db.js";
import { MAX_TOOL_OUTPUT, closeTurn, ensureSession, openTurn, putEvent, textOf, touch } from "./emit.js";
import type { Source } from "./types.js";

// Roo Code and Cline (VS Code extensions). Each task lives in
// <globalStorage>/<extension>/tasks/<taskId>/ with api_conversation_history.json
// (Anthropic-style messages), ui_messages.json (per-request token usage) and
// history_item.json (task metadata, including the workspace). Validated against
// real Roo Code tasks, which use the native tool protocol; the XML protocol
// below is still handled but has not been seen in the wild here. Cline shares
// the layout and remains unvalidated.

type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type ApiMsg = { role: "user" | "assistant"; content: Block[] | string; ts?: number };
type UiMsg = { ts: number; type: string; say?: string; ask?: string; text?: string };

const isPrompt = (text: string) => /<task>|<user_message>|<feedback>|<user_feedback>/.test(text);
const stripTags = (text: string) => text.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, "").replace(/<\/?[a-z_]+>/g, "").trim();

// A turn ends at attempt_completion, which real tasks call as a native tool and
// the XML protocol writes as an element. A task can complete more than once (the
// user replies without a tagged prompt), so an assistant message with no open
// turn opens one rather than being dropped. A task interrupted mid-tool has no
// completion at all and stays running.
const reopenTurn = db.prepare(`UPDATE turns SET status = 'running', completed_at = NULL WHERE id = ? AND status = 'done'`);

export function ingestTask(source: string, taskId: string, api: ApiMsg[], ui: UiMsg[], workspace?: string) {
  if (!api.length) return;
  const sid = taskId;
  const at = (m: ApiMsg, i: number) => new Date(m.ts ?? ui[0]?.ts ?? Number(taskId) + i).toISOString();
  const usages = ui.filter((u) => u.say === "api_req_started" && u.text).map((u) => { try { return JSON.parse(u.text!); } catch { return {}; } });
  const cwd = ui.map((u) => u.text ?? "").join("\n").match(/Current Work(?:ing|space) Directory \(([^)]+)\)/)?.[1];
  const first = api.find((m) => m.role === "user");
  const firstText = first ? stripTags(textOf(first.content)) : "";
  const home = workspace ?? cwd;
  ensureSession({ id: sid, source, agent_name: home ? basename(home) : source, title: firstText.slice(0, 80) || null, created_at: at(api[0], 0) });
  let turn: string | undefined;
  let n = 0;
  let assistantIdx = 0;
  let last: { time: string; calling: boolean } | undefined;
  // A completed turn stays addressable: the tool result acknowledging
  // attempt_completion belongs to it, while the next model message starts a new one.
  let closed = false;
  api.forEach((m, i) => {
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    const time = at(m, i);
    const eid = () => `${source}:${sid}:${n++}`;
    if (m.role === "user") {
      const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "");
      const prompt = texts.find(isPrompt);
      if (prompt) {
        if (turn) closeTurn(turn, "done", null);
        turn = eid();
        closed = false;
        openTurn(turn, sid, time);
        putEvent({ id: eid(), session_id: sid, turn_id: turn, type: "turn.created", created_at: time,
          raw: { input: [{ type: "user.message", content: stripTags(prompt).slice(0, 4000) }] } });
      }
      if (!turn) return;
      for (const b of blocks) {
        if (b.type === "tool_result") {
          putEvent({ id: eid(), session_id: sid, turn_id: turn, type: "tool.response", created_at: time,
            raw: { content: textOf(b.content).slice(0, MAX_TOOL_OUTPUT), toolCallId: b.tool_use_id, error: b.is_error === true } });
        } else if (b.type === "text" && b.text && !isPrompt(b.text) && /^\[[^\]]+\] Result:/.test(b.text)) {
          // XML-protocol tool results arrive as text: "[read_file for 'x'] Result: ..."
          putEvent({ id: eid(), session_id: sid, turn_id: turn, type: "tool.response", created_at: time,
            raw: { content: stripTags(b.text).slice(0, MAX_TOOL_OUTPUT), error: /^\[[^\]]+\] Result:\s*(Error|The tool execution failed)/i.test(b.text) } });
        }
      }
      return;
    }
    if (!turn || closed) {
      turn = eid();
      closed = false;
      openTurn(turn, sid, time);
    }
    const u = usages[assistantIdx++];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
    const toolCalls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
    // XML protocol: the tool call is an XML element in the text.
    const xml = toolCalls.length ? null : text.match(/<(read_file|write_to_file|apply_diff|execute_command|search_files|list_files|browser_action|use_mcp_tool|access_mcp_resource|ask_followup_question|attempt_completion|new_task|insert_content|search_and_replace|codebase_search|update_todo_list|switch_mode|fetch_instructions)>/);
    putEvent({ id: eid(), session_id: sid, turn_id: turn, type: "model.message", created_at: time,
      raw: {
        content: xml ? text.slice(0, text.indexOf(`<${xml[1]}>`)).trim() : text,
        toolCalls: xml ? [{ id: `xml-${n}`, function: { name: xml[1], arguments: text.slice(text.indexOf(`<${xml[1]}>`)).slice(0, 400) } }] : toolCalls,
        usage: u ? { inputTokens: (u.tokensIn ?? 0) + (u.cacheReads ?? 0) + (u.cacheWrites ?? 0), outputTokens: u.tokensOut ?? 0 } : undefined,
        cost: u?.cost,
      } });
    last = { time, calling: toolCalls.length > 0 || !!xml };
    if (xml?.[1] === "attempt_completion" || toolCalls.some((c) => c.function.name === "attempt_completion")) {
      closeTurn(turn, "done", time);
      putEvent({ id: eid(), session_id: sid, turn_id: turn, type: "turn.done", created_at: time, raw: { state: { status: "done" } } });
      closed = true;
    }
  });
  if (turn && !closed && last) {
    if (last.calling) reopenTurn.run(turn);
    else {
      closeTurn(turn, "done", last.time);
      // Stable id: a resumed task rewrites this row rather than adding a second.
      putEvent({ id: `${source}:${sid}:done`, session_id: sid, turn_id: turn, type: "turn.done", created_at: last.time, raw: { state: { status: "done" } } });
    }
  }
  const lastTs = ui[ui.length - 1]?.ts ?? api[api.length - 1].ts;
  if (lastTs) touch(sid, new Date(lastTs).toISOString());
}

// Extension ids for Roo Code and Cline across VS Code flavors.
export const ROO_STORAGES = [
  ["roo-code", "rooveterinaryinc.roo-cline"],
  ["cline", "saoudrizwan.claude-dev"],
] as const;
export const VSCODE_DIRS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

export function createRoo(source: string, tasksDir: string): Source {
  let detail = tasksDir;
  async function poll() {
    let n = 0;
    for (const t of readdirSync(tasksDir, { withFileTypes: true })) {
      if (!t.isDirectory()) continue;
      const dir = join(tasksDir, t.name);
      const apiPath = join(dir, "api_conversation_history.json");
      const uiPath = join(dir, "ui_messages.json");
      const itemPath = join(dir, "history_item.json");
      if (!existsSync(apiPath)) continue;
      n++;
      try {
        const key = [apiPath, uiPath].map((p) => (existsSync(p) ? `${statSync(p).size}:${statSync(p).mtimeMs}` : "-")).join("|");
        if (getCursor<string>(source, dir) === key) continue;
        const api = JSON.parse(readFileSync(apiPath, "utf8"));
        const ui = existsSync(uiPath) ? JSON.parse(readFileSync(uiPath, "utf8")) : [];
        const workspace = existsSync(itemPath)
          ? (JSON.parse(readFileSync(itemPath, "utf8")).workspace as string | undefined)
          : undefined;
        db.transaction(() => {
          ingestTask(source, t.name, api, ui, workspace);
          setCursor(source, dir, key);
        })();
      } catch (err) {
        console.error(`${source}: task ${t.name}: ${(err as Error).message}`);
      }
      await new Promise((r) => setImmediate(r));
    }
    detail = `${tasksDir} (${n} tasks)`;
  }
  return { name: source, poll, status: () => ({ ok: true, detail }) };
}
