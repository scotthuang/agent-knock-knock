import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runManagedRawTerminalSendAttempt,
  runManagedSessionSend,
  type TerminalManagedSendCliPorts,
  type TerminalManagedSendDependencies
} from "../src/terminal-managed-send-cli-adapter.js";
import type { TerminalCommandTarget } from
  "../src/terminal-command-cli-ports.js";
import { createFileLockCliAdapter } from "../src/file-lock-cli-adapter.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import { withStoreWriterLeaseAsync } from "../src/store.js";
import { terminalRuntimeResourceKey } from "../src/terminal-control-ref.js";

function dependencies(input: {
  ports?: Partial<TerminalManagedSendCliPorts>;
  events: string[];
}): TerminalManagedSendDependencies {
  const ports = new Proxy(input.ports ?? {}, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      input.events.push(`unexpected:${String(property)}`);
      throw new Error(`unexpected managed Send port ${String(property)}`);
    }
  }) as unknown as TerminalManagedSendCliPorts;
  return {
    ports,
    foregroundIdentificationAuthority: {
      clear: () => input.events.push("unexpected:foreground-clear"),
      current: () => undefined,
      remember: () => input.events.push("unexpected:foreground-remember"),
      assertCurrent: () => input.events.push("unexpected:foreground-assert")
    },
    replayExactActiveTerminalSubmission: () => {
      input.events.push("unexpected:replay");
      return false;
    },
    runTerminalControlSend: async () => {
      input.events.push("unexpected:terminal-input");
      throw new Error("terminal input must not start");
    },
    runtime: {
      now: () => new Date("2026-09-15T00:00:00.000Z")
    }
  };
}

const terminal = {
  conversationId: "terminal:v2:tmux:codex:managed-send:0.0:42",
  agent: "codex" as const,
  pid: 42,
  legacy: false,
  adapter: {},
  terminalControl: {
    kind: "tmux" as const,
    target: "managed-send:0.0",
    session: "managed-send",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: ["screen_status" as const, "send_keys" as const]
  }
} as unknown as TerminalCommandTarget;

test("managed Session Send rejects terminal authority before ports or input", async () => {
  const events: string[] = [];
  await assert.rejects(
    runManagedSessionSend(
      dependencies({ events }),
      { expectedTerminalToken: "terminal-authority" },
      "task"
    ),
    /--expected-terminal-token cannot be used with a managed Session/u
  );
  assert.deepEqual(events, []);
});

test("managed raw Send rejects non-background delivery before locks or input", async () => {
  const events: string[] = [];
  const attempt = { terminalControlSendInvoked: false };
  await assert.rejects(
    runManagedRawTerminalSendAttempt(
      dependencies({
        events,
        ports: {
          assertExpectedHandoffTokenUsesExactTerminalSelector: () => {
            events.push("selector");
          }
        }
      }),
      {},
      "task",
      terminal,
      false,
      attempt
    ),
    /raw terminal sends require --background/u
  );
  assert.deepEqual(events, ["selector"]);
  assert.equal(attempt.terminalControlSendInvoked, false);
});

