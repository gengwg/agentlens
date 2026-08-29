import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Report, type SessionSummary, type Trace, type TraceEvent } from "./api";

const fmtTokens = (n: number | null | undefined) =>
  n == null ? "-" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const fmtDur = (s: number | null | undefined) =>
  s == null ? "-" : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "");

// Segment kind for an event, matching the timeline lanes.
function laneOf(ev: TraceEvent): "input" | "model" | "tools" {
  if (ev.type === "model.message") return "model";
  if (ev.type.startsWith("tool.") || ev.type.startsWith("mcp.") || ev.type === "sandbox.created")
    return "tools";
  return "input";
}

function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} title={status} />;
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    api.sessions().then(setSessions).catch(() => {});
    api.reports().then(setReports).catch(() => {});
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);

  const investigate = async (sessionId?: string) => {
    setBusy(true);
    try {
      const { session_id } = await api.investigate(sessionId);
      setSelected(session_id);
    } finally {
      setBusy(false);
    }
  };

  const totals = useMemo(() => {
    const t = { sessions: sessions.length, errors: 0, tokens: 0, tools: 0 };
    for (const s of sessions) {
      if (s.error_turns > 0) t.errors++;
      t.tokens += (s.input_tokens ?? 0) + (s.output_tokens ?? 0);
      t.tools += s.tool_calls;
    }
    return t;
  }, [sessions]);

  return (
    <div className="app">
      <header>
        <h1>
          Agent<span className="accent">Lens</span>
        </h1>
        <div className="stats">
          <Stat label="sessions" value={String(totals.sessions)} />
          <Stat label="with errors" value={String(totals.errors)} alert={totals.errors > 0} />
          <Stat label="tool calls" value={String(totals.tools)} />
          <Stat label="tokens" value={fmtTokens(totals.tokens)} />
        </div>
        <button className="primary" disabled={busy} onClick={() => investigate()}>
          {busy ? "starting..." : "Investigate fleet"}
        </button>
      </header>
      {selected ? (
        <TraceView
          sessionId={selected}
          onBack={() => setSelected(null)}
          onInvestigate={() => investigate(selected)}
        />
      ) : (
        <main>
          <SessionTable sessions={sessions} onSelect={setSelected} />
          <ReportPanel reports={reports} />
        </main>
      )}
    </div>
  );
}

