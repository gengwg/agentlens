# AgentLens

Local observability for coding-agent harnesses: a fleet view and trace viewer
for every Claude Code, OpenCode, dsh, Cursor Agent, Antigravity CLI, and
TrueForge session on your machine (plus Codex CLI, Gemini CLI, Roo Code, and
Cline, experimental), and an investigator agent that diagnoses the bad ones.

Started at the Agent Harness Hackathon (WeMakeDevs + TrueFoundry, Aug 2026).

![Fleet dashboard](docs/sessions.png)

![Investigator trace](docs/trace.png)

## What it does

- Collects sessions, turns, and events into SQLite from local harness logs
  (Claude Code, OpenCode, dsh, and others) and from a TrueForge server. Any
  other harness can post the same JSON to the ingest API.
- Dashboard with a fleet overview and a per-session trace view: timeline of
  input/model/tool activity plus a turn-by-turn transcript with durations.
  "Failed turns" counts sessions whose turn ended in an error; "tool errors"
  counts sessions where a tool call failed. A tool the user declined is a
  choice, not a failure, and counts as neither.
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

```
npx @gengwg/agentlens
```

Open http://localhost:8788. Your existing Claude Code, OpenCode, dsh, and other
sessions show up within seconds, and running ones update live. Everything stays
on your machine: the server binds to loopback and reads the logs in place.

The package is [@gengwg/agentlens](https://www.npmjs.com/package/@gengwg/agentlens).
It pulls in `better-sqlite3`, which downloads a prebuilt native binary (or
compiles one) during install.

To hack on it instead, clone and run the API and dashboard separately:

```
git clone https://github.com/gengwg/agentlens && cd agentlens
npm install
npm run dev -w packages/server    # API :8788, MCP :8791
npm run dev -w packages/web       # dashboard http://localhost:5173
```

`npm start` from the clone builds the dashboard and serves everything on :8788,
the same as the published package.

## Sources

Sources are auto-detected from the default locations below; TrueForge is always
on (idle until the server is reachable). Each adapter translates its harness's
records into one event vocabulary, so the store, the MCP tools, and the trace
view are shared. `AGENTLENS_SOURCES` pins the list (comma-separated names).

| Source | Status | Default location (override) |
|---|---|---|
| `claude-code` | tested | `~/.claude/projects` (`CLAUDE_PROJECTS_DIR`) |
| `opencode` | tested | `~/.local/share/opencode/opencode.db` (`OPENCODE_DB`) |
| `dsh` | tested | `~/.dsh` (`DSH_HOME`) |
| `trueforge` | tested | `http://localhost:8790` (`TRUEFORGE_URL`) |
| `cursor` | tested on small samples | `~/.cursor` (`CURSOR_HOME`), Cursor Agent CLI transcripts |
| `antigravity` | tested on small samples | `~/.gemini/antigravity-cli` (`ANTIGRAVITY_HOME`) |
| `codex` | experimental | `~/.codex` (`CODEX_HOME`) |
| `gemini` | partly verified | `~/.gemini` (`GEMINI_HOME`); Gemini CLI is enterprise-only since June 2026 |
| `roo-code`, `cline` | experimental | VS Code `globalStorage` task dirs (`ROO_TASKS_DIR`) |

Experimental adapters are written from the public log formats and have
synthetic tests only; open an issue with a sample session if one misreads yours.
The Gemini adapter reads the current JSONL chat log and the older JSON
document; its prompt handling is verified against a real run, but Gemini CLI
refuses individual accounts, so its reply, tool, and token fields are not.
Cursor Agent transcripts record no per-message timestamps, tool results, or
token usage, so event times are interpolated between the chat's start and end.
Antigravity CLI records no token usage. The Cursor IDE's own chats (not the CLI)
are not read.
Other variables: `AGENTLENS_DB` (`agentlens.db`), `PORT` (`8788`), `MCP_PORT`
(`8791`).

Claude Code and dsh transcripts are tailed with per-file cursors (subagent
transcripts become threads); OpenCode is polled read-only from its SQLite
database (child sessions become threads); Gemini and Roo files are re-read when
they change. A turn left running by a killed process is closed after 30 minutes.

### Bring your own harness

Anything that can make an HTTP request can ship sessions in:

```
curl -X POST localhost:8788/api/ingest -H 'content-type: application/json' -d '{
  "source": "grok",
  "sessions": [{"id": "s1", "agent_name": "my-project", "title": "fix login", "created_at": "2026-09-06T10:00:00Z"}],
  "turns": [{"id": "s1:t1", "session_id": "s1", "created_at": "2026-09-06T10:00:00Z", "status": "done", "completed_at": "2026-09-06T10:00:42Z"}],
  "events": [
    {"id": "s1:e1", "session_id": "s1", "turn_id": "s1:t1", "type": "turn.created", "created_at": "2026-09-06T10:00:00Z",
     "raw": {"input": [{"type": "user.message", "content": "fix login"}]}},
    {"id": "s1:e2", "session_id": "s1", "turn_id": "s1:t1", "type": "model.message", "created_at": "2026-09-06T10:00:30Z",
     "raw": {"content": "Patched.", "toolCalls": [{"id": "c1", "function": {"name": "bash", "arguments": "{}"}}],
             "usage": {"inputTokens": 1200, "outputTokens": 80}}},
    {"id": "s1:e3", "session_id": "s1", "turn_id": "s1:t1", "type": "tool.response", "created_at": "2026-09-06T10:00:40Z",
     "raw": {"content": "ok", "toolCallId": "c1", "error": false}}
  ]
}'
```

Ids are yours and must be unique across sessions; resending is idempotent.
`source` is 1-32 characters from letters, digits, `-`, `_`, `.`.
Turn `status` is `running`, `done`, `error`, or `cancelled`. Event types the
dashboard renders: `turn.created`, `model.message`, `tool.response`,
`thread.created` (`raw.title`, with `thread_id` on the thread's events), and
`turn.done` (`raw.state.status`).

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
OpenCode, dsh, Codex CLI, Gemini CLI, Roo Code, and Cline; each new harness is
one file under `packages/server/src/sources/`, or a client of the ingest API.
A shared company server (per-machine shippers pushing to one AgentLens) is the
next step and is not built yet.

## Optional: investigator agent

The investigator is a TrueForge agent that triages failed or slow sessions from
any harness using the AgentLens MCP tools, parallel subagents, sandboxed
analysis, and an approval gate before publishing its incident report. The
sandbox needs `bwrap`, `socat`, and `rg` on the host.

1. `npx @truefoundry/trueforge` (TrueForge at http://localhost:8790)
2. Add a model provider (TrueForge UI settings, or the API).
3. `SANDBOX=1 npm run seed -w packages/server` registers the AgentLens MCP
   server in TrueForge, creates the investigator plus two demo agents (one wired
   to a dead MCP server so failures exist), and generates demo traffic.

Click "Investigate fleet" in the dashboard. The investigator finds the failing
sessions, fans out subagents, drafts an incident report, and pauses on the
approval gate; Allow publishes the report to the dashboard. Trace excerpts are
sent to the model provider configured in TrueForge.

## Links

- Build story: https://gengwg.medium.com/building-agentlens-what-trueforge-doesnt-tell-you-until-you-build-on-it-4173e6f7d6ce
- Raw build log: [BUILDLOG.md](BUILDLOG.md)
