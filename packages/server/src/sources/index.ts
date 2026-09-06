import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createAntigravity } from "./antigravity.js";
import { createClaudeCode } from "./claude-code.js";
import { createCodex } from "./codex.js";
import { createCursor } from "./cursor.js";
import { createDsh } from "./dsh.js";
import { createGemini } from "./gemini.js";
import { createOpenCode } from "./opencode.js";
import { ROO_STORAGES, VSCODE_DIRS, createRoo } from "./roo.js";
import { TRUEFORGE_URL, trueforgeSource } from "./trueforge.js";
import type { Source } from "./types.js";

export let active: Source[] = [];

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// AGENTLENS_SOURCES pins the list; otherwise enable whatever exists locally.
// TrueForge is always on (quiet while unreachable) so it can be started later.
export function detectSources(env = process.env): Source[] {
  const home = homedir();
  const paths = {
    claude: env.CLAUDE_PROJECTS_DIR ?? join(home, ".claude", "projects"),
    opencode: env.OPENCODE_DB ?? join(home, ".local", "share", "opencode", "opencode.db"),
    dsh: env.DSH_HOME ?? join(home, ".dsh"),
    codex: env.CODEX_HOME ?? join(home, ".codex"),
    gemini: env.GEMINI_HOME ?? join(home, ".gemini"),
    antigravity: env.ANTIGRAVITY_HOME ?? join(home, ".gemini", "antigravity-cli"),
    cursor: env.CURSOR_HOME ?? join(home, ".cursor"),
  };
  // Roo Code / Cline task stores across VS Code flavors, plus an explicit override.
  const rooDirs: [string, string][] = env.ROO_TASKS_DIR
    ? [["roo-code", env.ROO_TASKS_DIR]]
    : ROO_STORAGES.flatMap(([name, ext]) =>
        VSCODE_DIRS.map((v) => [name, join(home, ".config", v, "User", "globalStorage", ext, "tasks")] as [string, string]),
      );

  const factories: Record<string, () => Source[]> = {
    "claude-code": () => [createClaudeCode(paths.claude)],
    opencode: () => [createOpenCode(new Database(paths.opencode, { readonly: true, fileMustExist: true }))],
    dsh: () => [createDsh(paths.dsh)],
    codex: () => [createCodex(paths.codex)],
    gemini: () => [createGemini(paths.gemini)],
    antigravity: () => [createAntigravity(paths.antigravity)],
    cursor: () => [createCursor(paths.cursor)],
    "roo-code": () => rooDirs.filter(([n, d]) => n === "roo-code" && isDir(d)).map(([n, d]) => createRoo(n, d)),
    cline: () => rooDirs.filter(([n, d]) => n === "cline" && isDir(d)).map(([n, d]) => createRoo(n, d)),
    trueforge: () => [trueforgeSource],
  };
  const present: Record<string, boolean> = {
    "claude-code": isDir(paths.claude),
    opencode: existsSync(paths.opencode),
    dsh: isDir(join(paths.dsh, "sessions")),
    codex: isDir(join(paths.codex, "sessions")),
    gemini: isDir(join(paths.gemini, "tmp")),
    antigravity: isDir(join(paths.antigravity, "brain")),
    cursor: isDir(join(paths.cursor, "projects")),
    "roo-code": rooDirs.some(([n, d]) => n === "roo-code" && isDir(d)),
    cline: rooDirs.some(([n, d]) => n === "cline" && isDir(d)),
    trueforge: true,
  };

  const wanted = env.AGENTLENS_SOURCES
    ? env.AGENTLENS_SOURCES.split(",").map((s) => s.trim())
    : Object.keys(factories).filter((n) => present[n]);

  const sources: Source[] = [];
  for (const name of wanted) {
    const make = factories[name];
    if (!make) {
      console.error(`unknown source "${name}" in AGENTLENS_SOURCES, skipping`);
      continue;
    }
    try {
      for (const s of make()) {
        sources.push(s);
        console.log(`source ${s.name}: ${name === "trueforge" ? TRUEFORGE_URL : s.status().detail}`);
      }
    } catch (err) {
      // e.g. an OpenCode schema this adapter does not know; keep the rest running
      console.error(`source ${name} disabled: ${(err as Error).message}`);
    }
  }
  active = sources;
  return sources;
}
