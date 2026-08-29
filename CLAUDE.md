# AgentLens

Observability platform for TrueForge agents running inside a company, plus an
investigator agent (built on TrueForge itself) that diagnoses bad sessions.

Entry for the Agent Harness Hackathon (WeMakeDevs + TrueFoundry, Aug 24-30 2026).
Deadline is imminent: bias to shipping, smallest thing that works, no gold-plating.

## Tracks we optimize for

1. Best Use of TrueForge (primary): the investigator agent must visibly use
   MCP tools, subagents, sandbox, and approval gates. Document each in README.
2. Best UI/UX: the trace view is the centerpiece; invest polish there.
3. Best Blog Post: append to BUILDLOG.md after every milestone (what/why/surprises).

## Stack

- TypeScript everywhere, Node 22+ (local: v24).
- `packages/server`: collector + REST/SSE API + MCP server. Hono, better-sqlite3,
  `@truefoundry/trueforge-sdk`.
- `packages/web`: Vite + React dashboard.
- `agents/`: TrueForge agent YAML specs (demo agents + investigator).
- TrueForge runs locally: `npx @truefoundry/trueforge` -> http://localhost:8790

## TrueForge cheat sheet

Hierarchy: Agent -> Sessions -> Turns -> Events -> Deltas.

SDK (`@truefoundry/trueforge-sdk`):
- `new TrueForge({ baseUrl: 'http://localhost:8790' })`
- `client.sessions.list()` — auto-paginating async iterable, filter by `agentId`
- `client.sessions.create({ agent: { name } })`
- `client.sessions.createTurnStream(sessionId, { input: [{ type: 'user.message', content }] })`
- `client.sessions.listTurnEvents(sessionId, turnId, { order: 'asc' })` — completed
  turns only (events pre-merged); running turns must be streamed/subscribed.

Event types: `turn.created`, `model.message` (+ `.delta`), `tool.response`,
`mcp.initialize`, `tool.approval_required`, `turn.done` (has `state.status`,
`output`, `completed_at`).

Subagents: on by default; root agent calls built-in `create_sub_agent`; parallel,
one level deep; share the root's MCP tools/sandbox; their approval-requiring tool
calls still pause for the user.

Docs: https://trueforge.dev (index at https://trueforge.dev/llms.txt),
API reference at https://trueforge.dev/api-reference/, OpenAPI at /openapi.json.

## Conventions

- Smallest change that works. No new dependencies without a reason.
- No emojis anywhere. Comments only for the why, sparingly.
- Hackathon requires PR-based workflow: feature branches + PRs to main, never
  direct pushes to main. Imperative-mood commits.
- Repo: github.com/gengwg/agentlens (public, required by hackathon).
- Keep the README sections current: Harness feature map, Tools used,
  Qodo Code Review Evidence (link a representative merged PR + findings).
- Update BUILDLOG.md when a milestone lands.

## Commands

- TrueForge server: `npx @truefoundry/trueforge` (needs a model API key on first setup)
- AgentLens server: `npm run dev -w packages/server`
- Dashboard: `npm run dev -w packages/web`
- Seed demo traffic: `npm run seed -w packages/server`
