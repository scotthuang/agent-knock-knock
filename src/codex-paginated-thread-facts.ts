/** A fresh status transaction binds a physical TUI to a daemon-owned thread. */
export interface CodexPaginatedThreadBinding {
  codexHome: string;
  threadId: string;
  serverVersion: "0.158.0";
  processUuid: string;
  processBirth: string;
  pid: number;
  observedAt: string;
}
