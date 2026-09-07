import assert from "node:assert/strict";
import { test } from "node:test";
import { app, db, seedSession } from "./fixtures.ts";

test("GET /api/sessions returns the rollup", async () => {
  seedSession("s-api", { turns: [{ id: "t1", status: "error" }] });
  const res = await app.request("/api/sessions");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessions[0].id, "s-api");
  assert.equal(body.sessions[0].error_turns, 1);
  assert.equal(body.total, body.sessions.length);
});

test("GET /api/sessions pages, searches and filters server-side", async () => {
  seedSession("s-page-a", { agent: "needle", updated_at: "2026-09-10T00:00:00Z" });
  seedSession("s-page-b", { agent: "needle", updated_at: "2026-09-11T00:00:00Z", turns: [{ id: "tp1", status: "error" }] });
  const get = async (qs: string) => (await (await app.request(`/api/sessions?${qs}`)).json()) as any;

  const one = await get("q=needle&limit=1");
  assert.deepEqual(one.sessions.map((s: any) => s.id), ["s-page-b"], "newest first");
  assert.equal(one.total, 2, "total counts every match, not the page");

  const failed = await get("q=needle&filter=errors");
  assert.deepEqual(failed.sessions.map((s: any) => s.id), ["s-page-b"]);

  assert.equal((await get("q=no-such-session")).total, 0);
  assert.ok((await get("limit=99999")).sessions.length <= 2000, "limit is clamped");
});

test("GET /api/stats aggregates the whole fleet, not one page", async () => {
  seedSession("s-stat", {
    turns: [{ id: "ts1", status: "error" }],
    events: [{ id: "es1", type: "tool.response", raw: { content: "boom", error: true } }],
  });
  const stats = (await (await app.request("/api/stats")).json()) as any;
  const all = (await (await app.request("/api/sessions?limit=2000")).json()) as any;
  assert.equal(stats.sessions, all.total);
  assert.ok(stats.errors >= 1 && stats.toolErrors >= 1);
  assert.equal(stats.tools, all.sessions.reduce((n: number, s: any) => n + s.tool_calls, 0));
});

test("GET /api/sessions/:id returns session, turns and parsed events", async () => {
  seedSession("s-api-trace", {
    turns: [{ id: "t2" }],
    events: [{ id: "e1", turn_id: "t2", type: "model.message", raw: { content: "hi" } }],
  });
  const res = await app.request("/api/sessions/s-api-trace");
  const body = await res.json();
  assert.equal(body.session.id, "s-api-trace");
  assert.equal(body.turns.length, 1);
  assert.equal(body.events[0].raw.content, "hi");
});

test("GET /api/sessions/:id for an unknown id returns empty rather than erroring", async () => {
  const res = await app.request("/api/sessions/nope");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.session, undefined);
  assert.deepEqual(body.events, []);
});

test("GET /api/agents and /api/reports serve list payloads", async () => {
  seedSession("s-api-agent", { agent: "demo-flaky" });
  db.prepare(`INSERT INTO reports (title, body) VALUES (?, ?)`).run("incident", "body");

  const agents = await (await app.request("/api/agents")).json();
  assert.ok(agents.some((a: any) => a.agent_name === "demo-flaky"));

  const reports = await (await app.request("/api/reports")).json();
  assert.equal(reports[0].title, "incident");
});

