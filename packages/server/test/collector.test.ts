import assert from "node:assert/strict";
import { test } from "node:test";
import { db, turnRow, upsertTurn } from "./fixtures.ts";

test("turnRow maps a running turn with no state", () => {
  assert.deepEqual(turnRow("s1", { id: "t1", createdAt: "2026-09-01T00:00:00Z" }, 0), {
    id: "t1",
    session_id: "s1",
    created_at: "2026-09-01T00:00:00Z",
    completed_at: null,
    status: "running",
    error: null,
    ingested: 0,
    pending_actions: 0,
  });
});

test("turnRow keeps the error message only for error turns", () => {
  const failed = turnRow("s1", { id: "t2", state: { status: "error", message: "boom" } }, 1);
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "boom");

  const done = turnRow("s1", { id: "t3", state: { status: "done", message: "boom" } }, 1);
  assert.equal(done.error, null);
});

test("turnRow counts required actions as pending approvals", () => {
  const row = turnRow(
    "s1",
    { id: "t4", state: { status: "done", completedAt: "2026-09-01T00:00:05Z", requiredActions: [{}, {}] } },
    1,
  );
  assert.equal(row.pending_actions, 2);
  assert.equal(row.completed_at, "2026-09-01T00:00:05Z");
  assert.equal(row.ingested, 1);
});

// The row shape must match upsertTurn's named parameters, or ingest throws at runtime.
test("turnRow output is accepted by the upsertTurn statement", () => {
  const row = turnRow("s-ingest", { id: "t5", createdAt: "2026-09-01T00:00:00Z" }, 0);
  upsertTurn.run(row);
  upsertTurn.run(turnRow("s-ingest", { id: "t5", state: { status: "done" } }, 1));
  assert.deepEqual(db.prepare(`SELECT status, ingested FROM turns WHERE id='t5'`).get(), {
    status: "done",
    ingested: 1,
  });
});
