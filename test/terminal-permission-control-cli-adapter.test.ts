import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalPermissionControlCliAdapter,
  type TerminalPermissionControlCliPorts
} from "../src/terminal-permission-control-cli-adapter.js";
import {
  terminalPermissionControlBindingToken,
  terminalPermissionControlProfileFor
} from "../src/terminal-permission-control.js";
import {
  terminalPermissionControlAvailability,
  type TerminalPermissionControlSafetyFacts
} from "../src/terminal-permission-control-availability.js";
import {
  renderTerminalPermissionControlActions,
  withoutInspectionActionsDuringNativeTransition
} from "../src/terminal-list-renderer.js";
import {
  createTerminalEndpointRef,
  tmuxTerminalRouteKey,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import type { TerminalRuntimeCliAdapter } from "../src/terminal-runtime-cli-adapter.js";

const control: TerminalControlRef = {
  kind: "herdr", target: "default:w1:p4", socketPath: "/tmp/herdr.sock",
  session: "default", sessionDir: "/tmp/herdr-session",
  workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-4",
  terminalId: "pty-4", panePid: 41, currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys"]
};
const terminalId = "terminal:v2:herdr:codex:default:w1:p4:42";
const profile = terminalPermissionControlProfileFor("0.159.2")!;
const fingerprint = "a".repeat(64);
const incarnation = { processUuid: "process-uuid", processBirth: "process-birth" };

function bindingToken(terminalControl = control) {
  return terminalPermissionControlBindingToken({
    terminalId, terminalControl, pid: 42, workspace: "/workspace/project",
    ...incarnation, agentVersion: profile.agentVersion,
    behaviorProfile: profile.behaviorProfile
  });
}

function fixture() {
  const events: string[] = [];
  const output: unknown[] = [];
  const terminal = {
    conversationId: terminalId, agent: "codex", pid: 42,
    legacy: false, terminalControl: control
  } as ResolvedTerminalConversation;
  let processBirth = incarnation.processBirth;
  let currentVersion = profile.agentVersion;
  let blocked = false;
  let statusWorking = false;
  let beforeDomainInput: (() => void) | undefined;
  let outcome: "changed" | "uncertain" = "changed";
  const bridge = {
    resolveStoredTerminal: async () => { events.push("resolve"); return terminal; },
    status: async () => ({
      reachable: true, activity_state: statusWorking ? "working" : "idle",
      approval_state: { scanned: true, blocked: false }
    }),
    permissionOptions: async (_control, _version, options) => {
      events.push("query");
      beforeDomainInput?.();
      await options.beforeInput();
      events.push("query-input");
      return {
        agent: "codex", agentVersion: profile.agentVersion,
        behaviorProfile: profile.behaviorProfile, scope: "current_session",
        current: "read-only", choices: [
          { id: "read-only", label: "Read Only", description: "Read only", requiresConfirmation: false },
          { id: "full-access", label: "Full Access", description: "Full access", requiresConfirmation: true }
        ], catalogFingerprint: fingerprint
      };
    },
    setPermissions: async (_control, _version, mode, offered, options) => {
      events.push("set");
      assert.equal(offered, fingerprint);
      beforeDomainInput?.();
      await options.beforeInput();
      events.push("set-input");
      return {
        outcome, requested: { mode }, scope: "current_session",
        defaultsChanged: false, doNotRetry: outcome === "uncertain",
        ...(outcome === "changed" ? { effective: { mode } } : { reason: "postcondition unavailable" })
      };
    }
  } as unknown as TerminalAgentBridge;
  const ports: TerminalPermissionControlCliPorts = {
    runtime: {
      forOptions: () => ({
        createBridge: () => bridge,
        agentVersionForRunningProcess: () => currentVersion
      }) as unknown as TerminalRuntimeCliAdapter,
      physicalProcessIncarnation: () => ({ ...incarnation, processBirth }),
      physicalRuntime: () => ({ pid: 42, cwd: control.currentPath, terminalTarget: control.target })
    },
    lifecycle: {
      resolveLifecycleTerminal: async () => { events.push("discover"); return terminal; },
      assertSameInspectionTerminal: (expected, actual) => assert.equal(actual, expected),
      assertInspectionReady: ({ terminalStatus }) => {
        if (blocked) throw new Error("unresolved Turn");
        if (terminalStatus && terminalStatus.activity_state !== "idle") throw new Error("not idle");
      },
      assertForegroundHasNoLifecycleTransition: () => events.push("transition-check")
    },
    state: {
      storeDir: () => "/tmp/permission-test-store",
      inspectStore: () => ({ writable: true }),
      acquireTerminal: () => { events.push("lock"); return () => { events.push("unlock"); }; }
    },
    output: { print: (value) => output.push(value) }
  };
  return {
    app: createTerminalPermissionControlCliAdapter(ports), events, output,
    mutateBeforeInput: (callback: () => void) => { beforeDomainInput = callback; },
    replaceProcess: () => { processBirth = "replacement-process"; },
    replaceVersion: () => { currentVersion = "0.159.3"; },
    block: () => { blocked = true; },
    work: () => { statusWorking = true; },
    uncertain: () => { outcome = "uncertain"; }
  };
}

test("permission CLI queries a physical pane under lock and returns one scoped private offer", async () => {
  const subject = fixture();
  await subject.app.runPermissionOptions({ terminal: terminalId, expectedBindingToken: bindingToken() });
  const result = subject.output[0] as Record<string, any>;
  assert.equal(result.current, "read-only");
  assert.equal(result.scope, "current_session");
  assert.equal(result.choices[1].requires_confirmation, true);
  assert.deepEqual(result.available_actions.set_permissions.arguments, {
    terminal_id: terminalId, expected_binding_token: bindingToken(),
    expected_catalog_fingerprint: fingerprint
  });
  assert.ok(subject.events.indexOf("lock") < subject.events.indexOf("query-input"));
  assert.equal(subject.events.at(-1), "unlock");
});

test("permission CLI rejects raw commands and stale authority before native input", async () => {
  for (const options of [
    { expectedBindingToken: bindingToken(), command: "/permissions" },
    { expectedBindingToken: bindingToken(), keys: ["Enter"] },
    { expectedBindingToken: "stale-binding" }
  ]) {
    const subject = fixture();
    await assert.rejects(subject.app.runPermissionOptions({ terminal: terminalId, ...options }));
    assert.ok(!subject.events.includes("query-input"));
  }
});

test("permission CLI revalidates process, version and Turn ownership before native input", async () => {
  for (const change of ["replaceProcess", "replaceVersion", "block"] as const) {
    const subject = fixture();
    subject.mutateBeforeInput(subject[change]);
    await assert.rejects(subject.app.runPermissionOptions({ terminal: terminalId, expectedBindingToken: bindingToken() }));
    assert.ok(!subject.events.includes("query-input"));
    assert.equal(subject.events.at(-1), "unlock");
  }
  const working = fixture();
  working.work();
  await assert.rejects(working.app.runPermissionOptions({ terminal: terminalId, expectedBindingToken: bindingToken() }), /not idle/u);
  assert.ok(!working.events.includes("query"));
});

test("permission set reports proven state or uncertainty without retrying", async () => {
  for (const uncertain of [false, true]) {
    const subject = fixture();
    if (uncertain) subject.uncertain();
    await subject.app.runSetPermissions({
      terminal: terminalId, expectedBindingToken: bindingToken(),
      expectedCatalogFingerprint: fingerprint, mode: "full-access"
    });
    const result = subject.output[0] as Record<string, unknown>;
    assert.equal(result.outcome, uncertain ? "uncertain" : "changed");
    assert.equal(result.do_not_retry, uncertain);
    assert.equal(result.defaults_changed, false);
    assert.equal(subject.events.filter((event) => event === "set-input").length, 1);
    assert.equal(subject.events.at(-1), "unlock");
  }
});

function safetyFacts(overrides: Partial<TerminalPermissionControlSafetyFacts> = {}): TerminalPermissionControlSafetyFacts {
  return {
    exactTerminalRow: true, terminalId, processState: "active", agent: "codex",
    pid: 42, terminalControl: control, ...incarnation, agentVersion: profile.agentVersion,
    approvalScanned: true, approvalBlocked: false, terminalHasInteraction: false,
    terminalHasBlockingTurn: false, hasOrphanedDispatch: false,
    inputOwnerBlocked: false, exactEmptyComposer: true, screenState: "idle",
    activityState: "idle", ...overrides
  };
}

test("permission discovery requires exact physical and UI authority on Herdr and tmux", () => {
  const tmux: TerminalControlRef = {
    kind: "tmux", target: "work:0.0", session: "work", window: 0, pane: 0,
    panePid: 41, currentPath: "/workspace/project", capabilities: ["screen_status", "send_keys"]
  };
  createTerminalEndpointRef({
    identity: { providerKind: "tmux", endpointKey: "socket:/tmp/permission-tmux", resourceKey: "pane-id:%1" },
    route: { routeKey: tmuxTerminalRouteKey("socket:/tmp/permission-tmux", "work:0.0"), label: "work:0.0" },
    processAnchorPid: 41, capabilities: tmux.capabilities, providerRef: tmux
  });
  for (const terminalControl of [control, tmux]) {
    assert.equal(terminalPermissionControlAvailability(safetyFacts({
      terminalControl,
      terminalId: terminalControl.kind === "tmux"
        ? "terminal:v2:tmux:codex:work:0.0:42"
        : terminalId
    })).available, true);
  }
  const unsafe: Partial<TerminalPermissionControlSafetyFacts>[] = [
    { agent: "claude" }, { agentVersion: "0.170.0" }, { processBirth: undefined },
    { approvalScanned: false }, { approvalBlocked: true }, { terminalHasInteraction: true },
    { terminalHasBlockingTurn: true }, { hasOrphanedDispatch: true },
    { inputOwnerBlocked: true }, { exactEmptyComposer: false },
    { screenState: "working" }, { activityState: "unknown" }
  ];
  for (const item of unsafe) {
    assert.equal(terminalPermissionControlAvailability(safetyFacts(item)).available, false);
  }
  const actions = renderTerminalPermissionControlActions({
    renderedActions: {}, availability: terminalPermissionControlAvailability(safetyFacts())
  });
  assert.ok(actions.permission_options);
  assert.equal(actions.set_permissions, undefined);
  assert.equal(withoutInspectionActionsDuringNativeTransition(actions).permission_options, undefined);
});
