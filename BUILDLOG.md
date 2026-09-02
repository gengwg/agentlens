# Build log

Raw material for the hackathon blog post. One entry per milestone.

## 2026-08-29 — Kickoff

Idea: agent observability for companies running TrueForge agents, inspired by
the deepseek-harness trace UI. A passive dashboard alone would not score on the
"best use of harness" criteria, so the plan pairs it with an investigator agent
built on TrueForge that diagnoses bad sessions via MCP tools, subagents,
sandbox, and approvals.

Scaffolded repo, wrote CLAUDE.md with the TrueForge SDK cheat sheet.

## 2026-08-29 — End-to-end working

Collector polls TrueForge (sessions -> turns -> events) into SQLite; dashboard
shows fleet stats, a session table, and a per-session trace view (timeline lanes
for input/model/tools plus a transcript with subagent threads indented). The
investigator agent runs the full loop: list_problem_sessions -> two parallel
subagents each calling get_session_trace -> publish_incident_report paused on
the approval gate -> Allow publishes the report to the dashboard.

Surprises worth blogging:
- Turn event logs only exist for terminal turns; running turns must be streamed
  (`subscribeToTurn`). The collector stores completed turns, the UI live-tails
  running ones over an SSE proxy.
- A turn paused on approval reports `state.status: "done"` with the pending
  call in `requiredActions` - "done" does not mean finished.
- `tool.approval_required` events carry `toolCalls: [{id, sourceEventId}]` with
  no tool name; the UI resolves names from earlier assistant messages.
- MCP tool failures don't fail the turn. The error is nested inside
  `tool.response.content` as a JSON string, so "problem detection" has to look
  at tool payloads, not turn status.
- TrueForge's local sandbox silently degrades if `socat` is missing (bwrap and
  rg alone aren't enough); one apt install re-enables it.

## 2026-08-29 - Review rounds and submission

Shipped: demo video in docs/, Medium post, LinkedIn post, form submitted
(tracks: TrueForge, UI, LinkedIn post).

Then three review rounds hardened the code:
- Round 1 (external review): two real bugs fixed - the SSE live-tail tore down
  and reconnected every 2.5s because the React effect was keyed on the trace
  object the poller replaced each tick, and one failing session could starve
  the rest of a collector cycle. Also one crash found in the wild: malformed
  JSON to the MCP port killed the whole server via unhandled rejection.
- Several findings were declined as wrong: hoisting a singleton McpServer
  (the SDK throws on transport reuse - the "fix" would break concurrency),
  adding wildcard CORS to a localhost tool port (a security regression), and
  removing npm's own allowScripts field.
- Round 2: event ordering by created_at instead of relying on ULID ids, CORS
  pinned to the dashboard origin, MCP 400/500 split, keyboard-navigable rows,
  trace load errors surfaced. Follow-ups bounded the SSE auto-reconnect.

Lesson for the blog: LLM code review found real bugs and confidently proposed
harmful fixes in the same pass. Triage beats blind application.

## 2026-09-01 - Server test suite

Added 15 tests with `node:test` + tsx, no new dependencies: the SQL rollups in
`db.ts`, the Hono routes via `app.request()`, and the collector's turn-row
mapping. Tests point `AGENTLENS_DB` at `:memory:`, so each file gets a fresh
schema and the demo database is never touched.

The rollup queries were the reason to bother: three of their rules are invisible
from the call site and a refactor would break them silently - `pending_approvals`
reads only the newest turn, `tool_errors` matches a `{"error"%` prefix rather
than `%error%`, and `total_seconds` skips turns that never completed. Each now
has a test that fails if the SQL drifts.

One change to source: the duplicated turn-row literal in `ingestTurn` became an
exported `turnRow()`. It made the mapping testable and removed the copy that had
already drifted (one branch defaulted `status`, the other didn't). The suite also
runs the row through the real prepared statement, which is what would actually
break if a column and the object shape disagree.

Skipped the dashboard: testing `App.tsx` needs vitest + jsdom + testing-library,
three dependencies for the one surface we judge by looking at it.
