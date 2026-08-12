import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-management-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("list exposes physical tmux terminals with the terminal-first action contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-groups-"));
  const storeDir = path.join(tempDir, "conversations");
  const nativeWorkspace = path.join(tempDir, "native");
  const tmuxWorkspace = path.join(tempDir, "tmux");
  const approvalScreen = [
    "Would you like to run the following command?",
    "",
    "› 1. Yes, allow (y)",
    "  2. No (n)"
  ].join("\n");

  try {
    fs.mkdirSync(nativeWorkspace, { recursive: true });
    fs.mkdirSync(tmuxWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([
        {
          pid: 1234,
          ppid: 1,
          elapsed: "00:12",
          command: "codex",
          cwd: nativeWorkspace
        },
        {
          pid: 2222,
          ppid: 3333,
          elapsed: "00:30",
          command: "codex",
          cwd: tmuxWorkspace
        },
        {
          pid: 3333,
          ppid: 9999,
          elapsed: "00:31",
          command: "zsh -lc launch-agent",
          cwd: tmuxWorkspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: tmuxWorkspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": approvalScreen
      })
    ]);

    assert.equal("tasks" in listed, false);
    assert.equal("delegated" in listed, false);
    assert.equal("terminal_controlled" in listed, false);
    assert.equal("native" in listed, false);
    assert.deepEqual(listed.unavailable_managed_turns, []);
    assert.equal(listed.terminals.length, 1);
    const terminal = listed.terminals[0];
    assert.equal(terminal.id, "terminal:v2:tmux:codex:codex-work:0.0:2222");
    assert.equal(terminal.source, "terminal");
    assert.equal(terminal.process_state, "active");
    assert.equal("status" in terminal, false);
    assert.equal("commands" in terminal, false);
    assert.equal(terminal.terminal_control.target, "codex-work:0.0");
    assert.equal(terminal.activity_state, "awaiting_approval");
    assert.match(terminal.activity_reason, /approval prompt/);
    assert.equal(terminal.approval_state.blocked, true);
    assert.equal(terminal.approval_state.approvable, true);
    assert.equal(terminal.management_state, "unmanaged");
    assert.deepEqual(terminal.managed, {
      session_id: null,
      session_short_ref: null,
      current_turn: null,
      recent_turn: null,
      turn_count: 0,
      hidden_turn_count: 0,
      session_count: 0
    });
    assert.equal(listed.action_contracts.version, 14);
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Treat terminals\[\] as the primary resource/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /handoff_decision\.choices\.take_over_current\.action[\s\S]*explicit user confirmation[\s\S]*refresh list/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /terminal selector only[\s\S]*explicitly named by the user[\s\S]*prefilled[\s\S]*never infer/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /verified, idle human native-thread switch[\s\S]*expected_terminal_token[\s\S]*atomically adopts/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /status-card-only zero-rollout source[\s\S]*quiescent rollout-backed source[\s\S]*supported Codex \/clear foreground hint[\s\S]*released predecessor Turn history[\s\S]*uniquely accepts that exact request[\s\S]*narrow panes do not require \/status[\s\S]*strict session_id send, respond, approve, cancel, native lifecycle, and native_inspect remain unavailable[\s\S]*do not retry automatically[\s\S]*explicitly closed uncertain Turn[\s\S]*exact resolved close ledger[\s\S]*append-only uncertain receipt[\s\S]*close never forges the lost callback[\s\S]*cannot be renewed/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Managed controls target turn_id[\s\S]*list-prefilled conversation_id/u
    );
    assert.deepEqual(
      listed.action_contracts.field_semantics.process_state,
      {
        terminals: "physical_terminal_process_liveness",
        authoritative_for_tool_calls: false
      }
    );
    assert.deepEqual(
      listed.action_contracts.field_semantics.status,
      {
        managed_turns: "managed_turn_lifecycle",
        authoritative_for_tool_calls: false
      }
    );
    assert.equal(
      listed.action_contracts.field_semantics.activity_state
        .authoritative_for_tool_calls,
      false
    );
    assert.equal(
      listed.action_contracts.field_semantics.managed.current_turn,
      "the authoritative dispatch-ledger owner, never inferred from history"
    );
    assert.equal(
      listed.action_contracts.field_semantics.managed.session_id,
      "the continuing agent context and authoritative ordinary-send target"
    );
    assert.deepEqual(
      listed.action_contracts.field_semantics.available_actions,
      {
        meaning: "currently_safe_actions",
        authoritative_for_tool_calls: true
      }
    );
    assert.match(
      listed.action_contracts.field_semantics
        .native_agent_identity_observation.meaning,
      /verified_absent[\s\S]*unavailable resolver/u
    );
    assert.match(
      listed.action_contracts.field_semantics.management_conflict
        .verified_empty_native_session,
      /snapshot-bound send[\s\S]*isolated virgin Session/u
    );
    assert.equal(
      "status_card_only_deferred_binding" in
        listed.action_contracts.field_semantics.management_conflict,
      false
    );
    assert.match(
      listed.action_contracts.field_semantics.handoff_state
        .verified_empty_native_session_adoptable,
      /listed conflict send[\s\S]*revalidated before terminal input/u
    );
    assert.match(
      listed.action_contracts.actions.send.ordinary_use,
      /verified-empty Codex source[\s\S]*status-card\/candidate-rollout source/u
    );
    assert.match(
      listed.action_contracts.actions.send.status_card_only_deferred_scope,
      /listed selector\/token send[\s\S]*strict managed controls[\s\S]*callback authority remain unavailable[\s\S]*must not be retried automatically/u
    );
    assert.match(
      listed.action_contracts.actions.send.candidate_rollout_deferred_scope,
      /complete exact candidate inventory[\s\S]*supported \/clear foreground hint[\s\S]*predecessor Turn history stays read-only[\s\S]*unique post-anchor request acceptance[\s\S]*Same-UUID and different-UUID results keep separate Session lineages[\s\S]*never retried blindly[\s\S]*Explicit close[\s\S]*append-only receipt[\s\S]*absent old rollout[\s\S]*never synthesizes callback delivery/u
    );
    assert.deepEqual(
      listed.action_contracts.field_semantics.handoff_decision,
      {
        meaning:
          "an explicit human choice required before superseding an active source Turn",
        authoritative_action_path:
          "terminals[].handoff_decision.choices.take_over_current.action",
        requires_explicit_user_confirmation: true,
        after_success: "refresh list before using a follow-current send action"
      }
    );
    assert.deepEqual(
      listed.action_contracts.field_semantics.blocking_turns,
      {
        meaning:
          "terminal-incarnation-wide collateral unresolved managed Turns that suppress send, lifecycle, and native-inspection actions; an active human-handoff source Turn is never listed here and remains governed only by handoff_decision",
        authoritative_action_path:
          "terminals[].blocking_turns[].recovery_action",
        requires_explicit_user_confirmation: true,
        after_success: "refresh list before using any terminal action"
      }
    );
    assert.deepEqual(
      Object.keys(listed.action_contracts.actions),
      [
        "send",
        "new_thread",
        "list_resumable_threads",
        "native_inspect",
        "resume_thread",
        "reconcile_binding",
        "respond",
        "status",
        "approve",
        "cancel",
        "renew",
        "retry_callback",
        "close"
      ]
    );
    assert.equal(
      listed.action_contracts.actions.send.target_argument,
      "session_id"
    );
    assert.equal(
      listed.action_contracts.actions.send.initial_attach_target_argument,
      "selector"
    );
    assert.match(
      listed.action_contracts.actions.send.initial_attach_scope,
      /explicitly named by the user[\s\S]*unmanaged raw-terminal row[\s\S]*never infer/u
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.required,
      ["request"]
    );
    assert.equal(
      listed.action_contracts.actions.send.optional.includes("selector"),
      true
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.unsupported,
      ["timeoutSeconds"]
    );
    assert.deepEqual(
      listed.action_contracts.actions.reconcile_binding.required,
      [
        "terminal_id",
        "conflicting_session_id",
        "expected_session_revision",
        "expected_binding_token",
        "expected_terminal_token"
      ]
    );
    assert.equal(
      listed.action_contracts.actions.reconcile_binding.sends_terminal_input,
      false
    );
    assert.deepEqual(
      listed.action_contracts.actions.native_inspect.required,
      ["terminal_id", "inspection", "expected_binding_token"]
    );
    assert.equal(
      listed.action_contracts.actions.native_inspect.mutates_store,
      false
    );
    for (const action of [
      "respond",
      "status",
      "approve",
      "cancel",
      "renew",
      "retry_callback",
      "close"
    ]) {
      assert.equal(
        listed.action_contracts.actions[action].target_argument,
        "turn_id",
        `${action} must target the exact managed turn`
      );
    }
    assert.equal(
      listed.action_contracts.actions.respond.compatibility_target_argument,
      undefined
    );
    for (const action of ["status", "approve", "cancel", "close"]) {
      assert.equal(
        listed.action_contracts.actions[action].compatibility_target_argument,
        "conversation_id",
        `${action} must document its narrow raw-terminal compatibility target`
      );
      assert.match(
        listed.action_contracts.actions[action].compatibility_scope,
        action === "approve"
          ? /raw-terminal or manual terminal-scoped Codex approval action[\s\S]*never construct/u
          : /unmanaged raw-terminal row[\s\S]*never construct/u,
        `${action} must forbid invented raw-terminal selectors`
      );
    }
    for (const action of ["renew", "retry_callback"]) {
      assert.equal(
        listed.action_contracts.actions[action].compatibility_target_argument,
        "conversation_id",
        `${action} must document its legacy Turn alias`
      );
      assert.match(
        listed.action_contracts.actions[action].compatibility_scope,
        /legacy Turn alias only[\s\S]*never advertise/u,
        `${action} must not advertise a raw-terminal compatibility action`
      );
    }
    assert.deepEqual(
      listed.action_contracts.actions.close.optional,
      [
        "reason",
        "expected_message_id",
        "expected_transition_id",
        "expected_handoff_token"
      ]
    );
    const approvalActions = terminal.available_actions;
    assert.deepEqual(
      approvalActions.status.arguments,
      { conversation_id: terminal.id }
    );
    assert.equal(approvalActions.send, undefined);
    assert.deepEqual(
      approvalActions.approve.arguments,
      { conversation_id: terminal.id }
    );
    assert.deepEqual(
      approvalActions.approve.missing_required,
      ["expected_approval_fingerprint"]
    );
    assert.deepEqual(
      approvalActions.approve.before_call.arguments,
      { conversation_id: terminal.id }
    );
    assert.equal(approvalActions.approve.requires_explicit_user_confirmation, true);
    assert.deepEqual(
      approvalActions.cancel.arguments,
      { conversation_id: terminal.id }
    );
    assert.equal(approvalActions.close, undefined);
    assert.equal(listed.terminal_scan.terminal_count, 1);

    const debugListed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--terminal-debug",
      "--processes-json",
      JSON.stringify([{
        pid: 2222,
        ppid: 9999,
        elapsed: "00:30",
        command: "codex",
        cwd: tmuxWorkspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: tmuxWorkspace
      }])
    ]);
    assert.equal(debugListed.terminal_scan.diagnostics.provider, "registry");
    assert.deepEqual(
      debugListed.terminal_scan.diagnostics.providerKinds,
      ["tmux"]
    );
    assert.equal(
      debugListed.terminal_scan.diagnostics.providers.tmux.provider,
      "static"
    );
    assert.equal(
      debugListed.terminal_scan.diagnostics.providers.tmux.paneCount,
      1
    );

    const managedOnly = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--managed-only",
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 1,
        elapsed: "00:12",
        command: "codex",
        cwd: nativeWorkspace
      }])
    ]);
    assert.deepEqual(managedOnly.unavailable_managed_turns, []);
    assert.equal("native" in managedOnly, false);
    assert.deepEqual(managedOnly.terminals, []);
    assert.equal(managedOnly.terminal_scan.enabled, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list keeps same-named targets from distinct tmux servers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-multi-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const firstWorkspace = path.join(tempDir, "first");
  const secondWorkspace = path.join(tempDir, "second");

  try {
    fs.mkdirSync(firstWorkspace, { recursive: true });
    fs.mkdirSync(secondWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([
        {
          pid: 2201,
          ppid: 9001,
          elapsed: "00:20",
          command: "codex",
          cwd: firstWorkspace
        },
        {
          pid: 2202,
          ppid: 9002,
          elapsed: "00:21",
          command: "codex",
          cwd: secondWorkspace
        }
      ]),
      "--terminals-json",
      JSON.stringify([
        {
          kind: "tmux",
          target: "work:0.0",
          socketPath: "/tmp/tmux-first",
          session: "work",
          window: 0,
          pane: 0,
          panePid: 9001,
          currentCommand: "node",
          currentPath: firstWorkspace
        },
        {
          kind: "tmux",
          target: "work:0.0",
          socketPath: "/tmp/tmux-second",
          session: "work",
          window: 0,
          pane: 0,
          panePid: 9002,
          currentCommand: "node",
          currentPath: secondWorkspace
        }
      ])
    ]);

    assert.equal(listed.terminals.length, 2);
    assert.deepEqual(
      listed.terminals.map((entry: any) => entry.terminal_control.panePid).sort(),
      [9001, 9002]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list exposes terminal-controlled Codex working activity state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-activity-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const workingScreen = [
    "• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    "",
    "› Continue implementation"
  ].join("\n");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 2222,
        ppid: 9999,
        elapsed: "00:30",
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9999,
        currentCommand: "node",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": workingScreen
      })
    ]);

    assert.equal(listed.terminals.length, 1);
    assert.equal(listed.terminals[0].process_state, "active");
    assert.equal(listed.terminals[0].activity_state, "working");
    assert.match(listed.terminals[0].activity_reason, /Working/);
    assert.equal(listed.terminals[0].approval_state.blocked, false);
    assert.equal(listed.terminals[0].approval_state.approvable, false);
    assert.equal("commands" in listed.terminals[0], false);
    assert.equal(listed.terminals[0].available_actions.send, undefined);
    assert.deepEqual(
      listed.terminals[0].available_actions.cancel.arguments,
      { conversation_id: listed.terminals[0].id }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list recognizes the current Codex composer marker and keeps unknown screens fail closed", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-list-current-codex-composer-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-current:0.0";
  const process = {
    pid: 2222,
    ppid: 9999,
    elapsed: "00:30",
    command: "codex",
    cwd: workspace
  };
  const terminal = {
    kind: "tmux",
    target: terminalTarget,
    session: "codex-current",
    window: 0,
    pane: 0,
    panePid: 9999,
    currentCommand: "node",
    currentPath: workspace
  };

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const idle = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([process]),
      "--terminals-json",
      JSON.stringify([terminal]),
      "--terminal-screens-json",
      JSON.stringify({
        [terminalTarget]: [
          "The previous turn is complete.",
          "",
          "» Find and fix a bug in @filename",
          "",
          "gpt-5.6-sol high · /repo"
        ].join("\n")
      })
    ]);
    const idleEntry = idle.terminals[0];
    assert.equal(idleEntry.process_state, "active");
    assert.equal(idleEntry.activity_state, "idle");
    assert.match(idleEntry.activity_reason, /input prompt/u);
    assert.deepEqual(
      idleEntry.available_actions.send.arguments,
      { selector: idleEntry.id }
    );
    assert.equal(idleEntry.available_actions.cancel, undefined);

    const unknown = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([process]),
      "--terminals-json",
      JSON.stringify([terminal]),
      "--terminal-screens-json",
      JSON.stringify({
        [terminalTarget]: [
          "The result contains an inline » symbol.",
          "No current Codex composer is visible."
        ].join("\n")
      })
    ]);
    const unknownEntry = unknown.terminals[0];
    assert.equal(unknownEntry.process_state, "active");
    assert.equal(unknownEntry.activity_state, "unknown");
    assert.equal("commands" in unknownEntry, false);
    assert.deepEqual(
      Object.keys(unknownEntry.available_actions),
      ["status"]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list never advertises raw Claude approval or ambiguous cancellation", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-list-raw-claude-approval-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-raw:0.0";
  const approvalScreen = [
    " Bash command",
    "",
    "   npm test",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No"
  ].join("\n");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 5201,
        ppid: 9002,
        elapsed: "00:30",
        command: "claude",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: terminalTarget,
        session: "claude-raw",
        window: 0,
        pane: 0,
        panePid: 9002,
        currentCommand: "node",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: approvalScreen }),
      "--claude-agents-json",
      JSON.stringify([{
        kind: "interactive",
        pid: 5201,
        sessionId: "claude-session-raw-approval",
        cwd: workspace,
        status: "idle"
      }])
    ]);

    assert.equal(listed.terminals.length, 1);
    const entry = listed.terminals[0];
    assert.equal(entry.agent, "claude");
    assert.equal(entry.available_actions.approve, undefined);
    assert.equal(entry.available_actions.cancel, undefined);
    assert.deepEqual(
      Object.keys(entry.available_actions),
      ["status"]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list discovers Claude and Codex tmux sessions from static runtime snapshots", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-claude-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const codexWorkspace = path.join(tempDir, "codex-workspace");
  const claudeWorkspace = path.join(tempDir, "claude-workspace");

  try {
    fs.mkdirSync(codexWorkspace, { recursive: true });
    fs.mkdirSync(claudeWorkspace, { recursive: true });
    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: 5101,
        ppid: 9001,
        elapsed: "00:20",
        command: "codex",
        cwd: codexWorkspace
      }, {
        pid: 5201,
        ppid: 9002,
        elapsed: "00:30",
        command: "claude",
        cwd: claudeWorkspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 9001,
        currentCommand: "node",
        currentPath: codexWorkspace
      }, {
        kind: "tmux",
        target: "claude-work:1.0",
        session: "claude-work",
        window: 1,
        pane: 0,
        panePid: 9002,
        currentCommand: "node",
        currentPath: claudeWorkspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› ",
        "claude-work:1.0": "❯ "
      }),
      "--claude-agents-json",
      JSON.stringify([{
        kind: "interactive",
        pid: 5201,
        sessionId: "claude-session-list",
        startedAt: 1784870000000,
        cwd: claudeWorkspace,
        status: "idle"
      }])
    ]);

    assert.equal(listed.terminal_scan.active_count, 2);
    assert.equal(listed.terminal_scan.terminal_count, 2);
    assert.deepEqual(listed.terminal_scan.agents, ["codex", "claude"]);
    assert.deepEqual(listed.terminals.map((entry: any) => entry.agent).sort(), ["claude", "codex"]);

    const codex = listed.terminals.find((entry: any) => entry.agent === "codex");
    assert.equal(codex.id, "terminal:v2:tmux:codex:codex-work:0.0:5101");
    assert.equal(codex.source, "terminal");
    assert.equal(codex.process_state, "active");
    assert.equal("commands" in codex, false);
    assert.deepEqual(
      codex.available_actions.send.arguments,
      { selector: codex.id }
    );
    assert.deepEqual(
      codex.available_actions.send.missing_required,
      ["request"]
    );
    assert.equal(codex.available_actions.cancel, undefined);
    assert.equal(codex.terminal_control.capabilities.includes("screen_completion"), true);

    const claude = listed.terminals.find((entry: any) => entry.agent === "claude");
    assert.equal(claude.id, "terminal:v2:tmux:claude:claude-work:1.0:5201");
    assert.equal(claude.native_agent_session_id, "claude-session-list");
    assert.equal(claude.confidence, "high");
    assert.equal(claude.activity_state, "idle");
    assert.equal(claude.source, "terminal");
    assert.equal(claude.process_state, "active");
    assert.equal("commands" in claude, false);
    assert.deepEqual(
      claude.available_actions.send.arguments,
      { selector: claude.id }
    );
    assert.equal(claude.available_actions.cancel, undefined);
    assert.equal(claude.terminal_control.capabilities.includes("durable_completion"), true);
    assert.equal(claude.terminal_control.capabilities.includes("screen_completion"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: process.env
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
