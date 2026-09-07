#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./api.js";
import { backfillMain } from "./backfill.js";
import { startCollector } from "./collector.js";
import { refreshPrices } from "./db.js";
import { loadPrices, priceFor } from "./prices.js";
import { startMcpServer } from "./mcp.js";
import { shipMain } from "./ship.js";
import { detectSources } from "./sources/index.js";

function serveMain() {
  const port = Number(process.env.PORT ?? 8788);
  startCollector(detectSources());
  // Pricing is a bonus: fetched in the background, and every failure is a log
  // line rather than a broken start. Refreshed hourly so models seen after
  // boot get priced too.
  const prices = async () => {
    const known = await loadPrices();
    if (!known) return;
    const { models, priced } = refreshPrices((m) => priceFor(m));
    console.log(`prices: ${priced}/${models} models priced from ${known} known`);
  };
  prices().catch((err) => console.error(`prices: ${(err as Error).message}`));
  setInterval(() => prices().catch(() => {}), 60 * 60 * 1000).unref();
  startMcpServer(Number(process.env.MCP_PORT ?? 8791));

  // Serve the built dashboard from the same process so one URL is enough.
  // Bundled next to the compiled server when published, built in place in the repo.
  const here = dirname(fileURLToPath(import.meta.url));
  const dist = [join(here, "web"), join(here, "..", "..", "web", "dist")].find(existsSync);
  if (dist) {
    // serveStatic resolves `root` against cwd, so translate from this file's path.
    app.use("/*", serveStatic({ root: relative(process.cwd(), dist) || "." }));
  } else {
    console.log("dashboard not built (npm run build -w packages/web); API only");
  }

  // Loopback by default: the API serves full session traces and triggers
  // investigations with no auth. AGENTLENS_HOST opens it to a trusted network
  // (a tailnet); anyone who can reach it then sees everything.
  const host = process.env.AGENTLENS_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost")
    console.log(`warning: listening on ${host} with no authentication`);
  const server = serve({ fetch: app.fetch, port, hostname: host }, () =>
    console.log(`agentlens on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`),
  );
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === "EADDRINUSE"
        ? `port ${port} is already in use; set PORT to something else`
        : `server: ${err.message}`,
    );
    process.exit(1);
  });
}

// `agentlens ship ...` is a client of another AgentLens, not a server.
if (process.argv[2] === "ship") await shipMain(process.argv.slice(3));
// A one-off pass over history written before masking existed.
else if (process.argv[2] === "redact-history") backfillMain(process.argv.slice(3));
else serveMain();
