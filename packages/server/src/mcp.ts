import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { agentSummaries, db, sessionSummaries, sessionTrace } from "./db.js";

// MCP tools the investigator agent uses to inspect the fleet.
function buildMcp() {
  const mcp = new McpServer({ name: "agentlens", version: "0.1.0" });

  mcp.registerTool(
    "list_problem_sessions",
    {
      description:
        "List sessions with failed/cancelled turns or unusually slow turns, worst first. Start an investigation here.",
      inputSchema: {},
    },
    async () => {
      const rows = sessionSummaries()
        .filter(
          (s: any) =>
            s.error_turns > 0 || s.tool_errors > 0 || (s.total_seconds ?? 0) > 120,
        )
        .slice(0, 20);
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 1) }] };
    },
  );

  mcp.registerTool(
    "get_session_trace",
    {
      description:
        "Full trace for one session: turns with status/duration/errors, and per-event log (model messages, tool calls with args and truncated results, subagent threads).",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      const t = sessionTrace(session_id);
      const compact = {
        session: t.session,
        turns: t.turns,
        events: t.events.map((e: any) => {
          const raw = e.raw;
          return {
            type: e.type,
            at: e.created_at,
            thread: e.thread_id,
            content: typeof raw.content === "string" ? raw.content.slice(0, 800) : raw.content,
            toolCalls: raw.toolCalls?.map((c: any) => ({
              name: c.function?.name ?? c.toolInfo?.name,
              args: JSON.stringify(c.function?.arguments ?? "").slice(0, 400),
            })),
            usage: raw.usage,
            state: raw.state,
            error: raw.state?.message,
          };
        }),
      };
      return { content: [{ type: "text", text: JSON.stringify(compact, null, 1) }] };
    },
  );

  mcp.registerTool(
    "get_fleet_metrics",
    {
      description: "Per-agent aggregates: session counts and how many sessions had errors.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(agentSummaries(), null, 1) }],
    }),
  );

  mcp.registerTool(
    "export_trace_json",
    {
      description:
        "Export a session's raw event log as JSON, for deeper analysis in the sandbox (timing histograms, token accounting).",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => {
      const events = db
        .prepare(`SELECT raw FROM events WHERE session_id = ? ORDER BY created_at IS NULL, created_at, id`)
        .all(session_id) as { raw: string }[];
      return {
        content: [{ type: "text", text: `[${events.map((e) => e.raw).join(",")}]` }],
      };
    },
  );

  mcp.registerTool(
    "publish_incident_report",
    {
      description:
        "Publish the final incident report to the AgentLens dashboard. This is a write action and requires human approval.",
      inputSchema: { title: z.string(), body: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body }) => {
      db.prepare(`INSERT INTO reports (title, body) VALUES (?, ?)`).run(title, body);
      return { content: [{ type: "text", text: "Report published to dashboard." }] };
    },
  );

  return mcp;
}

export function startMcpServer(port = 8791) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      res.writeHead(405).end();
      return;
    }
    // Stateless mode: fresh server+transport per request, per the SDK's own
    // pattern - Protocol.connect() throws if a server instance is reused
    // across transports, so a hoisted singleton would break concurrent calls.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    // Parse the body first: malformed JSON is a client error (400), while
    // connect/handle failures are server errors (500).
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad request" }));
      return;
    }
    try {
      await buildMcp().connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("mcp:", (err as Error).message);
      // Respond instead of dying with an unhandled rejection.
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  // Loopback only: the MCP tools have no auth, so binding to all interfaces
  // would expose session traces and the report-write tool to the LAN.
  server.listen(port, "127.0.0.1", () =>
    console.log(`agentlens mcp on http://localhost:${port}/mcp`),
  );
  return server;
}
