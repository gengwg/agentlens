import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { maskText } from "./redact-secrets.js";

const execFileAsync = promisify(execFile);

export type MrState = "waiting" | "ready" | "blocked" | "done" | "stale";

export type GitlabMr = {
  sha?: string;
  state?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  web_url?: string;
  head_pipeline?: { sha?: string; status?: string } | null;
};

export type MrWatchSpec = {
  session_id: string;
  project: string;
  mr_iid: number;
  head_sha: string;
};

export type MrWatchRecord = MrWatchSpec & {
  state: MrState;
  pipeline_status: string | null;
  web_url: string | null;
  detail: string | null;
  created_at: string;
  last_checked_at: string;
};

export type MrWatchInput = Omit<MrWatchSpec, "head_sha">;
type GetMr = (project: string, iid: number) => Promise<GitlabMr>;
type SaveWatch = (watch: MrWatchRecord, registration?: boolean) => void;
type GetOwner = (project: string, iid: number, headSha: string) => string | undefined;

export class MrWatchConflictError extends Error {}

const TERMINAL = new Set<MrState>(["ready", "blocked", "done", "stale"]);
const keyOf = (spec: MrWatchSpec) => `${spec.project}!${spec.mr_iid}@${spec.head_sha}`;
const clean = (text: string) => maskText(text).slice(0, 300);

export function stateForMr(mr: GitlabMr, expectedHeadSha: string): Pick<MrWatchRecord, "state" | "pipeline_status" | "detail"> {
  if (mr.state === "merged") return { state: "done", pipeline_status: mr.head_pipeline?.status ?? null, detail: "merged" };
  if (mr.state && mr.state !== "opened") return { state: "stale", pipeline_status: null, detail: `merge request ${mr.state}` };
  if (mr.merge_status === "conflict" || mr.detailed_merge_status === "conflict")
    return { state: "blocked", pipeline_status: mr.head_pipeline?.status ?? null, detail: "merge conflict" };

  const pipeline = mr.head_pipeline;
  if (!pipeline?.status || pipeline.sha !== expectedHeadSha)
    return { state: "waiting", pipeline_status: null, detail: "waiting for a pipeline on the current head" };
  if (pipeline.status === "success") return { state: "ready", pipeline_status: pipeline.status, detail: "current-head CI is green" };
  if (["failed", "canceled", "skipped", "manual"].includes(pipeline.status))
    return { state: "blocked", pipeline_status: pipeline.status, detail: `pipeline ${pipeline.status}` };
  return { state: "waiting", pipeline_status: pipeline.status, detail: `pipeline ${pipeline.status}` };
}

