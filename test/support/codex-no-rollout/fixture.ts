import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  TerminalControlRef
} from "../../../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  tmuxTerminalRouteKey
} from "../../../src/terminal-control-ref.js";
import {
  LIVE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  FIXTURE_TMUX_PANE_ID,
  codexTestComposerScreen,
  type NoRolloutFixture,
  inProcessFixtures
} from "./model.js";
import {
  test
} from "./test-registration.js";
import {
  writeFakeTmux,
  writeFakeProcessTools,
  writeFakeSqlite
} from "./fake-executables.js";

export function createNoRolloutFixture(
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
      AKK_NATIVE_CODEX_HOMES: JSON.stringify([codexHome]),
      AKK_DESKTOP_CODEX_HOMES: JSON.stringify([codexHome]),
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
