import { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  executeCliCommand,
  parseCliCommand,
  type CliCommandDependencies
} from "../../src/cli-core.js";
import type {
  CodexLocalSessionAdapter
} from "../../src/codex-local-session-provider.js";
import type {
  CodexOpenRootRolloutInventory
} from "../../src/agent-session-provider.js";
import {
  inspectCodexOpenRootRolloutInventory
} from "../../src/codex-store-adapter.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../../src/managed-session.js";
import {
  createDeferredForegroundTransferId,
  DEFERRED_FOREGROUND_TRANSFER_SCHEMA,
  DEFERRED_FOREGROUND_TRANSFER_VERSION,
  listDeferredForegroundTransfers,
  saveDeferredForegroundTransfer,
  pathsForDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../../src/deferred-foreground-transfer.js";
import {
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  pathsForManagedSession,
  saveManagedSession,
  saveNativeThreadTransition
} from "../../src/session-store.js";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  saveState
} from "../../src/store.js";
import { createConversation } from "../../src/protocol.js";
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider,
  type CommandResult
} from "../../src/terminal-control-provider.js";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  type HerdrWireRequest
} from "../../src/herdr-terminal-control-provider.js";
import { StaticTerminalProcessSource } from "../../src/terminal-process-source.js";
import type {
  TerminalControlRef,
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken
} from "../../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  tmuxTerminalRouteKey
} from "../../src/terminal-control-ref.js";
import {
  codexNativeAcceptanceEnv,
  codexNoRolloutBackgroundSendArgs,
  codexNoRolloutManagedStateMachineArgs,
  codexNoRolloutStoreArgs
} from "./codex-no-rollout-cli-harness.js";

const binPath = new URL("../../src/cli.js", import.meta.url).pathname;
const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";
const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";
const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const EXTERNAL_THREAD_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_EXTERNAL_THREAD_ID = "33333333-3333-4333-8333-333333333333";
const FIRST_NATIVE_TURN_ID = "44444444-4444-4444-8444-444444444444";
const FIXTURE_TMUX_PANE_ID = "%42";
const SIMULATED_DEAD_CLI_PID = 2_147_483_647;
const CODEX_TEST_COMPOSER_FOOTER = "gpt-5.6-sol high · /repo";

function codexTestComposerScreen(text = ""): string {
  const [first = "", ...continuation] = text.split("\n");
  return [
    "Ready",
    `› ${first}`,
    ...continuation.map((row) => `  ${row}`),
    CODEX_TEST_COMPOSER_FOOTER
  ].join("\n");
}

export interface CodexNoRolloutTestDefinition {
  readonly name: string;
  readonly body: (context: TestContext) => void | Promise<void>;
}

const declaredTests: CodexNoRolloutTestDefinition[] = [];

export function test(
  name: string,
  body: (context: TestContext) => void | Promise<void>
): void {
  declaredTests.push({ name, body });
}

export function codexNoRolloutTestDefinitions(
): readonly CodexNoRolloutTestDefinition[] {
  return declaredTests;
}

