import assert from "node:assert/strict";
import { test } from "node:test";
import { GitlabWatcher, MrWatchConflictError, stateForMr, type GitlabMr, type MrWatchRecord } from "../src/gitlab-watch.ts";

const spec = { session_id: "s1", project: "group/project", mr_iid: 42 };
const mr = (status: string, sha = "abc", headSha = sha): GitlabMr => ({
  sha,
  state: "opened",
  merge_status: "can_be_merged",
  web_url: "https://gitlab.example/group/project/-/merge_requests/42",
  head_pipeline: { sha: headSha, status },
});

test("stateForMr distinguishes ready, merged, conflicts and failed CI", () => {
  assert.equal(stateForMr(mr("success"), "abc").state, "ready");
  assert.equal(stateForMr({ ...mr("failed"), state: "merged" }, "abc").state, "done");
  assert.equal(stateForMr({ ...mr("success"), merge_status: "conflict" }, "abc").state, "blocked");
  assert.equal(stateForMr(mr("failed"), "abc").state, "blocked");
  assert.equal(stateForMr(mr("running"), "abc").state, "waiting");
});

test("stateForMr never accepts a terminal pipeline from an older head", () => {
  const state = stateForMr(mr("success", "abc", "old"), "abc");
  assert.equal(state.state, "waiting");
  assert.equal(state.pipeline_status, null);
});

test("register deduplicates background loops per project, MR and head", async () => {
  let calls = 0;
  let sleepCalls = 0;
  const sleeps: (() => void)[] = [];
  const sleepWaiters: (() => void)[] = [];
  const waitForSleepCalls = async (expected: number) => {
    while (sleepCalls < expected)
      await new Promise<void>((resolve) => sleepWaiters.push(resolve));
  };
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => mr(calls++ < 2 ? "running" : "success"),
    save: (watch) => saved.push(watch),
    sleep: async () => {
      sleepCalls++;
      for (const notify of sleepWaiters.splice(0)) notify();
      return new Promise<void>((resolve) => sleeps.push(resolve));
    },
  });

  await watcher.register(spec);
  await watcher.register(spec);
  assert.equal(watcher.activeCount, 1);
  await waitForSleepCalls(1);
  sleeps.shift()!();
  await waitForSleepCalls(2);
  sleeps.shift()!();
  await watcher.idle();
  assert.equal(watcher.activeCount, 0);
  assert.equal(saved.at(-1)!.state, "ready");
});

test("a changed MR head makes the old watch stale and stops it", async () => {
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => calls++ === 0 ? mr("running") : mr("success", "new-head"),
    save: (watch) => saved.push(watch),
    sleep: async () => {},
  });
  await watcher.register(spec);
  await watcher.idle();
  assert.equal(saved.at(-1)!.state, "stale");
  assert.match(saved.at(-1)!.detail!, /head changed/);
  assert.equal(watcher.activeCount, 0);
});

test("a bounded watch expires as stale instead of polling forever", async () => {
  let now = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => mr("running"),
    save: (watch) => saved.push(watch),
    intervalMs: 1000,
    maxWatchMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  await watcher.register(spec);
  await watcher.idle();
  assert.equal(saved.at(-1)!.state, "stale");
  assert.match(saved.at(-1)!.detail!, /timed out/);
});

test("two consecutive GitLab read failures stop with visible stale state", async () => {
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => {
      if (calls++ === 0) return mr("running");
      throw new Error("temporary GitLab failure");
    },
    save: (watch) => saved.push(watch),
    sleep: async () => {},
  });
  await watcher.register(spec);
  await watcher.idle();
  assert.equal(saved.at(-1)!.state, "stale");
  assert.match(saved.at(-1)!.detail!, /2\/2/);
  assert.equal(calls, 3);
});

test("one GitLab failure stays waiting and recovers without becoming stale", async () => {
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => {
      calls++;
      if (calls === 2) throw new Error("one transient failure");
      return mr(calls === 1 ? "running" : "success");
    },
    save: (watch) => saved.push(watch),
    sleep: async () => {},
  });
  await watcher.register(spec);
  await watcher.idle();
  assert.equal(saved.at(-1)!.state, "ready");
  assert.ok(saved.some((watch) => watch.state === "waiting" && watch.detail?.includes("1/2")));
  assert.equal(saved.some((watch) => watch.state === "stale"), false);
});

test("resume preserves the registration deadline and expires an old watch immediately", async () => {
  let now = 30 * 60 * 1000 + 1;
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => { calls++; return mr("running"); },
    save: (watch) => saved.push(watch),
    now: () => now,
    sleep: async () => {},
  });
  const registered = {
    ...spec,
    head_sha: "abc",
    state: "waiting" as const,
    pipeline_status: "running",
    web_url: null,
    detail: null,
    created_at: new Date(0).toISOString(),
    last_checked_at: new Date(0).toISOString(),
  };
  watcher.resume([registered]);
  await watcher.idle();
  assert.equal(calls, 0, "an already-expired watch does not poll again");
  assert.equal(saved.at(-1)!.state, "stale");
  assert.match(saved.at(-1)!.detail!, /timed out/);
});

