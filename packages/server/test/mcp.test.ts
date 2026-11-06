import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app, buildMcp, db, ensureSnapshot, prepareInvestigation, seedSession, upsertEvent } from "./fixtures.ts";

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcp().connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const publish = (client: Client, codes: unknown, investigation_id?: string) =>
  client
    .callTool({ name: "publish_incident_report", arguments: { title: "flaky tools", body: "server down", codes, ...(investigation_id !== undefined ? { investigation_id } : {}) } })
    .catch(() => ({ isError: true }));

const reportCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM reports`).get() as { n: number }).n;

test("publish_incident_report tags each session and the API returns the tags", async () => {
  seedSession("s-mcp-a", { agent: "flaky-agent" });
  seedSession("s-mcp-b", { agent: "docs-helper" });
  const client = await connect();
  const res = await publish(client, [
    { session_id: "s-mcp-a", code: "tool-error" },
    { session_id: "s-mcp-a", code: "loop" },
    { session_id: "s-mcp-a", code: "tool-error" },
    { session_id: "s-mcp-b", code: "stall" },
  ]);
  assert.ok(!res.isError);

  const [report] = await (await app.request("/api/reports")).json();
  assert.equal(report.title, "flaky tools");
  assert.deepEqual(
    report.codes.map((c: any) => `${c.session_id}:${c.code}`).sort(),
    ["s-mcp-a:loop", "s-mcp-a:tool-error", "s-mcp-b:stall"],
  );
});

test("publish_incident_report is idempotent by investigation and by legacy content", async () => {
  seedSession("s-idempotent");
  const investigation = prepareInvestigation("session", "s-idempotent");
  const codes = [{ session_id: "s-idempotent", code: "loop" }];
  const client = await connect();
  const before = reportCount();

  assert.ok(!(await publish(client, codes, investigation.investigation_id)).isError);
  assert.ok(!(await publish(client, codes, investigation.investigation_id)).isError);
  assert.equal(reportCount(), before + 1, "approval retries reuse the investigation's report");

  assert.ok(!(await publish(client, codes)).isError);
  assert.ok(!(await publish(client, codes)).isError);
  assert.equal(reportCount(), before + 2, "legacy calls deduplicate identical content");
  assert.ok((await publish(client, codes, "unknown-investigation")).isError);
  assert.ok((await publish(client, codes, "")).isError, "an empty investigation id must not downgrade to content dedupe");
  assert.equal(reportCount(), before + 2);
});

test("list_problem_sessions supplies a snapshot id for each suspect", async () => {
  seedSession("s-problem", { turns: [{ id: "problem-t1", status: "error" }], events: [{ id: "e-problem-1", type: "model.message", raw: { content: "pinned" } }] });
  const client = await connect();
  const res = await client.callTool({ name: "list_problem_sessions", arguments: {} });
  const rows = JSON.parse((res as any).content[0].text);
  const row = rows.find((r: any) => r.id === "s-problem");
  assert.ok(row.snapshot_id);
  assert.equal(row.snapshot_id, ensureSnapshot("s-problem").id);
});

test("trace and export tools read a pinned snapshot after an event changes", async () => {
  seedSession("s-pinned", { events: [{ id: "e-pinned-1", type: "model.message", raw: { content: "before" } }] });
  const snapshot = ensureSnapshot("s-pinned");
  upsertEvent.run({
    id: "e-pinned-1", session_id: "s-pinned", turn_id: "t1", thread_id: null, type: "model.message",
    created_at: "2026-09-01T00:00:00Z", raw: JSON.stringify({ content: "after" }),
  });
  const client = await connect();

  const trace = await client.callTool({ name: "get_session_trace", arguments: { session_id: "s-pinned", snapshot_id: snapshot.id } });
  const compact = JSON.parse((trace as any).content[0].text);
  assert.equal(compact.events[0].content, "before");

  const exported = await client.callTool({ name: "export_trace_json", arguments: { session_id: "s-pinned", snapshot_id: snapshot.id } });
  const events = JSON.parse((exported as any).content[0].text);
  assert.equal(events[0].content, "before");

  for (const name of ["get_session_trace", "export_trace_json"]) {
    const rejected = await client.callTool({ name, arguments: { session_id: "s-pinned", snapshot_id: "" } }).catch(() => ({ isError: true }));
    assert.ok(rejected.isError, `${name} must reject an empty snapshot id instead of reading live evidence`);
  }
});

test("publish_incident_report rejects bad codes and unknown sessions without writing", async () => {
  seedSession("s-mcp-c");
  const client = await connect();
  const before = reportCount();
  for (const codes of [
    [{ session_id: "s-mcp-c", code: "gpu-melted" }],
    [],
    [{ session_id: "s-made-up", code: "loop" }],
  ]) {
    assert.ok((await publish(client, codes)).isError, `codes ${JSON.stringify(codes)} should be rejected`);
  }
  assert.equal(reportCount(), before);
});

test("list_tool_retries returns the rollup", async () => {
  seedSession("s-mcp-retry", {
    source: "claude-code",
    updated_at: new Date().toISOString(),
    events: [
      { id: "smr1", type: "model.message", raw: { toolCalls: [{ id: "c1", function: { name: "McpRetryTool", arguments: "{}" } }] } },
      { id: "smr2", type: "tool.response", raw: { toolCallId: "c1", content: "boom", error: true } },
      { id: "smr3", type: "model.message", raw: { toolCalls: [{ id: "c2", function: { name: "McpRetryTool", arguments: "{}" } }] } },
    ],
  });
  const client = await connect();
  const res = (await client.callTool({ name: "list_tool_retries", arguments: { days: 7 } })) as any;
  const rows = JSON.parse(res.content[0].text);
  assert.ok(Array.isArray(rows));
  const row = rows.find((r: any) => r.tool === "McpRetryTool");
  assert.ok(row && "retried" in row);
  assert.equal(row.retried, 1);
});