interface NoRolloutFixture {
  tempDir: string;
  storeDir: string;
  codexHome: string;
  rolloutPath: string;
  materializedPath: string;
  rolloutProbeCountPath: string;
  screenPath: string;
  processBirthPath: string;
  tmuxCallsPath: string;
  target: string;
  inputTarget: string;
  terminalId: string;
  terminalControl: TerminalControlRef;
  codexPid: number;
  cliPid?: number;
  clockMs: number;
  codexVersion: "0.146.0" | "0.147.0";
  terminalKind: "tmux" | "herdr";
  persistedCandidate: boolean;
  rolloutInitiallyAbsent: boolean;
  materializeRolloutOnProbe?: number;
  appendAcceptanceOnProbe?: number;
  deferredAcceptanceRequest?: string;
  identityObservationError?: string;
  openRootRollouts?: Array<{
    nativeThreadId: string;
    rolloutPath: string;
    fd: string;
  }>;
  acceptanceNativeThreadIdsOnEnter?: string[];
  additionalOpenRootNativeThreadIdsOnEnter?: string[];
  activeNativeThreadId: string;
  activeRolloutPath: string;
  viewportColumns: number | null;
  viewportRows: number;
  viewportZoomed: boolean;
  viewportPaneFocused: boolean;
  viewportFocusedPaneId?: string;
  viewportAreaColumns?: number;
  viewportAreaRows?: number;
  ttyViewportColumns: number | null;
  ttyViewportRows: number;
  ttyViewportInspectionPids: number[];
  runtimeLogs: Array<{
    level: "debug" | "info" | "warn" | "error";
    event: string;
    fields: Record<string, unknown>;
  }>;
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createNoRolloutFixture(
  {
    codexVersion = "0.146.0",
    materializeRolloutOnProbe,
    persistedCandidate = false,
    rolloutInitiallyAbsent = false,
    terminalKind = "tmux",
    viewportColumns = 100,
    viewportZoomed = false,
    viewportPaneFocused = true,
    viewportFocusedPaneId,
    viewportAreaColumns,
    viewportAreaRows = 40,
    ttyViewportColumns,
    ttyViewportRows
  }: {
    codexVersion?: "0.146.0" | "0.147.0";
    materializeRolloutOnProbe?: number;
    persistedCandidate?: boolean;
    rolloutInitiallyAbsent?: boolean;
    terminalKind?: "tmux" | "herdr";
    /** `null` simulates a provider that cannot prove exact viewport geometry. */
    viewportColumns?: number | null;
    viewportZoomed?: boolean;
    viewportPaneFocused?: boolean;
    viewportFocusedPaneId?: string;
    viewportAreaColumns?: number;
    viewportAreaRows?: number;
    ttyViewportColumns?: number | null;
    ttyViewportRows?: number;
  } = {}
): NoRolloutFixture {
  const tempDir = fs.mkdtempSync(path.join(
    fs.realpathSync(os.tmpdir()),
    "akk-codex-birth-"
  ));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const pendingInputPath = path.join(tempDir, "pending-input.txt");
  const materializedPath = path.join(tempDir, "materialized");
  const rolloutProbeCountPath = path.join(tempDir, "rollout-probe-count.txt");
  const processBirthPath = path.join(tempDir, "process-birth.txt");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const target = terminalKind === "herdr"
    ? "default:w1:p1"
    : "tmux-birth:0.0";
  const panePid = 72_000;
  const codexPid = 72_001;
  const terminalId =
    `terminal:v2:${terminalKind}:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${NATIVE_THREAD_ID}.jsonl`
  );
  const executablePath =
    `/opt/akk-test/releases/${codexVersion}-aarch64-apple-darwin/bin/codex`;
  const exactTtyViewportColumns = ttyViewportColumns === undefined
    ? viewportColumns === null
      ? null
      : viewportColumns - 3
    : ttyViewportColumns;
  const exactTtyViewportRows = ttyViewportRows ?? 38;

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(
    rolloutInitiallyAbsent ? codexHome : sessionsDir,
    { recursive: true, mode: 0o700 }
  );
  fs.writeFileSync(screenPath, codexTestComposerScreen());
  fs.writeFileSync(processBirthPath, LIVE_PROCESS_BIRTH);
  if (!rolloutInitiallyAbsent) {
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: NATIVE_THREAD_ID,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  if (persistedCandidate) {
    fs.writeFileSync(path.join(codexHome, "state_1.sqlite"), "", {
      mode: 0o600
    });
    writeFakeSqlite({
      fakeBinDir,
      nativeThreadId: NATIVE_THREAD_ID,
      rolloutPath,
      workspace
    });
  }
  writeFakeTmux({
    fakeBinDir,
    callsPath: tmuxCallsPath,
    screenPath,
    pendingInputPath,
    materializedPath,
    processBirthPath,
    rolloutPath,
    codexVersion,
    target,
    panePid,
    workspace,
    viewportColumns,
    viewportRows: 40
  });
  writeFakeProcessTools({
    fakeBinDir,
    materializedPath,
    materializeRolloutOnProbe,
    processBirthPath,
    rolloutProbeCountPath,
    rolloutPath,
    executablePath,
    workspace,
    panePid,
    codexPid
  });

  const capabilities = [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ] as const;
  const terminalControl: TerminalControlRef = terminalKind === "herdr"
    ? {
        kind: "herdr",
        target,
        socketPath: path.join(tempDir, "herdr.sock"),
        session: "default",
        sessionDir: path.join(tempDir, "herdr-session"),
        workspaceId: "w1",
        tabId: "w1:t1",
        paneId: "w1:p1",
        terminalId: "term-fixture-codex",
        panePid,
        currentCommand: "codex --yolo",
        currentPath: workspace,
        capabilities: [...capabilities]
      }
    : {
        kind: "tmux",
        target,
        session: "tmux-birth",
        window: 0,
        pane: 0,
        panePid,
        currentCommand: "codex",
        currentPath: workspace,
        capabilities: [...capabilities]
      };
  if (terminalControl.kind === "tmux") {
    const endpointKey = "default-server-route";
    createTerminalEndpointRef({
      identity: {
        providerKind: "tmux",
        endpointKey,
        resourceKey: `pane-id:${FIXTURE_TMUX_PANE_ID}`
      },
      route: {
        routeKey: tmuxTerminalRouteKey(
          endpointKey,
          terminalControl.target,
          terminalControl.socketPath
        ),
        label: terminalControl.target,
        currentCommand: terminalControl.currentCommand,
        currentPath: terminalControl.currentPath
      },
      processAnchorPid: terminalControl.panePid,
      capabilities: terminalControl.capabilities,
      providerRef: terminalControl
    });
  }
  const fixture: NoRolloutFixture = {
    tempDir,
    storeDir,
    codexHome,
    rolloutPath,
    materializedPath,
    rolloutProbeCountPath,
    screenPath,
    processBirthPath,
    tmuxCallsPath,
    target,
    inputTarget: terminalKind === "tmux" ? FIXTURE_TMUX_PANE_ID : target,
    terminalId,
    terminalControl,
    codexPid,
    clockMs: Date.now(),
    codexVersion,
    terminalKind,
    persistedCandidate,
    rolloutInitiallyAbsent,
    materializeRolloutOnProbe,
    activeNativeThreadId: NATIVE_THREAD_ID,
    activeRolloutPath: rolloutPath,
    viewportColumns,
    viewportRows: 40,
    viewportZoomed,
    viewportPaneFocused,
    viewportFocusedPaneId,
    viewportAreaColumns,
    viewportAreaRows,
    ttyViewportColumns: exactTtyViewportColumns,
    ttyViewportRows: exactTtyViewportRows,
    ttyViewportInspectionPids: [],
    runtimeLogs: [],
    environment: {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    },
    cleanup() {
      inProcessFixtures.delete(storeDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
  inProcessFixtures.set(storeDir, fixture);
  return fixture;
}

function persistStatusCardSession(
  fixture: NoRolloutFixture,
  processBirth: string,
  nativeThreadId = NATIVE_THREAD_ID,
  sessionId = "session-codex-status-card"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, processBirth),
      processBirth,
      evidence: "codex_status_card",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistExactEndedRolloutSession(
  fixture: NoRolloutFixture,
  sessionId = "session-codex-ended-rollout"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-11T02:36:56.000Z");
  const stat = fs.statSync(fixture.rolloutPath);
  const openRoot = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === NATIVE_THREAD_ID &&
    fs.realpathSync(candidate.rolloutPath) ===
      fs.realpathSync(fixture.rolloutPath)
  );
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: openRoot?.fd ?? "24",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(fixture.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistDetachedRolloutCompanion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  sessionId: string
): ManagedSessionState {
  const root = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  assert.ok(root, `missing fixture rollout for ${nativeThreadId}`);
  const stat = fs.statSync(root.rolloutPath);
  const now = new Date("2026-08-11T02:37:56.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "detached",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: root.fd,
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(root.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    detached_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function persistConflictSession(
  fixture: NoRolloutFixture,
  options: {
    sessionId: string;
    nativeThreadId?: string;
    processBirth?: string;
  }
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:30:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: options.sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: options.nativeThreadId,
      processUuid: options.processBirth
        ? processUuid(fixture.codexPid, options.processBirth)
        : undefined,
      processBirth: options.processBirth,
      evidence: options.nativeThreadId
        ? "codex_status_card"
        : "raw_terminal_attach",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

async function listFixtureTerminal(
  fixture: NoRolloutFixture
): Promise<Record<string, any>> {
  const listed = await runCli([
    "list",
    ...codexNoRolloutStoreArgs(fixture)
  ], fixture.environment);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const terminals = JSON.parse(listed.stdout).terminals;
  assert.equal(terminals.length, 1, listed.stdout);
  return terminals[0];
}

async function deferredForegroundSendAction(
  fixture: NoRolloutFixture
): Promise<Record<string, any>> {
  const terminal = await listFixtureTerminal(fixture);
  return assertTerminalUserExplicitSendAction(terminal);
}

function assertTerminalUserExplicitSendAction(
  terminal: Record<string, any>
): Record<string, any> {
  const action = terminal.available_actions?.send;
  assert.ok(action, JSON.stringify(terminal, null, 2));
  assert.equal(action.scope, "terminal_user_explicit");
  assert.equal(action.arguments.selector, terminal.id);
  assert.equal("session_id" in action.arguments, false);
  assert.equal(typeof action.arguments.expected_terminal_token, "string");
  return action;
}

function deferredForegroundSendArgs(
  fixture: NoRolloutFixture,
  action: Record<string, any>,
  message: string
): string[] {
  const expectedManagedTerminalToken = String(
    action.arguments.expected_managed_terminal_token ?? ""
  );
  assert.ok(
    expectedManagedTerminalToken,
    `managed deferred fixture is missing its managed token: ${JSON.stringify(action)}`
  );
  return [
    "send",
    "--conversation",
    String(action.arguments.selector),
    "--managed-only",
    "--expected-terminal-token",
    expectedManagedTerminalToken,
    "--message",
    message,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
}

function userExplicitDeferredForegroundSendArgs(
  fixture: NoRolloutFixture,
  action: Record<string, any>,
  message: string
): string[] {
  return [
    "send",
    "--conversation",
    String(action.arguments.selector),
    "--expected-terminal-token",
    String(action.arguments.expected_terminal_token),
    "--message",
    message,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
}

async function seedStatusCardManagedApproval(
  fixture: NoRolloutFixture
): Promise<{ session: ManagedSessionState; turn: Record<string, any> }> {
  const sent = await runCli([
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    "Prepare one permission request for explicit human review.",
    ...codexNoRolloutBackgroundSendArgs(fixture)
  ], fixture.environment);
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const output = JSON.parse(sent.stdout);
  assert.equal(output.delivery_receipt, "agent_accepted", sent.stdout);

  const originalSession = loadManagedSession(
    fixture.storeDir,
    String(output.session_id)
  );
  assert.ok(originalSession.binding);
  const statusCardAt = new Date().toISOString();
  const sessionSnapshot: ManagedSessionState = {
    ...originalSession,
    revision: (originalSession.revision as number) + 1,
    binding: {
      ...originalSession.binding,
      native_process: {
        ...originalSession.binding.native_process,
        rollout: undefined,
        evidence: "codex_status_card"
      }
    },
    updated_at: statusCardAt
  };
  // This fixture models a Store snapshot written by an older status-card
  // binder. The current CAS API intentionally forbids degrading a verified
  // rollout, so write the historical snapshot directly and immediately load
  // it through today's validator before exercising list/runtime behavior.
  fs.writeFileSync(
    pathsForManagedSession(
      originalSession.session_id,
      fixture.storeDir
    ).statePath,
    `${JSON.stringify(sessionSnapshot, null, 2)}\n`,
    { mode: 0o600 }
  );
  const session = loadManagedSession(
    fixture.storeDir,
    originalSession.session_id
  );

  const turn = listConversations(fixture.storeDir)[0];
  assert.ok(turn);
  const takeover = turn.native_session_takeover as Record<string, any>;
  const statusCardTurn = {
    ...turn,
    native_session_takeover: {
      ...takeover,
      terminal_agent_rollout: undefined
    },
    updated_at: statusCardAt
  };
  saveState(turn.state_path as string, statusCardTurn);
  fixture.identityObservationError =
    "injected Codex rollout observation unavailable";
  fs.rmSync(fixture.materializedPath, { force: true });
  fs.writeFileSync(fixture.screenPath, [
    "  Would you like to run the following command?",
    "",
    "  $ npm test",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)"
  ].join("\n"));
  return {
    session: loadManagedSession(fixture.storeDir, session.session_id),
    turn: listConversations(fixture.storeDir)[0]
  };
}

function approvalKeyCalls(
  fixture: NoRolloutFixture
): Array<{ args: string[]; at?: number }> {
  return readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
    call.args[0] === "send-keys" && call.args.at(-1) === "y"
  );
}

function codexApprovalScreen(command: string): string {
  return [
    "  Would you like to run the following command?",
    "",
    `  $ ${command}`,
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)"
  ].join("\n");
}

function soleDeferredForegroundTransfer(
  fixture: NoRolloutFixture
): DeferredForegroundTransfer {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  assert.equal(transfers.length, 1, JSON.stringify(transfers, null, 2));
  return transfers[0];
}

function taskInputCalls(
  fixture: NoRolloutFixture,
  message?: string
): Array<{ args: string[]; at?: number }> {
  return readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
    call.args[0] === "send-keys" &&
    (
      call.args.at(-1) === "C-m" ||
      (
        call.args.includes("-l") &&
        call.args.at(-1) !== "/status" &&
        (message === undefined || call.args.at(-1) === message)
      )
    )
  );
}

function assertSingleTaskInput(
  fixture: NoRolloutFixture,
  message: string
): void {
  assert.deepEqual(taskInputCalls(fixture, message).map((call) => call.args), [
    ["send-keys", "-t", fixture.inputTarget, "-l", message],
    ["send-keys", "-t", fixture.inputTarget, "C-m"]
  ]);
}

function persistedCodexV3AcceptanceAnchor(
  fixture: NoRolloutFixture,
  turnId: string
): Record<string, any> {
  const persisted = listConversations(fixture.storeDir).find((turn) =>
    turn.turn_id === turnId
  );
  assert.ok(persisted, `missing persisted Turn ${turnId}`);
  const takeover = persisted.native_session_takeover as Record<string, any>;
  const anchor = takeover.codex_rollout_acceptance_anchor;
  assert.equal(anchor?.version, 3);
  return anchor;
}

function assertRecoveredTurnBlocksDuplicate(result: CliTestResult): void {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /unresolved Turn|waiting_for_agent/iu);
  assert.doesNotMatch(
    result.stderr,
    /uncertain dispatch|do not retry|multiple unresolved deferred/iu
  );
}

function readSoleTerminalDispatchLedger(
  fixture: NoRolloutFixture
): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(soleTerminalDispatchLedgerPath(fixture), "utf8")
  );
}

function soleTerminalDispatchLedgerPath(
  fixture: NoRolloutFixture
): string {
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const paths = fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(ledgerDir, name))
    : [];
  assert.equal(paths.length, 1, JSON.stringify(paths));
  return paths[0];
}

async function seedResolvedHistoricalDispatchAndStatusCard(
  fixture: NoRolloutFixture
): Promise<{ source: ManagedSessionState; historicalTurnId: string }> {
  const historicalMessage = "Create one exact resolved historical dispatch.";
  const sent = await runCli([
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    historicalMessage,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ], codexNativeAcceptanceEnv(fixture.environment));
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const output = JSON.parse(sent.stdout);
  assert.equal(output.delivered, true, sent.stdout);
  const historicalTurnId = String(output.turn_id);
  const closed = await runCli([
    "close",
    "--turn",
    historicalTurnId,
    "--reason",
    "test-only resolved dispatch history fixture",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome)
  ], fixture.environment);
  assert.equal(closed.status, 0, closed.stderr || closed.stdout);
  assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);

