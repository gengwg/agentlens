import assert from "node:assert/strict";
import { test } from "node:test";
import { db, getCursor, seedSession } from "./fixtures.ts";

process.env.AGENTLENS_HOST_NAME = "testbox";
const { shipOnce } = await import("../src/ship.ts");
const MAX_BODY_BYTES = 2 * 1024 * 1024;

test("ship byte-batches sessions, turns and events, then advances its cursor", async () => {
  db.transaction(() => {
    for (let i = 0; i < 3000; i++) {
      seedSession(`large-${i}`, {
        agent: "a".repeat(1000),
        source: "claude-code",
        updated_at: "2026-12-01T00:00:00Z",
        turns: [{ id: `large-t-${i}-${"t".repeat(1000)}` }],
        events: [{ id: `large-e-${i}-${"e".repeat(1000)}`, type: "model.message", raw: {} }],
      });
    }
  })();

  const originalFetch = globalThis.fetch;
  const bodies: any[] = [];
  const sizes: number[] = [];
  globalThis.fetch = async (_input, init) => {
    const text = String(init!.body);
    sizes.push(Buffer.byteLength(text));
    bodies.push(JSON.parse(text));
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const sent = await shipOnce("http://shared-large.test", "shipped");
    assert.deepEqual(sent, { sessions: 3000, turns: 3000, events: 3000 });
    assert.ok(sizes.every((size) => size <= MAX_BODY_BYTES), "every request fits the ingest limit");

    const sessions = bodies.filter((body) => body.sessions);
    const turns = bodies.filter((body) => body.turns);
    const events = bodies.filter((body) => body.events);
    assert.ok(sessions.length > 1, "sessions split by bytes");
    assert.ok(turns.length > 1, "turns split by bytes");
    assert.ok(events.length > 1, "events split by bytes");
    assert.equal(sessions.flatMap((body) => body.sessions).length, 3000);
    assert.equal(turns.flatMap((body) => body.turns).length, 3000);
    assert.equal(events.flatMap((body) => body.events).length, 3000);
    assert.ok(bodies.lastIndexOf(sessions.at(-1)) < bodies.indexOf(turns[0]), "sessions arrive before turns");
    assert.ok(bodies.lastIndexOf(turns.at(-1)) < bodies.indexOf(events[0]), "turns arrive before events");

    const count = bodies.length;
    assert.deepEqual(await shipOnce("http://shared-large.test", "shipped"), { sessions: 0, turns: 0, events: 0 });
    assert.equal(bodies.length, count, "a successful pass does not deadlock into identical retries");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ship rejects an individually oversized row without advancing its cursor", async () => {
  seedSession("too-big", {
    agent: "x".repeat(MAX_BODY_BYTES),
    source: "claude-code",
    updated_at: "2027-01-01T00:00:00Z",
  });
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const text = String(init!.body);
    bodies.push(text);
    assert.ok(Buffer.byteLength(text) <= MAX_BODY_BYTES);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.rejects(shipOnce("http://shared-oversize.test", "shipped"), /sessions row testbox:too-big exceeds/);
    assert.ok(bodies.every((body) => !body.includes("too-big")), "the oversized row is never posted or truncated");
    assert.equal(getCursor("ship", "ship:http://shared-oversize.test"), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
