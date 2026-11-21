import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const entry = resolve(root, "packages/server/src/index.ts");
const runCli = (args: string[] = []) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTLENS_DB: ":memory:",
    AGENTLENS_HOST: "10.0.0.8",
    AGENTLENS_SOURCES: "none",
    AGENTLENS_PRICES: "off",
  };
  delete env.AGENTLENS_TOKEN;
  return spawnSync(process.execPath, ["--import", "tsx", entry, ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
};

test("server refuses a non-loopback bind without a token before starting listeners", () => {
  const result = runCli();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AGENTLENS_TOKEN is required/);
  assert.doesNotMatch(result.stdout, /agentlens mcp on/);
});

test("ship remains a client when the local bind has no token", () => {
  const result = runCli(["ship"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /usage: agentlens ship/);
});
