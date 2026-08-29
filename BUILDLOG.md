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
