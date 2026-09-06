import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createClaudeCode } from "./claude-code.js";
import { createOpenCode } from "./opencode.js";
import { TRUEFORGE_URL, trueforgeSource } from "./trueforge.js";
import type { Source, SourceName } from "./types.js";

export let active: Source[] = [];

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

// AGENTLENS_SOURCES pins the list; otherwise enable whatever exists locally.
// TrueForge is always on (quiet while unreachable) so it can be started later.
export function detectSources(env = process.env): Source[] {
  const projectsDir = env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  const opencodeDb = env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db");

  const wanted: SourceName[] = env.AGENTLENS_SOURCES
    ? (env.AGENTLENS_SOURCES.split(",").map((s) => s.trim()) as SourceName[])
    : [
        ...(isDir(projectsDir) ? (["claude-code"] as const) : []),
        ...(existsSync(opencodeDb) ? (["opencode"] as const) : []),
        "trueforge",
      ];

  const sources: Source[] = [];
  for (const name of wanted) {
    try {
      if (name === "claude-code") {
        sources.push(createClaudeCode(projectsDir));
        console.log(`source claude-code: ${projectsDir}`);
      } else if (name === "opencode") {
        sources.push(createOpenCode(new Database(opencodeDb, { readonly: true, fileMustExist: true })));
        console.log(`source opencode: ${opencodeDb}`);
      } else if (name === "trueforge") {
        sources.push(trueforgeSource);
        console.log(`source trueforge: ${TRUEFORGE_URL}`);
      } else {
        console.error(`unknown source "${name}" in AGENTLENS_SOURCES, skipping`);
      }
    } catch (err) {
      // e.g. an OpenCode schema this adapter does not know; keep the rest running
      console.error(`source ${name} disabled: ${(err as Error).message}`);
    }
  }
  active = sources;
  return sources;
}
