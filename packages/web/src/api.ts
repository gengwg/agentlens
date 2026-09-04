export type SessionSummary = {
  id: string;
  agent_name: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  turn_count: number;
  error_turns: number;
  running: number;
  tool_calls: number;
  tool_errors: number;
  pending_approvals: number;
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
  session: { id: string; agent_name: string; title: string | null } | null;
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

const json = (r: Response) => {
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

export const api = {
  sessions: (): Promise<SessionSummary[]> => fetch("/api/sessions").then(json),
  trace: (id: string): Promise<Trace> => fetch(`/api/sessions/${id}`).then(json),
  agents: (): Promise<any[]> => fetch("/api/agents").then(json),
  reports: (): Promise<Report[]> => fetch("/api/reports").then(json),
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
