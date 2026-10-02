import {
  type CommandResult
} from "../../../src/terminal-control-provider.js";
import type {
  TerminalControlRef
} from "../../../src/terminal-agent-adapter.js";

export const binPath = new URL("../../../src/cli.js", import.meta.url).pathname;

export const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";

export const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";

export const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";

export const EXTERNAL_THREAD_ID = "22222222-2222-4222-8222-222222222222";

export const SECOND_EXTERNAL_THREAD_ID = "33333333-3333-4333-8333-333333333333";

export const FIRST_NATIVE_TURN_ID = "44444444-4444-4444-8444-444444444444";

export const FIXTURE_TMUX_PANE_ID = "%42";

export const SIMULATED_DEAD_CLI_PID = 2_147_483_647;

export const CODEX_TEST_COMPOSER_FOOTER = "gpt-5.6-sol high · /repo";

export function codexTestComposerScreen(text = ""): string {
  const [first = "", ...continuation] = text.split("\n");
  return [
    "Ready",
    `› ${first}`,
    ...continuation.map((row) => `  ${row}`),
    CODEX_TEST_COMPOSER_FOOTER
  ].join("\n");
}

export function processUuid(pid: number, processBirth: string): string {
  return `codex-pid:${pid}:birth:${processBirth}`;
}

export class InProcessCliExit extends Error {
  constructor(readonly status: number) {
    super(`in-process CLI exit ${status}`);
  }
}

export const inProcessFixtures = new Map<string, NoRolloutFixture>();

export function successfulCommand(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface NoRolloutFixture {
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

export interface CliTestResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface FixtureMutableCheckpoint {
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

export interface CapturedInProcessExit {
  status: number;
  snapshotRoot: string;
  snapshotPath: string;
}
