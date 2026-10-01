import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { unmanagedTerminalBindingToken } from "../src/managed-session.js";
import {
  runHumanExplicitTerminalSend,
  type TerminalHumanExplicitSendCliPorts,
  type TerminalHumanExplicitSendDependencies
} from "../src/terminal-human-explicit-send-cli-adapter.js";
import type { TerminalCommandTarget } from
  "../src/terminal-command-cli-ports.js";
import type { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
import {
  terminalControlEvidence
} from "../src/terminal-control-ref.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION
} from "../src/callback-transport.js";
import { createCodexPaginatedTaskAnchor } from "../src/codex-paginated-task.js";
import { createTerminalActivityWatchAnchor, terminalUserExplicitFallbackWatchId } from "../src/terminal-watch-store.js";
import {
  assertCodexManagedSendHasLegacyHistory,
  codexPhysicalSendUsesPaginatedWatch,
  selectCodexUserExplicitSendWatchSource,
  terminalSendFallbackWatchPresentation
} from "../src/terminal-send-watch-policy.js";

test("managed Monitor refuses paginated zero-root history and preserves proven legacy support", () => {
  assert.equal(codexPhysicalSendUsesPaginatedWatch("0.158.0"), true);
  assert.equal(codexPhysicalSendUsesPaginatedWatch("0.159.0"), true);
  assert.equal(codexPhysicalSendUsesPaginatedWatch("0.159.2"), true);
  assert.equal(codexPhysicalSendUsesPaginatedWatch("0.155.1"), false);
  assert.equal(codexPhysicalSendUsesPaginatedWatch("0.157.1"), false);
  for (const agentVersion of ["0.159.3", "0.160.0", "1.0.0"]) {
    assert.equal(codexPhysicalSendUsesPaginatedWatch(agentVersion), true);
  }
  for (const agentVersion of ["0.157.0", "0.157.1", "0.158.0", "0.159.0", "0.159.2", "0.159.3", "0.160.0", "1.0.0"]) {
    assert.throws(() => assertCodexManagedSendHasLegacyHistory({
      agentVersion, verifiedLegacyRootCount: 0
    }), /No Turn was created and no task input was sent/u);
    assert.throws(() => assertCodexManagedSendHasLegacyHistory({
      agentVersion, verifiedLegacyRootCount: Number.NaN
    }));
    assert.doesNotThrow(() => assertCodexManagedSendHasLegacyHistory({
      agentVersion, verifiedLegacyRootCount: 1
    }));
  }
  assert.doesNotThrow(() => assertCodexManagedSendHasLegacyHistory({
    agentVersion: "0.155.1", verifiedLegacyRootCount: 0
  }));
});

test("paginated Codex Send cannot promise a future legacy rollout callback", () => {
  for (const agentVersion of ["0.157.0", "0.157.1", "0.158.0", "0.159.0", "0.159.2", "0.159.3", "0.160.0", "1.0.0"]) {
    const unavailable = selectCodexUserExplicitSendWatchSource({
      agentVersion,
      legacyRootCount: 0,
      paginatedAnchorAvailable: false
    });
    assert.equal(unavailable.source, "none");
    if (unavailable.source !== "none") assert.fail("callback source must be absent");
    assert.equal(unavailable.reasonCode, "codex_paginated_history_anchor_unavailable");
    assert.match(unavailable.warning, /no exact-task completion callback[\s\S]*best-effort terminal-activity Watch/u);
    assert.deepEqual(selectCodexUserExplicitSendWatchSource({
      agentVersion,
      legacyRootCount: 0,
      paginatedAnchorAvailable: true
    }), { source: "codex_paginated" });
    assert.deepEqual(selectCodexUserExplicitSendWatchSource({
      agentVersion,
      legacyRootCount: 1,
      paginatedAnchorAvailable: false
    }), { source: "codex_rollout" });
  }
  assert.deepEqual(selectCodexUserExplicitSendWatchSource({
    agentVersion: "0.155.1",
    legacyRootCount: 0,
    paginatedAnchorAvailable: false
  }), { source: "codex_rollout" });
});