test("routed Claude first attachment reaches exclusive ownership without bypassing binding conflicts or legacy authority", async t => {
  const identity = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    processUuid: "claude-process",
    processBirth: "Tue Sep 15 00:00:00 2026",
    evidence: "claude_native_registry"
  };
  const claudeTerminal = {
    ...terminal,
    agent: "claude" as const,
    conversationId: "terminal:v2:tmux:claude:managed-send:0.0:42"
  };
  const ownershipFailure = new Error("native thread already has another live owner");
  for (const scenario of [
    { name: "new managed attachment", routed: true, claimed: false, reachesOwnership: true },
    { name: "conflicting managed binding", routed: true, claimed: true, reachesOwnership: false },
    { name: "legacy physical authority", routed: false, claimed: false, reachesOwnership: false }
  ]) {
    await t.test(scenario.name, async () => {
      const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-managed-attach-")));
      const storeDir = path.join(directory, "store");
      const terminalLock = path.join(directory, "terminal.lock");
      const events: string[] = [];
      const locks = createFileLockCliAdapter({
        now: () => new Date(), nowMs: Date.now, pid: () => process.pid,
        sleepSync: () => { throw new Error("isolated owner fixture must not contend"); }
      });
      const observedAt = "2026-09-15T00:00:00.000Z";
      const claimedSession: ManagedSessionState | undefined = scenario.claimed ? {
        schema: "agent-knock-knock/session", version: 1,
        session_id: "conflicting-session", status: "bound", agent: "claude", workspace: "/workspace/project",
        binding: {
          binding_id: "conflicting-binding", generation: 1,
          terminal_id: claudeTerminal.conversationId, terminal_control: claudeTerminal.terminalControl,
          native_thread_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          native_process: { pid: 42, evidence: identity.evidence },
          bound_at: observedAt, last_verified_at: observedAt
        },
        lineage: { created_by: "attach" }, created_at: observedAt, updated_at: observedAt
      } : undefined;
      const dependency = dependencies({ events, ports: {
        assertExpectedHandoffTokenUsesExactTerminalSelector: () => {},
        storeDirFromOptions: () => storeDir,
        terminalWriterMutationLocks: () => ({
          resources: {
            terminal: { key: terminalRuntimeResourceKey(claudeTerminal.terminalControl), value: claudeTerminal.terminalControl },
            storeWriter: { key: storeDir, value: storeDir }
          },
          acquireTerminal: () => locks.acquire(terminalLock),
          withStoreWriter: operation => withStoreWriterLeaseAsync(storeDir, operation)
        }),
        mutationDispatchLedger: {
          load: () => undefined, save: () => {}, resolve: () => false,
          beforeMutation: async () => {}
        },
        terminalList: {
          assertTerminalIncarnationCanStartTurn: () => {},
          resolveTerminalScopedCodexApproval: async () => { throw new Error("unexpected Codex approval"); }
        },
        soleBoundManagedSessionClaimForTerminal: () => claimedSession,
        codexAllowedCompanionSetForManagedSession: () => ({ additional: [] }),
        observeCurrentNativeAgentSessionIdentity: async () => ({ status: "resolved", identity }),
        maybeDetachVerifiedEmptyCodexSource: async () => undefined,
        maybeAdoptObservedExternalThread: async () => ({ identity, adopted: false }),
        prepareDeferredCodexForegroundBinding: async () => undefined,
        bindingMatchesLiveTerminal: () => { events.push("binding-conflict"); return false; },
        materializeCurrentManagedSession: () => { events.push("materialize"); return undefined; },
        reattachManagedSessionForNativeIdentity: async () => undefined,
        assertNativeThreadHasExclusiveOwnership: async request => {
          assert.equal(request.nativeThreadId, identity.sessionId);
          assert.equal(request.agent, "claude");
          assert.equal(fs.existsSync(terminalLock), true);
          assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), true);
          events.push("exclusive-ownership");
          throw ownershipFailure;
        }
      } });
      dependency.foregroundIdentificationAuthority.clear = () => {};
      dependency.replayExactActiveTerminalSubmission = () => false;
      const attempt = { terminalControlSendInvoked: false };
      try {
        await assert.rejects(runManagedRawTerminalSendAttempt(dependency, {
          background: true, expectedTerminalToken: "managed-snapshot",
          ...(scenario.routed ? { routingRequireManagedTurn: true } : {})
        }, "task", claudeTerminal, false, attempt), error => scenario.reachesOwnership
          ? error === ownershipFailure
          : error instanceof Error && /managed continuation authority is unavailable/u.test(error.message));
        assert.deepEqual(events, scenario.reachesOwnership
          ? ["materialize", "exclusive-ownership"]
          : scenario.claimed ? ["binding-conflict"] : []);
        assert.equal(attempt.terminalControlSendInvoked, false);
        assert.equal(fs.existsSync(terminalLock), false);
        assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
