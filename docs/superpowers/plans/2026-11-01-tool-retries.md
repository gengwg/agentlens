# Tool Retry Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flag tool calls that failed and were then retried, per session and rolled up per tool across the fleet, so it shows where MCP servers and tools cost agents retries.

**Architecture:** One SQL loader in `db.ts` returns each session's tool calls and responses in order, with failure computed by the existing `TOOL_ERROR` predicate so a failure means the same thing everywhere. A pure module `retries.ts` pairs calls with responses, finds retries and rolls them up. The trace API, a new fleet endpoint, an MCP tool for the investigator and the web UI all read from that module.

**Tech Stack:** TypeScript, Node 22+, better-sqlite3, Hono, `@modelcontextprotocol/sdk`, React + Vite. Server tests use `node:test` via `npm test`.

**Spec:** No separate spec. The motivation is the Honeycomb talk at MCPCon 2026 ("agents don't file bugs, they retry"), summarized in `~/projects/mcpcon26/medium/agntcon-mcpcon-2026-notes.md`. This plan carries the design decisions below.

## Background the implementer needs

- A tool call lives on a `model.message` event: `raw.toolCalls[] = { id, function: { name, arguments } }`. `arguments` is usually a JSON string, sometimes an object. Some TrueForge calls carry `toolInfo.name` instead of `function.name` (see `src/mcp.ts:60`).
- Its result is a later `tool.response` event linked by `raw.toolCallId`. On the local database, every `tool.response` from claude-code (34,479), dsh, opencode and trueforge has a `toolCallId`. Antigravity's adapter writes none (`src/sources/antigravity.ts:46`), so its calls can't be paired and are skipped.
- A failed call is one whose `tool.response` matches `TOOL_ERROR` in `src/db.ts:205`. That predicate already excludes calls the user declined (`DENIED`, `src/db.ts:201`). Reuse it; do not re-implement the denial strings in TypeScript.
- Events order by `created_at IS NULL, created_at, id`, as in `sessionTrace` (`src/db.ts:425`).

## Definitions (decided, not open)

