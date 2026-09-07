import { lastPollAt } from "./collector.js";
import { fleetMetrics } from "./db.js";
import { active } from "./sources/index.js";

// Prometheus text format, so Grafana can draw the charts. AgentLens collects;
// it does not try to be a dashboard. See README "Send it to Grafana".
// Values are recomputed from SQLite per scrape rather than counted in memory:
// sessions, turns and events only accumulate, so counters stay monotonic, and a
// database that is deleted reads as a counter reset, which Prometheus expects.

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
const labels = (l: Record<string, string>) =>
  Object.entries(l)
    .map(([k, v]) => `${k}="${esc(v)}"`)
    .join(",");

type Line = { name: string; labels?: Record<string, string>; value: number };

function block(name: string, help: string, type: string, lines: Line[]): string {
  if (!lines.length) return "";
  const body = lines
    .map((l) => `${l.name}${l.labels ? `{${labels(l.labels)}}` : ""} ${l.value}`)
    .join("\n");
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${body}\n`;
}

export function renderMetrics(): string {
  const m = fleetMetrics();
  const out: string[] = [];

  out.push(
    block("agentlens_sessions_total", "Sessions recorded.", "counter",
      m.sessions.map((r) => ({ name: "agentlens_sessions_total", labels: { source: r.source, agent: r.agent }, value: r.n }))),
  );
  out.push(
    block("agentlens_turns_total", "Turns recorded.", "counter",
      m.turns.map((r) => ({ name: "agentlens_turns_total", labels: { source: r.source, agent: r.agent }, value: r.n }))),
  );
  out.push(
    block("agentlens_turn_errors_total", "Turns that ended in an error.", "counter",
      m.turns.map((r) => ({ name: "agentlens_turn_errors_total", labels: { source: r.source, agent: r.agent }, value: r.errors ?? 0 }))),
  );
  out.push(
    block("agentlens_running_turns", "Turns currently in progress.", "gauge",
      m.turns.map((r) => ({ name: "agentlens_running_turns", labels: { source: r.source, agent: r.agent }, value: r.running ?? 0 }))),
  );

  // A declined tool is a choice, not a failure, so denials are their own outcome.
  const tools: Line[] = [];
  for (const r of m.tools) {
    const errors = r.errors ?? 0;
    const denied = r.denied ?? 0;
    const base = { source: r.source, agent: r.agent };
    tools.push({ name: "agentlens_tool_calls_total", labels: { ...base, outcome: "ok" }, value: r.total - errors - denied });
    tools.push({ name: "agentlens_tool_calls_total", labels: { ...base, outcome: "error" }, value: errors });
    tools.push({ name: "agentlens_tool_calls_total", labels: { ...base, outcome: "denied" }, value: denied });
  }
  out.push(block("agentlens_tool_calls_total", "Tool responses by outcome.", "counter", tools));

  // Cache reads dominate the volume and cost a fraction of fresh input, so they
  // are their own kind rather than folded into "input".
  const tokens: Line[] = [];
  for (const r of m.tokens) {
    const base = { source: r.source, agent: r.agent, model: r.model };
    tokens.push({ name: "agentlens_tokens_total", labels: { ...base, kind: "input" }, value: r.input });
    tokens.push({ name: "agentlens_tokens_total", labels: { ...base, kind: "output" }, value: r.output });
    if (r.cache_read) tokens.push({ name: "agentlens_tokens_total", labels: { ...base, kind: "cache_read" }, value: r.cache_read });
    if (r.cache_write) tokens.push({ name: "agentlens_tokens_total", labels: { ...base, kind: "cache_write" }, value: r.cache_write });
  }
  out.push(block("agentlens_tokens_total", "Tokens reported by the harness.", "counter", tokens));

  out.push(
    block("agentlens_cost_usd_total", "Cost in USD, only where the harness reports it.", "counter",
      m.cost.filter((r) => r.usd > 0).map((r) => ({ name: "agentlens_cost_usd_total", labels: { source: r.source, agent: r.agent }, value: r.usd }))),
  );
  out.push(
    block("agentlens_pending_approvals", "Sessions whose newest turn is waiting on a human.", "gauge",
      m.approvals.map((r) => ({ name: "agentlens_pending_approvals", labels: { source: r.source }, value: r.n }))),
  );

  const dur: Line[] = [];
  for (const r of m.duration) {
    const buckets: [string, number][] = [["1", r.le1 ?? 0], ["5", r.le5 ?? 0], ["15", r.le15 ?? 0], ["60", r.le60 ?? 0], ["300", r.le300 ?? 0], ["+Inf", r.total]];
    for (const [le, v] of buckets)
      dur.push({ name: "agentlens_turn_duration_seconds_bucket", labels: { source: r.source, le }, value: v });
    dur.push({ name: "agentlens_turn_duration_seconds_sum", labels: { source: r.source }, value: r.sum });
    dur.push({ name: "agentlens_turn_duration_seconds_count", labels: { source: r.source }, value: r.total });
  }
  out.push(block("agentlens_turn_duration_seconds", "Completed turn duration.", "histogram", dur));

  out.push(
    block("agentlens_source_up", "Whether a configured source is readable.", "gauge",
      active.map((s) => ({ name: "agentlens_source_up", labels: { source: s.name }, value: s.status().ok ? 1 : 0 }))),
  );
  out.push(
    block("agentlens_collector_last_poll_timestamp_seconds", "When the collector last finished a pass.", "gauge", [
      { name: "agentlens_collector_last_poll_timestamp_seconds", value: lastPollAt / 1000 },
    ]),
  );

  return out.filter(Boolean).join("");
}