  const previousSession = loadManagedSession(
    fixture.storeDir,
    String(output.session_id)
  );
  const detachedAt = new Date().toISOString();
  assert.ok(previousSession.binding);
  const retiredBinding = terminalBindingFrom({
    terminalId: previousSession.binding.terminal_id,
    terminalControl: previousSession.binding.terminal_control,
    pid: previousSession.binding.native_process.pid,
    processUuid: previousSession.binding.native_process.process_uuid,
    processBirth: previousSession.binding.native_process.process_birth,
    evidence: "test_resolved_history_retired",
    generation: previousSession.binding.generation + 1,
    now: new Date(detachedAt)
  });
  saveManagedSession(fixture.storeDir, {
    ...previousSession,
    status: "detached",
    binding: retiredBinding,
    detached_at: detachedAt,
    updated_at: detachedAt
  }, { expectedRevision: previousSession.revision as number });
  fs.rmSync(fixture.rolloutPath, { force: true });
  fs.rmSync(fixture.materializedPath, { force: true });
  fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
  return {
    source: persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH),
    historicalTurnId
  };
}

function materializePreparedDeferredLedgerWithoutTurnState({
  fixture,
  transfer,
  message
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  message: string;
}): void {
  const binding = transfer.target_before_binding;
  const preparedAt = transfer.target_prepared_at;
  const messageId = transfer.message_id;
  const turnId = transfer.turn_id;
  const statePath = transfer.state_path;
  assert.ok(binding);
  assert.ok(preparedAt);
  assert.ok(messageId);
  assert.ok(turnId);
  assert.ok(statePath);
  saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: transfer.target_session_id,
    agent: "codex",
    workspace: transfer.workspace,
    status: "transitioning",
    binding,
    lineage: {
      created_by: "attach",
      previous_session_id: transfer.source_session_id,
      transition_id: transfer.transfer_id
    },
    last_transition_id: transfer.transfer_id,
    created_at: preparedAt,
    updated_at: preparedAt
  }, { expectedRevision: null });

  const identity = terminalEndpointIdentityFromEvidence(
    transfer.terminal_endpoint
  );
  assert.ok(identity);
  const terminalKey = createHash("sha256")
    .update(terminalEndpointIdentityKey(identity))
    .digest("hex")
    .slice(0, 20);
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const ledgerPath = path.join(
    ledgerDir,
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(ledgerDir, { recursive: true });
  const control = binding.terminal_control;
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: control.kind,
      target: control.target,
      socket_path: control.socketPath ?? null,
      pane_pid: control.panePid ?? null,
      current_path: control.currentPath ?? null
    },
    terminal_endpoint: transfer.terminal_endpoint,
    status: "prepared",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: transfer.target_session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: createHash("sha256").update(message).digest("hex"),
    request_hash: transfer.request_hash,
    executor_kind: "codex",
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(statePath),
    event_log_path: path.join(path.dirname(statePath), "events.ndjson"),
    deferred_foreground_transfer_id: transfer.transfer_id,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    prepared_at: preparedAt,
    dispatcher_pid: transfer.dispatcher_pid,
    callback_expected: false
  }, null, 2)}\n`, { mode: 0o600 });
}

function assertExactDeferredZeroInputAbortLedger({
  fixture,
  transfer,
  ledger
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
}): void {
  const binding = transfer.target_before_binding;
  assert.ok(binding);
  assert.equal(ledger.status, "resolved");
  assert.equal(ledger.safe_to_retry, true);
  assert.equal(ledger.dispatcher_pid, null);
  assert.equal(ledger.deferred_foreground_transfer_id, transfer.transfer_id);
  assert.equal(ledger.generation_id, transfer.message_id);
  assert.equal(ledger.conversation_id, transfer.turn_id);
  assert.equal(ledger.session_id, transfer.target_session_id);
  assert.equal(ledger.turn_id, transfer.turn_id);
  assert.equal(ledger.message_id, transfer.message_id);
  assert.equal(ledger.message_type, "task");
  assert.equal(ledger.request_hash, transfer.request_hash);
  assert.equal(ledger.executor_kind, "codex");
  assert.equal(ledger.binding_id, binding.binding_id);
  assert.equal(ledger.binding_generation, binding.generation);
  assert.equal(ledger.native_thread_id, undefined);
  assert.equal(path.resolve(ledger.store_dir), path.resolve(fixture.storeDir));
  assert.equal(path.resolve(ledger.state_path), path.resolve(String(
    transfer.state_path
  )));
  assert.ok(ledger.aborted_at);
  assert.ok(ledger.resolved_at);
  assert.equal(ledger.aborted_at, ledger.resolved_at);

  const forbiddenInputFields = [
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "submitted_at",
    "agent_accepted_at",
    "not_accepted_at",
    "uncertain_at",
    "acceptance_evidence"
  ];
  for (const field of forbiddenInputFields) {
    assert.equal(ledger[field], undefined, field);
  }
  const receipts = ledger.terminal_submission_receipts;
  assert.ok(Array.isArray(receipts));
  const ownReceipts = receipts.filter(
    (receipt: Record<string, any>) => receipt.message_id === transfer.message_id
  );
  assert.equal(ownReceipts.length, 1, JSON.stringify(receipts, null, 2));
  const receipt = ownReceipts[0];
  assert.equal(receipt.status, "aborted");
  assert.equal(receipt.safe_to_retry, true);
  assert.equal(receipt.aborted_at, ledger.aborted_at);
  assert.equal(receipt.resolved_at, ledger.resolved_at);
  for (const field of [
    "terminal_control",
    "terminal_endpoint",
    "generation_id",
    "conversation_id",
    "session_id",
    "turn_id",
    "message_id",
    "message_type",
    "message_body_hash",
    "request_hash",
    "executor_kind",
    "store_dir",
    "state_path",
    "event_log_path",
    "deferred_foreground_transfer_id",
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "callback_expected",
    "dispatcher_pid"
  ]) {
    assert.deepEqual(receipt[field], ledger[field], field);
  }
  for (const field of forbiddenInputFields) {
    assert.equal(receipt[field], undefined, `receipt ${field}`);
  }
}

function assertResolvedSameUuidDeferredTransfer({
  fixture,
  sourceSessionId,
  originalBindingId,
  originalGeneration
}: {
  fixture: NoRolloutFixture;
  sourceSessionId: string;
  originalBindingId: string;
  originalGeneration: number;
}): void {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  const transfer = transfers.find((candidate) =>
    candidate.status === "resolved"
  );
  assert.ok(transfer, JSON.stringify(transfers, null, 2));
  assert.equal(transfer.source_retirement, "binding_scrubbed_same_native_thread");
  assert.equal(transfer.target_native_thread_id, NATIVE_THREAD_ID);

  const source = loadManagedSession(fixture.storeDir, sourceSessionId);
  const target = loadManagedSession(
    fixture.storeDir,
    transfer.target_session_id
  );
  assert.equal(source.status, "detached");
  assert.equal(source.binding?.native_thread_id, undefined);
  assert.equal(source.binding?.native_process.rollout, undefined);
  assert.notEqual(source.binding?.binding_id, originalBindingId);
  assert.equal(source.binding?.generation, originalGeneration + 1);
  assert.equal(target.status, "bound");
  assert.equal(target.binding?.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    listManagedSessions(fixture.storeDir).filter(
      (session) => session.binding?.native_thread_id === NATIVE_THREAD_ID
    ).map((session) => session.session_id).join(","),
    target.session_id,
    "the accepted native UUID must have exactly one Store owner"
  );
  const turn = listConversations(fixture.storeDir).find(
    (candidate) => candidate.session_id === target.session_id
  );
  assert.ok(turn);
  assert.equal(turn.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    (turn.native_session_takeover as Record<string, any>)
      .terminal_bridge_submission?.status,
    "agent_accepted"
  );
}

function reconcileArguments(
  fixture: NoRolloutFixture,
  argumentsValue: Record<string, unknown>
): string[] {
  return [
    "reconcile-binding",
    "--terminal",
    String(argumentsValue.terminal_id),
    "--conflicting-session",
    String(argumentsValue.conflicting_session_id),
    "--expected-session-revision",
    String(argumentsValue.expected_session_revision),
    "--expected-binding-token",
    String(argumentsValue.expected_binding_token),
    "--expected-terminal-token",
    String(argumentsValue.expected_terminal_token),
    ...codexNoRolloutStoreArgs(fixture)
  ];
}

function persistBlockingTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  status: "waiting_for_agent" | "stalled" = "waiting_for_agent"
): void {
  const now = new Date("2026-08-06T02:31:00.000Z");
  const base = createConversation({
    userRequest: "This unresolved Turn must block binding reconciliation.",
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-reconcile-blocker",
    now
  });
  const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
  saveState(paths.statePath, {
    ...base,
    status,
    ...(status === "stalled"
      ? {
          stalled_at: now.toISOString(),
          stalled_reason: "test-only unresolved Codex dispatch"
        }
      : {}),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: `message-${base.conversation_id}`,
      terminal_bridge_started_at: now.toISOString(),
      terminal_agent_session_id: NATIVE_THREAD_ID,
      terminal_control: fixture.terminalControl
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: now.toISOString()
  });
}

function persistLegacyV1UncertainTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  message: string
): string {
  const binding = session.binding;
  assert.ok(binding);
  assert.ok(binding.native_thread_id);
  assert.ok(binding.terminal_endpoint);
  const preparedAt = "2026-08-12T01:33:47.000Z";
  const textInjectedAt = "2026-08-12T01:33:47.010Z";
  const enterDispatchedAt = "2026-08-12T01:33:47.020Z";
  const uncertainAt = "2026-08-12T01:33:47.030Z";
  const base = createConversation({
    userRequest: message,
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-legacy-v1-uncertain",
    workspace: session.workspace,
    now: new Date(preparedAt)
  });
  const turnId = base.turn_id;
  const messageId = `message-${turnId}`;
  const requestHash = createHash("sha256").update(message).digest("hex");
  const messageBodyHash = createHash("sha256").update(message).digest("hex");
  const paths = pathsForConversation(turnId, fixture.storeDir);
  const submission = {
    status: "uncertain",
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    native_thread_id: binding.native_thread_id,
    terminal_target: fixture.terminalControl.target,
    terminal_socket_path: fixture.terminalControl.socketPath ?? null,
    terminal_pane_pid: fixture.terminalControl.panePid,
    terminal_endpoint: binding.terminal_endpoint,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    last_proven_stage: "enter_dispatched",
    error: "legacy v1 acceptance could not attribute the post-clear rollout"
  };
  saveState(paths.statePath, {
    ...base,
    status: "stalled",
    stalled_at: uncertainAt,
    stalled_reason:
      "terminal submission outcome is uncertain; inspect the shared terminal pane before continuing",
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    native_session_takeover: {
      agent: "codex",
      terminal_agent_identity_protocol: 1,
      native_session_id: fixture.terminalId,
      terminal_agent_pid: fixture.codexPid,
      terminal_agent_session_id: binding.native_thread_id,
      terminal_agent_process_uuid: binding.native_process.process_uuid,
      terminal_agent_process_birth: binding.native_process.process_birth,
      terminal_agent_rollout: binding.native_process.rollout,
      terminal_agent_identity_evidence: binding.native_process.evidence,
      source_cwd: session.workspace,
      strategy: "terminal_control",
      terminal_control: fixture.terminalControl,
      terminal_endpoint: binding.terminal_endpoint,
      terminal_bridge: true,
      terminal_bridge_started_at: preparedAt,
      terminal_bridge_message_id: messageId,
      terminal_bridge_request_text: message,
      terminal_bridge_request_hash: requestHash,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: uncertainAt
  });

  const identity = terminalEndpointIdentityFromEvidence(
    binding.terminal_endpoint
  );
  assert.ok(identity);
  const terminalKey = createHash("sha256")
    .update(terminalEndpointIdentityKey(identity))
    .digest("hex")
    .slice(0, 20);
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const ledgerPath = path.join(
    ledgerDir,
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: fixture.terminalControl.kind,
      target: fixture.terminalControl.target,
      socket_path: fixture.terminalControl.socketPath ?? null,
      pane_pid: fixture.terminalControl.panePid ?? null,
      current_path: fixture.terminalControl.currentPath ?? null
    },
    terminal_endpoint: binding.terminal_endpoint,
    status: "uncertain",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    callback_expected: false,
    error: submission.error
  }, null, 2)}\n`, { mode: 0o600 });
  return turnId;
}