export async function glabGetMr(project: string, iid: number): Promise<GitlabMr> {
  const path = `projects/${encodeURIComponent(project)}/merge_requests/${iid}`;
  try {
    const { stdout } = await execFileAsync("glab", ["api", path], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const mr = JSON.parse(stdout) as GitlabMr;
    if (!mr || typeof mr !== "object") throw new Error("GitLab returned a non-object MR response");
    return mr;
  } catch (err) {
    throw new Error(clean((err as Error).message));
  }
}

export class GitlabWatcher {
  private readonly running = new Map<string, Promise<void>>();
  private readonly runningGenerations = new Map<string, number>();
  private readonly pending = new Map<string, { spec: MrWatchSpec; createdAt: string }>();
  private readonly deadlines = new Map<string, number>();
  private readonly generations = new Map<string, number>();
  private readonly getMr: GetMr;
  private readonly getOwner: GetOwner | undefined;
  private readonly save: SaveWatch;
  private readonly intervalMs: number;
  private readonly maxWatchMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: {
    getMr: GetMr;
    save: SaveWatch;
    getOwner?: GetOwner;
    intervalMs?: number;
    maxWatchMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  }) {
    this.getMr = opts.getMr;
    this.getOwner = opts.getOwner;
    this.save = opts.save;
    this.intervalMs = opts.intervalMs ?? 20_000;
    this.maxWatchMs = opts.maxWatchMs ?? 30 * 60 * 1000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  }

  get activeCount() {
    return this.running.size;
  }

  async register(input: MrWatchInput): Promise<MrWatchRecord> {
    const mr = await this.getMr(input.project, input.mr_iid);
    if (!mr.sha) throw new Error("GitLab response did not include the MR head SHA");
    const spec = { ...input, head_sha: mr.sha };
    const owner = this.getOwner?.(spec.project, spec.mr_iid, spec.head_sha);
    if (owner && owner !== spec.session_id)
      throw new MrWatchConflictError(`MR watch is already registered to session ${owner}`);
    const state = stateForMr(mr, spec.head_sha);
    const key = keyOf(spec);
    this.supersede(spec);
    const record = this.record(spec, state, mr.web_url ?? null);
    this.save(record, true);
    if (record.state === "waiting") {
      this.start(spec, record.created_at);
    } else if (!this.running.has(key)) {
      this.deadlines.delete(key);
      this.generations.delete(key);
      this.runningGenerations.delete(key);
    }
    return record;
  }

  resume(watches: MrWatchRecord[]) {
    for (const watch of watches) {
      this.supersede(watch);
      this.start(watch, watch.created_at);
    }
  }

  async idle() {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private supersede(spec: MrWatchSpec) {
    const key = keyOf(spec);
    this.pending.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private start(spec: MrWatchSpec, createdAt: string) {
    const key = keyOf(spec);
    this.deadlines.set(key, Date.parse(createdAt) + this.maxWatchMs);
    if (this.running.has(key)) {
      if (this.runningGenerations.get(key) !== this.generations.get(key))
        this.pending.set(key, { spec, createdAt });
      return;
    }
    const generation = this.generations.get(key) ?? 1;
    this.generations.set(key, generation);
    this.runningGenerations.set(key, generation);
    const promise = Promise.resolve()
      .then(() => this.loop(spec, generation))
      .catch((err) => console.error(`gitlab watch ${key}: ${clean((err as Error).message)}`))
      .finally(() => {
        if (this.running.get(key) !== promise) return;
        this.running.delete(key);
        this.runningGenerations.delete(key);
        const next = this.pending.get(key);
        if (next) {
          this.pending.delete(key);
          this.start(next.spec, next.createdAt);
          return;
        }
        this.deadlines.delete(key);
        this.generations.delete(key);
      });
    this.running.set(key, promise);
  }

  private record(
    spec: MrWatchSpec,
    state: Pick<MrWatchRecord, "state" | "pipeline_status" | "detail">,
    webUrl: string | null,
  ): MrWatchRecord {
    const now = new Date(this.now()).toISOString();
    return { ...spec, ...state, web_url: webUrl, created_at: now, last_checked_at: now };
  }

  private async loop(spec: MrWatchSpec, generation: number) {
    const key = keyOf(spec);
    const current = () => this.generations.get(key) === generation;
    let failures = 0;
    while (current()) {
      const remaining = (this.deadlines.get(key) ?? this.now()) - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(this.intervalMs, remaining));
      if (!current() || this.now() >= (this.deadlines.get(key) ?? this.now())) break;
      let mr: GitlabMr;
      try {
        mr = await this.getMr(spec.project, spec.mr_iid);
        failures = 0;
      } catch (err) {
        if (!current()) return;
        failures++;
        this.save(this.record(spec, {
          state: failures >= 2 ? "stale" : "waiting",
          pipeline_status: null,
          detail: `GitLab read failed (${failures}/2): ${clean((err as Error).message)}`,
        }, null));
        if (failures >= 2) return;
        continue;
      }
      if (!current()) return;

      if (mr.sha !== spec.head_sha) {
        this.save(this.record(spec, {
          state: "stale",
          pipeline_status: null,
          detail: `MR head changed${mr.sha ? ` to ${mr.sha.slice(0, 12)}` : ""}; register the new head to continue`,
        }, mr.web_url ?? null));
        return;
      }

      const state = stateForMr(mr, spec.head_sha);
      this.save(this.record(spec, state, mr.web_url ?? null));
      if (TERMINAL.has(state.state)) return;
    }
    if (current()) {
      this.save(this.record(spec, {
        state: "stale",
        pipeline_status: null,
        detail: `watch timed out after ${Math.round(this.maxWatchMs / 60_000)} minutes`,
      }, null));
    }
  }
}
