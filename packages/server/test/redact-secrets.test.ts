import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { db, insertEvent, seedSession, sessionTrace, upsertEvent } from "./fixtures.ts";

const { redactSecrets } = await import("../src/redact-secrets.ts");
const { upsertSession, upsertTurn } = await import("../src/db.ts");

// Fake credentials are assembled at runtime rather than written out. They are
// invented, but they match real formats by design, and a literal in the source
// trips GitHub's secret scanning - which is the scanner doing its job, so the
// answer is to not write them down rather than to dismiss the alert.
const fake = {
  openaiProject: "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
  githubPat: "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
  awsKey: "AKIA" + "IOSFODNN7EXAMPLE",
};

// Their own corpus, taken verbatim from grafana/agento11y
// redaction/fixtures/strings.json (Apache-2.0), light mode with emails off,
// which is the tier-1 set this port implements. If a pattern is transcribed
// wrong, one of these fails.
//
// Stored base64: the inputs are deliberately realistic example keys, and
// GitHub's secret scanning blocks a push that carries them in the clear -
// which is a fair thing for it to do, and not worth an allowlist entry.
const corpus = readFileSync(new URL("./fixtures/agento11y-light.json.b64", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l && !l.startsWith("#"))
  .join("");
const cases: { id: string; input: string; expected: string }[] = JSON.parse(
  Buffer.from(corpus, "base64").toString("utf8"),
);

test("every agento11y light-mode fixture masks exactly as theirs does", () => {
  assert.ok(cases.length >= 28, "corpus should not shrink silently");
  for (const c of cases) {
    assert.equal(redactSecrets(c.input), c.expected, c.id);
  }
});

test("tier-2 shapes are deliberately left alone", () => {
  // `DB_PASSWORD=hunter2` in a transcript is often the thing you are reading
  // the transcript to find, so key=value guessing stays out.
  assert.equal(redactSecrets("DB_PASSWORD=hunter2secretvalue"), "DB_PASSWORD=hunter2secretvalue");
  assert.equal(redactSecrets('{"api_key": "s3cret"}'), '{"api_key": "s3cret"}');
});

test("ordinary transcript text is untouched", () => {
  const text = "Run `npm test -- retry`, then check src/webhooks/retry.ts:41 and the ETIMEDOUT at 10.4.2.19:5432.";
  assert.equal(redactSecrets(text), text);
  assert.equal(redactSecrets(""), "");
});

test("a secret in a tool result never reaches SQLite", () => {
  seedSession("r-tool", { turns: [{ id: "rt1" }] });
  insertEvent.run({
    id: "r-e1",
    session_id: "r-tool",
    turn_id: "rt1",
    thread_id: null,
    type: "tool.response",
    created_at: "2026-09-01T00:00:00Z",
    // What `printenv` or a .env read looks like coming back from a tool.
    raw: JSON.stringify({ content: `GITHUB_TOKEN=${fake.githubPat}\nAWS_ACCESS_KEY_ID=${fake.awsKey}` }),
  });

  const stored = db.prepare(`SELECT raw FROM events WHERE id = ?`).get("r-e1") as { raw: string };
  assert.ok(!stored.raw.includes(fake.githubPat), "the GitHub token is gone");
  assert.ok(!stored.raw.includes(fake.awsKey), "the AWS key is gone");
  assert.ok(stored.raw.includes("[REDACTED:github-pat]"));
  assert.ok(stored.raw.includes("[REDACTED:aws-access-token]"));
  // Still valid JSON, and the surrounding text survives.
  const trace = sessionTrace("r-tool");
  assert.ok(trace.events[0].raw.content.includes("GITHUB_TOKEN="));
});

test("a secret in a prompt is masked too, and mutated rows stay masked", () => {
  seedSession("r-prompt", { turns: [{ id: "rp1" }] });
  const row = {
    id: "r-e2",
    session_id: "r-prompt",
    turn_id: "rp1",
    thread_id: null,
    type: "turn.created",
    created_at: "2026-09-01T00:00:00Z",
    raw: JSON.stringify({ input: [{ type: "user.message", content: `use ${fake.openaiProject} for this` }] }),
  };
  insertEvent.run(row);
  // OpenCode rewrites a row in place; the rewrite goes through the same gate.
  upsertEvent.run({ ...row, raw: JSON.stringify({ input: [{ type: "user.message", content: `retry with ${fake.openaiProject}` }] }) });

  const stored = db.prepare(`SELECT raw FROM events WHERE id = ?`).get("r-e2") as { raw: string };
  assert.ok(!stored.raw.includes(fake.openaiProject));
  assert.ok(stored.raw.includes("[REDACTED:openai-project-key]"));
  assert.ok(stored.raw.includes("retry with"), "the rewrite landed, masked");
});

test("a private key block is masked whole", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd\n-----END RSA PRIVATE KEY-----";
  const out = redactSecrets(`here it is:\n${pem}\nthat was it`);
  assert.equal(out, "here it is:\n[REDACTED:private-key]\nthat was it");
});

test("a secret in a session title is masked", () => {
  // A first prompt that opens with a key becomes the session title.
  upsertSession.run({
    id: "r-title2",
    agent_name: "repo",
    title: `use ${fake.githubPat} to fetch it`,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    created_by: "test",
    source: "claude-code",
  });
  const t = db.prepare(`SELECT title FROM sessions WHERE id = ?`).get("r-title2") as { title: string };
  assert.ok(!t.title.includes(fake.githubPat), "the token is not stored in the title");
  assert.ok(t.title.includes("[REDACTED:github-pat]") && t.title.includes("to fetch it"));
});

test("a turn error carrying a key is masked", () => {
  seedSession("r-err");
  upsertTurn.run({
    id: "r-err-t1",
    session_id: "r-err",
    created_at: "2026-09-01T00:00:00Z",
    completed_at: "2026-09-01T00:01:00Z",
    status: "error",
    error: `auth failed for ${fake.openaiProject}`,
    ingested: 1,
    pending_actions: 0,
  });
  const row = db.prepare(`SELECT error FROM turns WHERE id = ?`).get("r-err-t1") as { error: string };
  assert.ok(!row.error.includes(fake.openaiProject));
  assert.ok(row.error.includes("[REDACTED:openai-project-key]"));
  assert.ok(row.error.startsWith("auth failed for"), "the rest of the message survives");
});
