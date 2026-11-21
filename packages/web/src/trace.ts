import type { TraceEvent } from "./api";

export const TRACE_PAGE_SIZE = 200;

export function mergeTraceEvents(stored: TraceEvent[], live: TraceEvent[]): TraceEvent[] {
  const seen = new Set<string>();
  const merged: TraceEvent[] = [];
  for (const event of [...stored, ...live]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

export function searchTraceEvents(events: TraceEvent[], query: string): TraceEvent[] {
  if (!query) return events;
  const needle = query.toLowerCase();
  return events.filter((event) => JSON.stringify(event.raw).toLowerCase().includes(needle));
}

export function newestTraceEvents(events: TraceEvent[], limit: number): TraceEvent[] {
  return events.slice(Math.max(0, events.length - limit));
}
