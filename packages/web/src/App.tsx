import { useEffect, useMemo, useState } from "react";
import { api, type FleetTotals, type Report, type SessionSummary, type SourceStatus, type Trace, type TraceEvent } from "./api";

const PAGE = 200;

const fmtTokens = (n: number | null | undefined) =>
  n == null
    ? "-"
    : n >= 1e9
      ? `${(n / 1e9).toFixed(1)}B`
      : n >= 1e6
        ? `${(n / 1e6).toFixed(1)}M`
        : n >= 1000
          ? `${(n / 1000).toFixed(1)}k`
          : String(n);
const fmtDur = (s: number | null | undefined) =>
  s == null ? "-" : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const fmtAge = (iso: string | null | undefined) => {
  if (!iso) return null;
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86400)}d`;
};
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString() : "");

// Segment kind for an event, matching the timeline lanes.
function laneOf(ev: TraceEvent): "input" | "model" | "tools" {
  if (ev.type === "model.message") return "model";
  if (ev.type.startsWith("tool.") || ev.type.startsWith("mcp.") || ev.type === "sandbox.created")
    return "tools";
  return "input";
}

export type Filter = "errors" | "toolErrors" | "approval" | null;

function StatusDot({ status }: { status: string }) {
  return <span className={`dot ${status}`} title={status} />;
}

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [selected, select] = useState<string | null>(
    () => new URLSearchParams(location.search).get("session"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [filter, setFilter] = useState<Filter>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "score">("recent");
  const [limit, setLimit] = useState(PAGE);
  const [matched, setMatched] = useState(0);
  const [totals, setTotals] = useState<FleetTotals>({
    sessions: 0, errors: 0, toolErrors: 0, approvals: 0, tools: 0, tokens: 0,
  });

  // Push so the browser's Back returns to the fleet view; popstate syncs state.
  const setSelected = (id: string | null) => {
    select(id);
    history.pushState(null, "", id ? `?session=${id}` : location.pathname);
  };
  // Stat pills filter the fleet, so they also leave an open trace.
  const pickFilter = (f: Filter) => {
    setFilter(f);
    if (selected) setSelected(null);
  };
  useEffect(() => {
    const onPop = () => select(new URLSearchParams(location.search).get("session"));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // The server does the matching: a fleet of several thousand sessions is too
  // much to send every few seconds, let alone render.
  const refresh = () => {
    Promise.all([api.sessions({ q, filter, limit, sort }), api.stats(), api.reports(), api.sources()])
      .then(([page, t, r, src]) => {
        setSessions(page.sessions);
        setMatched(page.total);
        setTotals(t);
        setReports(r);
        setSources(src);
        setOffline(false);
        setLastSync(new Date());
      })
      .catch(() => setOffline(true));
  };
  useEffect(() => {
    // Typing should not fire a query per keystroke.
    const debounce = setTimeout(refresh, q ? 250 : 0);
    const t = setInterval(refresh, 3000);
    return () => {
      clearTimeout(debounce);
      clearInterval(t);
    };
  }, [q, filter, limit, sort]);
  // A new search starts at the first page again.
  useEffect(() => setLimit(PAGE), [q, filter, sort]);

  const investigate = async (sessionId?: string) => {
    setBusy(true);
    setError(null);
    try {
      const { session_id } = await api.investigate(sessionId);
      setSelected(session_id);
    } catch {
      setError("Failed to start investigation - is the AgentLens server running?");
    } finally {
      setBusy(false);
    }
  };

  // The investigator is a TrueForge agent; without TrueForge it cannot run.
  const tfOk = sources.some((s) => s.name === "trueforge" && s.ok);

  return (
    <div className="app">
      <header>
        <h1 className="clickable" title="All sessions" onClick={() => pickFilter(null)}>
          Agent<span className="accent">Lens</span>
        </h1>
        <div className="stats">
          <Stat
            label="sessions"
            value={String(totals.sessions)}
            active={filter === null}
            onClick={() => pickFilter(null)}
          />
          <Stat
            label="failed turns"
            value={String(totals.errors)}
            alert={totals.errors > 0}
            active={filter === "errors"}
            onClick={() => pickFilter(filter === "errors" ? null : "errors")}
          />
          <Stat
            label="tool errors"
            value={String(totals.toolErrors)}
            active={filter === "toolErrors"}
            onClick={() => pickFilter(filter === "toolErrors" ? null : "toolErrors")}
          />
          <Stat
            label="need approval"
            value={String(totals.approvals)}
            alert={totals.approvals > 0}
            active={filter === "approval"}
            onClick={() => pickFilter(filter === "approval" ? null : "approval")}
          />
          <Stat label="tool calls" value={String(totals.tools)} />
          <Stat label="tokens" value={fmtTokens(totals.tokens)} />
        </div>
        {filter && (
          <button className="chip" onClick={() => setFilter(null)}>
            filter: {filter === "toolErrors" ? "tool errors" : filter === "errors" ? "failed turns" : filter} &times;
          </button>
        )}
        {offline && (
          <span className="badge stale" title={`last sync ${lastSync?.toLocaleTimeString() ?? "never"}`}>
            server unreachable
          </span>
        )}
        {error && <span className="errMsg">{error}</span>}
        <button
          className="primary"
          disabled={busy || !tfOk}
          title={tfOk ? undefined : "TrueForge not connected"}
          onClick={() => investigate()}
        >
          {busy ? "starting..." : "Investigate fleet"}
        </button>
      </header>
      {selected ? (
        <TraceView
          sessionId={selected}
          onBack={() => setSelected(null)}
          onInvestigate={() => investigate(selected)}
          canInvestigate={tfOk}
        />
      ) : (
        <main>
          <SessionTable
            sessions={sessions}
            onSelect={setSelected}
            q={q}
            setQ={setQ}
            matched={matched}
            sort={sort}
            setSort={setSort}
            onMore={() => setLimit((n) => n + PAGE)}
          />
          <ReportPanel reports={reports} />
        </main>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  alert,
  active,
  onClick,
}: {
  label: string;
  value: string;
  alert?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      className={`stat ${alert ? "alert" : ""} ${active ? "active" : ""} ${onClick ? "clickable" : ""}`}
      tabIndex={onClick ? 0 : undefined}
      role={onClick ? "button" : undefined}
      aria-pressed={onClick ? !!active : undefined}
      title={onClick ? `filter by ${label}` : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (onClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function SessionTable({
  sessions: rows,
  onSelect,
  q,
  setQ,
  matched,
  sort,
  setSort,
  onMore,
}: {
  sessions: SessionSummary[];
  onSelect: (id: string) => void;
  q: string;
  setQ: (q: string) => void;
  matched: number;
  sort: "recent" | "score";
  setSort: (s: "recent" | "score") => void;
  onMore: () => void;
}) {
  return (
    <section className="card grow">
      <div className="cardHead">
        <h2>Sessions</h2>
        {matched > rows.length && (
          <span className="muted">
            showing {rows.length} of {matched}
          </span>
        )}
        {/* Recency buries the interesting sessions once a scheduled job is in
            the fleet, so the table can rank by what looks worst instead. */}
        <button
          className={`chip sort ${sort === "score" ? "on" : ""}`}
          title="Rank by failed turns, tool failures, stalls and tool calls per turn"
          onClick={() => setSort(sort === "score" ? "recent" : "score")}
        >
          {sort === "score" ? "worst first" : "newest first"}
        </button>
        <input placeholder="filter by source, agent, title, id" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <table>
        <thead>
          <tr>
            <th />
            <th>Source</th>
            <th>Agent</th>
            <th>Title</th>
            <th>Turns</th>
            <th>Tools</th>
            <th>Subagents</th>
            <th>Tokens</th>
            <th>Duration</th>
            <th>Age</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              tabIndex={0}
              className="clickable"
              onClick={() => onSelect(s.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(s.id);
                }
              }}
            >
              <td>
                <StatusDot
                  status={
                    s.running
                      ? "running"
                      : s.pending_approvals > 0
                        ? "approval"
                        : s.error_turns > 0
                          ? "error"
                          : "done"
                  }
                />
              </td>
              <td>
                <span className="badge source">{s.source}</span>
              </td>
              <td className="mono">
                <div className="agent" title={s.agent_name}>
                  {s.agent_name}
                </div>
              </td>
              <td className="dim">
                {/* Shipped sessions arrive without a title (it is prompt text
                    and stays on the origin machine), so show the id as an id. */}
                <div className={s.title ? "title" : "title dim"} title={s.title ?? s.id}>
                  {s.title ?? s.id.split(":").pop()!.slice(0, 18)}
                </div>
              </td>
              <td>{s.turn_count}</td>
              <td>
                {s.tool_calls}
                {s.tool_errors > 0 && <span className="errCount" title={`${s.tool_errors} failed`}> {s.tool_errors}!</span>}
              </td>
              <td>{s.subagents}</td>
              <td>{fmtTokens((s.input_tokens ?? 0) + (s.output_tokens ?? 0))}</td>
              <td>{fmtDur(s.total_seconds)}</td>
              <td className="dim">{s.pending_approvals > 0 && s.approval_since ? fmtAge(s.approval_since) : "-"}</td>
              <td className="dim">{fmtTime(s.updated_at)}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={11} className="empty">
                No sessions yet. Local Claude Code and OpenCode sessions appear automatically; run
                `npm run seed -w packages/server` for TrueForge demo traffic.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {matched > rows.length && (
        <button className="more" onClick={onMore}>
          show {Math.min(PAGE, matched - rows.length)} more
        </button>
      )}
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
  canInvestigate,
}: {
  sessionId: string;
  onBack: () => void;
  onInvestigate: () => void;
  canInvestigate: boolean;
}) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<TraceEvent[]>([]);
  const [q, setQ] = useState("");

  const runningTurnId = trace?.turns.find((t) => t.status === "running")?.id;
  const running = Boolean(runningTurnId);
  // Only TrueForge has a push stream and approval gates; other sources are
  // covered by the poll above.
  const isTrueforge = trace?.session?.source === "trueforge";

  useEffect(() => {
    let stop = false;
    const load = () =>
      api
        .trace(sessionId)
        .then((t) => {
          if (!stop) {
            setTrace(t);
            setLoadError(null);
          }
        })
        .catch(() => !stop && setLoadError("Failed to load this session."));
    load();
    const t = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sessionId]);

  // Live-tail the running turn via the SSE proxy. Keyed on the turn id, not
  // the trace object, so the 2.5s poll doesn't tear down the connection.
  useEffect(() => {
    if (!runningTurnId || !isTrueforge) return;
    const es = new EventSource(`/api/sessions/${sessionId}/turns/${runningTurnId}/live`);
    let firstErrorAt = 0;
    es.onmessage = (m) => {
      firstErrorAt = 0;
      const raw = JSON.parse(m.data);
      setLive((prev) =>
        raw.id && prev.some((e) => e.id === raw.id)
          ? prev
          : [
              ...prev,
              {
                id: raw.id ?? String(prev.length),
                turn_id: runningTurnId,
                thread_id: raw.threadId ?? null,
                type: raw.type,
                created_at: raw.createdAt ?? null,
                raw,
              },
            ],
      );
      if (raw.type === "turn.done") es.close();
    };
    // Let the browser's built-in reconnect run on transient errors, but bound
    // it: a dead turn id would otherwise retry forever (the 2.5s poll picks up
    // the completed turn shortly anyway).
    es.onerror = () => {
      const now = Date.now();
      if (!firstErrorAt) firstErrorAt = now;
      if (es.readyState === EventSource.CLOSED || now - firstErrorAt > 30_000) es.close();
    };
    return () => {
      es.close();
      setLive([]);
    };
  }, [sessionId, runningTurnId, isTrueforge]);

  const events = useMemo(() => {
    const stored = trace?.events ?? [];
    const storedIds = new Set(stored.map((e) => e.id));
    return [...stored, ...live.filter((e) => !storedIds.has(e.id))];
  }, [trace, live]);

  const filtered = q
    ? events.filter((e) => JSON.stringify(e.raw).toLowerCase().includes(q.toLowerCase()))
    : events;

  // toolCallId -> tool name, gathered from assistant messages.
  const toolNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      for (const c of e.raw.toolCalls ?? []) {
        if (c.id && c.function?.name) m.set(c.id, c.function.name);
      }
    }
    return m;
  }, [events]);

  // Only the newest turn can hold an actionable approval (a resolution creates
  // a new turn). If the newest turn has none pending, earlier approval_required
  // events are stale and TrueForge 422s on approving them.
  const approvalTurnId = useMemo(() => {
    const turns = trace?.turns ?? [];
    const newest = turns[turns.length - 1];
    return isTrueforge && newest && newest.pending_actions > 0 ? newest.id : null;
  }, [trace, isTrueforge]);

  if (!trace)
    return (
      <main className="empty">
        {loadError ?? "loading..."}{" "}
        {loadError && <button onClick={onBack}>&larr; sessions</button>}
      </main>
    );

  return (
    <main className="traceView">
      <div className="traceHead">
        <button onClick={onBack}>&larr; sessions</button>
        <span className="badge source">{trace.session?.source}</span>
        <h2 className="mono">
          {trace.session?.agent_name} <span className="dim">/ {sessionId.slice(0, 20)}</span>
        </h2>
        {running && <span className="badge running">running</span>}
        {loadError && <span className="errMsg">{loadError} Showing last known data.</span>}
        <span className="grow" />
        <input placeholder="search events" value={q} onChange={(e) => setQ(e.target.value)} />
        <button
          className="primary"
          disabled={!canInvestigate}
          title={canInvestigate ? undefined : "TrueForge not connected"}
          onClick={onInvestigate}
        >
          Investigate this session
        </button>
      </div>
      <Timeline events={events} />
      <div className="transcript">
        {filtered.map((e) => (
          <EventRow
            key={e.id}
            ev={e}
            sessionId={sessionId}
            toolNames={toolNames}
            approvalTurnId={approvalTurnId}
          />
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

function ApprovalButtons({
  sessionId,
  toolCallId,
  threadId,
}: {
  sessionId: string;
  toolCallId: string | undefined;
  threadId: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const submit = (allow: boolean) => {
    setState("sending");
    api
      .approve(sessionId, toolCallId, threadId, allow)
      .then(() => setState("sent"))
      .catch(() => setState("error"));
  };
  return (
    <div className="approveBtns">
      <button className="primary" disabled={state !== "idle"} onClick={() => submit(true)}>
        Allow
      </button>
      <button disabled={state !== "idle"} onClick={() => submit(false)}>
        Deny
      </button>
      {state === "sending" && <span className="dim">sending...</span>}
      {state === "sent" && <span className="dim">submitted</span>}
      {state === "error" && <span className="errMsg">approval failed</span>}
    </div>
  );
}

function EventRow({
  ev,
  sessionId,
  toolNames,
  approvalTurnId,
}: {
  ev: TraceEvent;
  sessionId: string;
  toolNames: Map<string, string>;
  approvalTurnId: string | null;
}) {
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
        <Row tag="TOOL" cls={raw.error ? "error" : "tool"} time={ev.created_at} sub={sub}>
          <span className="mono">{String(raw.content).slice(0, 500)}</span>
        </Row>
      );
    case "thread.created":
      return (
        <Row tag="SUBAGENT" cls="subagent" time={ev.created_at}>
          spawned: {raw.title}
        </Row>
      );
    case "tool.approval_required": {
      const call = raw.toolCalls?.[0];
      const name = call ? (toolNames.get(call.id) ?? call.id) : "?";
      const actionable = ev.turn_id === approvalTurnId;
      return (
        <Row tag="APPROVAL" cls="approval" time={ev.created_at} sub={sub}>
          <div>
            Tool <span className="mono">{name}</span> awaits approval
          </div>
          {actionable ? (
            <ApprovalButtons
              sessionId={sessionId}
              toolCallId={call?.id}
              threadId={raw.threadId ?? "main"}
            />
          ) : (
            <span className="dim">resolved</span>
          )}
        </Row>
      );
    }
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