test("Send receipt distinguishes exact callbacks, activity notifications, and no Watch", () => {
  const receipt = {
    callback_expected: true,
    callback_mode: "terminal_watch" as const,
    watch_id: "test-watch"
  };
  const exact = terminalSendFallbackWatchPresentation(receipt);
  assert.equal(exact.receiptFields.watch_mode, "exact_task");
  assert.equal(exact.receiptFields.confidence, "exact");
  assert.match(exact.summary, /native acceptance and completion/u);
  assert.match(exact.nextAction, /wait for Terminal Watch test-watch callback/u);
  for (const activityReceipt of [
    { ...receipt, watch_mode: "terminal_activity" as const },
    { ...receipt, confidence: "best_effort" as const }
  ]) {
    const activity = terminalSendFallbackWatchPresentation(activityReceipt);
    assert.equal(activity.callbackAvailable, true);
    assert.equal(activity.receiptFields.watch_mode, "terminal_activity");
    assert.equal(activity.receiptFields.confidence, "best_effort");
    assert.match(activity.summary, /cannot prove this request's exact completion/u);
    assert.match(activity.summary, /or answer native questions automatically/u);
    assert.match(activity.nextAction, /stable idle is not proof/u);
    assert.doesNotMatch(activity.nextAction, /wait for .* callback/u);
  }
  const absent = terminalSendFallbackWatchPresentation(undefined);
  assert.equal(absent.callbackAvailable, false);
  assert.deepEqual(absent.receiptFields, { callback_expected: false });
  assert.match(absent.summary, /No callback Watch/u);
});

test(
  "human-explicit Send never falls back after managed input may have started",
  async (t) => {
    const sandbox = fs.mkdtempSync(
      path.join(os.tmpdir(), "akk-human-explicit-send-")
    );
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
    const workspace = path.join(sandbox, "workspace");
    const runtimeDir = path.join(sandbox, "runtime");
    fs.mkdirSync(workspace, { recursive: true });
    const terminalControl = {
      kind: "tmux" as const,
      target: "human-explicit:0.0",
      session: "human-explicit",
      window: 0,
      pane: 0,
      panePid: 42,
      currentPath: workspace,
      capabilities: ["screen_status" as const, "send_keys" as const]
    };
    const terminal = {
      conversationId: "terminal:v2:tmux:codex:human-explicit:0.0:42",
      agent: "codex" as const,
      pid: 42,
      legacy: false,
      adapter: {},
      terminalControl
    } as unknown as TerminalCommandTarget;
    const processUuid = "11111111-1111-4111-8111-111111111111";
    const processBirth = "2026-09-15T00:00:00.000Z";
    const expectedTerminalToken = unmanagedTerminalBindingToken({
      terminalId: terminal.conversationId,
      terminalControl,
      agent: "codex",
      pid: 42,
      workspace,
      processUuid,
      processBirth
    });
    const accessedPorts: string[] = [];
    let managedAttempts = 0;
    const implemented = {
      required<Value>(value: Value | null | undefined, label: string): Value {
        if (value === undefined || value === null) throw new Error(label);
        return value;
      },
      assertExpectedHandoffTokenUsesExactTerminalSelector() {},
      processIncarnationForPid() {
        return { processUuid, processBirth, evidence: "process_birth" as const };
      },
      terminalBridgeRuntimeKey() {
        return "tmux:human-explicit:0.0:42";
      },
      terminalRuntimeForLiveIdentity() {
        return { agentVersion: "0.155.1", pid: 42 };
      }
    } satisfies Partial<TerminalHumanExplicitSendCliPorts>;
    const ports = new Proxy(implemented, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        accessedPorts.push(String(property));
        throw new Error(`unexpected port access: ${String(property)}`);
      }
    }) as unknown as TerminalHumanExplicitSendCliPorts;
    const dependencies: TerminalHumanExplicitSendDependencies = {
      ports,
      runtime: {
        env: () => ({ ...process.env, AKK_RUNTIME_DIR: runtimeDir }),
        now: () => new Date("2026-09-15T00:00:00.000Z"),
        log: () => {},
        printJson: () => {
          assert.fail("uncertain Send must not print a success receipt");
        },
        durableTerminalInputDispatched: () => false
      },
      managedSendAttempt: async (_options, _message, _terminal, _defer, attempt) => {
        managedAttempts += 1;
        attempt.terminalControlSendInvoked = true;
        throw new Error("input outcome unknown");
      }
    };

    await assert.rejects(
      runHumanExplicitTerminalSend(
        dependencies,
        {
          expectedTerminalToken,
          messageId: "message-possible-input"
        },
        "human request",
        terminal
      ),
      new RegExp(
        "managed terminal Send may already have started input; refusing an " +
        "automatic unmanaged fallback: input outcome unknown"
      )
    );
    assert.equal(managedAttempts, 1);
    assert.deepEqual(accessedPorts, []);
  }
);

