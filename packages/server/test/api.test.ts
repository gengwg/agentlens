import assert from "node:assert/strict";
import { test } from "node:test";
import { app, db, seedSession } from "./fixtures.ts";

test("GET /api/sessions returns the rollup", async () => {
  seedSession("s-api", { turns: [{ id: "t1", status: "error" }] });
  const res = await app.request("/api/sessions");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body[0].id, "s-api");
  assert.equal(body[0].error_turns, 1);
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