function persistReleasedCandidateSourceTurns(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const statuses = ["idle", "closed", "cancelled", "failed"] as const;
  statuses.forEach((status, index) => {
    const now = new Date(Date.UTC(2026, 7, 12, 1, index, 0));
    const base = createConversation({
      userRequest: `Released candidate history ${status}.`,
      sessionId: session.session_id,
      executorKind: "codex",
      executorSession: `codex-candidate-history-${status}`,
      workspace: session.workspace,
      now
    });
    const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
    saveState(paths.statePath, {
      ...base,
      status,
      ...(status === "idle" ? { idle_since: now.toISOString() } : {}),
      ...(status === "closed"
        ? {
            closed_at: now.toISOString(),
            close_reason: "test-only released candidate history"
          }
        : {}),
      terminal_binding_id: session.binding?.binding_id,
      terminal_binding_generation: session.binding?.generation,
      native_thread_id: session.binding?.native_thread_id,
      native_session_takeover: {
        agent: "codex",
        terminal_agent_identity_protocol: 1,
        native_session_id: fixture.terminalId,
        terminal_agent_pid: fixture.codexPid,
        terminal_agent_session_id: session.binding?.native_thread_id,
        terminal_agent_process_uuid:
          session.binding?.native_process.process_uuid,
        terminal_agent_process_birth:
          session.binding?.native_process.process_birth,
        terminal_agent_rollout: session.binding?.native_process.rollout,
        terminal_agent_identity_evidence:
          session.binding?.native_process.evidence,
        source_cwd: session.workspace,
        strategy: "terminal_control",
        terminal_control: fixture.terminalControl,
        terminal_bridge: true
      },
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath,
      updated_at: now.toISOString()
    });
  });
}

function persistUnresolvedTransition(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): NativeThreadTransition {
  const preparedAt = new Date("2026-08-06T02:32:00.000Z");
  return saveNativeThreadTransition(fixture.storeDir, {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: "transition-reconcile-blocker",
    operation: "new_thread",
    status: "prepared",
    terminal_id: fixture.terminalId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    source_session_id: session.session_id,
    source_expected_revision: session.revision,
    target_session_id: "session-reconcile-transition-target",
    target_expected_revision: null,
    before_native_thread_id:
      session.binding?.native_thread_id ?? EXTERNAL_THREAD_ID,
    before_process_uuid:
      session.binding?.native_process.process_uuid ??
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
    before_process_birth:
      session.binding?.native_process.process_birth ?? LIVE_PROCESS_BIRTH,
    before_binding: session.binding,
    adapter_version: "0.146.1",
    command_fingerprint: createHash("sha256")
      .update("fixture-reconcile-transition")
      .digest("hex"),
    dispatcher_pid: process.pid,
    prepared_at: preparedAt.toISOString()
  }, { expectedRevision: null });
}

