import { sweepStaleTurns } from "./db.js";
import type { Source } from "./sources/types.js";

// Generic poll loop over all configured sources. Failures are isolated per
// source and logged only on state transitions, so an absent TrueForge does not
// spam the console every tick.
export function startCollector(sources: Source[], intervalMs = 3000) {
  let running = false;
  const failing = new Map<string, string>();
  const tick = async () => {
    if (running) return;
    running = true;
    for (const src of sources) {
      try {
        await src.poll();
        if (failing.delete(src.name)) console.log(`collector: ${src.name} recovered`);
      } catch (err) {
        const msg = (err as Error).message;
        if (failing.get(src.name) !== msg) console.error(`collector: ${src.name}: ${msg}`);
        failing.set(src.name, msg);
      }
    }
    try {
      sweepStaleTurns();
    } catch (err) {
      console.error("collector: sweep:", (err as Error).message);
    } finally {
      running = false;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}