function Stat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className={`stat ${alert ? "alert" : ""}`}>
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function SessionTable({
  sessions,
  onSelect,
}: {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const rows = sessions.filter(
    (s) =>
      !q ||
      s.agent_name?.toLowerCase().includes(q.toLowerCase()) ||
      s.title?.toLowerCase().includes(q.toLowerCase()) ||
      s.id.includes(q),
  );
  return (
    <section className="card grow">
      <div className="cardHead">
        <h2>Sessions</h2>
        <input placeholder="filter by agent, title, id" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>Agent</th>
            <th>Title</th>
            <th>Turns</th>
            <th>Tools</th>
            <th>Subagents</th>
            <th>Tokens</th>
            <th>Duration</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} onClick={() => onSelect(s.id)}>
              <td>
                <StatusDot status={s.running ? "running" : s.error_turns > 0 ? "error" : "done"} />
              </td>
              <td className="mono">{s.agent_name}</td>
              <td className="dim">{s.title ?? s.id.slice(0, 18)}</td>
              <td>{s.turn_count}</td>
              <td>{s.tool_calls}</td>
              <td>{s.subagents}</td>
              <td>{fmtTokens((s.input_tokens ?? 0) + (s.output_tokens ?? 0))}</td>
              <td>{fmtDur(s.total_seconds)}</td>
              <td className="dim">{fmtTime(s.updated_at)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="empty">
                No sessions yet. Run `npm run seed -w packages/server` to generate demo traffic.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function ReportPanel({ reports }: { reports: Report[] }) {
  return (
    <section className="card reports">
      <div className="cardHead">
        <h2>Incident reports</h2>
      </div>
      {reports.length === 0 && <div className="empty">None published. Run an investigation.</div>}
      {reports.map((r) => (
        <details key={r.id} open={r.id === reports[0]?.id}>
          <summary>
            <span>{r.title}</span>
            <span className="dim">{fmtTime(r.created_at)}</span>
          </summary>
          <pre>{r.body}</pre>
        </details>
      ))}
    </section>
  );
}

function TraceView({
  sessionId,
  onBack,
  onInvestigate,
}: {
  sessionId: string;
  onBack: () => void;
  onInvestigate: () => void;
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [live, setLive] = useState<TraceEvent[]>([]);
  const [q, setQ] = useState("");
  const esRef = useRef<EventSource | null>(null);

  const running = trace?.turns.some((t) => t.status === "running") ?? false;

  useEffect(() => {
    let stop = false;
    const load = () => api.trace(sessionId).then((t) => !stop && setTrace(t)).catch(() => {});
    load();
    const t = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sessionId]);

  // Live-tail the newest running turn via the SSE proxy.
  useEffect(() => {
    const turn = trace?.turns.find((t) => t.status === "running");
    if (!turn || esRef.current) return;
    const es = new EventSource(`/api/sessions/${sessionId}/turns/${turn.id}/live`);
    esRef.current = es;
    es.onmessage = (m) => {
      const raw = JSON.parse(m.data);
      setLive((prev) => [
        ...prev,
        {
          id: raw.id ?? String(prev.length),
          turn_id: turn.id,
          thread_id: raw.threadId ?? null,
          type: raw.type,
          created_at: raw.createdAt ?? null,
          raw,
        },
      ]);
      if (raw.type === "turn.done") {
        es.close();
        esRef.current = null;
        setLive([]);
      }
    };
    es.onerror = () => {
      es.close();
      esRef.current = null;
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, [trace, sessionId]);

  const events = useMemo(() => {
    const stored = trace?.events ?? [];
    const storedIds = new Set(stored.map((e) => e.id));
    return [...stored, ...live.filter((e) => !storedIds.has(e.id))];
  }, [trace, live]);

  const filtered = q
    ? events.filter((e) => JSON.stringify(e.raw).toLowerCase().includes(q.toLowerCase()))
    : events;

  if (!trace) return <main className="empty">loading...</main>;

  return (
    <main className="traceView">
      <div className="traceHead">
        <button onClick={onBack}>&larr; sessions</button>
        <h2 className="mono">
          {trace.session?.agent_name} <span className="dim">/ {sessionId.slice(0, 20)}</span>
        </h2>
        {running && <span className="badge running">running</span>}
        <span className="grow" />
        <input placeholder="search events" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" onClick={onInvestigate}>
          Investigate this session
        </button>
      </div>
      <Timeline events={events} />
      <div className="transcript">
        {filtered.map((e) => (
          <EventRow key={e.id} ev={e} sessionId={sessionId} />
        ))}
      </div>
    </main>
  );
}

function Timeline({ events }: { events: TraceEvent[] }) {
  const timed = events.filter((e) => e.created_at);
  if (timed.length < 2) return null;
  const t0 = new Date(timed[0].created_at!).getTime();
  const t1 = new Date(timed[timed.length - 1].created_at!).getTime();
  const span = Math.max(t1 - t0, 1);
  const lanes: Record<string, { left: number; width: number; title: string }[]> = {
    input: [],
    model: [],
    tools: [],
  };
  let prev = t0;
  for (const e of timed) {
    const t = new Date(e.created_at!).getTime();
    const left = ((prev - t0) / span) * 100;
    const width = Math.max(((t - prev) / span) * 100, 0.4);
    lanes[laneOf(e)].push({ left, width, title: `${e.type} ${fmtTime(e.created_at)}` });
    prev = t;
  }
  return (
    <div className="timeline">
      {(["input", "model", "tools"] as const).map((lane) => (
        <div className="lane" key={lane}>
          <span className="laneLabel">{lane}</span>
          <div className="track">
            {lanes[lane].map((s, i) => (
              <span
                key={i}
                className={`seg ${lane}`}
                style={{ left: `${s.left}%`, width: `${s.width}%` }}
                title={s.title}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="laneMeta dim">
        {fmtDur((t1 - t0) / 1000)} total &middot; {timed.length} events
      </div>
    </div>
  );
}

function EventRow({ ev, sessionId }: { ev: TraceEvent; sessionId: string }) {
  const raw = ev.raw;
  const sub = !!ev.thread_id && ev.thread_id !== "main";
  switch (ev.type) {
    case "turn.created": {
      const input = raw.input?.find((i: any) => i.type === "user.message");
      return (
        <Row tag="USER" cls="user" time={ev.created_at} sub={sub}>
          {typeof input?.content === "string" ? input.content : JSON.stringify(input?.content ?? raw.input)}
        </Row>
      );
    }
    case "model.message": {
      const text = typeof raw.content === "string" ? raw.content : raw.content ? JSON.stringify(raw.content) : "";
      return (
        <Row tag="ASSISTANT" cls="assistant" time={ev.created_at} sub={sub} usage={raw.usage}>
          {text}
          {raw.toolCalls?.map((c: any, i: number) => (
            <div key={i} className="toolCall mono">
              {c.function?.name ?? c.toolInfo?.name}({String(c.function?.arguments ?? "").slice(0, 300)})
            </div>
          ))}
        </Row>
      );
    }
    case "tool.response":
      return (
        <Row tag="TOOL" cls="tool" time={ev.created_at} sub={sub}>
          <span className="mono">{String(raw.content).slice(0, 500)}</span>
        </Row>
      );
    case "thread.created":
      return (
        <Row tag="SUBAGENT" cls="subagent" time={ev.created_at}>
          spawned: {raw.title}
        </Row>
      );
    case "tool.approval_required":
      return (
        <Row tag="APPROVAL" cls="approval" time={ev.created_at} sub={sub}>
          <div>
            Tool <span className="mono">{raw.toolCall?.function?.name ?? raw.toolCall?.toolInfo?.name}</span> awaits
            approval
          </div>
          <div className="approveBtns">
            <button
              className="primary"
              onClick={() => api.approve(sessionId, raw.toolCall?.id, raw.threadId ?? "main", true)}
            >
              Allow
            </button>
            <button onClick={() => api.approve(sessionId, raw.toolCall?.id, raw.threadId ?? "main", false)}>
              Deny
            </button>
          </div>
        </Row>
      );
    case "turn.done":
      return (
        <Row tag="TURN" cls={raw.state?.status === "error" ? "error" : "done"} time={ev.created_at}>
          {raw.state?.status}
          {raw.state?.message ? ` - ${raw.state.message}` : ""}
          {raw.state?.metrics?.totalCostInUsd != null && (
            <span className="dim"> (${raw.state.metrics.totalCostInUsd.toFixed(4)})</span>
          )}
        </Row>
      );
    default:
      return (
        <Row tag={ev.type} cls="misc" time={ev.created_at} sub={sub}>
          {""}
        </Row>
      );
  }
}

function Row({
  tag,
  cls,
  time,
  sub,
  usage,
  children,
}: {
  tag: string;
  cls: string;
  time: string | null;
  sub?: boolean | null;
  usage?: { inputTokens?: number; outputTokens?: number };
  children: React.ReactNode;
}) {
  return (
    <div className={`row ${cls} ${sub ? "subthread" : ""}`}>
      <span className={`tag ${cls}`}>{tag}</span>
      <div className="body">{children}</div>
      <span className="meta dim">
        {usage ? `${fmtTokens(usage.inputTokens)}/${fmtTokens(usage.outputTokens)} tok ` : ""}
        {fmtTime(time)}
      </span>
    </div>
  );
}