function persistUnresolvedDispatchLedger(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: fixture.terminalControl.target,
      socket_path: null
    }))
    .digest("hex")
    .slice(0, 20);
  const runtimeDir = String(fixture.environment.AKK_RUNTIME_DIR);
  const ledgerPath = path.join(
    runtimeDir,
    "terminal-dispatch",
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 1,
    terminal_key: terminalKey,
    terminal_control: {
      kind: "tmux",
      target: fixture.terminalControl.target,
      socket_path: null,
      pane_pid: fixture.terminalControl.panePid,
      current_path: fixture.terminalControl.currentPath
    },
    kind: "turn",
    generation_id: "message-reconcile-ledger-blocker",
    conversation_id: `turn-for-${session.session_id}`,
    message_id: "message-reconcile-ledger-blocker",
    status: "uncertain",
    prepared_at: "2026-08-06T02:33:00.000Z",
    uncertain_at: "2026-08-06T02:33:01.000Z"
  })}\n`, { mode: 0o600 });
}

function processUuid(pid: number, processBirth: string): string {
  return `codex-pid:${pid}:birth:${processBirth}`;
}

interface CliTestResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

class InProcessCliExit extends Error {
  constructor(readonly status: number) {
    super(`in-process CLI exit ${status}`);
  }
}

interface FixtureMutableCheckpoint {
  activeNativeThreadId: string;
  activeRolloutPath: string;
  appendAcceptanceOnProbe?: number;
  deferredAcceptanceRequest?: string;
  openRootRollouts?: Array<{
    nativeThreadId: string;
    rolloutPath: string;
    fd: string;
  }>;
  acceptanceNativeThreadIdsOnEnter?: string[];
  additionalOpenRootNativeThreadIdsOnEnter?: string[];
  clockMs: number;
  runtimeLogCount: number;
  ttyViewportInspectionCount: number;
}

interface CapturedInProcessExit {
  status: number;
  snapshotRoot: string;
  snapshotPath: string;
}

function rewriteSnapshotLockOwners(
  directory: string,
  deadPid: number
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteSnapshotLockOwners(entryPath, deadPid);
      continue;
    }
    if (!entry.isFile() || !/\.(?:lock|reclaim)$/u.test(entry.name)) {
      continue;
    }
    const contents = fs.readFileSync(entryPath, "utf8").trim();
    try {
      const owner = JSON.parse(contents) as Record<string, unknown>;
      if (owner.pid === process.pid) {
        fs.writeFileSync(
          entryPath,
          `${JSON.stringify({ ...owner, pid: deadPid })}\n`,
          "utf8"
        );
      }
    } catch {
      if (Number(contents) === process.pid) {
        fs.writeFileSync(entryPath, `${deadPid}\n`, "utf8");
      }
    }
  }
}

function restoreDirectorySnapshot(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const sourceEntries = new Map(
    fs.readdirSync(source, { withFileTypes: true }).map((entry) => [
      entry.name,
      entry
    ])
  );
  for (const destinationEntry of fs.readdirSync(destination, {
    withFileTypes: true
  })) {
    if (!sourceEntries.has(destinationEntry.name)) {
      fs.rmSync(path.join(destination, destinationEntry.name), {
        recursive: true,
        force: true
      });
    }
  }
  for (const [name, sourceEntry] of sourceEntries) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const destinationStat = (() => {
      try {
        return fs.lstatSync(destinationPath);
      } catch {
        return undefined;
      }
    })();
    if (sourceEntry.isDirectory()) {
      if (destinationStat && !destinationStat.isDirectory()) {
        fs.rmSync(destinationPath, { recursive: true, force: true });
      }
      restoreDirectorySnapshot(sourcePath, destinationPath);
      continue;
    }
    if (sourceEntry.isFile() && destinationStat?.isFile()) {
      const sourceStat = fs.statSync(sourcePath);
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, sourceStat.mode);
      fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
      continue;
    }
    if (destinationStat) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, destinationPath, {
      recursive: sourceEntry.isDirectory(),
      preserveTimestamps: true
    });
  }
}

function fixtureMutableCheckpoint(
  fixture: NoRolloutFixture
): FixtureMutableCheckpoint {
  return {
    activeNativeThreadId: fixture.activeNativeThreadId,
    activeRolloutPath: fixture.activeRolloutPath,
    ...(fixture.appendAcceptanceOnProbe === undefined
      ? {}
      : { appendAcceptanceOnProbe: fixture.appendAcceptanceOnProbe }),
    ...(fixture.deferredAcceptanceRequest === undefined
      ? {}
      : { deferredAcceptanceRequest: fixture.deferredAcceptanceRequest }),
    ...(fixture.openRootRollouts === undefined
      ? {}
      : {
          openRootRollouts: fixture.openRootRollouts.map((candidate) => ({
            ...candidate
          }))
        }),
    ...(fixture.acceptanceNativeThreadIdsOnEnter === undefined
      ? {}
      : {
          acceptanceNativeThreadIdsOnEnter:
            [...fixture.acceptanceNativeThreadIdsOnEnter]
        }),
    ...(fixture.additionalOpenRootNativeThreadIdsOnEnter === undefined
      ? {}
      : {
          additionalOpenRootNativeThreadIdsOnEnter:
            [...fixture.additionalOpenRootNativeThreadIdsOnEnter]
        }),
    clockMs: fixture.clockMs,
    runtimeLogCount: fixture.runtimeLogs.length,
    ttyViewportInspectionCount: fixture.ttyViewportInspectionPids.length
  };
}

function restoreFixtureMutableCheckpoint(
  fixture: NoRolloutFixture,
  checkpoint: FixtureMutableCheckpoint
): void {
  fixture.activeNativeThreadId = checkpoint.activeNativeThreadId;
  fixture.activeRolloutPath = checkpoint.activeRolloutPath;
  if (checkpoint.appendAcceptanceOnProbe === undefined) {
    delete fixture.appendAcceptanceOnProbe;
  } else {
    fixture.appendAcceptanceOnProbe = checkpoint.appendAcceptanceOnProbe;
  }
  if (checkpoint.deferredAcceptanceRequest === undefined) {
    delete fixture.deferredAcceptanceRequest;
  } else {
    fixture.deferredAcceptanceRequest = checkpoint.deferredAcceptanceRequest;
  }
  fixture.openRootRollouts = checkpoint.openRootRollouts?.map((candidate) => ({
    ...candidate
  }));
  fixture.acceptanceNativeThreadIdsOnEnter =
    checkpoint.acceptanceNativeThreadIdsOnEnter === undefined
      ? undefined
      : [...checkpoint.acceptanceNativeThreadIdsOnEnter];
  fixture.additionalOpenRootNativeThreadIdsOnEnter =
    checkpoint.additionalOpenRootNativeThreadIdsOnEnter === undefined
      ? undefined
      : [...checkpoint.additionalOpenRootNativeThreadIdsOnEnter];
  fixture.clockMs = checkpoint.clockMs;
  fixture.runtimeLogs.length = checkpoint.runtimeLogCount;
  fixture.ttyViewportInspectionPids.length =
    checkpoint.ttyViewportInspectionCount;
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): Promise<CliTestResult> {
  args = codexNoRolloutManagedStateMachineArgs(args);
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  try {
    const result = await executeCliCommand(
      parsed.command,
      parsed.options,
      inProcessDependencies(fixture, env, onExit)
    );
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: ""
    };
  } catch (error) {
    return {
      status: error instanceof InProcessCliExit ? error.status : 1,
      stdout: "",
      stderr: error instanceof InProcessCliExit ? "" : errorMessage(error)
    };
  }
}

/**
 * Execute through the imported command and virtual clock, but freeze the exact
 * durable checkpoint observed by cliExit before ordinary exception unwinding
 * can compensate it. Restoring that snapshot after the command unwinds models
 * the state a hard process exit leaves for the next recovery invocation.
 */
async function runCliCrashCheckpoint(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliTestResult> {
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  const mutableCheckpoint = fixtureMutableCheckpoint(fixture);
  const previousCliPid = fixture.cliPid;
  fixture.cliPid = SIMULATED_DEAD_CLI_PID;
  let captured: CapturedInProcessExit | undefined;
  try {
    const result = await runCli(args, env, (status) => {
      if (!captured) {
        const snapshotRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "akk-in-process-cli-exit-")
        );
        const snapshotPath = path.join(snapshotRoot, "fixture");
        try {
          fs.cpSync(fixture.tempDir, snapshotPath, {
            recursive: true,
            preserveTimestamps: true
          });
          rewriteSnapshotLockOwners(snapshotPath, SIMULATED_DEAD_CLI_PID);
          captured = { status, snapshotRoot, snapshotPath };
        } catch (error) {
          fs.rmSync(snapshotRoot, { recursive: true, force: true });
          throw error;
        }
      }
      throw new InProcessCliExit(status);
    });
    if (!captured) {
      return result;
    }
    restoreDirectorySnapshot(captured.snapshotPath, fixture.tempDir);
    restoreFixtureMutableCheckpoint(fixture, mutableCheckpoint);
    return { status: captured.status, stdout: "", stderr: "" };
  } finally {
    if (captured) {
      fs.rmSync(captured.snapshotRoot, { recursive: true, force: true });
    }
    if (previousCliPid === undefined) {
      delete fixture.cliPid;
    } else {
      fixture.cliPid = previousCliPid;
    }
  }
}

/** Deliberate crash/exit and detached child-lifecycle process goldens. */
function runCliSubprocess(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    binPath,
    ...codexNoRolloutManagedStateMachineArgs(args)
  ], {
    encoding: "utf8",
    env,
    timeout: 60_000
  });
}

function spawnFixtureNodeEval(source: string) {
  return spawn(process.execPath, ["-e", source], { stdio: "ignore" });
}

const inProcessFixtures = new Map<string, NoRolloutFixture>();

function fixtureHerdrResponse(
  request: HerdrWireRequest,
  result: Record<string, unknown>
): Record<string, unknown> {
  return { id: request.id, result };
}

function createFixtureHerdrProvider(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  nowMs: () => number
): HerdrTerminalControlProvider {
  const control = fixture.terminalControl;
  assert.equal(control.kind, "herdr");
  const sessionList = JSON.stringify({
    sessions: [{
      name: control.session,
      default: true,
      running: true,
      socket_path: control.socketPath,
      session_dir: control.sessionDir
    }]
  });
  return new HerdrTerminalControlProvider({
    command: "herdr-fixture",
    runCommand: (_command, args) =>
      args[0] === "--version"
        ? successfulCommand(`herdr ${HERDR_EXACT_VERSION}\n`)
        : successfulCommand(sessionList),
    statSocket: () => ({
      device: "1",
      inode: "7001",
      ctimeNs: "1000000",
      ownerUid: 501
    }),
    inspectTtyViewport: (shellPid) => {
      fixture.ttyViewportInspectionPids.push(shellPid);
      return fixture.ttyViewportColumns === null
        ? undefined
        : {
            columns: fixture.ttyViewportColumns,
            rows: fixture.ttyViewportRows
          };
    },
    request: async (_socketPath, request) => {
      if (request.method === "ping") {
        return fixtureHerdrResponse(request, {
          type: "pong",
          version: HERDR_EXACT_VERSION,
          protocol: HERDR_EXACT_PROTOCOL,
          capabilities: {
            live_handoff: true,
            detached_server_daemon: true
          }
        });
      }
      if (request.method === "session.snapshot") {
        return fixtureHerdrResponse(request, {
          type: "session_snapshot",
          snapshot: {
            version: HERDR_EXACT_VERSION,
            protocol: HERDR_EXACT_PROTOCOL,
            panes: [{
              pane_id: control.paneId,
              terminal_id: control.terminalId,
              workspace_id: control.workspaceId,
              tab_id: control.tabId,
              cwd: control.currentPath,
              focused: true,
              agent_status: null,
              revision: 1
            }],
            ...(fixture.viewportColumns === null
              ? {}
              : {
                  layouts: [{
                    workspace_id: control.workspaceId,
                    tab_id: control.tabId,
                    zoomed: fixture.viewportZoomed,
                    ...(fixture.viewportFocusedPaneId
                      ? { focused_pane_id: fixture.viewportFocusedPaneId }
                      : {}),
                    ...(fixture.viewportAreaColumns === undefined ||
                      fixture.viewportAreaRows === undefined
                      ? {}
                      : {
                          area: {
                            x: 0,
                            y: 0,
                            width: fixture.viewportAreaColumns,
                            height: fixture.viewportAreaRows
                          }
                        }),
                    panes: [{
                      pane_id: control.paneId,
                      focused: fixture.viewportPaneFocused,
                      rect: {
                        x: 0,
                        y: 0,
                        width: fixture.viewportColumns,
                        height: fixture.viewportRows
                      }
                    }],
                    splits: []
                  }]
                })
          }
        });
      }
      if (request.method === "pane.process_info") {
        return fixtureHerdrResponse(request, {
          type: "pane_process_info",
          process_info: {
            pane_id: control.paneId,
            shell_pid: control.panePid,
            foreground_process_group_id: fixture.codexPid,
            foreground_processes: [{
              pid: fixture.codexPid,
              name: "codex",
              argv0: "codex",
              argv: ["codex", "--yolo"],
              cmdline: "codex --yolo",
              cwd: control.currentPath
            }]
          }
        });
      }
      if (request.method === "pane.read") {
        const screen = fs.readFileSync(fixture.screenPath, "utf8");
        const preserveEscapes = request.params.source === "visible" &&
          request.params.format === "ansi";
        return fixtureHerdrResponse(request, {
          type: "pane_read",
          read: {
            pane_id: control.paneId,
            workspace_id: control.workspaceId,
            tab_id: control.tabId,
            source: request.params.source,
            format: request.params.format,
            text: preserveEscapes
              ? screen
              : screen.replace(/\u001b\[[0-9;]*m/gu, ""),
            revision: 1,
            truncated: false
          }
        });
      }
      if (request.method === "pane.send_input") {
        const text = typeof request.params.text === "string"
          ? request.params.text
          : undefined;
        const keys = Array.isArray(request.params.keys)
          ? request.params.keys
          : [];
        if (
          text !== undefined &&
          env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
          text !== "/status"
        ) {
          fs.appendFileSync(
            fixture.tmuxCallsPath,
            `${JSON.stringify({
              args: ["send-keys", "-t", fixture.target, "-l", text],
              at: nowMs()
            })}\n`
          );
          return {
            id: request.id,
            error: {
              code: "pane_send_failed",
              message: "injected Herdr text failure before input"
            }
          };
        }
        const result = text !== undefined
          ? runInProcessTmux(
              fixture,
              env,
              ["send-keys", "-t", fixture.target, "-l", text],
              nowMs()
            )
          : keys.includes("ctrl+u")
            ? runInProcessTmux(
                fixture,
                env,
                ["send-keys", "-t", fixture.target, "C-u"],
                nowMs()
              )
          : keys.includes("enter")
            ? runInProcessTmux(
                fixture,
                env,
                ["send-keys", "-t", fixture.target, "C-m"],
                nowMs()
              )
            : successfulCommand();
        if (result.status !== 0) {
          throw new Error(result.stderr || "fixture Herdr input failed");
        }
        return fixtureHerdrResponse(request, { type: "ok" });
      }
      throw new Error(`unexpected fixture Herdr request ${request.method}`);
    }
  });
}

function inProcessDependencies(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): CliCommandDependencies {
  // A fixture can invoke the CLI multiple times to simulate a restart. Keep its
  // virtual clock monotonic across those invocations: sleep advances virtual
  // time without blocking, so resetting to a faster wall clock can otherwise
  // make a later acceptance appear to precede the persisted Enter dispatch.
  let nowMs = Math.max(Date.now(), fixture.clockMs);
  fixture.clockMs = nowMs;
  const provider = fixture.terminalKind === "herdr"
    ? createFixtureHerdrProvider(fixture, env, () => nowMs)
    : new TmuxTerminalControlProvider({
        commands: ["tmux"],
        socketPaths: [],
        runCommand: (_command, args) =>
          runInProcessTmux(fixture, env, args, nowMs)
      });
  return {
    terminalControlProviderRegistry:
      createTerminalControlProviderRegistry([provider]),
    terminalProcessSource: new StaticTerminalProcessSource(
      fixtureProcessSnapshots(fixture)
    ),
    codexLocalSessionAdapter: createFixtureCodexAdapter(fixture),
    codexThreadLifecycleProvider: createFixtureLifecycleProvider(fixture),
    loadClaudeAgentRows: () => [],
    agentVersionForRunningProcess: () => fixture.codexVersion,
    codexProcessBirthForPid: () =>
      fs.readFileSync(fixture.processBirthPath, "utf8").trim(),
    ...(fixture.cliPid ? { pid: fixture.cliPid } : {}),
    cwd: fixture.terminalControl.currentPath,
    env,
    now: () => nowMs,
    monotonicNowMs: () => nowMs,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    sleepSync: (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    exit: onExit ?? ((status) => {
      throw new InProcessCliExit(status);
    }),
    runtimeLog: (level, event, fields) => {
      fixture.runtimeLogs.push({ level, event, fields });
    }
  };
}

function fixtureProcessSnapshots(fixture: NoRolloutFixture) {
  const panePid = fixture.terminalControl.panePid;
  const workspace = fixture.terminalControl.currentPath;
  return [
    {
      pid: panePid,
      ppid: 1,
      command: "zsh",
      cwd: workspace,
      elapsed: "00:10"
    },
    {
      pid: fixture.codexPid,
      ppid: panePid,
      command:
        `/opt/akk-test/releases/${fixture.codexVersion}-aarch64-apple-darwin/bin/codex`,
      cwd: workspace,
      elapsed: "00:09"
    }
  ];
}

function createFixtureCodexAdapter(
  fixture: NoRolloutFixture
): CodexLocalSessionAdapter {
  return {
    async listThreadRows() {
      if (!fixture.persistedCandidate) {
        return [];
      }
      return [{
        id: NATIVE_THREAD_ID,
        cwd: fixture.terminalControl.currentPath,
        rollout_path: fixture.rolloutPath,
        updated_at_ms: 1_786_000_000_000,
        archived: 0
      }];
    },
    async readRollout(rolloutPath) {
      return fs.existsSync(rolloutPath)
        ? fs.readFileSync(rolloutPath, "utf8")
        : undefined;
    },
    async listProcessSnapshots() {
      return fixtureProcessSnapshots(fixture);
    },
    ...(fixture.openRootRollouts !== undefined
      ? {
          async inspectOpenRootRolloutInventoryForPid(pid: number, cwd?: string) {
            assert.equal(pid, fixture.codexPid);
            return fixtureCodexOpenRootInventory(fixture, cwd);
          }
        }
      : {}),
    async resolveActiveSessionIdentityForPid(
      pid,
      cwd,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    ) {
      assert.equal(pid, fixture.codexPid);
      if (fixture.identityObservationError) {
        throw new Error(fixture.identityObservationError);
      }
      if (fixture.openRootRollouts !== undefined) {
        const inventory = fixtureCodexOpenRootInventory(fixture, cwd);
        const roots = inventory.roots;
        if (roots.length === 0) {
          return undefined;
        }
        if (!preferredSessionId) {
          if (roots.length !== 1) {
            throw new Error(
              `fixture Codex process has ${roots.length} ambiguous open roots`
            );
          }
          return roots[0];
        }
        const preferred = roots.find((root) =>
          root.sessionId === preferredSessionId
        );
        const allowed = [
          allowedCompanionIdentity,
          ...(allowedAdditionalIdentities ?? [])
        ].flatMap((candidate) => candidate ? [candidate] : []);
        const exactAllowed = roots.filter((root) => allowed.some((candidate) =>
          candidate.sessionId === root.sessionId &&
          candidate.processUuid === root.processUuid &&
          candidate.processBirth === root.processBirth &&
          candidate.rollout?.fd === root.rollout.fd &&
          candidate.rollout?.device === root.rollout.device &&
          candidate.rollout?.inode === root.rollout.inode &&
          candidate.rollout?.path === root.rollout.path
        ));
        if (roots.some((root) => root !== preferred && !exactAllowed.includes(root))) {
          throw new Error("fixture Codex process has an unexpected open root");
        }
        if (preferred) {
          return preferred;
        }
        if (exactAllowed[0]) {
          return exactAllowed[0];
        }
        throw new Error("fixture Codex preferred open root is unavailable");
      }
      const probeCount = fs.existsSync(fixture.rolloutProbeCountPath)
        ? Number(fs.readFileSync(fixture.rolloutProbeCountPath, "utf8"))
        : 0;
      const nextProbeCount = probeCount + 1;
      fs.writeFileSync(fixture.rolloutProbeCountPath, String(nextProbeCount));
      if (fixture.materializeRolloutOnProbe === nextProbeCount) {
        fs.writeFileSync(fixture.materializedPath, "ready");
      }
      if (!fs.existsSync(fixture.materializedPath)) {
        return undefined;
      }
      if (
        fixture.appendAcceptanceOnProbe === nextProbeCount &&
        fixture.deferredAcceptanceRequest
      ) {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          fixture.deferredAcceptanceRequest,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date().toISOString()
          }
        );
        fs.appendFileSync(
          fixture.activeRolloutPath,
          `${JSON.stringify({
            timestamp: "2026-08-06T00:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: FIRST_NATIVE_TURN_ID,
              last_agent_message: "Recovered exact result"
            }
          })}\n`
        );
        fs.writeFileSync(
          fixture.screenPath,
          `Recovered exact result\n${codexTestComposerScreen()}`
        );
        fixture.appendAcceptanceOnProbe = undefined;
      }
      const processBirth = fs.readFileSync(
        fixture.processBirthPath,
        "utf8"
      ).trim();
      const stat = fs.statSync(fixture.activeRolloutPath);
      return {
        sessionId: fixture.activeNativeThreadId,
        processUuid: processUuid(pid, processBirth),
        processBirth,
        rollout: {
          fd: "12u",
          device: String(stat.dev),
          inode: String(stat.ino),
          path: fs.realpathSync(fixture.activeRolloutPath)
        },
        evidence: "open_rollout_fd"
      };
    }
  };
}

function fixtureCodexOpenRootInventory(
  fixture: NoRolloutFixture,
  cwd = String(fixture.terminalControl.currentPath)
): CodexOpenRootRolloutInventory {
  const records = [`p${fixture.codexPid}`];
  for (const root of fixture.openRootRollouts ?? []) {
    const rolloutPath = fs.realpathSync(root.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    records.push(
      `f${root.fd}`,
      "tREG",
      `D${stat.dev}`,
      `i${stat.ino}`,
      `n${rolloutPath}`
    );
  }
  return inspectCodexOpenRootRolloutInventory({
    codexHome: fixture.codexHome,
    pid: fixture.codexPid,
    cwd,
    processBirth: fs.readFileSync(
      fixture.processBirthPath,
      "utf8"
    ).trim(),
    lsofOutput: `${records.join("\n")}\n`
  });
}

function createFixtureLifecycleProvider(
  fixture: NoRolloutFixture
): TerminalThreadLifecycleCandidateProvider {
  const currentCandidate = (
    request: TerminalThreadLifecycleCandidateRequest
  ): TerminalThreadLifecycleCandidate | undefined => {
    if (
      !fixture.persistedCandidate ||
      path.resolve(request.cwd) !==
        path.resolve(String(fixture.terminalControl.currentPath))
    ) {
      return undefined;
    }
    const rolloutPath = fs.realpathSync(fixture.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    const fileToken = {
      path: rolloutPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
    const metadataFingerprint = createHash("sha256")
      .update(JSON.stringify({
        nativeThreadId: NATIVE_THREAD_ID,
        cwd: path.resolve(String(fixture.terminalControl.currentPath)),
        originator: "codex-tui",
        source: "cli",
        cliVersion: fixture.codexVersion,
        modelProvider: null,
        rolloutPath
      }))
      .digest("hex");
    const candidateToken = {
      schema: "agent-knock-knock/thread-candidate-token" as const,
      version: 1 as const,
      agent: "codex" as const,
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: path.resolve(String(fixture.terminalControl.currentPath)),
      source: "codex_rollout" as const,
      agentVersion: request.agentVersion,
      fileToken,
      metadataFingerprint
    };
    return {
      agent: "codex",
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: candidateToken.cwd,
      source: "codex_rollout",
      rootInteractive: true,
      fileToken,
      agentVersion: request.agentVersion,
      sourceAgentVersion: fixture.codexVersion,
      updatedAtMs: 1_786_000_000_000,
      metadataFingerprint,
      candidateToken
    };
  };
  return {
    async listThreadLifecycleCandidates(request) {
      const candidate = currentCandidate(request);
      return candidate ? [candidate] : [];
    },
    async revalidateThreadLifecycleCandidate(candidateOrToken, request) {
      const current = currentCandidate(request);
      if (!current) {
        return { status: "unavailable", reason: "fixture candidate unavailable" };
      }
      const supplied = "candidateToken" in candidateOrToken
        ? candidateOrToken.candidateToken
        : candidateOrToken as TerminalThreadLifecycleCandidateToken;
      return JSON.stringify(supplied) === JSON.stringify(current.candidateToken)
        ? { status: "valid", candidate: current }
        : { status: "changed", reason: "fixture candidate token changed" };
    }
  };
}

function runInProcessTmux(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  args: string[],
  nowMs: number
): CommandResult {
  fs.appendFileSync(
    fixture.tmuxCallsPath,
    `${JSON.stringify({ args, at: nowMs })}\n`
  );
  if (args[0] === "list-panes") {
    const injectDeferredIdentityDrift =
      env.AKK_TEST_DEFERRED_IDENTITY_DRIFT_BEFORE_TEXT === "1" &&
      listDeferredForegroundTransfers(fixture.storeDir).some(
        (transfer) =>
          transfer.status === "target_prepared" &&
          transfer.input_stage === "none"
      ) &&
      listConversations(fixture.storeDir).some((conversation) =>
        (conversation.native_session_takeover as Record<string, any> | undefined)
          ?.terminal_bridge_submission?.status === "prepared"
      );
    return successfulCommand(
      `${fixture.target.split(":")[0]}\t0\t0\t` +
      `${injectDeferredIdentityDrift
        ? Number(fixture.terminalControl.panePid) + 1
        : fixture.terminalControl.panePid}\tcodex\t` +
      `${fixture.terminalControl.currentPath}\t` +
      `\t${FIXTURE_TMUX_PANE_ID}\n`
    );
  }
  if (args[0] === "display-message") {
    return successfulCommand(
      fixture.viewportColumns === null
        ? ""
        : `${fixture.viewportColumns}\t${fixture.viewportRows}\n`
    );
  }
  if (args[0] === "capture-pane") {
    const screen = fs.readFileSync(fixture.screenPath, "utf8");
    return successfulCommand(
      args.includes("-e")
        ? screen
        : screen.replace(/\u001b\[[0-9;]*m/gu, "")
    );
  }
  if (args[0] === "send-keys" && args.includes("-l")) {
    const text = String(args.at(-1) ?? "");
    if (env.AKK_TEST_TMUX_TEXT_FAILURE === "1" && text !== "/status") {
      return {
        status: 1,
        stdout: "",
        stderr: "injected tmux text failure"
      };
    }
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    fs.writeFileSync(pendingInputPath, text);
    if (text !== "/status") {
      fs.writeFileSync(fixture.screenPath, codexTestComposerScreen(text));
    }
    if (
      text !== "/status" &&
      env.AKK_TEST_MATERIALIZE_ROLLOUT_AFTER_TEXT === "1"
    ) {
      fs.writeFileSync(fixture.materializedPath, "ready");
      appendNativeAcceptance(
        fixture.activeRolloutPath,
        text,
        FIRST_NATIVE_TURN_ID,
        {
          nativeThreadId: fixture.activeNativeThreadId,
          workspace: String(fixture.terminalControl.currentPath),
          codexVersion: fixture.codexVersion,
          timestamp: new Date(nowMs).toISOString()
        }
      );
    }
    if (text === "/status") {
      fs.writeFileSync(
        fixture.screenPath,
        fixture.codexVersion === "0.147.0"
          ? "Ready\n› /status\n\n" +
            "  /status      show current session configuration and token usage\n" +
            "  /statusline  configure which items appear in the status line\n"
          : "Ready\n› /status\n\n" +
            "  /status  show current session configuration and token usage\n"
      );
      if (env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT
        );
      }
    }
    return successfulCommand();
  }
  if (args[0] === "send-keys" && args.at(-1) === "C-u") {
    fs.writeFileSync(path.join(fixture.tempDir, "pending-input.txt"), "");
    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    return successfulCommand();
  }
  if (args[0] === "send-keys" && args.at(-1) === "C-m") {
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    const pendingInput = fs.existsSync(pendingInputPath)
      ? fs.readFileSync(pendingInputPath, "utf8")
      : "";
    fs.writeFileSync(pendingInputPath, "");
    if (pendingInput === "/status") {
      const statusSession = env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
        ? `${fixture.activeNativeThreadId.slice(0, 10)}...`
        : fixture.activeNativeThreadId;
      fs.writeFileSync(
        fixture.screenPath,
        `/status\n╭──────────────────────────────────────────────────╮\n` +
        `│ OpenAI Codex (v${fixture.codexVersion})                       │\n` +
        `│ Session: ${statusSession} │\n` +
        "│ Account: private@example.com                 │\n" +
        `╰──────────────────────────────────────────────────╯\n` +
        codexTestComposerScreen()
      );
    } else if (pendingInput === "/clear") {
      const nextRolloutPath = path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-06T01-00-00-${EXTERNAL_THREAD_ID}.jsonl`
      );
      fs.writeFileSync(nextRolloutPath, `${JSON.stringify({
        timestamp: "2026-08-06T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: EXTERNAL_THREAD_ID,
          cwd: fixture.terminalControl.currentPath,
          originator: "codex-tui",
          source: "cli",
          cli_version: fixture.codexVersion
        }
      })}\n`, { mode: 0o600 });
      fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
      fixture.activeRolloutPath = nextRolloutPath;
      fs.writeFileSync(fixture.materializedPath, "ready");
      fs.writeFileSync(
        fixture.screenPath,
        `New Codex thread ${EXTERNAL_THREAD_ID}\n` +
        codexTestComposerScreen()
      );
    } else {
      if (env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
        );
      }
      fs.writeFileSync(fixture.materializedPath, "ready");
      if (
        env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE === "1" ||
        fixture.acceptanceNativeThreadIdsOnEnter?.length === 0
      ) {
        if (!fs.existsSync(fixture.activeRolloutPath)) {
          fs.mkdirSync(path.dirname(fixture.activeRolloutPath), {
            recursive: true,
            mode: 0o700
          });
          fs.writeFileSync(fixture.activeRolloutPath, `${JSON.stringify({
            timestamp: new Date(nowMs).toISOString(),
            type: "session_meta",
            payload: {
              id: fixture.activeNativeThreadId,
              cwd: fixture.terminalControl.currentPath,
              originator: "codex-tui",
              source: "cli",
              cli_version: fixture.codexVersion
            }
          })}\n`, { mode: 0o600 });
        }
      } else if (fixture.acceptanceNativeThreadIdsOnEnter) {
        for (const nativeThreadId of fixture.acceptanceNativeThreadIdsOnEnter) {
          const rolloutPath = ensureFixtureCandidateRollout(
            fixture,
            nativeThreadId,
            new Date(nowMs).toISOString()
          );
          appendNativeAcceptance(
            rolloutPath,
            pendingInput,
            FIRST_NATIVE_TURN_ID,
            {
              nativeThreadId,
              workspace: String(fixture.terminalControl.currentPath),
              codexVersion: fixture.codexVersion,
              timestamp: new Date(nowMs).toISOString()
            }
          );
        }
        fixture.activeNativeThreadId =
          fixture.acceptanceNativeThreadIdsOnEnter[0];
        fixture.activeRolloutPath = ensureFixtureCandidateRollout(
          fixture,
          fixture.activeNativeThreadId,
          new Date(nowMs).toISOString()
        );
      } else {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          pendingInput,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date(nowMs).toISOString()
          }
        );
      }
      for (const nativeThreadId of
        fixture.additionalOpenRootNativeThreadIdsOnEnter ?? []) {
        ensureFixtureCandidateRollout(
          fixture,
          nativeThreadId,
          new Date(nowMs).toISOString()
        );
      }
      fs.writeFileSync(fixture.screenPath, "Working\n");
    }
    return successfulCommand();
  }
  return successfulCommand();
}

