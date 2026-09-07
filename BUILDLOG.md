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


## 2026-09-06 - "Append-only" was not true, and the shipper believed it

The previous entry's premise was wrong. Events are append-only for Claude Code,
which reads immutable JSONL, but not for OpenCode: it rewrites a message row in
place while a step streams, filling in token counts and tool calls, and keeps
the original timestamp. The session's updated_at moves to the completion time,
so the corrected event always sorted below the shipping watermark and never
travelled. The shared server kept whichever half-finished version happened to
ship first. The same reasoning failure dropped events whose harness timestamp
predates the watermark, which happens because created_at comes from the log,
not from insertion order.

Events now carry a seq column, bumped on every write, insert or update, and the
shipper keeps a cursor on it; the timestamp cursor still decides which sessions
and turns resend, since those genuinely mutate. An event rewritten in place now
ships again with the same timestamp, verified against a real database: the
rewritten row landed at the receiver with its corrected token count. A full
pass into an empty receiver moved 189 sessions, 2286 turns and 40212 events,
none missing a turn or session, and the only strings that crossed were the two
placeholders the redactor writes. Two smaller ones from the same review: a pass
is now many requests, so a slow one no longer overlaps the next tick on the
same cursor, and --interval has an upper bound, since anything past ~24 days
overflows Node's timer and clamps to 1 ms.

## 2026-09-06 - A second machine, and the fleet view stopped scaling

Started a shipper on a second machine to test the shared server with more than
one host in it. The first pass moved 2912 sessions, 5692 turns and 90931 events
in under nine seconds, and the receiving database confirmed what the design
promised: two hosts, no event missing its turn, and not one content field or
title in any shipped row.

The interesting part was the data. That machine had 2719 OpenCode sessions
since June, almost all one turn with two tool calls, arriving in pairs every
thirty minutes: a cron job, not a person. Useful to see, and it made the real
problem obvious. /api/sessions had no limit, so the dashboard fetched every
session every three seconds and rendered them all in one table: 1.3 MB and
1.35 s per poll at 3110 sessions, with the rollup's twelve correlated
subqueries running for every row before most were thrown away.

Paging and matching now happen in SQL. The table asks for 200 rows and grows
by 200; the search box and the stat pills are query parameters, with the pills
using EXISTS so the rollup never runs for a session that will not be shown.
The header stats moved to their own aggregate endpoint, since summing the page
would have reported the fleet wrong. Same data, 85 KB and 0.12 s per poll.

Also: shipped sessions have no title, so the title column showed a raw id and
read like a corrupted one. Ids now render as ids, with the full value on hover.

## 2026-09-06 - Three chores: a real Roo log, a workspace that is not recorded, and safe screenshots

Roo Code was the last adapter with real data available, so it got checked
against three actual tasks. It was written from the XML tool protocol described
in the public format notes; the real logs use the native one, where the
end-of-turn marker is a tool call named attempt_completion rather than an XML
element. Nothing closed a turn, so every Roo session sat running until the
30-minute sweep, and the workspace regex never matched, so they all grouped
under "roo-code" instead of a repo name. Both fixed: turns end at
attempt_completion whichever protocol carries it, and the workspace comes from
history_item.json, which simply has a field for it. Two smaller things fell out
of that. A task can complete more than once, so an assistant message with no
open turn opens one instead of being dropped, and a completed turn stays
addressable long enough for the tool result that acknowledges it to land. After
the fix every count matches the raw files exactly: 48 model messages, 52 tool
responses, 4437771 input tokens for the largest task, and re-polling changes
nothing.

Antigravity's workspace question closed as "cannot be done". On a machine with
three conversations only one had a row in conversation_summaries.db, and for the
other two the workspace appears nowhere on disk: the only paths in those blobs
are the CLI's own config directories. Documented instead of guessed.

