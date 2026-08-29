import { serve } from "@hono/node-server";
import { app } from "./api.js";
import { startCollector } from "./collector.js";
import { startMcpServer } from "./mcp.js";

const port = Number(process.env.PORT ?? 8788);
startCollector();
startMcpServer(8791);
serve({ fetch: app.fetch, port }, () =>
  console.log(`agentlens api on http://localhost:${port}`),
);
