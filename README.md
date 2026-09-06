# AgentLens

Local observability for coding-agent harnesses: a fleet view and trace viewer
for every Claude Code, OpenCode, and TrueForge session on your machine, plus an
investigator agent that diagnoses the bad ones.

Started at the Agent Harness Hackathon (WeMakeDevs + TrueFoundry, Aug 2026).

![Fleet dashboard](docs/sessions.png)

![Investigator trace](docs/trace.png)

## What it does

- Collects sessions, turns, and events into SQLite from local harness logs
  (Claude Code JSONL, the OpenCode database) and from a TrueForge server.
- Dashboard with a fleet overview and a per-session trace view: timeline of
  input/model/tool activity plus a turn-by-turn transcript with durations.
- Investigator agent (a TrueForge agent) that triages failed or slow sessions
  using AgentLens MCP tools, parallel subagents, sandboxed analysis, and an
  approval gate before publishing its incident report.

## Layout

- `packages/server` — collector with one adapter per harness
  (`src/sources/`), REST/SSE API, MCP server
- `packages/web` — dashboard (Vite + React)

Agent specs (investigator plus two demo agents) are defined in
`packages/server/src/seed.ts` and registered in TrueForge via its API.

## Running

Needs Node 22+.

1. `npm install`
2. `npm run dev -w packages/server` (API :8788, MCP server :8791)
3. `npm run dev -w packages/web` (dashboard at http://localhost:5173)

Your existing Claude Code and OpenCode sessions show up within seconds, and
running ones update live. Everything stays on your machine: the server binds to
loopback and reads the logs in place.

To also run TrueForge agents and the investigator (needs `bwrap`, `socat`, and
`rg` on the host for the sandbox):

4. `npx @truefoundry/trueforge` (TrueForge at http://localhost:8790)
5. Add a model provider (TrueForge UI settings, or the API).
6. `SANDBOX=1 npm run seed -w packages/server` registers the AgentLens MCP
   server in TrueForge, creates the investigator plus two demo agents (one wired
   to a dead MCP server so failures exist), and generates demo traffic.

Click "Investigate fleet" in the dashboard. The investigator finds the failing
sessions (from any harness), fans out subagents, drafts an incident report, and
pauses on the approval gate; Allow publishes the report to the dashboard.

## Sources

Sources are auto-detected: Claude Code if `~/.claude/projects` exists, OpenCode
if `~/.local/share/opencode/opencode.db` exists, TrueForge always (idle until
the server is reachable). Each adapter translates its harness's records into one
event vocabulary, so the store, the MCP tools, and the trace view are shared.

| Variable | Default |
|---|---|
| `AGENTLENS_SOURCES` | auto; comma list of `claude-code`, `opencode`, `trueforge` |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` |
| `OPENCODE_DB` | `~/.local/share/opencode/opencode.db` |
| `TRUEFORGE_URL` | `http://localhost:8790` |
| `AGENTLENS_DB` | `agentlens.db` |
| `PORT`, `MCP_PORT` | `8788`, `8791` |

Claude Code sessions are read from the JSONL transcripts (tail with per-file
cursors, subagent transcripts become threads); OpenCode is polled read-only
from its SQLite database (child sessions become threads). A turn left running
by a killed process is closed after 10 minutes.

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
- Node 22+/TypeScript, Hono, better-sqlite3, Vite + React

All changes land through pull requests; no direct pushes to main.

## Related work

TrueForge's bundled UI is a per-session chat interface; it has no cross-session
view, metrics, or timelines. Existing agent-observability tools (OpenTelemetry
wrappers, CLI analyzers) are harness-agnostic and miss what the harness knows:
subagent threads, approval gates, turn states. AgentLens is harness-native.

Future work: an OTLP exporter on the collector, translating the mirrored event
log into OpenTelemetry GenAI spans so traces land in Tempo/Jaeger alongside
infra traces. TrueForge emits no telemetry itself, so the exporter belongs here.

The store and UI are harness-neutral. Adapters exist for TrueForge, Claude Code,
and OpenCode; each new harness is one file under `packages/server/src/sources/`.
A shared company server (per-machine shippers pushing to one AgentLens) is the
next step and is not built yet.

## Links

- Build story: https://gengwg.medium.com/building-agentlens-what-trueforge-doesnt-tell-you-until-you-build-on-it-4173e6f7d6ce
- Raw build log: [BUILDLOG.md](BUILDLOG.md)
