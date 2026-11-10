import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { captureClaudeTranscriptAnchor } from "../../src/claude-local-transcript-provider.js";
import { createTerminalRuntimeCliAdapter } from "../../src/terminal-runtime-cli-adapter.js";
import { TerminalAgentBridge } from "../../src/terminal-agent-bridge.js";
import { StaticTerminalControlProvider } from "../../src/terminal-control-provider.js";
import type { ClaudeAgentRow } from "../../src/claude-terminal-agent-adapter.js";
import type { TerminalControlRef } from "../../src/terminal-agent-adapter.js";

/** Sanitized incident shape: an old background shell precedes this Turn's anchor. */
export function claudeMonitorIncident(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-incident-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, ".claude"), cwd = path.join(root, "workspace");
  const sessionId = "c5fb2ff0-81e0-443c-9eaf-0c25d3b9a2af", pid = 67397;
  const directory = path.join(home, "projects", cwd.replace(/[^A-Za-z0-9]/gu, "-"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(directory, `${sessionId}.jsonl`);
  const row: ClaudeAgentRow = { pid, kind: "interactive", sessionId, cwd,
    startedAt: 1793185422337, status: "idle" };
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const base = (n: number, parent: number | null, timestamp: string) => ({
    uuid: id(n), parentUuid: parent === null ? null : id(parent), timestamp,
    cwd, sessionId, version: "2.1.295", isSidechain: false, entrypoint: "cli"
  });
  const old = { ...base(1, null, "2026-11-10T08:00:00.000Z"), type: "user",
    toolUseResult: { backgroundTaskId: "bhyl81iab" },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "old-shell", content: "webpack remains in background" }] } };
  fs.writeFileSync(file, JSON.stringify(old) + "\n", { mode: 0o600 });
  const anchor = captureClaudeTranscriptAnchor({ sessionId, cwd, pid, claudeHome: home,
    agentRows: [row], now: new Date("2026-11-10T09:18:35.134Z") });
  assert.ok(anchor);
  row.status = "shell";
  const text = "Read-only: check ports 8003 and 8014; foreground response completes this task.";
  const pending = [{ ...base(2, 1, "2026-11-10T09:18:43.170Z"), type: "user", promptId: id(20),
    message: { role: "user", content: text } }];
  const finished = [...pending,
    { ...base(3, 2, "2026-11-10T09:20:00.171Z"), type: "assistant",
      message: { role: "assistant", id: id(30), stop_reason: "end_turn",
        content: [{ type: "text", text: "8003 and 8014 are listening. Old webpack shell remains alive. Foreground done." }] } },
    { ...base(4, 3, "2026-11-10T09:20:00.424Z"), type: "system", subtype: "turn_duration", durationMs: 77000 }];
  const write = (complete: boolean) => fs.writeFileSync(file,
    [old, ...(complete ? finished : pending)].map(r => JSON.stringify(r) + "\n").join(""), { mode: 0o600 });
  write(true);
  const takeover = { terminal_bridge: true, terminal_bridge_message_id: "message-1",
    terminal_bridge_last_activity_at: "2026-11-10T09:18:32.924Z",
    terminal_bridge_started_at: "2026-11-10T09:18:32.924Z", claude_transcript_anchor: anchor,
    terminal_bridge_submission: { message_id: "message-1", status: "agent_accepted" } };
  const request = { sessionId, cwd, requestText: text,
    requestHash: createHash("sha256").update(text).digest("hex"), startedAt: takeover.terminal_bridge_started_at,
    context: { pid, nativeTakeover: takeover } };
  const selected: (number | undefined)[] = [];
  const runtime = createTerminalRuntimeCliAdapter({ options: { claudeHome: home },
    dependencies: { loadClaudeAgentRows(_options, observation) {
      selected.push(observation.pid);
      return [{ ...row, status: observation.pid === pid ? row.status : "busy" }];
    } }, completion: { detectExactBound: () => ({ handled: false }), loadCodexContexts: async () => [] },
    identity: { resolveCurrent: async () => undefined, assertRuntime() {} }, workspace: { assertConfigured() {} } });
  const control: TerminalControlRef = { kind: "tmux", target: "work:0.0", session: "work", window: 0,
    pane: 0, panePid: pid, currentPath: cwd, capabilities: ["screen_status", "durable_completion"] };
  const provider = new StaticTerminalControlProvider({ panes: [{ ...control }], screens: {
    [control.target]: "Claude Code v2.1.295\nSautéed for 1m 17s · done 17:20 · 1 shell still running\n❯ \n  ? for shortcuts"
  } });
  const bridge = new TerminalAgentBridge({ registry: runtime.createAgentRegistry(), terminalProvider: provider });
  return { row, selected, takeover, request, file, write, root,
    poll: () => bridge.monitorPoll({ agent: "claude", terminalControl: control,
      screenOptions: { runtime: { pid, sessionId, cwd } }, durableRequest: request }) };
}
