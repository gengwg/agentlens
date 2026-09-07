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

## 2026-09-06 - Claude Code and OpenCode sources

What: the collector is now a loop over source adapters (`src/sources/`). Claude
Code is tailed from its JSONL transcripts with per-file byte cursors, OpenCode
is polled read-only from its SQLite database, TrueForge moved into an adapter
and became optional. Sessions carry a `source`; the UI shows it and only offers
Investigate/Approve/live tail when TrueForge is connected.

Why: the team uses several harnesses. Translating each into the event
vocabulary the store and trace view already understood (turn.created,
model.message, tool.response, thread.created, turn.done) was a fraction of the
work of making the store generic, and the investigator's MCP tools got the new
sessions for free.

Surprises:
- Claude Code splits one API message across several JSONL records (thinking,
  text, tool_use), each repeating the same usage. Counting per record inflated
  tokens 2-3x; usage now rides on the first rendered record of a message.
- Forked and resumed sessions copy the parent's history with identical record
  uuids. Event ids had to be namespaced by session or INSERT OR IGNORE silently
  dropped the whole fork.
- `promptId` is not unique per prompt; the prompt record's uuid is the turn id.
- Remote-control sessions flag real prompts `isMeta`, the same flag used for
  injected skill content. It now only suppresses a prompt while a turn is open,
  and model output with no open turn opens one rather than being dropped.
- OpenCode mutates message and part rows in place as a step runs, so its events
  are upserted and the cursor overlaps by 5s. A new prompt aborts the previous
  turn without a marker; the next prompt closes it.
- Killed processes leave turns running forever; a sweep closes turns idle for
  10 minutes on local sources.

## 2026-09-06 - dsh, an ingest API, and experimental adapters

What: a dsh adapter built against real logs, `POST /api/ingest` for any harness
that can speak JSON, and experimental adapters for Codex CLI, Gemini CLI, Roo
Code, and Cline written from their public formats with synthetic tests.

Why: a scan of the team's repos showed Claude Code, OpenCode, Roo Code, and
Cursor configs, with Gemini, Codex, Copilot, and Kimi mentioned. Only dsh had
logs on the build machine, so the ingest API is the escape hatch for the rest
and the first step toward a shared server.

Surprises:
- dsh appends one zstd frame per record. Node's zstd decoder (one-shot and
  streaming) returns only the first frame, so the adapter splits on frame
  magics and merges chunks that fail to decode.
- Gemini CLI rewrites the whole chat JSON; Roo Code keeps token usage in a
  separate ui_messages.json and, on the XML tool protocol, tool calls are
  markup inside the assistant text.
- Learned after shipping: Google stopped serving Gemini CLI to consumer plans
  on 2026-06-18 (enterprise licenses keep it) in favor of Antigravity CLI. The
  adapter stays for enterprise users and existing history; Antigravity needs a
  sample session before an adapter is worth writing.

## 2026-09-06 - Cursor Agent and Antigravity CLI

What: adapters for the Cursor Agent CLI (`~/.cursor/projects/*/agent-transcripts`)
and Antigravity CLI (`~/.gemini/antigravity-cli/brain/*/.system_generated/logs`),
both worked out from real sessions on a second machine, generated with one
prompt each in print mode.

Surprises:
- Cursor's transcript is sparse: user and assistant lines with tool_use blocks
  and a turn_ended status, but no timestamps, tool results, or usage. Only
  meta.json has start and end times, so event times are interpolated.
- Antigravity keeps the real conversation in a SQLite store of protobuf blobs,
  but also writes a readable JSONL transcript of steps (USER_INPUT,
  PLANNER_RESPONSE with tool_calls, GENERIC tool output). No usage either.
- Both CLIs refuse tools in headless mode without an explicit trust flag.

## 2026-09-06 - Splitting the error signal

What: the fleet header now shows "failed turns" and "tool errors" as separate
pills, each filtering the table; the red status dot means a failed turn only,
and a row shows its failed-tool count next to the tool total. Declined tools no
longer count as errors anywhere, and the investigator's list_problem_sessions
wants three or more tool errors before flagging a session on that alone.

