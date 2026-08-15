import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createTerminalIdentityAuthorityCliAdapter,
  type CreateTerminalIdentityAuthorityCliAdapterInput
} from "../src/terminal-identity-authority-cli-adapter.js";
import {
  codexCompanionSet,
  exactLifecycleIdentity,
  verifiedEmptySourceSnapshotMatches
} from "../src/terminal-identity-authority-service.js";
import { StaticTerminalProcessSource } from
  "../src/terminal-process-source.js";

function adapter(
  environment: Partial<
    CreateTerminalIdentityAuthorityCliAdapterInput["environment"]
  > = {}
) {
  const unexpected = (): never => {
    throw new Error("unexpected identity adapter port call");
  };
  const ports: CreateTerminalIdentityAuthorityCliAdapterInput = {
    runtime: {
      createBridge: unexpected,
      createControlProvider: unexpected,
      createProcessSource: () => new StaticTerminalProcessSource([]),
      requiresExactBoundCodexCompletion: () => false,
      runtimeIdentity: unexpected,
      durableRequest: unexpected,
      observeNativeIdentity: async () => ({
        status: "verified_absent",
        evidence: "native_identity_resolver_verified_absent"
      }),
      probeCodexCurrentThread: async () => unexpected()
    },
    store: {
      terminalControlFromTakeover: () => undefined,
      storeDir: () => "/tmp/identity-store",
      storeDirForConversation: () => undefined,
      turnsForSession: () => [],
      turnMatchesTerminal: () => false,
      isDiscoverableTurn: () => false,
      readEvents: () => [],
      loadLedger: () => undefined,
      ledgerMatchesControl: () => false,
      ledgerProcessAnchor: () => undefined
    },
    authority: {
      assertTurnBindingCurrent: unexpected,
      assertManagedSessionCanStartTurn: unexpected,
      assertNativeThreadHasExclusiveOwnership: async () => unexpected(),
      assertSafeTerminalSend: unexpected,
      assertTerminalLifecycleReady: unexpected,
      provisionalManagedBindingTurnCount: () => undefined,
      managedTurnNeedsAttention: () => false,
      hasUnresolvedNativeTransition: () => false,
      hasAnyNativeTransition: () => false
    },
    environment: {
      cwd: () => "/tmp/identity-workspace",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      isProcessAlive: () => true,
      workspaceMatches: () => true,
      ...environment
    }
  };
  assert.deepEqual(Object.keys(ports).sort(), [
    "authority", "environment", "runtime", "store"
  ]);
  return createTerminalIdentityAuthorityCliAdapter(ports);
}

test("identity facts preserve lifecycle fallback and malformed fail-closed rules", () => {
  assert.deepEqual(exactLifecycleIdentity({
    agent: "codex",
    pid: 41,
    identity: { sessionId: "native-41", evidence: "status_card" },
    codexIncarnation: {
      processUuid: "codex-pid:41:birth:first",
      processBirth: "first"
    }
  }), {
    sessionId: "native-41",
    evidence: "status_card",
    processBirth: "first",
    processUuid: "codex-pid:41:birth:first"
  });
  assert.throws(() => exactLifecycleIdentity({
    agent: "claude",
    pid: 42,
    identity: { sessionId: "native-42", evidence: "agents_json" }
  }), /Claude lifecycle process incarnation is unavailable for pid 42/u);
  assert.equal(verifiedEmptySourceSnapshotMatches({
    expectedStatus: "detached",
    currentStatus: "detached",
    expectedRevision: 3,
    currentRevision: 4,
    expectedBindingToken: "binding-a",
    currentBindingToken: "binding-a"
  }), false);
});

test("companion selection keeps the primary fence and deterministic uniqueness", () => {
  const first = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    processUuid: "codex-pid:51:birth:one",
    processBirth: "one",
    rollout: { fd: "7", device: "1", inode: "2", path: "/tmp/one" }
  };
  const second = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    processUuid: "codex-pid:51:birth:one",
    processBirth: "one",
    rollout: { fd: "8", device: "1", inode: "3", path: "/tmp/two" }
  };
  assert.deepEqual(codexCompanionSet({
    primary: first,
    candidates: [first, second, second]
  }), { primary: first, additional: [second] });
});

test("process-birth lookup stays lazy and async-execution isolated", async () => {
  const first = adapter();
  const second = adapter();
  const trace: string[] = [];
  assert.equal(Object.isFrozen(first), true);

  const [left, right] = await Promise.all([
    runCliCommandExecution("identity-left", {}, {
      codexProcessBirthForPid: (pid) => {
        trace.push(`left:${pid}`);
        return "left-birth";
      }
    }, async () => {
      assert.deepEqual(first.codexProcessIncarnationForPid(71), {
        processUuid: "codex-pid:71:birth:left-birth",
        processBirth: "left-birth",
        evidence: "codex_process_birth"
      });
    }),
    runCliCommandExecution("identity-right", {}, {
      codexProcessBirthForPid: (pid) => {
        trace.push(`right:${pid}`);
        return "right-birth";
      }
    }, async () => {
      assert.deepEqual(second.codexProcessIncarnationForPid(72), {
        processUuid: "codex-pid:72:birth:right-birth",
        processBirth: "right-birth",
        evidence: "codex_process_birth"
      });
    })
  ]);
  assert.deepEqual(left, { exitCode: 0, stdout: "" });
  assert.deepEqual(right, { exitCode: 0, stdout: "" });
  assert.deepEqual(trace.sort(), ["left:71", "right:72"]);

  trace.length = 0;
  await runCliCommandExecution("identity-lazy", {}, {
    codexProcessBirthForPid: (pid) => {
      trace.push(`unexpected:${pid}`);
      return "unused";
    }
  }, async () => {
    assert.deepEqual(first.exactLifecycleProcessIdentity({
      conversationId: "codex-terminal:73",
      agent: "codex",
      pid: 73,
      legacy: false,
      terminalControl: {
        kind: "tmux",
        target: "work:0.0",
        panePid: 73
      }
    } as never, {
      sessionId: "native-73",
      processBirth: "stored-birth",
      evidence: "status_card"
    }), {
      sessionId: "native-73",
      processBirth: "stored-birth",
      processUuid: "codex-pid:73:birth:stored-birth",
      evidence: "status_card"
    });
  });
  assert.deepEqual(trace, []);
});

test("the data-only identity service has no infrastructure authority", () => {
  const source = fs.readFileSync(
    path.resolve("src/terminal-identity-authority-service.ts"),
    "utf8"
  );
  for (const forbidden of [
    "node:fs",
    "node:path",
    "JSON.parse",
    "ManagedSessionState",
    "ResolvedTerminalConversation",
    "TerminalProcessSource",
    "Record<string, any>",
    "lock"
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
