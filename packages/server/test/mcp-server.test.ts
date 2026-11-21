import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import "./fixtures.ts";

const { startMcpServer } = await import("../src/mcp.ts");

test("MCP rejects an oversized request body before parsing it", async () => {
  const server = startMcpServer(0);
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const postMalformed = (bytes: number) => fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(bytes),
    });

    const atLimit = await postMalformed(1_000_000);
    assert.equal(atLimit.status, 400, "the cap is inclusive");
    const oversized = await postMalformed(1_000_001);
    assert.equal(oversized.status, 413, "an oversized body is rejected before malformed JSON can be parsed");
    assert.deepEqual(await oversized.json(), { error: "request body too large" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