- **Retry:** a failed call F to tool T in thread H is retried by call R when R is the first call to T, in thread H, among the next `RETRY_WINDOW = 3` calls in that thread that come from a later `model.message` than F. Calls in the same message as F were issued before the failure was seen, so they are never retries of F.
- **sameArgs:** F's and R's arguments are equal after canonicalizing. If a value is a string that parses as JSON, use `JSON.stringify(JSON.parse(s))`. If it is an object, use `JSON.stringify`. Otherwise compare the trimmed string.
- **recovered:** `true` if R's response did not fail, `false` if it failed, `null` if R has no response yet.
- **server:** for a name `mcp__<server>__<tool>` (Claude Code's MCP naming), `<server>`. Otherwise `null`. Other harnesses' MCP naming is ambiguous and stays `null`.

## Global Constraints

- No new dependencies. No emojis. Comments only for the why.
- Feature branch and PR to main; never push to main. Imperative-mood commits.
- `RETRY_WINDOW = 3`, exported from `src/retries.ts`.
- Failure semantics come only from `TOOL_ERROR` in `src/db.ts`.
- Fleet rollup default window: 7 days, by `sessions.updated_at`.
- Out of scope: Prometheus metrics, `PROBLEM_SCORE`, Grafana, live SSE events in a running turn (retries come from stored events only), pairing Antigravity calls.
- Update `README.md` (feature list) and append to `BUILDLOG.md` when it lands (repo convention, `CLAUDE.md`).

## Review Focus

1. Two calls to the same tool in one `model.message`, the first fails: the second is not a retry. Tested in Task 1.
2. A declined call (`DENIED`) followed by the same tool: not a failure, so no retry. Tested in Task 2 (needs the SQL predicate).
3. The same tool in a subagent thread after a main-thread failure: not a retry. Tested in Task 1.
4. A failed `tool.response` with no `toolCallId`, or a call whose name is missing: skipped without throwing, and not counted in failures. Tested in Task 2.
5. A retry call still waiting on its response (running turn): `recovered: null`, and the UI shows it as pending, not as a failure. Tested in Task 1; rendered in Task 4.

---

### Task 1: Pure retry detection

**Files:**
- Create: `packages/server/src/retries.ts`
- Test: `packages/server/test/retries.test.ts`

**Interfaces:**
- Produces:
  - `export const RETRY_WINDOW = 3`
  - `export type ToolRow = { type: "model.message" | "tool.response"; thread_id: string | null; created_at: string | null; calls: string | null /* JSON of raw.toolCalls */; call_id: string | null; failed: 0 | 1 }`
  - `export type ToolCall = { id: string; tool: string; args: string /* canonical */; thread: string; at: string | null; message: number /* index of the model.message row */; failed: boolean | null /* null: no response */ }`
  - `export type Retry = { sessionId: string; tool: string; server: string | null; failedCallId: string; retryCallId: string; sameArgs: boolean; recovered: boolean | null; gapSeconds: number | null }`
  - `export type ToolRetryStat = { tool: string; server: string | null; failures: number; retried: number; sameArgs: number; recovered: number; sessions: number }`
  - `export function toolCallsOf(rows: ToolRow[]): ToolCall[]` (thread `null` becomes `"main"`; calls with no name or no id are dropped)
  - `export function findRetries(sessionId: string, calls: ToolCall[]): Retry[]`
  - `export function serverOf(tool: string): string | null`
  - `export function rollupRetries(sessions: { sessionId: string; calls: ToolCall[] }[]): ToolRetryStat[]` (sorted by `retried` desc, then `failures` desc; `sessions` counts distinct sessions with at least one failure of that tool)

Tests build `ToolRow[]` directly, with a small local helper `msg(thread, ...calls)` and `res(callId, failed)`. No database. Each call is in its own message unless a test says otherwise.

- [ ] **Step 1: Write the failing tests** in `test/retries.test.ts`:
  - `"a failed call retried with the same args that then works"`: rows `msg(c1 Bash {"cmd":"ls"})`, `res(c1, failed)`, `msg(c2 Bash "{ \"cmd\": \"ls\" }")`, `res(c2, ok)` give exactly one `Retry` with `failedCallId: "c1"`, `retryCallId: "c2"`, `sameArgs: true`, `recovered: true`.
  - `"other tools in between still count, but only inside the window"`: fail on Read c1, then Grep, Glob, Read c4 makes c4 the retry (3rd call after). Fail on Read c1, then Grep, Glob, Bash, Read c5 gives no retry.
  - `"a call in the same message as the failure is not its retry"`: one `msg` holding Read c1 and Read c2, `res(c1, failed)`, `res(c2, ok)` gives `[]`.
  - `"another thread is not a retry"`: Bash fails on thread `main`, next Bash is on thread `t1:sub`, giving `[]`.
  - `"a chain of failures yields one retry per failure"`: c1 fail, c2 fail, c3 ok, all one tool, separate messages. Two retries: (c1 to c2, `recovered: false`) and (c2 to c3, `recovered: true`).
  - `"a retry with no response yet is pending"`: c1 fail, c2 with no `res` row gives `recovered: null`.
  - `"changed arguments are not sameArgs"`: `{"path":"a"}` then `{"path":"b"}` gives `sameArgs: false`.
  - `"serverOf reads Claude Code MCP names"`: `serverOf("mcp__kubecon__search_sessions") === "kubecon"`, `serverOf("Bash") === null`, `serverOf("mcp__x") === null`.
  - `"rollup counts failures, retries and sessions per tool"`: session A has 2 failed Bash calls (one retried and recovered) and session B has 1 failed Bash retried with the same args, not recovered. Expect `{ tool: "Bash", server: null, failures: 3, retried: 2, sameArgs: 1, recovered: 1, sessions: 2 }`. `sameArgs` counts only retried failures.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/server && node --import tsx --test test/retries.test.ts`
Expected: FAIL, module `../src/retries.ts` not found.

- [ ] **Step 3: Implement `src/retries.ts`** with the signatures above. `toolCallsOf` parses `calls`, numbers `model.message` rows in order for `message`, and sets `failed` from the first `tool.response` row with that `call_id`. `findRetries` scans each failed call forward through the same thread's calls, skipping those with the same `message`. `gapSeconds` is the seconds between the two calls' `at`, or `null` if either is missing.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w packages/server`
Expected: all tests pass, including the 9 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/retries.ts packages/server/test/retries.test.ts
git commit -m "Detect retried tool calls from a session's calls and responses"
```

### Task 2: Load tool rows from the database

**Files:**
- Modify: `packages/server/src/db.ts` (add the loaders after `sessionTrace`, near line 432)
- Modify: `packages/server/src/retries.ts` (add the DB-backed entry points)
- Modify: `packages/server/test/fixtures.ts` (export the new functions; add `thread_id?: string | null` to `EventSpec`)
- Test: `packages/server/test/retries.test.ts`

**Interfaces:**
- Consumes: `ToolRow`, `toolCallsOf`, `findRetries`, `rollupRetries` from Task 1.
- Produces:
  - `export function sessionToolRows(sessionId: string): ToolRow[]` in `db.ts`. One query over `events e JOIN sessions s`, types `model.message` and `tool.response`, ordered like `sessionTrace`. Selects `json_extract(e.raw,'$.toolCalls') AS calls`, `json_extract(e.raw,'$.toolCallId') AS call_id`, and `CASE WHEN ${TOOL_ERROR} THEN 1 ELSE 0 END AS failed`. Selecting fields instead of `raw` avoids parsing large tool output.
  - `export function retryCandidateSessions(since: string): string[]` in `db.ts`: ids of sessions with `updated_at >= since` that match `MATCH.toolErrors`.
  - `export function sessionRetries(sessionId: string): Retry[]` in `retries.ts`
  - `export function fleetRetries(since: string): ToolRetryStat[]` in `retries.ts`

- [ ] **Step 1: Write the failing tests** using `seedSession` with `source: "claude-code"`:
  - `"a declined call is not a failure, so re-asking is not a retry"`: Bash c1 response `{ toolCallId: "c1", content: "Permission for this action was denied by the hook", error: true }`, then Bash c2 ok. `sessionRetries` gives `[]`.
  - `"a failed response with no toolCallId is skipped"`: a failed `tool.response` without `toolCallId` plus one normal retried Bash failure. `fleetRetries("2026-01-01T00:00:00Z")` reports Bash `failures: 1`, and nothing throws.
  - `"fleetRetries only looks at sessions updated since the cutoff"`: two sessions with the same retried failure, `updated_at` `2026-09-01` and `2026-10-20`. `fleetRetries("2026-10-01T00:00:00Z")` gives `sessions: 1`.
  - `"thread_id from the event decides the thread"`: seed the retry call with `thread_id: "t1:sub"`, which gives `[]`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/server && node --import tsx --test test/retries.test.ts`
Expected: FAIL, `sessionRetries` is not exported.

- [ ] **Step 3: Implement the two loaders in `db.ts` and the two entry points in `retries.ts`**, then export them from `test/fixtures.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w packages/server`
Expected: all pass, and the existing `"declined tools count as denials, not errors"` test is unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/retries.ts packages/server/test/fixtures.ts packages/server/test/retries.test.ts
git commit -m "Load tool calls per session and roll retries up across the fleet"
```

### Task 3: Expose retries through the API and MCP

**Files:**
- Modify: `packages/server/src/db.ts:416-432` (`sessionTrace` returns `retries`)
- Modify: `packages/server/src/api.ts` (new route next to `/api/stats`, line 39)
- Modify: `packages/server/src/mcp.ts` (new tool after `get_fleet_metrics`; add `retries` to `get_session_trace`'s compact output)
- Test: `packages/server/test/api.test.ts`, `packages/server/test/mcp.test.ts`

**Interfaces:**
- Consumes: `sessionRetries(sessionId)` and `fleetRetries(since)` from Task 2.
- Produces:
  - `sessionTrace(id)` returns `{ session, turns, events, retries: Retry[] }`.
  - `GET /api/retries?days=N` returns `ToolRetryStat[]`. `days` defaults to 7, is clamped to 1..90, and a non-numeric value falls back to 7. `since = new Date(Date.now() - days*86400e3).toISOString()`.
  - MCP tool `list_tool_retries`, input `{ days?: number }` (zod, int, 1..90, default 7). Description: "Tools that failed and were retried, per tool and MCP server, worst first. sameArgs counts blind retries with identical arguments; recovered counts retries that then worked." It returns the rollup as JSON text, like `get_fleet_metrics`.

- [ ] **Step 1: Write the failing tests**
  - api: `"GET /api/sessions/:id includes retries"`: seed one retried failure, then `body.retries[0].retryCallId === "c2"`.
  - api: `"GET /api/retries rolls up and defaults to 7 days"`: seed a retried failure with `updated_at` set to now. `/api/retries` contains that tool. `/api/retries?days=abc` returns 200 with the same result.
  - mcp: `"list_tool_retries returns the rollup"`: call it with `{ days: 7 }`, parse the text, and expect an array element with `tool` and `retried` fields.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w packages/server`
Expected: the 3 new tests FAIL (404 or unknown tool), and the rest pass.

- [ ] **Step 3: Implement** the `sessionTrace` field, the route and the MCP tool. Add `retries` to `get_session_trace`'s `compact` object so the investigator sees it.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w packages/server`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/db.ts packages/server/src/api.ts packages/server/src/mcp.ts packages/server/test/api.test.ts packages/server/test/mcp.test.ts
git commit -m "Serve tool retries on the trace, a fleet endpoint and an MCP tool"
```

### Task 4: Show retries in the dashboard

**Files:**
- Modify: `packages/web/src/api.ts` (add `retries: Retry[]` to `Trace`, add `ToolRetryStat`, add `api.retries(days)`)
- Modify: `packages/web/src/App.tsx` (the `tool.response` case at line 694, and a fleet table below the sessions table)
- Modify: `packages/server/src/demo.ts` (one scenario with a retried failure, so the demo shows it)
- Modify: `README.md`, `BUILDLOG.md`

**Interfaces:**
- Consumes: the `/api/sessions/:id` `retries` field and `GET /api/retries` from Task 3. Mirror the `Retry` and `ToolRetryStat` types in `packages/web/src/api.ts` (the web package does not import from the server).

- [ ] **Step 1: Trace view.** Build `Map<failedCallId, Retry>` from `trace.retries`. On a `tool.response` whose `raw.toolCallId` is in the map, append one line under the content: `retried with the same args`, or `retried with changed args`, followed by ` -> worked`, ` -> failed again` or ` -> pending` from `recovered`.

- [ ] **Step 2: Fleet table.** Add a "Retried tools (7 days)" table under the sessions table with columns Tool, Server, Failures, Retried, Same args, Recovered, Sessions. Load it once, alongside the existing `Promise.all` at `App.tsx:93`. Hide the table when the list is empty.

- [ ] **Step 3: Demo data.** In one existing demo turn, add a failed call followed by a retry of the same tool with the same args that succeeds.

- [ ] **Step 4: Verify**

Run: `npm run build` (repo root), then `AGENTLENS_DB=/tmp/agentlens-demo.db npm run demo -w packages/server` and start the server and dashboard against that DB (README "No harness logs to look at yet?").
Expected: the build passes. In the browser, the demo session's failed call shows "retried with the same args -> worked", and the fleet table lists that tool with Retried 1. Take one screenshot for the README only if the table looks right.

- [ ] **Step 5: Docs and commit.** Add one line to the README feature list and a BUILDLOG entry covering what was built, the definition of a retry, and anything that surprised you on the real data in Task 5.

```bash
git add packages/web/src packages/server/src/demo.ts README.md BUILDLOG.md
git commit -m "Show retried tool calls in the trace and a fleet table"
```

### Task 5: Check it against real data, then open the PR

**Files:** none changed unless a check fails.

- [ ] **Step 1: Copy the real database.** The server runs migrations and an `UPDATE` when it opens a database (`db.ts:66-85`), so never point it at the original. Run `cp packages/server/agentlens.db <scratch>/agentlens-copy.db`. The local copy is about 197 MB and was last written Oct 19. If Weigang has a fresher one on another host, ask before fetching it.

- [ ] **Step 2: Measure.** Against the copy, time `fleetRetries` for 7 days and for 3650 days (everything): `AGENTLENS_DB=<copy> node --import tsx -e '...'`, printing the elapsed time and the top 10 rows. Budget: under 1 s for 7 days. If the full history is over 5 s, report it rather than optimizing.

- [ ] **Step 3: Spot-check correctness.** Pick 5 random retries and 5 failed calls that were not retried. Read each trace through `GET /api/sessions/:id` and confirm by eye that each verdict matches the definition. Any disagreement is a bug: fix the code and add the case as a Task 1 or 2 test.

- [ ] **Step 4: Sensitivity.** Report retry counts for the top 5 tools with `RETRY_WINDOW` at 1 and at 3, in the PR description, so the window choice is visible. Keep 3 unless the spot-check showed it misattributes retries.

- [ ] **Step 5: PR.** Push the branch and open a PR to main whose body has the definition, test counts, and the Step 2 to 4 numbers. Do not merge without Weigang.
