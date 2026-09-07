import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

// Which branch a session was working on. Read from .git/HEAD rather than by
// running git: no subprocess per session, and it works when git is absent.
//
// The branch is recorded once, when the session row is first created. A session
// that outlives a checkout keeps the branch it started on, which is the honest
// thing to store given the harness logs do not say when a checkout happened.

const cache = new Map<string, string | null>();

function headFile(dir: string): string | undefined {
  const dotGit = join(dir, ".git");
  if (!existsSync(dotGit)) return undefined;
  // A worktree or submodule has .git as a file pointing at the real gitdir.
  if (statSync(dotGit).isFile()) {
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    const target = m?.[1]?.trim();
    return target && existsSync(join(target, "HEAD")) ? join(target, "HEAD") : undefined;
  }
  const head = join(dotGit, "HEAD");
  return existsSync(head) ? head : undefined;
}

export function branchOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const hit = cache.get(cwd);
  if (hit !== undefined) return hit;

  let branch: string | null = null;
  try {
    // The working directory is often a subdirectory of the repository.
    let dir = cwd;
    for (let i = 0; i < 40; i++) {
      const head = headFile(dir);
      if (head) {
        const text = readFileSync(head, "utf8").trim();
        const ref = text.match(/^ref:\s*refs\/heads\/(.+)$/);
        // Detached HEAD holds a bare sha; the short form is more use than null.
        branch = ref ? ref[1] : /^[0-9a-f]{40}$/.test(text) ? text.slice(0, 7) : null;
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    // Unreadable .git, a permission error, a race with a checkout: no branch.
  }
  cache.set(cwd, branch);
  return branch;
}
