import { serve } from "@hono/node-server";
import { app } from "./api.js";
import { startCollector } from "./collector.js";
import { startMcpServer } from "./mcp.js";
import { detectSources } from "./sources/index.js";

const port = Number(process.env.PORT ?? 8788);
startCollector(detectSources());
startMcpServer(Number(process.env.MCP_PORT ?? 8791));
// Loopback only for the same reason: the API serves full session traces and
// triggers investigations with no auth.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(`agentlens api on http://localhost:${port}`),
);
