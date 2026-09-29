import type { CodexPaginatedVersion } from "./codex-lifecycle-compatibility.js";
/** A fresh status transaction binds a physical TUI to a daemon-owned thread. */
export interface CodexPaginatedThreadBinding {
  codexHome: string;
  threadId: string;
  serverVersion: CodexPaginatedVersion;
  processUuid: string;
  processBirth: string;
  pid: number;
  observedAt: string;
}
