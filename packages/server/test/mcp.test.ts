import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app, buildMcp, db, seedSession } from "./fixtures.ts";

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildMcp().connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return client;
}

const publish = (client: Client, codes: unknown) =>
  client
    .callTool({ name: "publish_incident_report", arguments: { title: "flaky tools", body: "server down", codes } })
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