function successfulCommand(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  pendingInputPath: string;
  materializedPath: string;
  processBirthPath: string;
  rolloutPath: string;
  codexVersion: "0.146.0" | "0.147.0";
  target: string;
  panePid: number;
  workspace: string;
  viewportColumns: number | null;
  viewportRows: number;
}): void {
  const statusPopup = options.codexVersion === "0.147.0"
    ? "Ready\n› /status\n\n" +
      "  /status      show current session configuration and token usage\n" +
      "  /statusline  configure which items appear in the status line\n"
    : "Ready\n› /status\n\n" +
      "  /status  show current session configuration and token usage\n";
  const fakeTmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args, at: Date.now() }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-birth\t0\t0\t${options.panePid}\tcodex\t${options.workspace}` +
      `\t\t${FIXTURE_TMUX_PANE_ID}\n`
  )});
} else if (args[0] === "display-message") {
  process.stdout.write(${JSON.stringify(
    options.viewportColumns === null
      ? ""
      : `${options.viewportColumns}\t${options.viewportRows}\n`
  )});
} else if (args[0] === "capture-pane") {
  const screen = fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8");
  process.stdout.write(
    args.includes("-e")
      ? screen
      : screen.replace(/\\u001b\\[[0-9;]*m/g, "")
  );
} else if (args[0] === "send-keys" && args.includes("-l")) {
  if (
    process.env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
    args.at(-1) !== "/status"
  ) {
    process.stderr.write("injected tmux text failure");
    process.exitCode = 1;
  } else {
    fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, args.at(-1));
    if (args.at(-1) === "/status") {
      fs.writeFileSync(${JSON.stringify(options.screenPath)},
        ${JSON.stringify(statusPopup)});
      const driftedProcessBirth =
        process.env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT;
      if (driftedProcessBirth) {
        fs.writeFileSync(
          ${JSON.stringify(options.processBirthPath)},
          driftedProcessBirth
        );
      }
    } else {
      const text = String(args.at(-1) ?? "");
      const [first = "", ...continuation] = text.split("\\n");
      fs.writeFileSync(
        ${JSON.stringify(options.screenPath)},
        [
          "Ready",
          "› " + first,
          ...continuation.map((row) => "  " + row),
          ${JSON.stringify(CODEX_TEST_COMPOSER_FOOTER)}
        ].join("\\n")
      );
    }
  }
} else if (args[0] === "send-keys" && args.at(-1) === "C-u") {
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  fs.writeFileSync(
    ${JSON.stringify(options.screenPath)},
    ${JSON.stringify(codexTestComposerScreen())}
  );
} else if (args[0] === "send-keys" && args.at(-1) === "C-m") {
  const pendingInput = fs.existsSync(${JSON.stringify(options.pendingInputPath)})
    ? fs.readFileSync(${JSON.stringify(options.pendingInputPath)}, "utf8")
    : "";
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  if (pendingInput === "/status") {
    const statusSession = process.env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
      ? ${JSON.stringify(`${NATIVE_THREAD_ID.slice(0, 10)}...`)}
      : ${JSON.stringify(NATIVE_THREAD_ID)};
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, ${JSON.stringify(
      `/status\n╭──────────────────────────────────────────────────╮\n` +
      `│ OpenAI Codex (v${options.codexVersion})                       │\n` +
      `│ Session: `
    )} + statusSession + ${JSON.stringify(
      ` │\n│ Account: private@example.com                 │\n` +
      `╰──────────────────────────────────────────────────╯\n` +
      codexTestComposerScreen()
    )});
  } else {
    if (process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
      fs.writeFileSync(
        ${JSON.stringify(options.processBirthPath)},
        process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
      );
    }
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
    const rolloutPath = ${JSON.stringify(options.rolloutPath)};
    if (rolloutPath && pendingInput) {
      const turnId = ${JSON.stringify(FIRST_NATIVE_TURN_ID)};
      if (!fs.existsSync(rolloutPath)) {
        fs.mkdirSync(require("node:path").dirname(rolloutPath), {
          recursive: true,
          mode: 0o700
        });
        fs.writeFileSync(rolloutPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "session_meta",
          payload: {
            id: ${JSON.stringify(NATIVE_THREAD_ID)},
            cwd: ${JSON.stringify(options.workspace)},
            originator: "codex-tui",
            source: "cli",
            cli_version: ${JSON.stringify(options.codexVersion)}
          }
        }) + "\\n", { mode: 0o600 });
      }
      if (process.env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE !== "1") {
        const records = [
          {
            timestamp: "2026-08-06T00:00:01.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId }
          },
          {
            timestamp: "2026-08-06T00:00:01.010Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: pendingInput }],
              internal_chat_message_metadata_passthrough: { turn_id: turnId }
            }
          }
        ];
        fs.appendFileSync(
          rolloutPath,
          records.map((record) => JSON.stringify(record)).join("\\n") + "\\n"
        );
      }
    }
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
}
`, { mode: 0o755 });
}

