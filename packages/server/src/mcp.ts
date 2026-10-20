import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { agentSummaries, db, sessionSummaries, sessionTrace } from "./db.js";

// Fixed vocabulary so reports can be compared and counted across investigations.
export const FAILURE_CODES = {
  "tool-error": "a tool call failed or its server was unreachable",
  loop: "repeated the same calls without making progress",
  stall: "long gap with no progress, or hit an iteration or time limit",
  "wrong-premise": "acted on a false belief about its environment or task",
  "approval-wait": "blocked waiting on a human approval",
  "model-error": "the model or provider failed (rate limit, context overflow, malformed output)",
  other: "none of the above",
} as const;
const codeEnum = z.enum(Object.keys(FAILURE_CODES) as [keyof typeof FAILURE_CODES]);

// MCP tools the investigator agent uses to inspect the fleet.
export function buildMcp() {
  const mcp = new McpServer({ name: "agentlens", version: "0.1.0" });

  mcp.registerTool(
    "list_problem_sessions",
    {
      description:
        "List sessions ranked by how much they look like they went wrong: failed turns, repeated tool failures, long stalls, and unusual numbers of tool calls per turn. Worst first. Start an investigation here.",
      inputSchema: {},
    },
    async () => {
      // Ranked in SQL rather than filtered on thresholds, so this really is
      // worst first; a session with nothing wrong scores zero and is dropped.
      const rows = sessionSummaries({ sort: "score", limit: 20 }).filter(
        (s: any) => s.problem_score > 0,
      );
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

  // The human approval gate for this tool is enforced by TrueForge via
  // require_approval_for_tools in the investigator manifest (seed.ts); the
  // annotation below only describes the tool.
  mcp.registerTool(
    "publish_incident_report",
    {
      description:
        "Publish the final incident report to the AgentLens dashboard. This is a write action and requires human approval. " +
        "codes: one entry per failure seen, naming the session it happened in. " +
        Object.entries(FAILURE_CODES).map(([k, v]) => `${k}: ${v}`).join("; ") + ".",
      inputSchema: {
        title: z.string(),
        body: z.string(),
        codes: z.array(z.object({ session_id: z.string(), code: codeEnum })).min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ title, body, codes }) => {
      // Codes are counted per agent through their session, so a made-up id
      // would silently skew those counts.
      const known = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
      const unknown = [...new Set(codes.map((c) => c.session_id))].filter((id) => !known.get(id));
      if (unknown.length) {
        return { isError: true, content: [{ type: "text", text: `Unknown session ids: ${unknown.join(", ")}` }] };
      }
      db.transaction(() => {
        const { lastInsertRowid } = db.prepare(`INSERT INTO reports (title, body) VALUES (?, ?)`).run(title, body);
        const tag = db.prepare(`INSERT OR IGNORE INTO report_codes (report_id, session_id, code) VALUES (?, ?, ?)`);
        for (const c of codes) tag.run(lastInsertRowid, c.session_id, c.code);
      })();
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
  server.on("error", (err: NodeJS.ErrnoException) => {
    // Usually a second AgentLens on the same machine. Say which port, and stop.
    console.error(
      err.code === "EADDRINUSE"
        ? `mcp port ${port} is already in use; set MCP_PORT to something else`
        : `mcp: ${err.message}`,
    );
    process.exit(1);
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`agentlens mcp on http://localhost:${port}/mcp`),
  );
  return server;
}
