export type SourceName = "trueforge" | "claude-code" | "opencode";

export interface Source {
  name: SourceName;
  // One incremental pass; may throw, the collector isolates failures per source.
  poll(): Promise<void>;
  status(): { ok: boolean; detail: string };
}