function writeFakeProcessTools(options: {
  fakeBinDir: string;
  materializedPath: string;
  materializeRolloutOnProbe?: number;
  processBirthPath: string;
  rolloutProbeCountPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
}): void {
  const fakePs = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(fakePs, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.processBirthPath)}, "utf8") + "\\n");
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)});
}
`, { mode: 0o755 });

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  fs.writeFileSync(fakeLsof, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.codexPid}\\nftxt\\nn${options.executablePath}\\n");
} else {
  const probeCountPath = ${JSON.stringify(options.rolloutProbeCountPath)};
  const probeCount = fs.existsSync(probeCountPath)
    ? Number(fs.readFileSync(probeCountPath, "utf8"))
    : 0;
  const nextProbeCount = probeCount + 1;
  fs.writeFileSync(probeCountPath, String(nextProbeCount));
  const materializeOnProbe = ${JSON.stringify(
    options.materializeRolloutOnProbe ?? null
  )};
  if (materializeOnProbe === nextProbeCount) {
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
  }
  if (fs.existsSync(${JSON.stringify(options.materializedPath)})) {
    const canonicalRolloutPath = fs.realpathSync(
      ${JSON.stringify(options.rolloutPath)}
    );
    const stat = fs.statSync(canonicalRolloutPath);
    process.stdout.write("p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn" + canonicalRolloutPath + "\\n");
  }
}
`, { mode: 0o755 });
}