Why: with any failed tool call counting, 98 of 187 local sessions were red, so
the number carried no information. Measuring the corpus showed 96 of those had
no failed turn at all, and the two most common "errors" were permission denials
and user rejections. Splitting the two signals leaves 4 sessions with failed
turns and 84 with real tool errors.

## 2026-09-06 - Published to npm

What: `packages/server` is now the publishable `@gengwg/agentlens`, compiled to
JavaScript with `tsc` and shipping the built dashboard next to it, exposed as an
`agentlens` binary. `npx @gengwg/agentlens` starts the whole thing.

Why: clone, install, start was three steps and a checkout nobody wanted. The
tool is for colleagues on other machines, so it had to be installable.

Notes: the compiled server looks for the dashboard next to itself first and
falls back to the monorepo path, so the same entry point serves both. The
tarball is 96 KB; `better-sqlite3` fetches its own native binary at install.

## 2026-09-06 - Gemini CLI writes JSONL, not JSON

Running Gemini CLI on a second machine to validate the adapter turned up two
things. It refuses individual accounts now (IneligibleTierError, migrate to
Antigravity), so the reply and token paths cannot be exercised at all. But the
failed run still wrote its chat file, which revealed the adapter was reading
the wrong format: current versions write session-*.jsonl, a header line plus
$set patch lines carrying the whole message array, not the single JSON document
the adapter expected. It now folds either shape into one document.

A test built from the real header also caught an ordering bug: turn.done shared
the final reply's timestamp and sorted ahead of it, so a trace ended before its
last message. The turn now ends at the session's last write.

## 2026-09-06 - A shared server that does not move transcripts

What: `agentlens ship --to <url>` posts session metadata from one machine to
another AgentLens, and `AGENTLENS_HOST` lets the receiver listen on a private
address. Content is dropped by the sender, not the receiver: prompts, replies,
tool output, tool arguments, error messages and titles never leave the machine.
Tool names, token counts, timings, statuses and error flags do.

Why: the fleet view answers most team questions (who is burning tokens, which
projects fail, how long turns take) without needing anyone's transcripts, and
sending company code to a VM is a decision nobody should make by accident.

Tested against a DigitalOcean box over a tailnet: 189 sessions, 2260 turns and
39466 events shipped, and a scan of the receiving database found zero content
characters. The only non-empty text was the literal "subagent" placeholder the
redactor writes for thread titles. Remote traces show the full shape, 266 rows
with tags, token counts and a timeline, and empty bodies.

The receiver still has no authentication, so it is private-network only.

## 2026-09-06 - Fitting the shared fleet table

Shipped sessions carry machine-qualified agent names and no titles, which made
the table 65px wider than its card and clipped the Updated column. The title
fallback now drops the machine prefix from the id (the Agent column already
names the machine), the agent cell truncates with a tooltip, and cell padding
lost 2px a side. Measured on the shared view: 1107px to 1042px, exactly the
card width.

## 2026-09-06 - The package shipped three copies of the dashboard

Publishing 0.6.0 revealed that the build script copied the freshly built web
assets into dist/web without clearing it first. Vite hashes filenames, so every
past bundle survived: six asset files where the page references two, 230 kB
instead of 101 kB. The copy now clears its target.

## 2026-09-06 - The shipper was resending whole histories

A review pass on the new shipper found it resending every event of any session
that changed, so an active session pushed its entire history every 60 seconds:
2074 events and 946 KB per pass on a real database. Events are append-only, so
only the ones written since the last watermark now travel, which is 32 events
and 30 KB for the same state. A first pass, which can be 17 MB, is chunked
rather than sent as one request, and a non-numeric --interval is rejected
instead of becoming setInterval(NaN).

Checked end to end into an empty receiver: 189 sessions, 2281 turns and 40048
events landed, no event without its turn, and a second pass shipped nothing.
The 11 turns the sender holds back are orphans with no session row, which the
dashboard never shows either.

