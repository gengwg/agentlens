import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Model prices, so cost can be worked out for harnesses that do not report it
// (Claude Code, dsh, Cursor and Antigravity report none). Prices come from
// models.dev, the same database OpenCode prices its own sessions from. They are
// fetched and cached rather than shipped: the repository states no licence for
// the data, and prices change. No network, no cache, no cost - the reported
// numbers still work, and nothing else breaks.
//
// AGENTLENS_PRICES points at a local JSON file instead, in the same shape:
//   { "claude-opus-5": { "input": 5, "output": 25, "cache_read": 0.5, "cache_write": 6.25 } }
// with dollars per million tokens. AGENTLENS_PRICES=off disables pricing.

export type Price = { input: number; output: number; cache_read: number; cache_write: number };
export type PriceTable = Record<string, Price>;

const URL_ = process.env.AGENTLENS_PRICES_URL ?? "https://models.dev/api.json";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const cachePath = () => join(homedir(), ".cache", "agentlens", "prices.json");

let table: PriceTable = {};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// models.dev nests models under providers; flatten to model id -> price.
export function flatten(api: any): PriceTable {
  const out: PriceTable = {};
  for (const provider of Object.values(api ?? {}) as any[]) {
    for (const [id, model] of Object.entries((provider?.models ?? {}) as Record<string, any>)) {
      const c = model?.cost;
      if (!c || (!num(c.input) && !num(c.output))) continue;
      out[id.toLowerCase()] = {
        input: num(c.input),
        output: num(c.output),
        cache_read: num(c.cache_read),
        cache_write: num(c.cache_write),
      };
    }
  }
  return out;
}

// Harnesses name the same model differently: "anthropic/claude-opus-5",
// "~moonshotai/kimi-latest", "claude-sonnet-4-5-20250929". Take the part after
// the last slash, then drop trailing segments until something matches, so a
// dated build falls back to its base model.
export function priceFor(model: string | null | undefined, t: PriceTable = table): Price | undefined {
  if (!model) return undefined;
  const key = model.toLowerCase().replace(/^~/, "").split("/").pop()!;
  if (t[key]) return t[key];
  const parts = key.split("-");
  for (let i = parts.length - 1; i > 1; i--) {
    const hit = t[parts.slice(0, i).join("-")];
    if (hit) return hit;
  }
  return undefined;
}

export const priceTable = () => table;

function readCache(path: string): PriceTable | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object") return undefined;
    // A cache holds the flat shape; a file straight from models.dev is nested.
    const first = Object.values(raw as Record<string, any>)[0];
    return first && typeof first === "object" && "models" in first ? flatten(raw) : (raw as PriceTable);
  } catch {
    return undefined;
  }
}

// Never blocks startup and never throws: pricing is a bonus, not a dependency.
export async function loadPrices(): Promise<number> {
  const override = process.env.AGENTLENS_PRICES;
  if (override === "off") return 0;
  if (override) {
    table = readCache(override) ?? {};
    if (!Object.keys(table).length) console.error(`prices: ${override} has no usable prices`);
    return Object.keys(table).length;
  }

  const path = cachePath();
  const fresh = existsSync(path) && Date.now() - statSync(path).mtimeMs < MAX_AGE_MS;
  if (existsSync(path)) table = readCache(path) ?? {};
  if (fresh) return Object.keys(table).length;

  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const flat = flatten(await res.json());
    if (Object.keys(flat).length) {
      table = flat;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(flat));
    }
  } catch (err) {
    // Offline, or models.dev is down. Whatever is cached still applies.
    if (!Object.keys(table).length) console.error(`prices: ${(err as Error).message}; cost stays as reported only`);
  }
  return Object.keys(table).length;
}