The README screenshots were stale because a fresh capture would have shown real
repo names and prompts. Now `npm run demo` writes an invented fleet, and the
screenshots come from that: eight sessions across six sources, with a failed
turn, tool errors, subagents, a running turn and an approval gate. Making that
approval render properly was a small lesson in the UI's own rules, since the
trace resolves a tool name through the call that requested it and only shows
Allow/Deny for TrueForge sessions. Also, with a fleet of two machines the token
total read 10267.1M, so the formatter learned about billions.

## 2026-09-07 - Handing the charts to Grafana

Grafana shipped Agent Observability, with coding-agent plugins for Claude Code,
Cursor, OpenCode and Codex that default to metadata-only capture and even have
a local mode. That is this project's problem statement with a product team
behind it, so the interesting question stopped being "how do we compete" and
became "what do we do that they cannot". The answer I gave myself was
retroactive history, and it was wrong - see the correction below, added the same
day.

So: AgentLens collects, Grafana renders. `GET /metrics` exposes the fleet in
Prometheus format and `docs/grafana-dashboard.json` is an importable dashboard.
No charts were added to the AgentLens UI, deliberately.

The metrics are recomputed from SQLite per scrape rather than counted in
memory, which keeps the collector and the exporter from disagreeing and makes a
deleted database read as a counter reset. Grouped by source, agent and model
only; a session label would have made cardinality unbounded. 462 series and
44 KB at 3,110 sessions, 0.22 s per scrape, so the planned 15-second memo was
not needed. The tool-error and denial predicates are the same SQL the dashboard
uses, so a tool error means one thing in both places.

Two things worth writing down. Cost was already being captured by OpenCode and
Roo Code and had never been summed anywhere: the shared database turned out to
hold $1,391 of reported spend, which nobody had seen. And OpenCode reports cost
twice, per message and again on turn.done, so a naive sum double counts; a
session now takes its turn totals when it has them and its message costs
otherwise. Nothing is priced locally, because adapters fold cache reads into
input tokens and cache reads are most of the 10.3B tokens while costing a
fraction, so a price table would produce confident nonsense.

Verified with a throwaway Prometheus and Grafana in Docker scraping the demo
fleet under a synthetic load generator: every panel binds and draws, and
/metrics agrees with /api/stats on sessions, tool calls and tokens to the digit.
The screenshot in the README is that, not anyone's real fleet.

## 2026-09-07 - Correction: they do backfill history

The entry above claims Grafana's plugins only see sessions started after
installation, so reading existing logs was AgentLens's remaining edge. That is
false. `agento11y history import <claude-code|codex|cursor|opencode|pi>` exists,
with a session picker, `--since` defaulting to 90 days, `--all`, `--dry-run`, a
ledger so repeats do not double-export, and `--local`. A dry run on this machine
planned 140 sessions and about 11,946 turns.

I asserted the opposite repeatedly, in the README, in PR #47 and in a release
note, having read their plugin docs but never their CLI's help output. The docs
describe how capture works; the binary lists what it can do. Reading the second
would have taken one command.

What genuinely remains: harness coverage they do not have (dsh, Roo Code,
Antigravity CLI, TrueForge), the trace view and its approval gate, the
investigator agent, and being self-hostable and open end to end. That is a
narrower claim than the one this log made this morning, and the recommendation
for a team of four is now plainly their tool, not this one.

## 2026-09-07 - Cache tokens were being thrown away

Grafana's local viewer shows per-session cost for Claude Code and a 96% input
cache-hit rate. I had said the day before that a price table here would be
"confident nonsense" because adapters fold cache reads into input tokens - true
of the adapters, not of the logs. Claude Code reports `input_tokens`,
`cache_creation_input_tokens` and `cache_read_input_tokens` separately, and
`claude-code.ts` was adding all three into one number and discarding the split.
Five adapters did the same thing with their own field names.

Fixed with one helper, `usageOf` in emit.ts, so an event now carries
`inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`. Cache
reads cost a fraction of fresh input and cache writes cost more, so this is the
prerequisite for computing cost at all.

