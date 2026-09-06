import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./api.js";
import { startCollector } from "./collector.js";
import { startMcpServer } from "./mcp.js";
import { detectSources } from "./sources/index.js";

const port = Number(process.env.PORT ?? 8788);
startCollector(detectSources());
startMcpServer(Number(process.env.MCP_PORT ?? 8791));

// Serve the built dashboard from the same process so one URL is enough.
// serveStatic resolves `root` against cwd, so translate from this file's path.
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || "." }));
} else {
  console.log("dashboard not built (npm run build -w packages/web); API only");
}

// Loopback only for the same reason: the API serves full session traces and
// triggers investigations with no auth.
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () =>
  console.log(`agentlens on http://localhost:${port}`),
);
