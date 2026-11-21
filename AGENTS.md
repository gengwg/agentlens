# AgentLens contributor guide

This file applies to the whole repository. `README.md` is the canonical user and
product documentation.

## Workspace and shared model

- This is an npm workspace with two packages: `packages/server` (Hono collector,
  REST/SSE API, MCP server, and SQLite store) and `packages/web` (Vite + React
  dashboard). Agent and demo registrations live in `packages/server/src/seed.ts`.
- Harness adapters live in `packages/server/src/sources/`. Each adapter translates
  its input into the shared event vocabulary (`turn.created`, `model.message`,
  `tool.response`, `thread.created`, and `turn.done`) and common session/turn rows;
  the database, MCP tools, and dashboard must remain harness-neutral. Update all
  affected consumers and adapter tests when changing an event or `raw` payload shape.
- Transcripts and SQLite databases are sensitive even with write-time secret masking.
  Preserve the shared redaction/write boundaries and never commit real transcripts or
  databases. The API and metrics endpoints are unauthenticated only on the default
  loopback binding. A non-loopback server requires `AGENTLENS_TOKEN`, checks Host
  headers, and belongs on a private network; preserve those checks on every route.
- Generate demo traffic only in a separate database, not the normal `agentlens.db`.
  For example, run `AGENTLENS_DB=demo.db npm run demo -w packages/server`, then start
  the server with the same `AGENTLENS_DB` to browse it. Tests use `:memory:`.

## Setup, development, and verification

Use Node 22+ and run these commands from the repository root. `npm ci` installs the
locked workspace dependencies. CI currently uses Node 24 and runs the final three
checks below.

```bash
npm ci
npm test
npx tsc --noEmit -p packages/server
npm run build -w packages/web
```

Run the two development processes in separate terminals:

```bash
npm run dev -w packages/server  # API :8788, MCP :8791
npm run dev -w packages/web     # dashboard :5173
```

Use `npm run build` for the complete publishable build. The web build writes
`packages/web/dist/`; the server build compiles TypeScript into
`packages/server/dist/`, replaces `dist/web/` with the current web export, and copies
the root `README.md` to the ignored `packages/server/README.md` included in the npm
package. The server bundle step requires the web export to exist, so do not use it as
a standalone clean build. Edit the root README rather than its generated package
copy, and never edit generated `dist/` output.

## Changes and documentation

All changes land through feature branches and pull requests to `main`, never direct
pushes to `main`. When relevant capabilities or tooling change, keep the README's
"Harness feature map" and "Tools used" sections current. Append a short
what/why/surprises entry to `BUILDLOG.md` when a milestone lands.
