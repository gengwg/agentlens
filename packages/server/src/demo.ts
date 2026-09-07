// Fills a database with an invented fleet, so the dashboard can be tried (or
// screenshotted) without pointing it at real transcripts. Every id starts with
// "demo:". Use a throwaway database: AGENTLENS_DB=demo.db npm run demo.
import { db, upsertTurn } from "./db.js";
import { ensureSession, putEvent } from "./sources/emit.js";

const T0 = Date.parse("2026-09-05T09:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

type Step =
  | { say: string; tokens?: [number, number] }
  | { tool: string; args: string; result: string; error?: boolean }
  | { thread: string };

function session(o: {
  id: string;
  source: string;
  agent: string;
  title: string | null;
  start: number;
  turns: { prompt: string; minutes: number; steps: Step[]; status?: string; error?: string; approval?: string; usd?: number }[];
}) {
  const sid = `demo:${o.id}`;
  let clock = o.start;
  ensureSession({ id: sid, source: o.source, agent_name: o.agent, title: o.title, created_at: at(clock) });
  o.turns.forEach((turn, ti) => {
    const tid = `${sid}:t${ti}`;
    const started = clock;
    let n = 0;
    const eid = () => `${tid}:e${n++}`;
    putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "turn.created", created_at: at(clock),
      raw: { input: [{ type: "user.message", content: turn.prompt }] } });
    for (const step of turn.steps) {
      clock += 0.4;
      if ("say" in step) {
        putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "model.message", created_at: at(clock),
          raw: { content: step.say, toolCalls: [], model: "claude-sonnet-5",
            usage: { inputTokens: step.tokens?.[0] ?? 0, outputTokens: step.tokens?.[1] ?? 0 } } });
      } else if ("thread" in step) {
        putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "thread.created", created_at: at(clock),
          raw: { title: step.thread, threadId: `${tid}:${step.thread}` } });
      } else {
        const callId = `${tid}-c${n}`;
        putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "model.message", created_at: at(clock),
          raw: { content: "", model: "claude-sonnet-5", usage: { inputTokens: 4200, outputTokens: 90 },
            toolCalls: [{ id: callId, function: { name: step.tool, arguments: step.args } }] } });
        clock += 0.2;
        putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "tool.response", created_at: at(clock),
          raw: { content: step.result, toolCallId: callId, error: step.error === true } });
      }
    }
    const done = turn.status !== "running";
    clock = started + turn.minutes;
    if (turn.approval) {
      // The approval event names the call by id, and the trace resolves that id
      // through the model message that requested it, so both are needed.
      const callId = `${tid}-approval`;
      putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "model.message", created_at: at(clock - 0.2),
        raw: { content: "", model: "claude-sonnet-5", usage: { inputTokens: 12_300, outputTokens: 140 },
          toolCalls: [{ id: callId, function: { name: turn.approval, arguments: '{"paths":["docs/img/old-*.png"]}' } }] } });
      putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "tool.approval_required", created_at: at(clock),
        raw: { toolCalls: [{ id: callId }], threadId: "main" } });
    }
    upsertTurn.run({ id: tid, session_id: sid, created_at: at(started),
      completed_at: done ? at(clock) : null, status: turn.status ?? "done",
      error: turn.error ?? null, ingested: 1, pending_actions: turn.approval ? 1 : 0 });
    if (done) {
      putEvent({ id: eid(), session_id: sid, turn_id: tid, type: "turn.done", created_at: at(clock),
        raw: { state: { status: turn.status ?? "done", message: turn.error ?? null,
          metrics: turn.usd ? { totalCostInUsd: turn.usd } : undefined } } });
    }
    clock += 3;
  });
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(at(clock), sid);
}

session({
  id: "checkout-retry", source: "claude-code", agent: "checkout-api", start: 0,
  title: "retry failed payment webhooks",
  turns: [
    {
      prompt: "Webhook retries pile up after a gateway timeout. Find out why and fix it.",
      minutes: 14,
      usd: 0.62,
      steps: [
        { say: "Let me look at how retries are scheduled." },
        { tool: "Grep", args: '{"pattern":"scheduleRetry","glob":"src/**/*.ts"}', result: "src/webhooks/retry.ts:41\nsrc/webhooks/queue.ts:88" },
        { tool: "Read", args: '{"file_path":"src/webhooks/retry.ts"}', result: "const backoff = (n) => 2 ** n * 1000; // capped nowhere" },
        { say: "The backoff has no ceiling, so a slow gateway pushes every retry into the same minute. I will cap it and add jitter.", tokens: [38_400, 620] },
        { tool: "Edit", args: '{"file_path":"src/webhooks/retry.ts"}', result: "Applied 1 edit" },
        { tool: "Bash", args: '{"command":"npm test -- retry"}', result: "12 passing" },
        { say: "Capped at five minutes with jitter; the retry suite passes.", tokens: [41_900, 210] },
      ],
    },
  ],
});