for (const version of ["0.158.0", "0.159.0", "0.159.2", "0.159.3", "0.160.0", "1.0.0"] as const) {
  test(`Codex ${version} physical Send prepares paginated Watch before input and never attempts managed Send`, async (t) => {
    for (const callbackKind of ["exact", "activity", "unavailable", "unsafe"] as const) {
      const callbackAvailable = callbackKind === "exact" || callbackKind === "activity";
      await t.test(`${callbackKind} callback and same-ID replay safety`, async (nested) => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-paginated-physical-send-"));
        nested.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
        const workspace = path.join(sandbox, "workspace");
        const storeDir = path.join(sandbox, "store");
        const runtimeDir = path.join(sandbox, "runtime");
        fs.mkdirSync(workspace, { recursive: true });
        fs.mkdirSync(storeDir, { recursive: true });
        const terminalControl = {
          kind: "tmux" as const, target: "paginated:0.0", session: "paginated",
          window: 0, pane: 0, panePid: 4242, currentPath: workspace,
          capabilities: ["screen_status" as const, "send_keys" as const]
        };
        const terminal: TerminalCommandTarget = {
          conversationId: "terminal:v2:tmux:codex:paginated:0.0:4242",
          agent: "codex", pid: 4242, terminalControl
        };
        const processUuid = "codex-pid:4242:birth:exact-birth";
        const processBirth = "exact-birth";
        const expectedTerminalToken = unmanagedTerminalBindingToken({
          terminalId: terminal.conversationId, terminalControl, agent: "codex",
          pid: 4242, workspace, processUuid, processBirth
        });
        const events: string[] = [];
        const printed: Record<string, unknown>[] = [];
        const payload = "  native request";
        let managedAttempts = 0;
        let sends = 0;
        let watchId = "";
        const receipt = () => callbackAvailable ? {
          callback_expected: true as const, callback_mode: "terminal_watch" as const,
          watch_id: watchId,
          watch_mode: callbackKind === "activity" ? "terminal_activity" as const : "exact_task" as const,
          confidence: callbackKind === "activity" ? "best_effort" as const : "exact" as const
        } : undefined;
        const bridge = {
          async resolveConversationId() { return terminal; },
          async status() {
            return {
              reachable: true, activity_state: "idle",
              approval_state: { scanned: true, blocked: false },
              screen: { digest: "safe-screen" }
            };
          },
          async sendUserExplicit(
            _agent: unknown, control: unknown, text: string,
            options: { beforeMutationReservation: (value: unknown) => Promise<void> }
          ) {
            events.push("physical_send");
            sends += 1;
            assert.equal(text, payload);
            await options.beforeMutationReservation({ terminalControl: control });
            return { disposition: "replaced_current_composer" };
          }
        } as unknown as TerminalAgentBridge;
        const implemented = {
          required<Value>(value: Value | null | undefined, label: string): Value {
            if (value === undefined || value === null) throw new Error(label);
            return value;
          },
          assertExpectedHandoffTokenUsesExactTerminalSelector() {},
          processIncarnationForPid() {
            return { processUuid, processBirth, evidence: "process_birth" as const };
          },
          terminalBridgeRuntimeKey() { return "tmux:paginated:0.0:4242"; },
          terminalRuntimeForLiveIdentity() {
            return { agentVersion: version, pid: 4242 };
          },
          storeDirFromOptions() { return storeDir; },
          acquireTerminalBridgeSendLock() { return () => {}; },
          acquireFileLock() { return () => {}; },
          createTerminalAgentBridge() { return bridge; },
          loadTerminalBridgeDispatchLedger() { return undefined; },
          textSummary(text: unknown) { return { length: String(text).length, preview: String(text) }; },
          async prepareUserExplicitFallbackWatch(input) {
            events.push("prepare_watch");
            assert.equal(input.requestText, payload);
            if (callbackKind === "unsafe") throw Object.assign(new Error("Native status Enter outcome uncertain"), { doNotRetry: true });
            if (!callbackAvailable) throw new Error("Exact paginated reader unavailable");
            watchId = terminalUserExplicitFallbackWatchId({
              messageId: input.messageId, physicalToken: input.physicalToken,
              requestHash: input.requestHash
            });
            const terminalEndpoint = terminalControlEvidence(terminalControl);
            return {
              watchId, terminalId: terminal.conversationId, agent: "codex" as const,
              pid: 4242, terminalEndpoint,
              terminalIdentity: {
                terminal_id: terminal.conversationId, terminal_endpoint: terminalEndpoint,
                workspace, binding_token: input.physicalToken
              },
              physicalToken: input.physicalToken, requestHash: input.requestHash,
              callbackRoute: {
                schema: CALLBACK_ROUTE_SCHEMA, version: CALLBACK_ROUTE_VERSION,
                transport: "openclaw", profile_id: "fixture", profile_revision: "1",
                controller_session_id: "fixture-session"
              },
              openclawSession: "fixture-session", openclawBin: "openclaw", timeoutMs: 60_000,
              ...(callbackKind === "activity" ? { warnings: ["exact_task_anchor_unavailable: protocol unavailable; terminal_activity_fallback"] } : {}),
              anchor: callbackKind === "activity" ? createTerminalActivityWatchAnchor({
                capturedAt: new Date("2026-10-01T00:00:00.000Z"),
                terminalId: terminal.conversationId, pid: 4242, initialActivityState: "idle",
                nativeProcessUuid: processUuid, nativeProcessBirth: processBirth,
                origin: "user_explicit_send", requestHash: input.requestHash
              }) : createCodexPaginatedTaskAnchor({
                origin: "user_explicit_send", captured_at: "2026-10-01T00:00:00.000Z",
                codex_home: "/codex", codex_version: version,
                thread_cwd: workspace, thread_originator: "codex-tui",
                native_thread_id: "019ee559-7bb8-7fd1-970c-0f7b6978c44e",
                process_uuid: processUuid, process_birth: processBirth, pid: 4242,
                request_hash: input.requestHash
              })
            };
          },
          async attachUserExplicitFallbackWatch() {
            events.push("attach_watch");
            const value = receipt();
            assert.ok(value);
            return value;
          },
          userExplicitFallbackWatchReceipt() { return receipt(); }
        } satisfies Partial<TerminalHumanExplicitSendCliPorts>;
        const ports = new Proxy(implemented, {
          get(target, property, receiver) {
            if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
            throw new Error("Unexpected paginated Send port: " + String(property));
          }
        }) as unknown as TerminalHumanExplicitSendCliPorts;
        const dependencies: TerminalHumanExplicitSendDependencies = {
          ports,
          runtime: {
            env: () => ({ ...process.env, AKK_RUNTIME_DIR: runtimeDir }),
            now: () => new Date("2026-10-01T00:00:00.000Z"),
            log: () => {},
            printJson: (value) => { printed.push(value as Record<string, unknown>); },
            durableTerminalInputDispatched: () => false
          },
          managedSendAttempt: async () => {
            managedAttempts += 1;
            assert.fail("Paginated physical Send cannot enter the legacy managed path");
          }
        };
        const options = { expectedTerminalToken, messageId: "paginated-message", background: true };
        if (callbackKind === "unsafe") {
          await assert.rejects(() => runHumanExplicitTerminalSend(dependencies, options, payload, terminal), /Native status Enter outcome uncertain/u);
          assert.equal(sends, 0, "uncertain probe forbids subsequent task input");
          await assert.rejects(() => runHumanExplicitTerminalSend(dependencies, options, payload, terminal), /automatic replay is forbidden/u);
          assert.equal(sends, 0, "same-message reservation prevents replay after an uncertain probe");
          return;
        }
        await runHumanExplicitTerminalSend(dependencies, options, payload, terminal);
        assert.equal(managedAttempts, 0);
        assert.equal(sends, 1);
        assert.equal(printed[0]?.delivered, true);
        assert.equal(printed[0]?.callback_expected, callbackAvailable);
        assert.equal(events[0], "prepare_watch");
        assert.equal(events[1], "physical_send");
        if (callbackAvailable) {
          assert.equal(events[2], "attach_watch");
          assert.equal(printed[0]?.watch_mode, callbackKind === "activity" ? "terminal_activity" : "exact_task");
          assert.equal((printed[0]?.capabilities as Record<string, unknown>).interaction_respond, false);
          if (callbackKind === "activity") {
            assert.equal(printed[0]?.confidence, "best_effort");
            assert.match(JSON.stringify(printed[0]?.callback_warnings), /terminal_activity_fallback/u);
            assert.match(String(printed[0]?.next_action), /stable idle is not proof/u);
          }
        } else {
          assert.match(JSON.stringify(printed[0]?.callback_warnings), /reader unavailable/u);
          assert.doesNotMatch(String(printed[0]?.next_action), /wait for .* callback/u);
        }
        await runHumanExplicitTerminalSend(dependencies, options, payload, terminal);
        assert.equal(printed[1]?.replayed, true);
        assert.equal(printed[1]?.callback_expected, callbackAvailable);
        assert.equal(sends, 1);
        assert.equal(managedAttempts, 0);
      });
    }
  });

}
