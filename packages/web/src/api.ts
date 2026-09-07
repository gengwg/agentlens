export type SessionSummary = {
  id: string;
  source: string;
  agent_name: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  turn_count: number;
  error_turns: number;
  running: number;
  tool_calls: number;
  tool_errors: number;
  tool_denials: number;
  pending_approvals: number;
  approval_since: string | null;
  subagents: number;
  input_tokens: number | null;
  output_tokens: number | null;
  total_seconds: number | null;
};

export type TraceEvent = {
  id: string;
  turn_id: string;
  thread_id: string | null;
  type: string;
  created_at: string | null;
  raw: any;
};

export type Trace = {
  session: { id: string; source: string; agent_name: string; title: string | null } | null;
  turns: {
    id: string;
    created_at: string;
    completed_at: string | null;
    status: string;
    error: string | null;
    pending_actions: number;
  }[];
  events: TraceEvent[];
};

export type Report = { id: number; title: string; body: string; created_at: string };

export type SourceStatus = { name: string; ok: boolean; detail: string };

const json = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export type SessionPage = { sessions: SessionSummary[]; total: number };
export type FleetTotals = {
  sessions: number; errors: number; toolErrors: number; approvals: number; tools: number; tokens: number;
};

export const api = {
  sessions: (opts: { q?: string; filter?: string | null; limit?: number; sort?: string }): Promise<SessionPage> => {
    const p = new URLSearchParams({ limit: String(opts.limit ?? 200) });
    if (opts.q) p.set("q", opts.q);
    if (opts.filter) p.set("filter", opts.filter);
    if (opts.sort) p.set("sort", opts.sort);
    return fetch(`/api/sessions?${p}`).then(json);
  },
  stats: (): Promise<FleetTotals> => fetch("/api/stats").then(json),
  trace: (id: string): Promise<Trace> => fetch(`/api/sessions/${id}`).then(json),
  agents: (): Promise<any[]> => fetch("/api/agents").then(json),
  reports: (): Promise<Report[]> => fetch("/api/reports").then(json),
  sources: (): Promise<SourceStatus[]> => fetch("/api/sources").then(json),
  investigate: (sessionId?: string): Promise<{ session_id: string; turn_id: string }> =>
    fetch("/api/investigate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sessionId ? { session_id: sessionId } : {}),
    }).then(json),
  approve: (sessionId: string, toolCallId: string | undefined, threadId: string, allow: boolean) =>
    fetch(`/api/sessions/${sessionId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool_call_id: toolCallId, thread_id: threadId, allow }),
    }).then(json),
};