test("CORS allows the dashboard origin and rejects others", async () => {
  const allowed = await app.request("/api/agents", {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");

  const blocked = await app.request("/api/agents", {
    headers: { Origin: "http://evil.example" },
  });
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
});

test("GET /api/sources lists configured sources", async () => {
  const res = await app.request("/api/sources");
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test("TrueForge-only routes refuse when TrueForge is not connected", async () => {
  seedSession("s-cc", { source: "claude-code", turns: [{ id: "t-cc", status: "running" }] });
  assert.equal((await app.request("/api/sessions/s-cc/turns/t-cc/live")).status, 404);
  assert.equal((await app.request("/api/investigate", { method: "POST", body: "{}" })).status, 503);
  const approve = await app.request("/api/sessions/s-cc/approve", {
    method: "POST",
    body: JSON.stringify({ tool_call_id: "x" }),
  });
  assert.equal(approve.status, 503);
});

test("POST /api/ingest accepts normalized sessions, turns and events", async () => {
  const body = {
    source: "grok",
    sessions: [{ id: "gk1", agent_name: "proj", title: "hi", created_at: "2026-09-01T00:00:00Z" }],
    turns: [{ id: "gk1:t1", session_id: "gk1", created_at: "2026-09-01T00:00:00Z", status: "done", completed_at: "2026-09-01T00:00:09Z" }],
    events: [
      { id: "gk1:e1", session_id: "gk1", turn_id: "gk1:t1", type: "turn.created", created_at: "2026-09-01T00:00:00Z", raw: { input: [{ type: "user.message", content: "hi" }] } },
      { id: "gk1:e2", session_id: "gk1", turn_id: "gk1:t1", type: "model.message", created_at: "2026-09-01T00:00:05Z", raw: { content: "hello", usage: { inputTokens: 10, outputTokens: 2 } } },
      { id: "gk1:e3", session_id: "gk1", turn_id: "gk1:t1", type: "tool.response", created_at: "2026-09-01T00:00:06Z", raw: { content: "nope", error: true } },
    ],
  };
  const post = (b: unknown) => app.request("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200); // idempotent
  const s = (await (await app.request("/api/sessions")).json()).sessions.find((x: any) => x.id === "gk1");
  assert.equal(s.source, "grok");
  assert.equal(s.turn_count, 1);
  assert.equal(s.total_seconds, 9);
  assert.equal(s.tool_errors, 1);
  assert.equal(s.input_tokens, 10);
  assert.equal((await post({ sessions: [{ id: "x" }] })).status, 400);
  assert.equal((await post({ source: "bad source!", sessions: [] })).status, 400);
  assert.equal((await post({ source: "ok", events: [{ id: "e", type: "x" }] })).status, 400);
});

test("GET /api/sessions?sort=score puts the worst first", async () => {
  seedSession("s-sort-clean", { agent: "clean", updated_at: "2026-09-25T00:00:00Z" });
  seedSession("s-sort-bad", {
    agent: "bad",
    updated_at: "2026-09-24T00:00:00Z",
    turns: [{ id: "tsb1", status: "error" }],
  });
  const ids = async (qs: string) =>
    ((await (await app.request(`/api/sessions?${qs}&limit=100`)).json()) as any).sessions.map((s: any) => s.id);

  const scored = await ids("sort=score");
  assert.ok(scored.indexOf("s-sort-bad") < scored.indexOf("s-sort-clean"));
  const recent = await ids("");
  assert.ok(recent.indexOf("s-sort-clean") < recent.indexOf("s-sort-bad"), "default order is unchanged");
});

test("POST /api/ingest stores a shipped branch, bounded in length", async () => {
  const post = (b: unknown) =>
    app.request("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
  await post({
    source: "shipped",
    sessions: [
      { id: "br1", agent_name: "box/repo", branch: "feat/wide", created_at: "2026-09-01T00:00:00Z" },
      { id: "br2", agent_name: "box/repo", branch: "x".repeat(500), created_at: "2026-09-01T00:00:00Z" },
      { id: "br3", agent_name: "box/repo", branch: 42, created_at: "2026-09-01T00:00:00Z" },
    ],
  });
  const rows = (await (await app.request("/api/sessions?q=box/repo&limit=10")).json()) as any;
  const by = Object.fromEntries(rows.sessions.map((s: any) => [s.id, s.branch]));
  assert.equal(by.br1, "feat/wide");
  assert.equal(by.br2.length, 200, "a long branch is truncated rather than stored whole");
  assert.equal(by.br3, null, "a non-string branch is ignored");
});
