import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConversation } from "../src/protocol.js";
import {
  appendEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";
import { runInProcessCli } from "./in-process-cli-fixtures.js";

const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-management-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("status --trace preserves the bounded redacted executor-log view", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-trace-"));
  const storeDir = path.join(tempDir, "store");
  try {
    const base = createConversation({
      userRequest: "inspect the trace",
      executorKind: "codex",
      executorSession: "codex-trace",
      workspace: tempDir,
      now: new Date("2026-08-14T00:00:00.000Z")
    });
    const paths = pathsForConversation(base.conversation_id, storeDir);
    const conversation = {
      ...base,
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath
    };
    saveState(paths.statePath, conversation);
    const outputPath = path.join(paths.conversationDir, "codex-output.log");
    fs.writeFileSync(outputPath, [
      "[thinking] private reasoning",
      "[tool] shell --token private-token (completed)",
      "output:",
      "password=private-value",
      "[done] completed"
    ].join("\n"));
    appendEvent(paths.logPath, {
      event: "executor_launch",
      conversation_id: conversation.conversation_id,
      output_path: outputPath
    });

    const status = await runCli([
      "status",
      "--state",
      paths.statePath,
      "--trace"
    ]);
    assert.equal(status.trace.source, "executor_output_log");
    assert.equal(status.trace.output_path, outputPath);
    assert.equal(status.trace.thinking_redacted_count, 1);
    assert.deepEqual(status.trace.agent_messages, [
      { kind: "thinking", body: "[redacted]" }
    ]);
    assert.equal(status.trace.tool_calls[0].name, "shell --token <redacted>");
    assert.equal(status.trace.tool_calls[0].output_preview, "password=<redacted>");
    assert.doesNotMatch(JSON.stringify(status.trace), /private-token|private-value/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list exposes physical tmux terminals with the terminal-first action contract", async () => {
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
    const listed = await runCli([
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
    assert.equal(listed.action_contracts.version, 23);
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Treat terminals\[\] as the primary resource/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /terminal_user_explicit[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state[\s\S]*Composer visibility, stability, or exactness do not veto[\s\S]*C-u[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*no Composer observation may veto Enter[\s\S]*unmanaged work[\s\S]*Terminal Watch callback[\s\S]*failure is reported/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /parsed working activity does not veto/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /handoff_decision\.choices\.take_over_current\.action[\s\S]*explicit user confirmation[\s\S]*refresh list/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /user-explicit raw terminal selector[\s\S]*discovery choice[\s\S]*exact terminal_id prefilled[\s\S]*never infer/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /verified, idle human native-thread switch[\s\S]*atomically adopts/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /session_exact[\s\S]*terminal_follow_current/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /rollout-backed managed Codex pane[\s\S]*exact terminal_id[\s\S]*one materialized rollout does not prove the current (?:Codex )?TUI foreground thread/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /complete nonempty pinned open-rollout inventory[\s\S]*one post-anchor rollout uniquely accepts that exact request/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /\/clear resume hint is diagnostic only/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /released predecessor Turn history[\s\S]*narrow panes do not require \/status[\s\S]*strict session_id send, respond, approve, cancel, native lifecycle, and native_inspect remain unavailable[\s\S]*do not retry automatically/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Explicit Close always honors the user's decision[\s\S]*sends no terminal input[\s\S]*never stops the coding agent or pane[\s\S]*best-effort cleanup warnings without vetoing the Close[\s\S]*Refresh list afterward and use Watch/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Managed controls target turn_id[\s\S]*list-prefilled conversation_id/u
    );
    assert.match(
      listed.action_contracts.instructions.join("\n"),
      /Manual approval binds the exact prompt[\s\S]*prompt authority private[\s\S]*complete exact evidence is not approvable/u
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
    assert.match(
      listed.action_contracts.field_semantics.managed.session_id,
      /continuing agent context[\s\S]*ordinary-send target only when (?:the listed send action|available_actions\.send) (?:explicitly )?prefills it[\s\S]*rollout-backed Codex uses the listed follow-current terminal action instead/u
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
      /listed follow-current send[\s\S]*strict managed controls[\s\S]*callback authority remain unavailable[\s\S]*must not be retried automatically/u
    );
    assert.match(
      listed.action_contracts.actions.send.candidate_rollout_deferred_scope,
      /complete nonempty candidate inventory[\s\S]*one rollout is materialized[\s\S]*does not prove the current TUI foreground thread[\s\S]*predecessor Turn history stays read-only[\s\S]*unique post-anchor request acceptance[\s\S]*\/clear resume hint is diagnostic only[\s\S]*not routing authority[\s\S]*Same-UUID and different-UUID results keep separate Session lineages[\s\S]*never retried blindly[\s\S]*Explicit Close is the user-owned escape hatch[\s\S]*closes the AKK Turn first[\s\S]*best-effort releases only linked AKK metadata[\s\S]*without terminal input or coding-agent interruption/u
    );
    assert.match(
      listed.action_contracts.actions.send.ordinary_use,
      /session_id never follows the pane[\s\S]*unavailable for rollout-backed Codex Sessions[\s\S]*listed follow-current action[\s\S]*unique exact rollout/u
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
          "terminal-incarnation-wide unresolved managed Turns that suppress managed send, lifecycle, and native-inspection actions but never terminal_user_explicit physical Send; each exact Turn remains explicitly closable even during a deferred transfer or human handoff",
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
        "retry_submission",
        "watch",
        "unwatch",
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
    assert.deepEqual(
      listed.action_contracts.actions.retry_submission,
      {
        tool: "agent_knock_knock_send",
        target_argument: "turn_id",
        required: ["turn_id"],
        accepts_only: ["turn_id"],
        creates_turn: false,
        caller_supplies_request_text: false,
        may_retransmit_original_request_text: true,
        retransmit_condition:
          "durable structured proof that Enter was never attempted plus a positively empty live composer",
        requires_explicit_user_confirmation: true,
        candidate_source:
          "the current exact managed Turn's available_actions.retry_submission",
        scope:
          "Recover only the original durable submission whose text injection is proven but Enter dispatch remains uncertain. AKK either submits the proven exact existing draft once, or retransmits the immutable original request once only after structured no-Enter proof and a positively empty live composer. It revalidates all terminal, identity, route, composer, and one-shot authority under lock and otherwise fails closed."
      }
    );
    assert.equal(
      listed.action_contracts.actions.send.initial_attach_target_argument,
      "terminal_id"
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.managed_scopes,
      {
        session_exact: {
          target_arguments: ["session_id"],
          follows_current_terminal: false
        },
        terminal_follow_current: {
          target_arguments: ["terminal_id"],
          follows_current_terminal: true
        }
      }
    );
    assert.match(
      listed.action_contracts.actions.send.initial_attach_scope,
      /terminal_user_explicit[\s\S]*terminal_id prefilled by an exact live terminal row[\s\S]*selector explicitly named by the user[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state[\s\S]*C-u[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*without a post-text Composer veto/u
    );
    assert.equal(
      listed.action_contracts.actions.send
        .codex_terminal_user_explicit_composer_policy,
      "replace_current_composer_and_submit"
    );
    assert.deepEqual(
      listed.action_contracts.actions.send.required,
      ["request"]
    );
    assert.equal(
      listed.action_contracts.actions.approve.approval_authority,
      "private_server_bound_reviewed_prompt"
    );
    assert.equal(
      listed.action_contracts.actions.approve.missing_prompt_region_evidence,
      "not_approvable"
    );
    assert.equal(
      listed.action_contracts.actions.send.optional.includes("terminal_id"),
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
        "conflicting_session_id"
      ]
    );
    assert.equal(
      listed.action_contracts.actions.reconcile_binding.sends_terminal_input,
      false
    );
    assert.deepEqual(
      listed.action_contracts.actions.native_inspect.required,
      ["terminal_id", "inspection"]
    );
    assert.equal(
      listed.action_contracts.actions.native_inspect.mutates_store,
      false
    );
    for (const action of [
      "respond",
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
    assert.deepEqual(
      listed.action_contracts.actions.status.target_arguments,
      { exactly_one_of: ["turn_id", "conversation_id", "watch_id"] }
    );
    assert.deepEqual(
      listed.action_contracts.actions.approve.target_arguments,
      { exactly_one_of: ["turn_id", "terminal_id"] }
    );
    for (const action of ["status", "cancel", "close"]) {
      assert.equal(
        listed.action_contracts.actions[action].compatibility_target_argument,
        "conversation_id",
        `${action} must document its narrow raw-terminal compatibility target`
      );
      assert.match(
        listed.action_contracts.actions[action].compatibility_scope,
        /unmanaged raw-terminal row[\s\S]*never construct/u,
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
        "expected_transition_id"
      ]
    );
    assert.equal(
      listed.action_contracts.actions.close.requires_explicit_user_confirmation,
      true
    );
    assert.equal(listed.action_contracts.actions.close.user_priority, true);
    assert.equal(listed.action_contracts.actions.close.sends_terminal_input, false);
    assert.equal(listed.action_contracts.actions.close.stops_coding_agent, false);
    assert.match(
      listed.action_contracts.actions.close.cleanup_policy,
      /Close the selected AKK Turn first[\s\S]*best-effort[\s\S]*preserved and reported as a warning rather than blocking Close/u
    );
    assert.match(
      listed.action_contracts.actions.close.handoff_scope,
      /same user-priority management-release path[\s\S]*does not depend on a private live-terminal fence/u
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

    const debugListed = await runCli([
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

    const managedOnly = await runCli([
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

test("list keeps same-named targets from distinct tmux servers", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-multi-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const firstWorkspace = path.join(tempDir, "first");
  const secondWorkspace = path.join(tempDir, "second");

  try {
    fs.mkdirSync(firstWorkspace, { recursive: true });
    fs.mkdirSync(secondWorkspace, { recursive: true });
    const listed = await runCli([
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

test("list exposes terminal-controlled Codex working activity state", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-activity-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const workingScreen = [
    "• Working (8s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    "",
    "›"
  ].join("\n");

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const listed = await runCli([
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
    assert.equal(
      listed.terminals[0].available_actions.send.scope,
      "terminal_user_explicit"
    );
    assert.deepEqual(
      listed.terminals[0].available_actions.cancel.arguments,
      { conversation_id: listed.terminals[0].id }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list recognizes the current Codex composer marker and keeps explicit Send on unknown non-approval screens", async () => {
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
    const idle = await runCli([
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
    assert.equal(
      idleEntry.available_actions.send.arguments.selector,
      idleEntry.id
    );
    assert.equal(
      typeof idleEntry.available_actions.send.arguments.expected_terminal_token,
      "string"
    );
    assert.equal(
      idleEntry.available_actions.send.scope,
      "terminal_user_explicit"
    );
    assert.equal(
      idleEntry.available_actions.send.composer_policy,
      "replace_current_composer_and_submit"
    );
    assert.equal(idleEntry.available_actions.cancel, undefined);

    const unknown = await runCli([
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
      ["status", "send"]
    );
    assert.equal(
      unknownEntry.available_actions.send.scope,
      "terminal_user_explicit"
    );
    assert.equal(
      unknownEntry.available_actions.send.composer_policy,
      "replace_current_composer_and_submit"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list never advertises raw Claude approval or ambiguous cancellation", async () => {
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
    const listed = await runCli([
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

test("list discovers Claude and Codex tmux sessions from static runtime snapshots", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-claude-tmux-"));
  const storeDir = path.join(tempDir, "conversations");
  const codexWorkspace = path.join(tempDir, "codex-workspace");
  const claudeWorkspace = path.join(tempDir, "claude-workspace");

  try {
    fs.mkdirSync(codexWorkspace, { recursive: true });
    fs.mkdirSync(claudeWorkspace, { recursive: true });
    const listed = await runCli([
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
    assert.equal(
      codex.available_actions.send.arguments.selector,
      codex.id
    );
    assert.equal(
      typeof codex.available_actions.send.arguments.expected_terminal_token,
      "string"
    );
    assert.equal(codex.available_actions.send.scope, "terminal_user_explicit");
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
    assert.equal(
      claude.available_actions.send.arguments.selector,
      claude.id
    );
    assert.equal(
      typeof claude.available_actions.send.arguments.expected_terminal_token,
      "undefined"
    );
    assert.equal(claude.available_actions.send.scope, undefined);
    assert.equal(claude.available_actions.cancel, undefined);
    assert.equal(claude.terminal_control.capabilities.includes("durable_completion"), true);
    assert.equal(claude.terminal_control.capabilities.includes("screen_completion"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

async function runCli(args: string[]) {
  const result = await runInProcessCli(args, {
    env: { ...process.env },
    processBirthForPid: (pid) => `management-fixture-process-birth:${pid}`
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
