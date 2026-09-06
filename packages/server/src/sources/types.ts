// Free-form so the ingest API can accept any harness name.
export type SourceName = string;

export interface Source {
  name: SourceName;
  // One incremental pass; may throw, the collector isolates failures per source.
  poll(): Promise<void>;
  status(): { ok: boolean; detail: string };
}
