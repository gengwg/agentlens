// Masks secrets before an event reaches SQLite, because a session records
// whatever crossed it: a key pasted into a prompt, a `printenv`, a .env read
// back by a tool. The store is a file on your disk with no authentication in
// front of it, so a token in a transcript is a token at rest.
//
// The pattern table is the tier-1 set from Grafana's agento11y (Apache-2.0,
// https://github.com/grafana/agento11y/blob/main/redaction/patterns.json),
// whose patterns are in turn hand-curated from Gitleaks (MIT,
// https://github.com/gitleaks/gitleaks). Their mask format is kept verbatim so
// their own fixtures serve as this file's tests. See NOTICE.
//
// Only the high-confidence formats are ported. Their tier 2 guesses at
// key=value shapes, which is the right call for a product that must not leak
// and the wrong one here: `DB_PASSWORD=hunter2` in a transcript is often the
// thing you are trying to read when debugging.
//
// AGENTLENS_REDACT=0 turns this off.

type Pattern = { id: string; re: RegExp };

const PATTERNS: Pattern[] = [
  { id: "grafana-cloud-token", re: /\bglc_[A-Za-z0-9_-]{20,}/g },
  { id: "grafana-service-account-token", re: /\bglsa_[A-Za-z0-9_-]{20,}/g },
  { id: "aws-access-token", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/g },
  { id: "github-pat", re: /\bghp_[A-Za-z0-9_]{36,}/g },
  { id: "github-oauth", re: /\bgho_[A-Za-z0-9_]{36,}/g },
  { id: "github-app-token", re: /\bghs_[A-Za-z0-9_]{36,}/g },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{82}/g },
  { id: "anthropic-api-key", re: /\bsk-ant-api03-[a-zA-Z0-9_-]{93}AA/g },
  { id: "anthropic-admin-key", re: /\bsk-ant-admin01-[a-zA-Z0-9_-]{93}AA/g },
  { id: "openai-api-key", re: /\bsk-[a-zA-Z0-9]{20}T3BlbkFJ[a-zA-Z0-9]{20}/g },
  { id: "openai-project-key", re: /\bsk-proj-[a-zA-Z0-9_-]{40,}/g },
  { id: "openai-svcacct-key", re: /\bsk-svcacct-[a-zA-Z0-9_-]{40,}/g },
  { id: "gcp-api-key", re: /\bAIza[A-Za-z0-9_-]{35}/g },
  { id: "private-key", re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { id: "connection-string", re: /(?:postgres|mysql|mongodb|redis|amqp):\/\/[^ \t\n\f\r\xa0'"]+@[^ \t\n\f\r\xa0'"]+/g },
  { id: "bearer-token", re: /[Bb]earer[ \t\n\f\r\xa0]+[A-Za-z0-9_.\-~+/]{20,}={0,3}/g },
  { id: "slack-token", re: /\bxox[bporas]-[A-Za-z0-9-]{10,}/g },
  { id: "stripe-key", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { id: "sendgrid-api-key", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g },
  { id: "twilio-api-key", re: /\bSK[a-f0-9]{32}/g },
  { id: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}/g },
  { id: "pypi-token", re: /\bpypi-[A-Za-z0-9_-]{50,}/g },
];

// Cheap gate: nothing in the table can match without one of these fragments,
// so most events skip 22 regexes entirely. Every tool result runs through here.
const HINTS = /glc_|glsa_|A3T|AKIA|ASIA|ABIA|ACCA|ghp_|gho_|ghs_|github_pat_|sk-|AIza|PRIVATE KEY|:\/\/|earer|xox|k_live_|k_test_|SG\.|\bSK|npm_|pypi-/;

export const redactionEnabled = () => process.env.AGENTLENS_REDACT !== "0";

export function redactSecrets(text: string): string {
  if (!text || !HINTS.test(text)) return text;
  let out = text;
  for (const { id, re } of PATTERNS) out = out.replace(re, `[REDACTED:${id}]`);
  return out;
}

// Events are stored as a JSON string, and every pattern's mask is plain ASCII
// with no quotes or backslashes, so masking the serialized form cannot break
// the JSON. Doing it here rather than per field covers prompts, model output,
// tool arguments and tool results in one pass.
export function redactEventRaw(raw: string): string {
  return redactionEnabled() ? redactSecrets(raw) : raw;
}
