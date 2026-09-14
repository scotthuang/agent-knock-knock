import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  prepareTerminalControlSend,
  type PreparedTerminalControlSend,
  type TerminalDispatchPreparationPorts
} from "../src/terminal-command-dispatch-preparation.js";
import type { TerminalAgentBridge } from
  "../src/terminal-agent-bridge.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import {
  terminalDispatchStateResourceForStore
} from "../src/terminal-dispatch-capability.js";
import type { TerminalControlSendRequest } from
  "../src/terminal-dispatch-composition.js";
import type { TerminalDispatchExecutionService } from
  "../src/terminal-dispatch-execution.js";
import { terminalRuntimeResourceKey } from
  "../src/terminal-control-ref.js";
import {
  canonicalMutationResource,
  withCanonicalMutationLocks
} from "../src/mutation-transaction.js";
import {
  createConversation,
  createMessage
} from "../src/protocol.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "demo:0.0",
  session: "demo",
  window: 0,
  pane: 0,
  panePid: 42,
  currentPath: "/private/tmp",
  capabilities: ["screen_status", "send_keys"]
};

async function runFixture(input: {
  assertSafe?: () => void;
} = {}): Promise<{ result?: PreparedTerminalControlSend; trace: string[] }> {
  const trace: string[] = [];
  const storeDir = path.resolve("/private/tmp/akk-dispatch-preparation-store");
  const conversation = {
    ...createConversation({
      userRequest: "hello",
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      executorSession: "codex",
      workspace: "/private/tmp",
      now: new Date("2026-09-15T00:00:00.000Z")
    }),
    native_session_takeover: {
      terminal_agent_pid: 42
    }
  };
  const message = createMessage({
    conversation,
    id: "message-1",
    from: "openclaw",
    to: "codex",
    type: "task",
    body: "hello"
  });
  const bridge = {
    status: async () => {
      trace.push("status");
      return {
        reachable: true,
        activity_state: "idle",
        activity_reason: "fixture idle",
        approval_state: { scanned: true, blocked: false, approvable: false },
        screen: { excerpt: "idle", digest: "screen-1" }
      };
    }
  } as unknown as TerminalAgentBridge;
  const execution = {
    preflightRequiresOwner: () => {
      trace.push("preflight-owner");
      return false;
    },
    evaluatePreflight: () => {
      trace.push("preflight-decision");
      return { action: "proceed" };
    },
    resolveCurrentNativeIdentity: async () => {
      trace.push("native-identity");
      return undefined;
    },
    assertTurnIdentity: () => trace.push("turn-identity")
  } as unknown as TerminalDispatchExecutionService;
  const ports: TerminalDispatchPreparationPorts = {
    assertCodexComposerReadyForAutomatedInput: async () => {
      trace.push("composer");
    },
    assertNoUnresolvedTerminalBridgeSubmission: () => {
      trace.push("unresolved-dispatch");
    },
    assertSafeTerminalSend: () => {
      trace.push("safe-terminal");
      input.assertSafe?.();
    },
    createRegistry: () => {
      throw new Error("registry must remain lazy");
    },
    createTerminalBridge: () => {
      trace.push("bridge");
      return bridge;
    },
    execution: () => {
      trace.push("execution");
      return execution;
    },
    foregroundProofs: {
      clear: () => undefined,
      current: () => undefined,
      remember: () => undefined,
      assertCurrent: () => trace.push("foreground-proof")
    },
    loadClaudeAgentRows: () => [],
    loadDispatchLedger: () => {
      trace.push("load-ledger");
      return undefined;
    },
    loadDispatchOwner: () => undefined,
    now: () => new Date("2026-09-15T00:00:01.000Z"),
    positiveMinutes: (value) => Number(value),
    reconcilePreparedLedger: (_control, ledger) => {
      trace.push("reconcile-ledger");
      return ledger;
    },
    requestFingerprint: () => "request-hash",
    required: (value, label) => {
      if (value === undefined || value === null) throw new Error(label);
      return value;
    },
    resolveLedgerPaneIncarnation: (_control, ledger) => ledger,
    terminalBridgeEnabled: () => false,
    terminalRuntimeForLiveIdentity: () => {
      throw new Error("physical runtime must remain lazy");
    },
    terminalRuntimeIdentityForConversation: () => {
      trace.push("runtime");
      return { pid: 42, cwd: "/private/tmp" };
    },
    presentation: {
      write: () => undefined,
      budget: () => undefined,
      nextAction: () => undefined,
      summarize: () => undefined
    }
  };
  const state = terminalDispatchStateResourceForStore(
    storeDir,
    path.join(storeDir, "conversations", "turn-1", "state.json"),
    path.join(storeDir, "conversations", "turn-1", "events.ndjson")
  );
  const resources = Object.freeze({
    terminal: canonicalMutationResource(
      terminalRuntimeResourceKey(CONTROL),
      CONTROL
    ),
    storeWriter: canonicalMutationResource(storeDir, storeDir),
    state
  });
  let result: PreparedTerminalControlSend | undefined;
  await withCanonicalMutationLocks({
    resources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: (operation) => operation(),
    acquireState: () => () => undefined
  }, async (scopes, lockedResources) => {
    const request: TerminalControlSendRequest = {
      transaction: { scopes, resources: lockedResources },
      options: {},
      conversation,
      nextConversation: conversation,
      executor: conversation.executor,
      message
    };
    result = await prepareTerminalControlSend(request, ports, {
      agentTimeoutMinutes: 60,
      agentHardTimeoutMinutes: 720,
      ordinaryScrollbackLines: 120,
      foregroundScrollbackLines: 240
    });
  });
  return { result, trace };
}

test("dispatch preparation observes one route and performs no terminal input", async () => {
  const { result, trace } = await runFixture();
  assert.equal(result?.terminalControl, CONTROL);
  assert.equal(result?.terminalRequestHash, "request-hash");
  assert.equal(result?.bridgeStartedAt, "2026-09-15T00:00:01.000Z");
  assert.deepEqual(trace, [
    "bridge",
    "execution",
    "load-ledger",
    "reconcile-ledger",
    "preflight-owner",
    "preflight-decision",
    "native-identity",
    "turn-identity",
    "runtime",
    "status",
    "foreground-proof",
    "safe-terminal"
  ]);
});

test("dispatch preparation preserves the verified-idle error boundary", async () => {
  await assert.rejects(
    runFixture({ assertSafe: () => { throw new Error("fixture blocked"); } }),
    /refusing to send to Codex without a verified idle terminal: fixture blocked/u
  );
});
