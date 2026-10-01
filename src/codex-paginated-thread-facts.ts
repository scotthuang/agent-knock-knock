/** A fresh status transaction binds a physical TUI to a daemon-owned thread. */
export interface CodexPaginatedThreadBinding {
  codexHome: string;
  threadId: string;
  /** Version of the exact foreground Codex TUI process and its UI contract. */
  agentVersion: string;
  /** Version returned by the shared app-server initialize response. */
  serverVersion: string;
  processUuid: string;
  processBirth: string;
  pid: number;
  observedAt: string;
}
