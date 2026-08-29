// Registers AgentLens in TrueForge (MCP server + investigator agent),
// creates demo agents, and generates demo traffic. Idempotent.
import { TrueForge } from "@truefoundry/trueforge-sdk";

const TF = process.env.TRUEFORGE_URL ?? "http://localhost:8790";
const client = new TrueForge({ baseUrl: TF });

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${TF}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pickModel(): Promise<string> {
  if (process.env.MODEL) return process.env.MODEL;
  const { data } = await api("GET", "/models");
  if (!data?.length) {
    throw new Error(
      "No models configured in TrueForge. Add a model provider at " +
        `${TF} (Settings) or POST /api/v1/settings/model-providers, then re-run.`,
    );
  }
  return data[0].name ?? data[0].model_id;
}

async function ensureMcpServer(name: string, url: string, description: string) {
  const existing = await api("GET", "/settings/mcp-servers");
  if (existing.data?.some((s: any) => (s.manifest?.name ?? s.name) === name)) return;
  await api("POST", "/settings/mcp-servers", {
    manifest: { type: "remote", name, url, description },
  });
  console.log(`mcp server registered: ${name}`);
}

async function ensureAgent(name: string, manifest: Record<string, unknown>) {
  const { data } = await client.agents.list();
  const found = (data as any[])?.find((a) => a.name === name);
  if (found) {
    await client.agents.update(found.id, { manifest: manifest as any });
    console.log(`agent updated: ${name}`);
    return;
  }
  await client.agents.create({ name, manifest: manifest as any });
  console.log(`agent created: ${name}`);
}

const INVESTIGATOR_INSTRUCTIONS = `You are the AgentLens investigator, an SRE for AI agents.
Your job: diagnose problem sessions recorded by AgentLens and produce one concise incident report.

Method:
1. Call list_problem_sessions (or get_session_trace if the user names a session).
2. For each suspect session (up to 3), delegate analysis to a parallel subagent.
   Each subagent gets one session id and must call get_session_trace, then report:
   root cause hypothesis, failing tool or model step, timings, and evidence.
3. If timing or token patterns need computation, use export_trace_json and analyze
   the JSON in your sandbox with a short script.
4. Synthesize one incident report (title, affected agents/sessions, root causes,
   recommended fixes) and publish it with publish_incident_report. Publishing
   requires human approval; wait for it.
Be terse and factual. Cite session and turn ids.`;

async function main() {
  const model = await pickModel();
  console.log(`using model: ${model}`);

  await ensureMcpServer(
    "agentlens",
    "http://localhost:8791/mcp",
    "AgentLens observability: query sessions, traces, fleet metrics; publish incident reports.",
  );
  // Intentionally unreachable server so demo traffic produces real failures.
  await ensureMcpServer(
    "flaky-tools",
    "http://localhost:9992/mcp",
    "Demo tool server that is down, used to generate failing sessions.",
  );

  await ensureAgent("investigator", {
    model: { name: model },
    instructions: INVESTIGATOR_INSTRUCTIONS,
    mcp_servers: [
      {
        name: "agentlens",
        preload: true,
        require_approval_for_tools: ["publish_incident_report"],
      },
    ],
    config: {
      dynamic_sub_agents: { enabled: true },
      sandbox: { enabled: process.env.SANDBOX === "1" },
    },
  });

  await ensureAgent("docs-helper", {
    model: { name: model },
    instructions: "Answer questions concisely in one short paragraph.",
  });

  await ensureAgent("flaky-agent", {
    model: { name: model },
    instructions:
      "Always use your MCP tools to answer. If a tool fails, retry once, then give up and apologize.",
    mcp_servers: [{ name: "flaky-tools" }],
    config: { iteration_limit: 6 },
  });

  if (process.env.TRAFFIC === "0") return;
  console.log("generating demo traffic...");
  const runs: Array<[string, string]> = [
    ["docs-helper", "What is an agent harness, in two sentences?"],
    ["docs-helper", "Explain MCP in one paragraph."],
    ["flaky-agent", "Look up the current status of order 4711 with your tools."],
    ["flaky-agent", "Fetch the weekly metrics summary using your tools."],
  ];
  await Promise.allSettled(
    runs.map(async ([agent, content]) => {
      const { data: session } = await client.sessions.create({ agent: { name: agent } });
      const stream = await client.sessions.createTurnStream(session.id, {
        input: [{ type: "user.message", content }],
      });
      for await (const ev of stream) {
        if ((ev as any).type === "turn.done") {
          console.log(`${agent}: turn ${(ev as any).state?.status}`);
        }
      }
    }),
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
