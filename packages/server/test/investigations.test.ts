import assert from "node:assert/strict";
import { test } from "node:test";
import { ensureSnapshot, launchInvestigation, readSnapshot, seedSession, upsertEvent } from "./fixtures.ts";

function eventRow(sessionId: string, id: string, content: string) {
  return {
    id,
    session_id: sessionId,
    turn_id: "t1",
    thread_id: null,
    type: "model.message",
    created_at: "2026-09-01T00:00:00Z",
    raw: JSON.stringify({ content }),
  };
}

function fakeLauncher(failTurns = 0) {
  const calls = { sessions: 0, turns: 0 };
  const client = {
    sessions: {
      create: async (_input: { agent: { name: string } }) => {
        calls.sessions++;
        await new Promise((resolve) => setImmediate(resolve));
        return { data: { id: `tf-${calls.sessions}` } };
      },
      createTurn: async (sessionId: string, _input: { input: { type: "user.message"; content: string }[] }) => {
        calls.turns++;
        await new Promise((resolve) => setImmediate(resolve));
        if (calls.turns <= failTurns) throw new Error("turn failed");
        return { data: { id: `${sessionId}-turn-${calls.turns}` } };
      },
    },
  };
  return { calls, client };
}

test("an investigation snapshot survives in-place event updates", () => {
  seedSession("s-snapshot", { turns: [{ id: "t1" }], events: [{ id: "e-snapshot-1", type: "model.message", raw: { content: "before" } }] });
  const first = ensureSnapshot("s-snapshot");
  assert.equal(ensureSnapshot("s-snapshot").id, first.id);

  upsertEvent.run(eventRow("s-snapshot", "e-snapshot-1", "after"));
  const second = ensureSnapshot("s-snapshot");
  assert.notEqual(second.id, first.id);
  assert.equal(readSnapshot(first.id)!.snapshot.events[0].raw.content, "before");
  assert.equal(readSnapshot(second.id)!.snapshot.events[0].raw.content, "after");
});

test("targeted launches deduplicate concurrently and advance on a new revision", async () => {
  seedSession("s-launch", { events: [{ id: "e-launch-1", type: "model.message", raw: { content: "before" } }] });
  const { calls, client } = fakeLauncher();
  const [first, concurrent] = await Promise.all([
    launchInvestigation("session", "s-launch", client),
    launchInvestigation("session", "s-launch", client),
  ]);
  assert.equal(first.investigation_id, concurrent.investigation_id);
  assert.equal(first.session_id, concurrent.session_id);
  assert.equal(calls.sessions, 1);
  assert.equal(calls.turns, 1);
  assert.notEqual(first.deduplicated, concurrent.deduplicated);

  const again = await launchInvestigation("session", "s-launch", client);
  assert.equal(again.investigation_id, first.investigation_id);
  assert.equal(again.deduplicated, true);
  assert.equal(calls.sessions, 1);

  upsertEvent.run(eventRow("s-launch", "e-launch-2", "new evidence"));
  const advanced = await launchInvestigation("session", "s-launch", client);
  assert.notEqual(advanced.investigation_id, first.investigation_id);
  assert.equal(calls.sessions, 2);
});

test("fleet launches deduplicate by the fleet revision", async () => {
  seedSession("s-fleet", { events: [{ id: "e-fleet-1", type: "model.message", raw: {} }] });
  const { calls, client } = fakeLauncher();
  const first = await launchInvestigation("fleet", undefined, client);
  const again = await launchInvestigation("fleet", undefined, client);
  assert.equal(again.investigation_id, first.investigation_id);
  assert.equal(again.deduplicated, true);
  assert.equal(calls.sessions, 1);

  upsertEvent.run(eventRow("s-fleet", "e-fleet-2", "new"));
  const advanced = await launchInvestigation("fleet", undefined, client);
  assert.notEqual(advanced.investigation_id, first.investigation_id);
  assert.equal(calls.sessions, 2);
});

test("turn failure resumes the existing TrueForge root session", async () => {
  seedSession("s-resume", { events: [{ id: "e-resume-1", type: "model.message", raw: {} }] });
  const { calls, client } = fakeLauncher(1);
  await assert.rejects(launchInvestigation("session", "s-resume", client), /turn failed/);
  const recovered = await launchInvestigation("session", "s-resume", client);
  assert.equal(recovered.session_id, "tf-1");
  assert.equal(calls.sessions, 1);
  assert.equal(calls.turns, 2);
});