session({
  id: "billing-flaky", source: "opencode", agent: "billing-worker", start: 40,
  title: "invoice export keeps failing in staging",
  turns: [
    {
      prompt: "The nightly invoice export failed again. What broke?",
      minutes: 9,
      usd: 0.18,
      status: "error",
      error: "export job exited 1",
      steps: [
        { tool: "Bash", args: '{"command":"kubectl logs job/invoice-export"}', result: "Error: connect ETIMEDOUT 10.4.2.19:5432", error: true },
        { say: "The job cannot reach the database. Checking the network policy." },
        { tool: "Bash", args: '{"command":"kubectl get networkpolicy -o yaml"}', result: "egress: to: [podSelector: app=postgres]" },
        { tool: "Bash", args: '{"command":"kubectl get pods -l app=postgres"}', result: "No resources found in staging namespace.", error: true },
        { say: "The policy allows egress to a pod label that no longer exists; staging moved Postgres to an external host.", tokens: [22_100, 480] },
      ],
    },
  ],
});

session({
  id: "docs-rewrite", source: "trueforge", agent: "docs-site", start: 95,
  title: "rewrite the getting started page",
  turns: [
    {
      prompt: "Rewrite the getting started page so a new user can run it in under five minutes.",
      minutes: 21,
      usd: 1.41,
      steps: [
        { thread: "audit current docs" },
        { thread: "check install paths" },
        { say: "Two subagents are reading the current page and the install scripts." },
        { tool: "Write", args: '{"file_path":"docs/getting-started.md"}', result: "Wrote 64 lines" },
        { say: "Cut it to one install command and one run command, with the old flow moved below.", tokens: [88_600, 1_340] },
      ],
    },
    {
      prompt: "Also drop the screenshots that no longer match.",
      minutes: 4,
      approval: "delete_files",
      steps: [
        { say: "Three screenshots are stale. Removing them needs your approval." },
      ],
    },
  ],
});

session({
  // TrueForge, because the stale sweep would close a days-old running turn from
  // a local harness and the demo wants one session still in flight.
  id: "search-index", source: "trueforge", agent: "search-indexer", start: 150,
  title: "reindex after the schema change",
  turns: [
    {
      prompt: "Reindex everything against the new schema and report throughput.",
      minutes: 6,
      status: "running",
      steps: [
        { tool: "Bash", args: '{"command":"./bin/reindex --since 2026-09-01"}', result: "indexed 412000 documents..." },
        { say: "Running at about 9k documents a second." },
      ],
    },
  ],
});

session({
  id: "mobile-crash", source: "shipped", agent: "workstation-2/mobile-app", start: 175,
  // Shipped from another machine: metadata only, so no title and no content.
  title: null,
  turns: [
    {
      prompt: "",
      minutes: 11,
      steps: [
        { tool: "read_file", args: "", result: "" },
        { tool: "execute_command", args: "", result: "", error: true },
        { say: "", tokens: [51_200, 900] },
      ],
    },
  ],
});

session({
  id: "infra-drift", source: "dsh", agent: "platform-infra", start: 200,
  title: "why did the node pool scale down",
  turns: [
    {
      prompt: "The staging node pool dropped to one node overnight. Why?",
      minutes: 7,
      usd: 0.11,
      steps: [
        { tool: "kubectl", args: '{"args":"get events --field-selector reason=ScaleDown"}', result: "ScaleDown: removing node after 10m of low utilization" },
        { say: "The autoscaler reclaimed two idle nodes; nothing failed.", tokens: [17_800, 260] },
      ],
    },
  ],
});

session({
  id: "flaky-e2e", source: "cursor", agent: "web-storefront", start: 225,
  title: "quarantine the flaky cart test",
  turns: [
    {
      prompt: "The cart e2e test fails about one run in five. Quarantine it and open a note.",
      minutes: 12,
      usd: 0.34,
      steps: [
        { tool: "run_terminal_cmd", args: '{"command":"npx playwright test cart --repeat-each 5"}', result: "3 passed, 2 failed (timeout waiting for #cart-total)", error: true },
        { say: "It waits on a total that renders after a debounce. Quarantining rather than papering over it." },
        { tool: "edit_file", args: '{"target_file":"e2e/cart.spec.ts"}', result: "Applied 1 edit" },
        { say: "Marked as fixme with a note pointing at the debounce.", tokens: [29_400, 510] },
      ],
    },
  ],
});

session({
  id: "release-notes", source: "antigravity", agent: "release-tools", start: 250,
  title: "draft notes for 2.4",
  turns: [
    {
      prompt: "Draft release notes for 2.4 from the merged PRs.",
      minutes: 5,
      usd: 0.07,
      steps: [
        { tool: "run_command", args: '{"command":"gh pr list --state merged --search milestone:2.4"}', result: "14 pull requests" },
        { say: "Grouped into four themes with the two breaking changes first." },
      ],
    },
  ],
});

console.log("demo fleet written to", process.env.AGENTLENS_DB ?? "agentlens.db");
