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

// Every session a test tags carries this line, and publish() quotes it for each one.
const QUOTE = "flaky-tools server unreachable";
const seedQuoted = (id: string, opts: Parameters<typeof seedSession>[1] = {}) =>
  seedSession(id, { ...opts, events: [{ id: `e-${id}`, type: "tool.response", raw: { content: `error: ${QUOTE} after 3 tries` } }] });
const evidenceFor = (codes: unknown) =>
  [...new Set((codes as { session_id: string }[]).map((c) => c.session_id))].map((session_id) => ({ session_id, quote: QUOTE }));

const publish = (client: Client, codes: unknown, investigation_id?: string, evidence: unknown = evidenceFor(codes)) =>
  client
    .callTool({ name: "publish_incident_report", arguments: { title: "flaky tools", body: "server down", codes, evidence, ...(investigation_id !== undefined ? { investigation_id } : {}) } })
    .catch(() => ({ isError: true }));

const reportCount = () => (db.prepare(`SELECT COUNT(*) AS n FROM reports`).get() as { n: number }).n;

test("publish_incident_report tags each session and the API returns the tags", async () => {
  seedQuoted("s-mcp-a", { agent: "flaky-agent" });
  seedQuoted("s-mcp-b", { agent: "docs-helper" });
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
  seedQuoted("s-idempotent");
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

test("publish_incident_report masks secrets in storage and remains idempotent", async () => {
  seedQuoted("s-mcp-secret");
  const githubPat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  const openaiProject = "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const title = `Incident ${githubPat}`;
  const body = `Used ${openaiProject}`;
  const codes = [{ session_id: "s-mcp-secret", code: "loop" }];
  const client = await connect();
  const before = reportCount();
  const call = () => client.callTool({ name: "publish_incident_report", arguments: { title, body, codes, evidence: evidenceFor(codes) } });

  assert.ok(!(await call()).isError);
  assert.ok(!(await call()).isError);
  assert.equal(reportCount(), before + 1, "identical retries still publish only one report");

  const stored = db.prepare(`SELECT id, title, body FROM reports ORDER BY id DESC LIMIT 1`).get() as { id: number; title: string; body: string };
  assert.equal(stored.title, "Incident [REDACTED:github-pat]");
  assert.ok(stored.body.startsWith("Used [REDACTED:openai-project-key]\n"));

  const reports = await (await app.request("/api/reports")).json();
  const report = reports.find((r: any) => r.id === stored.id);
  assert.ok(report);
  assert.equal(report.title, stored.title);
  assert.equal(report.body, stored.body);
  assert.ok(!JSON.stringify(report).includes(githubPat));
  assert.ok(!JSON.stringify(report).includes(openaiProject));
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
  seedQuoted("s-mcp-c");
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

test("read tools say they are read-only and the publish tool says it writes", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  const hint = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
  for (const name of ["list_problem_sessions", "get_session_trace", "get_fleet_metrics", "list_tool_retries", "export_trace_json"]) {
    assert.equal(hint[name], true, name);
  }
  assert.equal(hint.publish_incident_report, false);
  assert.equal(Object.keys(hint).length, 6, "a new tool needs an explicit readOnlyHint");
});

test("publish_incident_report accepts unverified-claim", async () => {
  seedQuoted("s-mcp-unverified", { agent: "docs-helper" });
  const client = await connect();
  const res = await publish(client, [{ session_id: "s-mcp-unverified", code: "unverified-claim" }]);
  assert.ok(!res.isError);
});

test("publish_incident_report rejects evidence the trace does not contain, without writing", async () => {
  seedSession("s-ev-a", {
    events: [
      { id: "e-s-ev-a-1", type: "tool.response", raw: { content: `error: ${QUOTE}` } },
      { id: "e-s-ev-a-2", type: "model.message", raw: { content: "a line only session a has" } },
    ],
  });
  seedQuoted("s-ev-b");
  const client = await connect();
  const before = reportCount();
  const codes = [{ session_id: "s-ev-a", code: "tool-error" }, { session_id: "s-ev-b", code: "loop" }];
  for (const [why, evidence] of [
    ["an invented quote", [{ session_id: "s-ev-a", quote: QUOTE }, { session_id: "s-ev-b", quote: "connection refused on port 9992" }]],
    ["a tagged session with no quote", [{ session_id: "s-ev-a", quote: QUOTE }]],
    ["a real quote cited to the wrong session", [{ session_id: "s-ev-a", quote: QUOTE }, { session_id: "s-ev-b", quote: "a line only session a has" }]],
    ["a quote too short to mean anything", [{ session_id: "s-ev-a", quote: "error" }, { session_id: "s-ev-b", quote: QUOTE }]],
    ["no evidence at all", []],
  ] as const) {
    assert.ok((await publish(client, codes, undefined, evidence)).isError, why);
  }
  const res = (await client.callTool({
    name: "publish_incident_report",
    arguments: { title: "t", body: "b", codes, evidence: [{ session_id: "s-ev-a", quote: QUOTE }, { session_id: "s-ev-b", quote: "connection refused on port 9992" }] },
  })) as any;
  assert.match(res.content[0].text, /s-ev-b/, "the error names the failing session");
  assert.doesNotMatch(res.content[0].text, /s-ev-a/, "and only the failing one");
  assert.equal(reportCount(), before);
});

test("publish_incident_report accepts quotes copied from get_session_trace and shows them in the report", async () => {
  seedSession("s-ev-trace", {
    events: [
      { id: "e-ev-1", type: "model.message", raw: { content: "Running the build\n  then   the tests", toolCalls: [{ id: "c1", function: { name: "Bash", arguments: JSON.stringify({ command: 'npm test -- --grep "retry"' }) } }] } },
      { id: "e-ev-2", type: "tool.response", raw: { toolCallId: "c1", content: "boom", state: { message: "exit status 1: 3 tests failed" } } },
    ],
  });
  const client = await connect();
  const trace = (await client.callTool({ name: "get_session_trace", arguments: { session_id: "s-ev-trace" } })) as any;
  const text: string = trace.content[0].text;
  // What a model copies out of the tool's JSON: escaped tool arguments and
  // reflowed whitespace, not the raw bytes stored in events.raw.
  const args = text.slice(text.indexOf("npm test"), text.indexOf("retry") + 5);
  assert.match(args, /\\/, "the arguments reach the model JSON-escaped");
  const evidence = [
    { session_id: "s-ev-trace", quote: args },
    { session_id: "s-ev-trace", quote: "Running the build then the tests" },
    { session_id: "s-ev-trace", quote: "exit status 1: 3 tests failed" },
  ];
  const res = (await client.callTool({
    name: "publish_incident_report",
    arguments: { title: "build loop", body: "tests fail", codes: [{ session_id: "s-ev-trace", code: "loop" }], evidence },
  })) as any;
  assert.ok(!res.isError, res.content?.[0]?.text);
  const stored = db.prepare(`SELECT body FROM reports ORDER BY id DESC LIMIT 1`).get() as { body: string };
  assert.ok(stored.body.startsWith("tests fail\n"));
  assert.match(stored.body, /s-ev-trace: "exit status 1: 3 tests failed"/);
});

test("publish_incident_report checks quotes against the pinned snapshot when one is cited", async () => {
  seedSession("s-ev-pin", { events: [{ id: "e-ev-pin", type: "model.message", raw: { content: "the original pinned evidence" } }] });
  seedQuoted("s-ev-other");
  const snapshot = ensureSnapshot("s-ev-pin");
  upsertEvent.run({
    id: "e-ev-pin", session_id: "s-ev-pin", turn_id: "t1", thread_id: null, type: "model.message",
    created_at: "2026-09-01T00:00:00Z", raw: JSON.stringify({ content: "rewritten after the snapshot" }),
  });
  const client = await connect();
  const codes = [{ session_id: "s-ev-pin", code: "stall" }];
  const before = reportCount();
  assert.ok((await publish(client, codes, undefined, [{ session_id: "s-ev-pin", quote: "the original pinned evidence" }])).isError, "live trace no longer has it");
  assert.ok((await publish(client, codes, undefined, [{ session_id: "s-ev-pin", quote: "the original pinned evidence", snapshot_id: "" }])).isError, "an empty snapshot id must not fall back to live");
  assert.ok((await publish(client, codes, undefined, [{ session_id: "s-ev-pin", quote: QUOTE, snapshot_id: ensureSnapshot("s-ev-other").id }])).isError, "another session's snapshot");
  assert.equal(reportCount(), before);
  assert.ok(!(await publish(client, codes, undefined, [{ session_id: "s-ev-pin", quote: "the original pinned evidence", snapshot_id: snapshot.id }])).isError);
});

test("publish_incident_report masks a quoted secret and still matches the masked trace", async () => {
  const githubPat = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
  seedSession("s-ev-secret", { events: [{ id: "e-ev-secret", type: "tool.response", raw: { content: "push failed for token [REDACTED:github-pat] at origin" } }] });
  const client = await connect();
  const res = await publish(client, [{ session_id: "s-ev-secret", code: "tool-error" }], undefined, [
    { session_id: "s-ev-secret", quote: `push failed for token ${githubPat} at origin` },
  ]);
  assert.ok(!res.isError);
  const stored = db.prepare(`SELECT body FROM reports ORDER BY id DESC LIMIT 1`).get() as { body: string };
  assert.ok(!stored.body.includes(githubPat));
  assert.match(stored.body, /\[REDACTED:github-pat\]/);
});

test("publish_incident_report accepts a quote that spans a tool argument's key and value", async () => {
  // Claude Code stores tool arguments as an object, and the trace tools show
  // them as JSON, so a natural quote includes the key.
  seedSession("s-ev-objargs", {
    events: [{ id: "e-ev-obj", type: "model.message", raw: { toolCalls: [{ id: "c1", function: { name: "Bash", arguments: { command: "kubectl get pods -A" } } }] } }],
  });
  const client = await connect();
  const trace = (await client.callTool({ name: "get_session_trace", arguments: { session_id: "s-ev-objargs" } })) as any;
  const text: string = trace.content[0].text;
  const quote = text.slice(text.indexOf("command"), text.indexOf("pods") + 4);
  assert.match(quote, /command.+kubectl get pods/);
  const res = await publish(client, [{ session_id: "s-ev-objargs", code: "loop" }], undefined, [{ session_id: "s-ev-objargs", quote }]);
  assert.ok(!res.isError);
});