test("resume near the deadline allows only the remaining polling time", async () => {
  let now = 1000;
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => { calls++; return mr("running"); },
    save: (watch) => saved.push(watch),
    maxWatchMs: 2000,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  watcher.resume([{
    ...spec,
    head_sha: "abc",
    state: "waiting",
    pipeline_status: "running",
    web_url: null,
    detail: null,
    created_at: new Date(0).toISOString(),
    last_checked_at: new Date(0).toISOString(),
  }]);
  await watcher.idle();
  assert.equal(calls, 0, "no new read starts after the persisted deadline");
  assert.equal(saved.at(-1)!.state, "stale");
});

test("a different session cannot take over an existing watch", async () => {
  let owner: string | undefined;
  let calls = 0;
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => mr(calls++ === 0 ? "running" : "success"),
    getOwner: () => owner,
    save: (watch) => { owner = watch.session_id; saved.push(watch); },
    sleep: async () => {},
  });
  await watcher.register(spec);
  await assert.rejects(watcher.register({ ...spec, session_id: "another-session" }), MrWatchConflictError);
  await watcher.idle();
  assert.equal(owner, spec.session_id);
  assert.ok(saved.every((watch) => watch.session_id === spec.session_id));
});

test("a terminal re-check supersedes an in-flight poll", async () => {
  let calls = 0;
  let releaseSleep!: () => void;
  let markSleepStarted!: () => void;
  let markInflightStarted!: () => void;
  let finishInflight!: (mr: GitlabMr) => void;
  const sleepStarted = new Promise<void>((resolve) => { markSleepStarted = resolve; });
  const inflightStarted = new Promise<void>((resolve) => { markInflightStarted = resolve; });
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => {
      calls++;
      if (calls === 1) return mr("running");
      if (calls === 2) {
        markInflightStarted();
        return new Promise<GitlabMr>((resolve) => { finishInflight = resolve; });
      }
      return mr("success");
    },
    save: (watch) => saved.push(watch),
    sleep: async () => {
      markSleepStarted();
      return new Promise<void>((resolve) => { releaseSleep = resolve; });
    },
  });
  await watcher.register(spec);
  await sleepStarted;
  releaseSleep();
  await inflightStarted;
  await watcher.register(spec);
  assert.equal(saved.at(-1)!.state, "ready");
  finishInflight(mr("running"));
  await watcher.idle();
  assert.equal(saved.length, 2, "the superseded poll never writes after the terminal re-check");
  assert.equal(saved.at(-1)!.state, "ready");
});

test("a waiting re-check queued behind a terminal re-check starts after the old loop exits", async () => {
  let calls = 0;
  let releaseSleep!: () => void;
  let markSleepStarted!: () => void;
  let markInflightStarted!: () => void;
  let finishInflight!: (mr: GitlabMr) => void;
  let sleepCount = 0;
  const sleepStarted = new Promise<void>((resolve) => { markSleepStarted = resolve; });
  const inflightStarted = new Promise<void>((resolve) => { markInflightStarted = resolve; });
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => {
      calls++;
      if (calls === 1 || calls === 4) return mr("running");
      if (calls === 2) {
        markInflightStarted();
        return new Promise<GitlabMr>((resolve) => { finishInflight = resolve; });
      }
      return mr("success");
    },
    save: (watch) => saved.push(watch),
    sleep: async () => {
      if (sleepCount++ > 0) return;
      markSleepStarted();
      return new Promise<void>((resolve) => { releaseSleep = resolve; });
    },
  });
  await watcher.register(spec);
  await sleepStarted;
  releaseSleep();
  await inflightStarted;
  await watcher.register(spec);
  await watcher.register(spec);
  finishInflight(mr("running"));
  await watcher.idle();
  assert.equal(saved.at(-1)!.state, "ready");
  assert.equal(calls, 5, "the queued waiting registration starts one replacement loop");
  assert.equal(watcher.activeCount, 0);
});

test("a waiting re-check during a natural terminal save survives final cleanup", async () => {
  let calls = 0;
  let recheck: Promise<MrWatchRecord> | undefined;
  let markRecheckStarted!: () => void;
  const recheckStarted = new Promise<void>((resolve) => { markRecheckStarted = resolve; });
  const saved: MrWatchRecord[] = [];
  const watcher = new GitlabWatcher({
    getMr: async () => {
      calls++;
      if (calls === 1 || calls === 3) return mr("running");
      return mr("success");
    },
    save: (watch) => {
      saved.push(watch);
      if (watch.state === "ready" && !recheck) {
        recheck = watcher.register(spec);
        markRecheckStarted();
      }
    },
    sleep: async () => {},
  });
  await watcher.register(spec);
  await recheckStarted;
  await recheck!;
  await watcher.idle();
  assert.equal(calls, 4, "the natural exit is followed by one replacement loop");
  assert.equal(saved.at(-1)!.state, "ready");
  assert.equal(watcher.activeCount, 0);
});