The rollups needed care to avoid a discontinuity: rows written before today fold
cache into `inputTokens`, so "tokens in" is now the sum of input, cache read and
cache write. Old rows and new ones therefore report the same total, which a test
pins. /metrics gained `kind="cache_read"` and `kind="cache_write"`.

On real logs the split is stark: 87 newly written events carried 244,047 fresh
input tokens against 1,054,044 cache reads, so 81% of that traffic was cache and
would have been priced as if it were full-rate input.

## 2026-09-07 - Ranking sessions by what looks wrong

The shared fleet is 3,153 sessions and most of them are a scheduled job that
runs twice an hour: one turn, two tool calls, nothing interesting. Sorted by
recency, which is all the table could do, the sessions worth looking at were
buried hundreds of rows down.

Sessions now carry a problem_score computed in SQL from four blunt signals: a
failed turn is worth 50, each tool failure 5 up to 20 of them, one point per
minute of the longest stall inside the session up to 30, and tool calls per turn
above ten up to 30. Every term is capped so one signal cannot swamp the others,
and the tool-failure term reuses the predicate the UI already uses, so a tool
the user declined still does not count as a fault.

`list_problem_sessions` in the MCP server claimed "worst first" and never
sorted - it filtered on hardcoded thresholds and inherited ORDER BY updated_at.
It now actually ranks, and drops anything scoring zero.

Ordering 3,153 sessions by score costs 308 ms against 214 ms for recency, so no
two-step query was needed. On the real fleet the top of the list is a session
with 7 failed turns and 18 tool failures, then one with 6 failed turns, then
764 tool calls across 69 turns with 42 failures - none of which was visible
before without scrolling.

The plan said no new UI chrome. One toggle in the table header was needed
anyway, because a ranking nobody can reach is not a feature.

## 2026-09-07 - Pricing the sessions the harness never priced

Cost only ever covered OpenCode and Roo Code, the two harnesses that report it
themselves. Claude Code, the biggest spender here, showed nothing. Grafana's
viewer prices it per session, so there was no excuse.

The awkward part was where to get prices. Inventing them was the thing I had
already refused to do once. models.dev is the database OpenCode itself prices
from, it has every model in this fleet but two, and it is served as one JSON
document. Its repository states no licence for the data, though, so shipping a
copy inside the package was out. Prices are fetched once a week instead and
cached under ~/.cache/agentlens. That is the only outbound request this tool
makes; it sends nothing, `AGENTLENS_PRICES=off` stops it, and pointing the same
variable at a file uses your own table. With no prices and no network, reported
cost still works.

Three details worth keeping. Harnesses name the same model differently -
`anthropic/claude-opus-5`, `~moonshotai/kimi-latest`,
`claude-sonnet-4-5-20250929` - so matching takes the part after the last slash
and then drops trailing segments until something hits, which lets a dated build
fall back to its base model. A session that reports its own cost is never
second-guessed. And an event without a cache-token split cannot be priced at
all: before v0.8.1 cache reads were folded into input, and charging those at the
input rate overstates a bill by roughly ten times, so those rows stay unpriced
rather than wrong.

`agentlens_cost_usd_total` now carries basis="reported" or basis="estimated",
because presenting a computed number as a charge would be exactly the sort of
confident nonsense this was meant to avoid. On the local fleet, 16 of 18 models
priced; the two misses are Claude Code's `<synthetic>` placeholder, which is not
a model, and a free DeepSeek preview.

## 2026-09-07 - A cost column

Cost existed in the API and in /metrics but never in the table anyone actually
looks at. It sits between Tokens and Duration now: what the harness charged, or
what the tokens are worth at published prices, never both. An estimate is dimmed
and says so on hover, so a computed number is never mistaken for a charge.

Two deliberate blanks. Under a cent shows nothing, because $0.00 reads like a
measurement and a blank reads like "not priced", which is the truth. And
sessions from before the cache split stay empty rather than wrong.

On the real fleet that is 27 of 194 rows priced today, one of them an estimate.
The rest fill in as collectors write split-aware events.
