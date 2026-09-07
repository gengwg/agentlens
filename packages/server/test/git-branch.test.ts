import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { db, seedSession, sessionSummaries } from "./fixtures.ts";

const { branchOf } = await import("../src/git-branch.ts");
const { upsertSession } = await import("../src/db.ts");

const repo = (head: string, opts: { asFile?: boolean } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "agentlens-branch-"));
  if (opts.asFile) {
    // A worktree or submodule: .git is a file pointing at the real gitdir.
    const real = join(root, "gitdir");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "HEAD"), head);
    writeFileSync(join(root, ".git"), `gitdir: ${real}\n`);
  } else {
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "HEAD"), head);
  }
  return root;
};

test("branchOf reads a checked-out branch, including from a subdirectory", () => {
  const root = repo("ref: refs/heads/feat/price-table\n");
  assert.equal(branchOf(root), "feat/price-table");

  const deep = join(root, "packages", "server", "src");
  mkdirSync(deep, { recursive: true });
  assert.equal(branchOf(deep), "feat/price-table", "the working directory is usually below the repo root");
});

test("branchOf handles a detached HEAD, a worktree, and no repo at all", () => {
  assert.equal(branchOf(repo("9f1c2b3a4d5e6f70819293a4b5c6d7e8f9012345\n")), "9f1c2b3", "detached HEAD shows the short sha");
  assert.equal(branchOf(repo("ref: refs/heads/main\n", { asFile: true })), "main", "a worktree points at its real gitdir");
  assert.equal(branchOf(mkdtempSync(join(tmpdir(), "agentlens-nogit-"))), null);
  assert.equal(branchOf(null), null);
  assert.equal(branchOf(""), null);
});

test("this repository's own branch resolves", () => {
  // Not a fixture: proves it works against a real .git rather than a mock.
  const here = new URL("..", import.meta.url).pathname;
  const b = branchOf(here);
  assert.ok(typeof b === "string" && b.length > 0, `expected a branch, got ${b}`);
});

test("a session records the branch it started on, and keeps it", () => {
  const root = repo("ref: refs/heads/main\n");
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run("b-sess");
  const row = {
    id: "b-sess",
    agent_name: "repo",
    title: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    created_by: "test",
    source: "claude-code",
  };
  upsertSession.run({ ...row, cwd: root });
  const first = sessionSummaries().find((s: any) => s.id === "b-sess") as any;
  assert.equal(first.branch, "main");

  // A later write with no directory must not erase it.
  upsertSession.run({ ...row, updated_at: "2026-09-01T00:05:00Z" });
  const after = sessionSummaries().find((s: any) => s.id === "b-sess") as any;
  assert.equal(after.branch, "main", "a session keeps the branch it started on");
});

test("the filter box can answer 'what ran on this branch'", () => {
  seedSession("b-find", { agent: "somewhere" });
  db.prepare(`UPDATE sessions SET branch = ? WHERE id = ?`).run("release/2.4", "b-find");
  const hits = sessionSummaries({ q: "release/2.4", limit: 20 }).map((s: any) => s.id);
  assert.deepEqual(hits, ["b-find"]);
});
