# AgentLens

Observability for TrueForge agents: a trace viewer for every session your agents
run, and an investigator agent that diagnoses the bad ones.

Built for the Agent Harness Hackathon (WeMakeDevs + TrueFoundry, Aug 2026).

## What it does

- Collects sessions, turns, and events from a TrueForge server into SQLite.
- Dashboard with a fleet overview and a per-session trace view: timeline of
  input/model/tool activity plus a turn-by-turn transcript with durations.
- Investigator agent (a TrueForge agent) that triages failed or slow sessions
  using AgentLens MCP tools, parallel subagents, sandboxed analysis, and an
  approval gate before publishing its incident report.

## Layout

- `packages/server` — collector, REST/SSE API, MCP server
- `packages/web` — dashboard (Vite + React)
- `agents/` — TrueForge agent specs

## Running

1. `npx @truefoundry/trueforge` (TrueForge at http://localhost:8790)
2. `npm install`
3. `npm run dev -w packages/server`
4. `npm run dev -w packages/web`

## Harness feature map

How AgentLens uses TrueForge capabilities (filled in as built):

| TrueForge capability | Where used |
|---|---|
| MCP tools | Investigator agent calls the AgentLens MCP server (list_problem_sessions, get_trace, get_metrics) |
| Subagents | Investigator fans out one subagent per suspect session |
| Sandboxed code execution | Trace analysis scripts run in the sandbox |
| Human approvals | Approval gate before the investigator publishes an incident report |
| Persistent sessions | Collector ingests session/turn/event history via the SDK; dashboard renders it |

## Tools used

- TrueForge (`@truefoundry/trueforge`, `@truefoundry/trueforge-sdk`) - agent harness
- Qodo - code review on pull requests
- Node 22+/TypeScript, Hono, better-sqlite3, Vite + React

## Qodo Code Review Evidence

- Representative merged PR: (link after first milestone PR)
- Findings and responses: (1-2 lines after Qodo review)
- PR history shows initial and follow-up Qodo reviews.

All changes land through pull requests; no direct pushes to main.
