import { mrWatchOwner, saveMrWatch } from "./db.js";
import { GitlabWatcher, glabGetMr } from "./gitlab-watch.js";

const positive = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const gitlabWatcher = new GitlabWatcher({
  getMr: glabGetMr,
  save: saveMrWatch,
  getOwner: mrWatchOwner,
  intervalMs: positive(process.env.GITLAB_WATCH_INTERVAL_MS, 20_000),
  maxWatchMs: positive(process.env.GITLAB_WATCH_TIMEOUT_MS, 30 * 60 * 1000),
});
