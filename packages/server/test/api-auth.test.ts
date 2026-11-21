import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "./fixtures.ts";

async function withAccess(bind: string | undefined, token: string | undefined, run: () => Promise<void>) {
  const oldBind = process.env.AGENTLENS_HOST;
  const oldToken = process.env.AGENTLENS_TOKEN;
  if (bind === undefined) delete process.env.AGENTLENS_HOST;
  else process.env.AGENTLENS_HOST = bind;
  if (token === undefined) delete process.env.AGENTLENS_TOKEN;
  else process.env.AGENTLENS_TOKEN = token;
  try {
    await run();
  } finally {
    if (oldBind === undefined) delete process.env.AGENTLENS_HOST;
    else process.env.AGENTLENS_HOST = oldBind;
    if (oldToken === undefined) delete process.env.AGENTLENS_TOKEN;
    else process.env.AGENTLENS_TOKEN = oldToken;
  }
}

test("API accepts only loopback or configured Host headers", async () => {
  await withAccess("127.0.0.1", undefined, async () => {
    for (const host of ["localhost:8788", "127.0.0.1:8788", "[::1]:8788"]) {
      const res = await app.request("/api/sessions", { headers: { host } });
      assert.equal(res.status, 200, host);
    }
    const rejected = await app.request("/api/sessions", { headers: { host: "evil.example" } });
    assert.equal(rejected.status, 403);
  });

  await withAccess("10.0.0.8", "test-token", async () => {
    const res = await app.request("/api/sessions", {
      headers: { host: "10.0.0.8:8788", authorization: "Bearer test-token" },
    });
    assert.equal(res.status, 200);
  });
});

test("non-loopback binds require a bearer on API and metrics regardless of Host", async () => {
  await withAccess("10.0.0.8", "test-token", async () => {
    for (const path of ["/api/sessions", "/metrics"]) {
      assert.equal((await app.request(path, { headers: { host: "10.0.0.8" } })).status, 401);
      assert.equal((await app.request(path, {
        headers: { host: "10.0.0.8", authorization: "Bearer wrong" },
      })).status, 401);
      assert.equal((await app.request(path, {
        headers: { host: "10.0.0.8", authorization: "Bearer test-token" },
      })).status, 200);
    }

    const spoofed = await app.request("/api/sessions", { headers: { host: "localhost" } });
    assert.equal(spoofed.status, 401, "a loopback Host does not relax an exposed bind");
    const rebound = await app.request("/api/sessions", {
      headers: { host: "evil.example", authorization: "Bearer test-token" },
    });
    assert.equal(rebound.status, 403);
  });
});
