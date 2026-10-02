import assert from "node:assert/strict";
import fs from "node:fs";
import {
  type ManagedSessionState
} from "../../../src/managed-session.js";
import {
  listDeferredForegroundTransfers,
  type DeferredForegroundTransfer
} from "../../../src/deferred-foreground-transfer.js";
import {
  loadManagedSession,
  pathsForManagedSession
} from "../../../src/session-store.js";
import {
  listConversations,
  saveState
} from "../../../src/store.js";
import {
  codexNoRolloutBackgroundSendArgs,
  codexNoRolloutStoreArgs
} from "../codex-no-rollout-cli-harness.js";
import {
  type NoRolloutFixture,
  type CliTestResult
} from "./model.js";
import {
  test
} from "./test-registration.js";
import {
  runCli
} from "./cli.js";
import {
  readTmuxCalls
} from "./rollouts.js";

export async function listFixtureTerminal(
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

export async function deferredForegroundSendAction(
  fixture: NoRolloutFixture
): Promise<Record<string, any>> {
  const terminal = await listFixtureTerminal(fixture);
  return assertTerminalUserExplicitSendAction(terminal);
}

export function assertTerminalUserExplicitSendAction(
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

export function deferredForegroundSendArgs(
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

export function userExplicitDeferredForegroundSendArgs(
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

export async function seedStatusCardManagedApproval(
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

export function approvalKeyCalls(
  fixture: NoRolloutFixture
): Array<{ args: string[]; at?: number }> {
  return readTmuxCalls(fixture.tmuxCallsPath).filter((call) =>
    call.args[0] === "send-keys" && call.args.at(-1) === "y"
  );
}

export function codexApprovalScreen(command: string): string {
  return [
    "  Would you like to run the following command?",
    "",
    `  $ ${command}`,
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)"
  ].join("\n");
}

export function soleDeferredForegroundTransfer(
  fixture: NoRolloutFixture
): DeferredForegroundTransfer {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  assert.equal(transfers.length, 1, JSON.stringify(transfers, null, 2));
  return transfers[0];
}

export function taskInputCalls(
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

export function assertSingleTaskInput(
  fixture: NoRolloutFixture,
  message: string
): void {
  assert.deepEqual(taskInputCalls(fixture, message).map((call) => call.args), [
    ["send-keys", "-t", fixture.inputTarget, "-l", message],
    ["send-keys", "-t", fixture.inputTarget, "C-m"]
  ]);
}

export function persistedCodexV3AcceptanceAnchor(
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

export function assertRecoveredTurnBlocksDuplicate(result: CliTestResult): void {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /unresolved Turn|waiting_for_agent/iu);
  assert.doesNotMatch(
    result.stderr,
    /uncertain dispatch|do not retry|multiple unresolved deferred/iu
  );
}
