import assert from "node:assert/strict";
import { test } from "node:test";
import { db, seedSession } from "./fixtures.ts";

const { renderMetrics } = await import("../src/metrics.ts");

// Parse the exposition format back into a map so assertions read like queries.
function scrape() {
  const txt = renderMetrics();
  const series = new Map<string, number>();
  const families = new Map<string, string>();
  for (const line of txt.split("\n")) {
    if (line.startsWith("# TYPE ")) {
      const [, name, type] = line.split(" ").slice(1);
      families.set(name, type);
      continue;
    }
    if (!line || line.startsWith("#")) continue;
    const i = line.lastIndexOf(" ");
    series.set(line.slice(0, i), Number(line.slice(i + 1)));
  }
  return { txt, series, families };
}

test("metrics count sessions, turns and tool outcomes by source and agent", () => {
  seedSession("m-ok", {
    source: "claude-code",
    agent: "checkout",
    turns: [{ id: "mt1", created_at: "2026-09-01T00:00:00Z", completed_at: "2026-09-01T00:00:04Z" }],
    events: [
      { id: "me1", turn_id: "mt1", type: "tool.response", raw: { content: "fine" } },
      { id: "me2", turn_id: "mt1", type: "tool.response", raw: { content: "ENOENT", error: true } },
      { id: "me3", turn_id: "mt1", type: "tool.response", raw: { content: "The user doesn't want to proceed with this tool use.", error: true } },
      { id: "me4", turn_id: "mt1", type: "model.message", raw: { model: "claude-sonnet-5", usage: { inputTokens: 900, outputTokens: 20 } } },
    ],
  });
  const { series, families } = scrape();
  const l = 'source="claude-code",agent="checkout"';

  assert.equal(series.get(`agentlens_sessions_total{${l}}`), 1);
  assert.equal(series.get(`agentlens_turns_total{${l}}`), 1);
  assert.equal(series.get(`agentlens_tool_calls_total{${l},outcome="ok"}`), 1);
  assert.equal(series.get(`agentlens_tool_calls_total{${l},outcome="error"}`), 1);
  assert.equal(series.get(`agentlens_tool_calls_total{${l},outcome="denied"}`), 1, "a declined tool is not an error");
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-sonnet-5",kind="input"}`), 900);
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-sonnet-5",kind="output"}`), 20);

  assert.equal(families.get("agentlens_sessions_total"), "counter");
  assert.equal(families.get("agentlens_running_turns"), "gauge");
  assert.equal(families.get("agentlens_turn_duration_seconds"), "histogram");
});

test("the turn duration histogram is cumulative and carries sum and count", () => {
  seedSession("m-dur", {
    source: "dsh",
    turns: [
      { id: "md1", created_at: "2026-09-01T00:00:00Z", completed_at: "2026-09-01T00:00:02Z" },
      { id: "md2", created_at: "2026-09-01T00:10:00Z", completed_at: "2026-09-01T00:10:40Z" },
    ],
  });
  const { series } = scrape();
  const at = (le: string) => series.get(`agentlens_turn_duration_seconds_bucket{source="dsh",le="${le}"}`)!;

  assert.deepEqual([at("1"), at("5"), at("15"), at("60"), at("300"), at("+Inf")], [0, 1, 1, 2, 2, 2]);
  assert.equal(series.get(`agentlens_turn_duration_seconds_count{source="dsh"}`), 2);
  assert.equal(series.get(`agentlens_turn_duration_seconds_sum{source="dsh"}`), 42);
});

test("cost counts what a harness reported, without double counting OpenCode", () => {
  // OpenCode writes each reply's cost and again the turn total; only one may count.
  seedSession("m-cost-oc", {
    source: "opencode",
    agent: "billing",
    turns: [{ id: "mc1" }],
    events: [
      { id: "mc-e1", turn_id: "mc1", type: "model.message", raw: { cost: 0.02 } },
      { id: "mc-e2", turn_id: "mc1", type: "model.message", raw: { cost: 0.03 } },
      { id: "mc-e3", turn_id: "mc1", type: "turn.done", raw: { state: { status: "done", metrics: { totalCostInUsd: 0.05 } } } },
    ],
  });
  // Roo reports per message only, with no turn total to fall back from.
  seedSession("m-cost-roo", {
    source: "roo-code",
    agent: "docs",
    events: [{ id: "mr-e1", type: "model.message", raw: { cost: 0.25 } }],
  });
  const { series } = scrape();
  assert.equal(series.get(`agentlens_cost_usd_total{source="opencode",agent="billing"}`), 0.05);
  assert.equal(series.get(`agentlens_cost_usd_total{source="roo-code",agent="docs"}`), 0.25);
});

test("pending approvals are a gauge, and running turns are reported", () => {
  seedSession("m-wait", {
    source: "trueforge",
    agent: "investigator",
    turns: [{ id: "mw1", created_at: "2026-09-01T00:00:00Z", pending_actions: 1, status: "running" }],
  });
  const { series } = scrape();
  assert.equal(series.get(`agentlens_pending_approvals{source="trueforge"}`), 1);
  assert.equal(series.get(`agentlens_running_turns{source="trueforge",agent="investigator"}`), 1);
});

test("label values are escaped so one odd agent name cannot break a scrape", () => {
  db.prepare(
    `INSERT INTO sessions (id, agent_name, title, created_at, updated_at, created_by, source)
     VALUES (?, ?, '', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', 'test', 'claude-code')`,
  ).run("m-odd", 'we"ird\\path');
  const { txt, series } = scrape();
  assert.ok(series.has(`agentlens_sessions_total{source="claude-code",agent="we\\"ird\\\\path"}`));
  for (const line of txt.split("\n").filter((l) => l && !l.startsWith("#"))) {
    const quotes = (line.match(/(?<!\\)"/g) ?? []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes: ${line}`);
  }
});

test("every series belongs to a declared family", () => {
  const { txt, families } = scrape();
  for (const line of txt.split("\n").filter((l) => l && !l.startsWith("#"))) {
    const name = line.slice(0, line.search(/[{ ]/));
    const base = name.replace(/_(bucket|sum|count)$/, "");
    assert.ok(families.has(name) || families.has(base), `${name} has no # TYPE line`);
  }
});

test("cache reads and writes are their own token kinds", () => {
  seedSession("m-cache", {
    source: "opencode",
    agent: "pricing",
    events: [
      { id: "mk1", type: "model.message", raw: { model: "claude-opus-5", usage: { inputTokens: 120, outputTokens: 40, cacheReadTokens: 90_000, cacheWriteTokens: 300 } } },
      // A row from before the split carries no cache fields, and must not invent any.
      { id: "mk2", type: "model.message", raw: { model: "claude-haiku-4-5", usage: { inputTokens: 50, outputTokens: 5 } } },
    ],
  });
  const { series } = scrape();
  const l = 'source="opencode",agent="pricing"';
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-opus-5",kind="input"}`), 120);
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-opus-5",kind="cache_read"}`), 90_000);
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-opus-5",kind="cache_write"}`), 300);
  assert.equal(series.get(`agentlens_tokens_total{${l},model="claude-haiku-4-5",kind="cache_read"}`), undefined);
});