function writeFakeSqlite(options: {
  fakeBinDir: string;
  nativeThreadId: string;
  rolloutPath: string;
  workspace: string;
}): void {
  const columns = [
    "id",
    "cwd",
    "rollout_path",
    "updated_at_ms",
    "archived",
    "source",
    "cli_version"
  ].map((name) => ({ name }));
  const rows = [{
    id: options.nativeThreadId,
    cwd: options.workspace,
    rollout_path: options.rolloutPath,
    updated_at_ms: 1_786_000_000_000,
    archived: 0,
    source: "cli",
    cli_version: "0.146.0"
  }];
  fs.writeFileSync(path.join(options.fakeBinDir, "sqlite3"), `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const sql = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!sql || sql === "BEGIN;" || sql === "COMMIT;" || sql === ".quit") {
      continue;
    }
    if (sql === "pragma table_info(threads);") {
      process.stdout.write(${JSON.stringify(JSON.stringify(columns) + "\n")});
      continue;
    }
    const control = /^select '([^']+)' as "__akk_sqlite_control";$/u.exec(sql);
    if (control) {
      process.stdout.write(JSON.stringify([{
        __akk_sqlite_control: control[1]
      }]) + "\\n");
      continue;
    }
    if (sql.startsWith("select id")) {
      process.stdout.write(${JSON.stringify(JSON.stringify(rows) + "\n")});
      continue;
    }
    process.stderr.write("unexpected sqlite query: " + sql);
    process.exitCode = 1;
  }
});
process.stdin.resume();
`, { mode: 0o755 });
}

function readTmuxCalls(
  filePath: string
): Array<{ args: string[]; at?: number }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appendNativeAcceptance(
  rolloutPath: string,
  request: string,
  turnId: string,
  metadata: {
    nativeThreadId: string;
    workspace: string;
    codexVersion: string;
    timestamp: string;
  }
): void {
  if (!request) {
    return;
  }
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: metadata.timestamp,
      type: "session_meta",
      payload: {
        id: metadata.nativeThreadId,
        cwd: metadata.workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: metadata.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  const records = [
    {
      timestamp: "2026-08-06T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId }
    },
    {
      timestamp: "2026-08-06T00:00:01.010Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    }
  ];
  fs.appendFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

function enableFixtureCandidateInventory(
  fixture: NoRolloutFixture,
  nativeThreadIds: string[]
): void {
  fixture.openRootRollouts = [];
  for (const nativeThreadId of nativeThreadIds) {
    ensureFixtureCandidateRollout(fixture, nativeThreadId);
  }
}

function ensureFixtureCandidateRollout(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  materializedAt = new Date().toISOString()
): string {
  const existing = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  if (existing) {
    return existing.rolloutPath;
  }
  const rolloutPath = nativeThreadId === NATIVE_THREAD_ID
    ? fixture.rolloutPath
    : path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-12T00-00-00-${nativeThreadId}.jsonl`
      );
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: materializedAt,
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: fixture.terminalControl.currentPath,
        originator: "codex-tui",
        source: "cli",
        cli_version: fixture.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  fixture.openRootRollouts?.push({
    nativeThreadId,
    rolloutPath,
    fd: `${12 + (fixture.openRootRollouts?.length ?? 0)}u`
  });
  return rolloutPath;
}

function appendFixtureCompletion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  text = "Candidate rollout completed exactly once."
): void {
  const rolloutPath = ensureFixtureCandidateRollout(
    fixture,
    nativeThreadId
  );
  fs.appendFileSync(rolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: FIRST_NATIVE_TURN_ID,
      last_agent_message: text
    }
  })}\n`);
  fs.writeFileSync(
    fixture.screenPath,
    `${text}\n${codexTestComposerScreen()}`
  );
}

async function waitForFixtureConversation(
  statePath: string,
  predicate: (conversation: Record<string, any>) => boolean,
  timeoutMs: number
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    const current = JSON.parse(
      fs.readFileSync(statePath, "utf8")
    ) as Record<string, any>;
    latest = current;
    if (predicate(current)) {
      return current;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `fixture conversation did not settle before ${timeoutMs}ms: ` +
      JSON.stringify({
        status: latest?.status,
        stalled_reason: latest?.stalled_reason,
        native_session_takeover: latest?.native_session_takeover
      }, null, 2)
  );
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture process ${pid} did not exit before ${timeoutMs}ms`);
}

export {
  binPath,
  LIVE_PROCESS_BIRTH,
  STALE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  EXTERNAL_THREAD_ID,
  SECOND_EXTERNAL_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  FIXTURE_TMUX_PANE_ID,
  SIMULATED_DEAD_CLI_PID,
  CODEX_TEST_COMPOSER_FOOTER,
  codexTestComposerScreen,
  createNoRolloutFixture,
  persistStatusCardSession,
  persistExactEndedRolloutSession,
  persistDetachedRolloutCompanion,
  persistConflictSession,
  listFixtureTerminal,
  deferredForegroundSendAction,
  assertTerminalUserExplicitSendAction,
  deferredForegroundSendArgs,
  userExplicitDeferredForegroundSendArgs,
  seedStatusCardManagedApproval,
  approvalKeyCalls,
  codexApprovalScreen,
  soleDeferredForegroundTransfer,
  taskInputCalls,
  assertSingleTaskInput,
  persistedCodexV3AcceptanceAnchor,
  assertRecoveredTurnBlocksDuplicate,
  readSoleTerminalDispatchLedger,
  soleTerminalDispatchLedgerPath,
  seedResolvedHistoricalDispatchAndStatusCard,
  materializePreparedDeferredLedgerWithoutTurnState,
  assertExactDeferredZeroInputAbortLedger,
  assertResolvedSameUuidDeferredTransfer,
  reconcileArguments,
  persistBlockingTurn,
  persistLegacyV1UncertainTurn,
  persistReleasedCandidateSourceTurns,
  persistUnresolvedTransition,
  persistUnresolvedDispatchLedger,
  processUuid,
  InProcessCliExit,
  rewriteSnapshotLockOwners,
  restoreDirectorySnapshot,
  fixtureMutableCheckpoint,
  restoreFixtureMutableCheckpoint,
  runCli,
  runCliCrashCheckpoint,
  runCliSubprocess,
  spawnFixtureNodeEval,
  inProcessFixtures,
  fixtureHerdrResponse,
  createFixtureHerdrProvider,
  inProcessDependencies,
  fixtureProcessSnapshots,
  createFixtureCodexAdapter,
  fixtureCodexOpenRootInventory,
  createFixtureLifecycleProvider,
  runInProcessTmux,
  successfulCommand,
  errorMessage,
  writeFakeTmux,
  writeFakeProcessTools,
  writeFakeSqlite,
  readTmuxCalls,
  appendNativeAcceptance,
  enableFixtureCandidateInventory,
  ensureFixtureCandidateRollout,
  appendFixtureCompletion,
  waitForFixtureConversation,
  waitForProcessExit,
};

export type {
  NoRolloutFixture,
  CliTestResult,
  FixtureMutableCheckpoint,
  CapturedInProcessExit,
};
