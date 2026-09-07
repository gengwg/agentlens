import assert from "node:assert/strict";
import { test } from "node:test";
import { db, refreshPrices, seedSession, sessionSummaries } from "./fixtures.ts";

const { flatten, priceFor } = await import("../src/prices.ts");

// The shape models.dev serves: providers, each with models carrying a cost block.
const API = {
  anthropic: {
    models: {
      "claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      "claude-sonnet-4-5": { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      "claude-free-preview": { cost: { input: 0, output: 0 } },
    },
  },
  moonshotai: { models: { "kimi-latest": { cost: { input: 0.6, output: 2.5 } } } },
  broken: { models: { "no-cost-block": {} } },
};

const table = flatten(API);

test("flatten keeps priced models and drops the free and the malformed", () => {
  assert.deepEqual(Object.keys(table).sort(), ["claude-opus-5", "claude-sonnet-4-5", "kimi-latest"]);
  assert.deepEqual(table["claude-opus-5"], { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 });
  assert.equal(table["kimi-latest"].cache_read, 0, "a missing cache price is zero, not undefined");
});

test("priceFor copes with how each harness names a model", () => {
  assert.equal(priceFor("claude-opus-5", table)!.input, 5);
  assert.equal(priceFor("anthropic/claude-opus-5", table)!.input, 5, "OpenCode prefixes the provider");
  assert.equal(priceFor("~moonshotai/kimi-latest", table)!.input, 0.6, "and sometimes marks it with a tilde");
  assert.equal(priceFor("claude-sonnet-4-5-20250929", table)!.input, 3, "a dated build falls back to its base model");
  assert.equal(priceFor("CLAUDE-OPUS-5", table)!.input, 5);
  assert.equal(priceFor("gpt-9-imaginary", table), undefined);
  assert.equal(priceFor(null, table), undefined);
  assert.equal(priceFor("<synthetic>", table), undefined, "Claude Code's synthetic messages are not a model");
});

test("cost is estimated from tokens when the harness reports none", () => {
  seedSession("p-claude", {
    source: "claude-code",
    agent: "priced",
    events: [
      {
        id: "pc-1",
        type: "model.message",
        raw: {
          model: "claude-opus-5",
          // 1M fresh in, 1M cache read, 100k out: 5 + 0.5 + 2.5 = 8.00
          usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
        },
      },
    ],
  });
  refreshPrices((m: string) => priceFor(m, table));

  const s = sessionSummaries().find((x: any) => x.id === "p-claude") as any;
  assert.equal(s.reported_cost_usd, 0, "Claude Code reports no cost");
  assert.equal(Number(s.estimated_cost_usd.toFixed(4)), 8);
});

test("a harness that reports its own cost is never second-guessed", () => {
  seedSession("p-opencode", {
    source: "opencode",
    agent: "priced",
    turns: [{ id: "po-t1" }],
    events: [
      {
        id: "po-1",
        turn_id: "po-t1",
        type: "model.message",
        raw: { model: "claude-opus-5", cost: 0.11, usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    ],
  });
  refreshPrices((m: string) => priceFor(m, table));

  const s = sessionSummaries().find((x: any) => x.id === "p-opencode") as any;
  assert.equal(Number(s.reported_cost_usd.toFixed(2)), 0.11);
});

test("events written before the cache split stay unpriced", () => {
  seedSession("p-old", {
    source: "claude-code",
    agent: "legacy",
    events: [
      // Cache folded into inputTokens: pricing this at the input rate would
      // overstate it roughly tenfold, so it is left alone.
      { id: "po-old", type: "model.message", raw: { model: "claude-opus-5", usage: { inputTokens: 5_000_000, outputTokens: 1000 } } },
    ],
  });
  refreshPrices((m: string) => priceFor(m, table));

  const s = sessionSummaries().find((x: any) => x.id === "p-old") as any;
  assert.equal(s.estimated_cost_usd, 0);
});

test("refreshPrices only stores models it can price", () => {
  seedSession("p-unknown", {
    events: [{ id: "pu-1", type: "model.message", raw: { model: "gpt-9-imaginary", usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }],
  });
  const { models, priced } = refreshPrices((m: string) => priceFor(m, table));
  assert.ok(models > priced, "an unpriceable model is counted but not stored");
  const stored = db.prepare(`SELECT COUNT(*) n FROM model_prices WHERE model = ?`).get("gpt-9-imaginary") as { n: number };
  assert.equal(stored.n, 0);

  const s = sessionSummaries().find((x: any) => x.id === "p-unknown") as any;
  assert.equal(s.estimated_cost_usd, 0, "no price means no guess");
});
