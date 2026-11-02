import { retryCandidateSessions, sessionToolRows } from "./db.js";

// Agents rarely report a broken tool; they call it again. A failed call followed
// shortly by another call to the same tool in the same thread is that signal.
export const RETRY_WINDOW = 3;

export type ToolRow = {
  type: "model.message" | "tool.response";
  thread_id: string | null;
  created_at: string | null;
  calls: string | null;
  call_id: string | null;
  failed: 0 | 1;
};

export type ToolCall = {
  id: string;
  tool: string;
  args: string;
  thread: string;
  at: string | null;
  message: number;
  // Row indexes of the call and of its first response, so a retry can be
  // required to come after the failure was visible.
  row: number;
  responseRow: number | null;
  failed: boolean | null;
};

export type Retry = {
  sessionId: string;
  tool: string;
  server: string | null;
  failedCallId: string;
  retryCallId: string;
  sameArgs: boolean;
  recovered: boolean | null;
  gapSeconds: number | null;
};

export type ToolRetryStat = {
  tool: string;
  server: string | null;
  failures: number;
  retried: number;
  sameArgs: number;
  recovered: number;
  sessions: number;
};

function canonical(args: unknown): string {
  if (typeof args === "string") {
    try {
      return JSON.stringify(JSON.parse(args));
    } catch {
      return args.trim();
    }
  }
  if (args && typeof args === "object") return JSON.stringify(args);
  return args == null ? "" : String(args);
}

export function serverOf(tool: string): string | null {
  const m = /^mcp__(.+?)__.+$/.exec(tool);
  return m ? m[1] : null;
}

export function toolCallsOf(rows: ToolRow[]): ToolCall[] {
  const responses = new Map<string, { failed: boolean; row: number }>();
  rows.forEach((r, row) => {
    if (r.type === "tool.response" && r.call_id && !responses.has(r.call_id)) responses.set(r.call_id, { failed: r.failed === 1, row });
  });
  const out: ToolCall[] = [];
  let message = -1;
  for (const [row, r] of rows.entries()) {
    if (r.type !== "model.message") continue;
    message++;
    if (!r.calls) continue;
    let calls: any[];
    try {
      calls = JSON.parse(r.calls);
    } catch {
      continue;
    }
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      const tool = c?.function?.name ?? c?.toolInfo?.name;
      if (!c?.id || !tool) continue;
      out.push({
        id: c.id,
        tool,
        args: canonical(c.function?.arguments),
        thread: r.thread_id ?? "main",
        at: r.created_at,
        message,
        row,
        responseRow: responses.get(c.id)?.row ?? null,
        failed: responses.get(c.id)?.failed ?? null,
      });
    }
  }
  return out;
}

const seconds = (a: string | null, b: string | null) =>
  a && b && !Number.isNaN(Date.parse(a)) && !Number.isNaN(Date.parse(b)) ? (Date.parse(b) - Date.parse(a)) / 1000 : null;

export function findRetries(sessionId: string, calls: ToolCall[]): Retry[] {
  const byThread = new Map<string, ToolCall[]>();
  for (const c of calls) {
    const list = byThread.get(c.thread);
    if (list) list.push(c);
    else byThread.set(c.thread, [c]);
  }
  const out: Retry[] = [];
  for (const thread of byThread.values()) {
    thread.forEach((f, i) => {
      if (f.failed !== true) return;
      let r: ToolCall | undefined;
      for (let j = i + 1, seen = 0; j < thread.length && seen < RETRY_WINDOW; j++) {
        // Calls issued before the failure came back (the same message, or a
        // parallel call that an adapter wrote as its own row) are not retries.
        if (thread[j].message === f.message || (f.responseRow !== null && thread[j].row < f.responseRow)) continue;
        seen++;
        if (thread[j].tool === f.tool) {
          r = thread[j];
          break;
        }
      }
      if (!r) return;
      out.push({
        sessionId,
        tool: f.tool,
        server: serverOf(f.tool),
        failedCallId: f.id,
        retryCallId: r.id,
        sameArgs: f.args === r.args,
        recovered: r.failed === null ? null : !r.failed,
        gapSeconds: seconds(f.at, r.at),
      });
    });
  }
  return out;
}

export function rollupRetries(sessions: { sessionId: string; calls: ToolCall[] }[]): ToolRetryStat[] {
  const stats = new Map<string, ToolRetryStat & { seen: Set<string> }>();
  const stat = (tool: string) => {
    let s = stats.get(tool);
    if (!s) stats.set(tool, (s = { tool, server: serverOf(tool), failures: 0, retried: 0, sameArgs: 0, recovered: 0, sessions: 0, seen: new Set() }));
    return s;
  };
  for (const { sessionId, calls } of sessions) {
    for (const c of calls) {
      if (c.failed !== true) continue;
      const s = stat(c.tool);
      s.failures++;
      s.seen.add(sessionId);
    }
    for (const r of findRetries(sessionId, calls)) {
      const s = stat(r.tool);
      s.retried++;
      if (r.sameArgs) s.sameArgs++;
      if (r.recovered === true) s.recovered++;
    }
  }
  return [...stats.values()]
    .map(({ seen, ...s }) => ({ ...s, sessions: seen.size }))
    // Identical-argument retries are the blind ones; for general tools like a
    // shell, "called it again" is mostly the agent's next unrelated command.
    .sort((a, b) => b.sameArgs - a.sameArgs || b.retried - a.retried || b.failures - a.failures);
}

export function sessionRetries(sessionId: string): Retry[] {
  return findRetries(sessionId, toolCallsOf(sessionToolRows(sessionId)));
}

export function fleetRetries(since: string): ToolRetryStat[] {
  return rollupRetries(retryCandidateSessions(since).map((sessionId) => ({ sessionId, calls: toolCallsOf(sessionToolRows(sessionId)) })));
}
