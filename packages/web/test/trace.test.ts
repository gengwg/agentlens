import assert from "node:assert/strict";
import { test } from "node:test";
import type { TraceEvent } from "../src/api.ts";
import {
  mergeTraceEvents,
  newestTraceEvents,
  searchTraceEvents,
  TRACE_PAGE_SIZE,
} from "../src/trace.ts";

function event(id: string | number, content = `event ${id}`): TraceEvent {
  return {
    id: String(id),
    turn_id: "turn",
    thread_id: null,
    type: "model.message",
    created_at: null,
    raw: { content },
  };
}

function ids(events: TraceEvent[]): string[] {
  return events.map((event) => event.id);
}

test("initial window contains the newest 200 events in chronological order", () => {
  const events = Array.from({ length: 450 }, (_, i) => event(i));
  const rows = newestTraceEvents(searchTraceEvents(events, ""), TRACE_PAGE_SIZE);

  assert.equal(rows.length, 200);
  assert.deepEqual(ids(rows), Array.from({ length: 200 }, (_, i) => String(i + 250)));
});

test("expanding the window prepends older slices without duplicates", () => {
  const events = Array.from({ length: 450 }, (_, i) => event(i));
  const initial = newestTraceEvents(events, TRACE_PAGE_SIZE);
  const expanded = newestTraceEvents(events, TRACE_PAGE_SIZE * 2);

  assert.deepEqual(ids(expanded.slice(0, 200)), Array.from({ length: 200 }, (_, i) => String(i + 50)));
  assert.deepEqual(expanded.slice(200), initial);
  assert.equal(new Set(ids(expanded)).size, expanded.length);

  const all = newestTraceEvents(events, TRACE_PAGE_SIZE * 3);
  assert.deepEqual(ids(all), ids(events));
});

test("search runs before slicing so matches outside the initial window remain reachable", () => {
  const events = Array.from({ length: 450 }, (_, i) => event(i));
  events[2] = event(2, "an ancient Needle");

  const matches = searchTraceEvents(events, "needle");
  assert.deepEqual(ids(matches), ["2"]);
  assert.deepEqual(ids(newestTraceEvents(matches, TRACE_PAGE_SIZE)), ["2"]);
});

test("stored and live events are deduplicated by id with stored events winning", () => {
  const stored = [event(1, "stored one"), event(2, "stored two")];
  const live = [event(2, "live duplicate"), event(3, "live three"), event(3, "duplicate live")];

  const merged = mergeTraceEvents(stored, live);
  assert.deepEqual(ids(merged), ["1", "2", "3"]);
  assert.equal(merged[1].raw.content, "stored two");
  assert.deepEqual(ids(newestTraceEvents(merged, 2)), ["2", "3"]);
});
