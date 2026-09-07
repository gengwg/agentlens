import assert from "node:assert/strict";
import { test } from "node:test";
import { db, seedSession } from "./fixtures.ts";

const { apply, scan } = await import("../src/backfill.ts");
const { redactSecrets } = await import("../src/redact-secrets.ts");

// Rows written before masking existed. Inserted straight through SQL, since the
// point is that they bypassed the guarded writers.
const key = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";

test("history written before masking is found and masked, once", () => {
  seedSession("bf-old", { turns: [{ id: "bf-t1" }] });
  db.prepare(`INSERT INTO events (id, session_id, turn_id, type, created_at, raw, seq)
    VALUES (?, ?, ?, 'tool.response', '2026-09-01T00:00:00Z', ?, 999999)`)
    .run("bf-e1", "bf-old", "bf-t1", JSON.stringify({ content: `token is ${key}` }));
  db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(`deploy with ${key}`, "bf-old");
  db.prepare(`UPDATE turns SET error = ? WHERE id = ?`).run(`auth failed for ${key}`, "bf-t1");

  const found = scan();
  assert.ok(found.events >= 1 && found.titles >= 1 && found.errors >= 1, JSON.stringify(found));

  const changed = apply();
  assert.equal(changed.events, found.events);
  assert.equal(changed.titles, found.titles);
  assert.equal(changed.errors, found.errors);

  const row = db.prepare(`SELECT raw FROM events WHERE id = ?`).get("bf-e1") as { raw: string };
  const s = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get("bf-old") as { title: string };
  const t = db.prepare(`SELECT error FROM turns WHERE id = ?`).get("bf-t1") as { error: string };
  for (const text of [row.raw, s.title, t.error]) {
    assert.ok(!text.includes(key), text);
    assert.ok(text.includes("[REDACTED:github-pat]"));
  }
  assert.ok(row.raw.includes("token is"), "surrounding text survives");
  assert.deepEqual(JSON.parse(row.raw).content, "token is [REDACTED:github-pat]", "still valid JSON");

  // Idempotent: a second pass finds nothing, which is what makes it safe to run
  // over every row rather than tracking which are old.
  assert.deepEqual(scan(), { events: 0, titles: 0, errors: 0 });
  assert.deepEqual(apply(), { events: 0, titles: 0, errors: 0 });
});

test("the pass leaves the shipping cursor alone", () => {
  // seq must not move: a shipper already sent these events without content, so
  // bumping it would resend everything for no gain.
  const before = db.prepare(`SELECT seq FROM events WHERE id = ?`).get("bf-e1") as { seq: number };
  apply();
  const after = db.prepare(`SELECT seq FROM events WHERE id = ?`).get("bf-e1") as { seq: number };
  assert.equal(after.seq, before.seq);
});

test("a mask literal is not a secret", () => {
  assert.equal(redactSecrets("[REDACTED:bearer-token] [REDACTED:private-key]"), "[REDACTED:bearer-token] [REDACTED:private-key]");
});
