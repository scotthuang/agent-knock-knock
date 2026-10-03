import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { observePaginatedWatch } from "../src/codex-paginated-watch.js";
import { createCodexPaginatedTaskAnchor, createCodexPaginatedTaskCheckpoint,
  type CodexPaginatedTaskSnapshot } from "../src/codex-paginated-task.js";
import { initialTerminalWatchInteractionPolicy, type TerminalWatch } from "../src/terminal-watch-record.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";

const NOW = "2026-10-02T00:00:00.000Z";
const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const REQUEST = "Observe only this task.";
function fixture(backend = "0.159.2", agentVersion = "0.159.0") {
  const anchor = createCodexPaginatedTaskAnchor({
    origin: "active_task", captured_at: NOW, codex_home: "/codex",
    codex_version: agentVersion, backend_version: backend,
    native_thread_id: THREAD, thread_cwd: "/repo", thread_originator: "codex-tui",
    process_uuid: "exact-process", process_birth: "exact-birth", pid: 700,
    request_hash: createHash("sha256").update(REQUEST).digest("hex"), turn_id: "active-turn"
  });
  const watch: TerminalWatch = {
    schema: "agent-knock-knock/terminal-watch", version: 3,
    watch_id: "terminal-watch-backend-drift", agent: "codex", anchor,
    terminal: { terminal_id: "terminal:v2:fixture", workspace: "/repo", binding_token: "a".repeat(64),
      terminal_endpoint: terminalControlEvidence({ kind: "herdr", target: "w1:p1", socketPath: "/tmp/herdr-fixture.sock",
        session: "fixture", panePid: 700, currentCommand: "codex", currentPath: "/repo", capabilities: ["screen_status"],
        sessionDir: "/tmp/herdr-fixture", workspaceId: "w1", tabId: "t1", paneId: "p1", terminalId: "native-p1" }) },
    observation_checkpoint: createCodexPaginatedTaskCheckpoint(),
    interaction_policy: initialTerminalWatchInteractionPolicy(anchor),
    openclaw_session: "controller", openclaw_bin: "/bin/openclaw",
    created_at: NOW, updated_at: NOW, last_activity_at: NOW,
    deadline_at: "2026-10-02T01:00:00.000Z", status: "active", notification_outbox: []
  };
  const snapshot: CodexPaginatedTaskSnapshot = {
    codexHome: "/codex", serverVersion: backend, completeToBoundary: true,
    thread: { id: THREAD, sessionId: THREAD, cwd: "/repo", historyMode: "paginated",
      cliVersion: backend, originator: "codex-tui", source: "cli",
      status: { type: "active", activeFlags: ["waitingOnUserInput"] }, turns: [] },
    turns: [{ id: "active-turn", status: "inProgress", itemsView: "full", error: null,
      startedAt: 100, completedAt: null, durationMs: null,
      items: [{ id: "input", type: "userMessage", content: [{ type: "text", text: REQUEST }] }] }]
  };
  return { watch, snapshot };
}

test("Watch grants native answer authority only for the unchanged audited backend pair", async () => {
  for (const [agentVersion, boundBackend, actual, allowed] of [
    ["0.159.0", "0.159.2", "0.159.2", true],
    ["0.159.0", "0.159.2", "0.159.3", false],
    ["0.159.0", "0.159.2", "1.0.0", false],
    ["0.159.3", "0.159.3", "0.159.3", true],
    ["0.159.3", "0.160.0", "0.160.0", true],
    ["0.160.0", "0.160.0", "0.160.0", true],
    ["0.159.3", "0.159.3", "0.160.0", false],
    ["0.159.3", "0.160.0", "0.159.3", false],
    ["0.160.0", "0.159.3", "0.159.3", false],
    ["0.159.2", "0.160.0", "0.160.0", false]
  ] as const) {
    const { watch, snapshot } = fixture(boundBackend, agentVersion);
    snapshot.serverVersion = actual;
    let blockingReads = 0;
    let answerAuthority: boolean | undefined;
    const result = await observePaginatedWatch({ watch, observedAt: NOW,
      terminalMatches: true, terminalAvailable: true,
      readSnapshot: async () => snapshot,
      blockingQuestionnaire: async () => { blockingReads += 1; return undefined; },
      questionnaire: (_checkpoint, _questions, allowResponses) => { answerAuthority = allowResponses; return undefined; }
    });
    assert.equal(result.kind, "pending");
    assert.equal(answerAuthority, allowed);
    assert.equal(blockingReads, allowed ? 1 : 0);
  }
  assert.equal(fixture("0.159.3").watch.interaction_policy, "notify_only");
});

test("backend upgrade completion stays bound to the original native turn", async () => {
  const { watch, snapshot } = fixture();
  snapshot.serverVersion = "0.159.3";
  snapshot.turns = [{ ...snapshot.turns[0]!, status: "completed", completedAt: 101, durationMs: 1000,
    items: [...snapshot.turns[0]!.items, { id: "result", type: "agentMessage", phase: "final_answer", text: "Original task complete." }] }];
  const observe = () => observePaginatedWatch({ watch, observedAt: NOW,
    terminalMatches: true, terminalAvailable: true, readSnapshot: async () => snapshot,
    questionnaire: () => assert.fail("completion must not open a native questionnaire") });
  const completed = await observe();
  assert.equal(completed.kind, "completed");
  if (completed.kind === "completed") assert.equal(completed.completion_text, "Original task complete.");
  snapshot.thread.id = "019ee559-7bb8-7fd1-970c-0f7b6978c450";
  assert.equal((await observe()).kind, "invalidated");
});
