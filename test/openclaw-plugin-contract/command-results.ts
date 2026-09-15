import { spawnSync } from "node:child_process";
import {
  test,
  assert,
  fs,
  os,
  path,
  plugin,
  createOpenClawPluginForTest,
  assertNoModelOpaqueAuthority,
  assertModelToolResultHasNoOpaqueAuthority,
  packageRoot,
  readManifest,
  requiredStringArray,
  isRecord,
  type ToolDefinition,
  type ToolFactory
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw controls distinguish managed turns from list-prefilled raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-turn-controls-"));
  const fakeCli = path.join(tempDir, "controls.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const changedAuthorityPath = path.join(tempDir, "changed-authority");
  const tools = new Map<string, ToolDefinition>();
  const toolFactories = new Map<string, ToolFactory>();
  let command:
    | {
        handler?: (context: {
          args: string;
          sessionKey: string;
          sessionId?: string;
        }) => Promise<any>;
      }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const args = process.argv.slice(2);`,
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const fs = require("node:fs");`,
        `const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";`,
        `const changed = fs.existsSync(${JSON.stringify(changedAuthorityPath)});`,
        `const approvalFingerprint = (changed ? "b" : "a").repeat(64);`,
        `const rejectFingerprint = (changed ? "d" : "c").repeat(64);`,
        `const terminalToken = changed ? "terminal-token-changed" : "terminal-token-current";`,
        `const listResult = { terminals: [{ id: terminalId,`,
        `  available_actions: {`,
        `    approve: { tool: "agent_knock_knock_approve", arguments: { conversation_id: terminalId, expected_approval_fingerprint: approvalFingerprint, expected_terminal_token: terminalToken } },`,
        `    reconcile_binding: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 7, expected_binding_token: "conflict-binding-current", expected_terminal_token: terminalToken } }`,
        `  },`,
        `  handoff_decision: { kind: "active_turn_requires_decision", choices: { take_over_current: { action: { tool: "agent_knock_knock_close", arguments: { turn_id: "turn-active", reason: "superseded_by_human_context_switch" }, requires_explicit_user_confirmation: true } } } },`,
        `  audit_history: {`,
        `    reconcile: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 6, expected_binding_token: "stale-conflict-binding", expected_terminal_token: "stale-terminal-token" } },`,
        `    handoff: { tool: "agent_knock_knock_close", arguments: { turn_id: "turn-active", reason: "superseded_by_human_context_switch", expected_handoff_token: "stale-handoff" } }`,
        `  },`,
        `  managed: { current_turn: { turn_id: "turn-approve", available_actions: {`,
        `    approve: { tool: "agent_knock_knock_approve", arguments: { turn_id: "turn-approve", expected_approval_fingerprint: approvalFingerprint } }`,
        `  } } }`,
        `}] };`,
        `const unresolvedLifecycle = args.includes("transition-current") || args.includes("transition-from-list");`,
        `const turnIndex = args.indexOf("--turn");`,
        `const conversationIndex = args.indexOf("--conversation");`,
        `const statusTarget = turnIndex >= 0 ? args[turnIndex + 1] : conversationIndex >= 0 ? args[conversationIndex + 1] : undefined;`,
        `const staleCallback = { message: { metadata: { terminal_status: { approval_state: { approvable: true, fingerprint: "f".repeat(64) } } } } };`,
        `const approvalState = { approvable: true, fingerprint: approvalFingerprint, choices: [{ decision: "approve_once", label: "Yes", fingerprint: approvalFingerprint }, { decision: "reject", label: "No", fingerprint: rejectFingerprint }] };`,
        `const statusResult = statusTarget?.startsWith("terminal:") ? { source: "terminal_control", conversation_id: statusTarget, approval_state: approvalState, callback_delivery: staleCallback } : { conversation_id: statusTarget, session_id: "session-controls", turn_id: statusTarget, approval_state: approvalState, callback_delivery: staleCallback };`,
        `const result = args[0] === "list" ? listResult : args[0] === "status" ? statusResult : args[0] === "reconcile-binding" ? { status: "reconciled", terminal_id: terminalId, turn_created: false } : unresolvedLifecycle ? {`,
        `  source: "terminal_control",`,
        `  terminal_control: { target: "work:0.0" },`,
        `  closed: false,`,
        `  terminal_dispatch_resolved: false,`,
        `  transition_id: "transition-from-list",`,
        `  blocked: true,`,
        `  do_not_retry: true,`,
        `  reason: "live identity mismatch"`,
        `} : {};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:controls",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
          if (typeof tool === "function") {
            toolFactories.set(options.name, tool);
          }
        }
      }
    });

    const statusTool = tools.get("agent_knock_knock_status");
    assert.ok(statusTool, "agent_knock_knock_status must be registered");
    assert.ok(statusTool.parameters?.properties?.turn_id);
    assert.ok(statusTool.parameters?.properties?.conversation_id);
    assert.ok(statusTool.parameters?.properties?.watch_id);
    assert.deepEqual(statusTool.parameters?.anyOf, [
      { required: ["turn_id"] },
      { required: ["conversation_id"] },
      { required: ["watch_id"] }
    ]);
    assert.deepEqual(statusTool.parameters?.not, {
      anyOf: [
        { required: ["turn_id", "conversation_id"] },
        { required: ["turn_id", "watch_id"] },
        { required: ["conversation_id", "watch_id"] }
      ]
    });
    const watchTool = tools.get("agent_knock_knock_watch");
    assert.ok(watchTool, "agent_knock_knock_watch must be registered");
    assert.deepEqual(watchTool.parameters?.required, ["terminal_id"]);
    assert.equal(watchTool.parameters?.additionalProperties, false);
    assert.equal(
      Object.hasOwn(
        watchTool.parameters?.properties ?? {},
        "expected_binding_token"
      ),
      false
    );
    assert.match(
      watchTool.description ?? "",
      /read-only[\s\S]*exact selected[\s\S]*best-effort terminal activity[\s\S]*sends no terminal input/u
    );
    const unwatchTool = tools.get("agent_knock_knock_unwatch");
    assert.ok(unwatchTool, "agent_knock_knock_unwatch must be registered");
    assert.deepEqual(unwatchTool.parameters?.required, ["watch_id"]);
    assert.equal(unwatchTool.parameters?.additionalProperties, false);

    for (const name of [
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const definition = tools.get(name);
      assert.ok(definition, `${name} must be registered`);
      assert.ok(definition.parameters?.properties?.turn_id);
      assert.ok(definition.parameters?.properties?.conversation_id);
      assert.deepEqual(definition.parameters?.anyOf, [
        { required: ["turn_id"] },
        { required: ["conversation_id"] }
      ]);
      assert.deepEqual(
        definition.parameters?.not,
        name === "agent_knock_knock_close"
          ? {
              anyOf: [
                { required: ["turn_id", "conversation_id"] },
                {
                  required: [
                    "expected_message_id",
                    "expected_transition_id"
                  ]
                }
              ]
            }
          : { required: ["turn_id", "conversation_id"] }
      );
    }
    const sendTurnSchema = tools.get("agent_knock_knock_send")
      ?.parameters?.properties?.turn_id;
    assert.ok(sendTurnSchema);
    assert.match(
      String(sendTurnSchema.description ?? ""),
      /available_actions\.retry_submission[\s\S]*exactly \{turn_id\}/u
    );
    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const conversationSchema = tools.get(name)?.parameters?.properties
        ?.conversation_id;
      const description = isRecord(conversationSchema)
        ? String(conversationSchema.description ?? "")
        : "";
      assert.match(description, /raw-terminal|raw terminal/u, name);
      assert.match(description, /never construct|never guess/u, name);
    }
    const closeTool = tools.get("agent_knock_knock_close");
    assert.equal(closeTool?.parameters?.additionalProperties, false);
    assert.ok(closeTool?.parameters?.properties?.expected_message_id);
    assert.ok(closeTool?.parameters?.properties?.expected_transition_id);
    assert.equal(
      Object.hasOwn(
        closeTool?.parameters?.properties ?? {},
        "expected_handoff_token"
      ),
      false
    );
    assert.match(closeTool?.description ?? "", /expected_transition_id/u);
    assert.match(closeTool?.description ?? "", /cannot veto closing the Turn/u);
    const approveTool = tools.get("agent_knock_knock_approve");
    assert.ok(approveTool);
    assert.deepEqual(approveTool.parameters?.anyOf, [
      { required: ["turn_id"] },
      { required: ["terminal_id"] }
    ]);
    assert.deepEqual(approveTool.parameters?.not, {
      required: ["turn_id", "terminal_id"]
    });
    assert.deepEqual(
      approveTool.parameters?.properties?.decision?.enum,
      ["approve_once", "reject"]
    );
    for (const forbidden of ["keys", "key", "index", "label"]) {
      assert.equal(
        Object.hasOwn(approveTool.parameters?.properties ?? {}, forbidden),
        false
      );
    }
    assertNoModelOpaqueAuthority(
      approveTool.parameters,
      "$.agent_knock_knock_approve.parameters"
    );
    await assert.rejects(
      () => approveTool.execute!("ambiguous-approval-target", {
        turn_id: "turn-managed",
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234"
      }),
      /approve requires exactly one of turn_id or terminal_id/u
    );
    await assert.rejects(
      () => approveTool.execute!("approval-without-offer", {
        turn_id: "turn-no-offer"
      }),
      /requires a current approval request shown by agent_knock_knock_status in this controller conversation/u
    );
    assert.equal(
      fs.existsSync(callsPath),
      false,
      "missing model-session authority must fail before spawning the CLI"
    );

    await assert.rejects(
      () => closeTool!.execute!("ambiguous-recovery-fence", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234",
        expected_message_id: "message-current",
        expected_transition_id: "transition-current"
      }),
      /only one of expected_message_id or expected_transition_id/u
    );
    await closeTool!.execute!("managed-handoff-ignores-private-fence", {
      turn_id: "turn-active-with-recovery-id",
      reason: "superseded_by_human_context_switch",
      expected_message_id: "message-current"
    });
    await assert.rejects(
      () => closeTool!.execute!("raw-handoff-target", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234",
        reason: "superseded_by_human_context_switch"
      }),
      /requires the exact managed turn_id/u
    );

    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      await assert.rejects(
        () => tools.get(name)!.execute!("ambiguous-turn-target", {
          turn_id: "turn-modern",
          conversation_id: "turn-legacy-other"
        }),
        /only one of turn_id or conversation_id/u,
        name
      );
    }
    await assert.rejects(
      () => statusTool.execute!("ambiguous-watch-target", {
        turn_id: "turn-modern",
        watch_id: "terminal-watch-modern"
      }),
      /exactly one of turn_id, conversation_id, or watch_id/u
    );

    const sendTool = tools.get("agent_knock_knock_send");
    const respondTool = tools.get("agent_knock_knock_respond");
    for (const invalidSessionId of [
      "only",
      "@deadbeef",
      "terminal:v2:tmux:codex:work:0.0:1234"
    ]) {
      await assert.rejects(
        () => sendTool!.execute!("invalid-session-id", {
          session_id: invalidSessionId,
          request: "must not reinterpret an authoritative id"
        }),
        /session_id must be an authoritative managed id/u
      );
    }
    for (const invalidTurnId of [
      "latest",
      "@deadbeef",
      "terminal:v2:tmux:codex:work:0.0:1234"
    ]) {
      await assert.rejects(
        () => respondTool!.execute!("invalid-turn-id", {
          turn_id: invalidTurnId,
          request: "must not reinterpret an authoritative id"
        }),
        /turn_id must be an authoritative managed id/u
      );
      await assert.rejects(
        () => tools.get("agent_knock_knock_status")!.execute!(
          "invalid-status-turn-id",
          { turn_id: invalidTurnId }
        ),
        /turn_id must be an authoritative managed id/u
      );
    }

    const displayedList = await tools.get("agent_knock_knock_list")?.execute?.(
      "list-private-authority",
      {}
    );
    assertModelToolResultHasNoOpaqueAuthority(displayedList);
    const displayedApproval = await tools
      .get("agent_knock_knock_status")
      ?.execute?.("status-private-approval", {
        turn_id: "turn-approve"
      });
    assertModelToolResultHasNoOpaqueAuthority(displayedApproval);
    const foreignApprove = toolFactories
      .get("agent_knock_knock_approve")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await assert.rejects(
      () => foreignApprove!.execute!("cross-session-approval", {
        turn_id: "turn-approve"
      }),
      /in this controller conversation/u
    );
    const foreignReconcile = toolFactories
      .get("agent_knock_knock_reconcile_binding")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await assert.rejects(
      () => foreignReconcile!.execute!("cross-session-reconcile", {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
        conflicting_session_id: "session-conflict"
      }),
      /in this controller session/u
    );
    const foreignClose = toolFactories
      .get("agent_knock_knock_close")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await foreignClose!.execute!("cross-session-handoff", {
      turn_id: "turn-active-foreign",
      reason: "superseded_by_human_context_switch"
    });
    await statusTool.execute?.("watch-status", {
      watch_id: "terminal-watch-status"
    });
    await watchTool.execute?.("watch", {
      terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
      hardTimeoutMinutes: 30
    });
    await unwatchTool.execute?.("unwatch", {
      watch_id: "terminal-watch-status"
    });
    await tools.get("agent_knock_knock_approve")?.execute?.("approve", {
      turn_id: "turn-approve"
    });
    await tools.get("agent_knock_knock_status")?.execute?.(
      "status-before-reject",
      { turn_id: "turn-approve" }
    );
    await tools.get("agent_knock_knock_approve")?.execute?.("reject", {
      turn_id: "turn-approve",
      decision: "reject"
    });
    const displayedTerminalApproval = await tools
      .get("agent_knock_knock_status")
      ?.execute?.("terminal-status-private-approval", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234"
      });
    assertModelToolResultHasNoOpaqueAuthority(displayedTerminalApproval);
    await tools.get("agent_knock_knock_approve")?.execute?.(
      "terminal-scoped-approve",
      {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234"
      }
    );
    const reconciled = await tools
      .get("agent_knock_knock_reconcile_binding")
      ?.execute?.("reconcile-semantic-only", {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
        conflicting_session_id: "session-conflict"
      });
    assert.equal(reconciled?.details?.status, "reconciled");
    await tools.get("agent_knock_knock_renew")?.execute?.("renew", {
      turn_id: "turn-renew"
    });
    await tools.get("agent_knock_knock_retry_callback")?.execute?.("retry", {
      turn_id: "turn-retry"
    });
    await tools.get("agent_knock_knock_cancel")?.execute?.("cancel", {
      turn_id: "turn-cancel"
    });
    await tools.get("agent_knock_knock_close")?.execute?.("close", {
      turn_id: "turn-close"
    });
    await tools.get("agent_knock_knock_close")?.execute?.("take-over-current", {
      turn_id: "turn-active",
      reason: "superseded_by_human_context_switch"
    });
    const blockedCloseTool = await tools.get("agent_knock_knock_close")?.execute?.(
      "recover-lifecycle",
      {
        conversation_id:
          "terminal:v2:tmux:codex:work:0.0:1234",
        expected_transition_id: "transition-current"
      }
    );
    assert.equal(blockedCloseTool?.isError, true);
    assert.equal(blockedCloseTool?.details?.terminal_dispatch_resolved, false);
    assert.equal(blockedCloseTool?.details?.blocked, true);
    const slashRecovery = await command?.handler?.({
      args:
        `close terminal:v2:tmux:codex:work:0.0:1234 ` +
        "--expected-transition-id transition-from-list",
      sessionKey: "agent:test:lifecycle-recovery"
    });
    assert.equal(slashRecovery?.isError, true);
    assert.match(
      slashRecovery?.text ?? "",
      /did not clear the unresolved terminal dispatch fence/u
    );
    assert.match(slashRecovery?.text ?? "", /remains blocked/u);
    assert.match(slashRecovery?.text ?? "", /Do not retry/u);
    assert.doesNotMatch(slashRecovery?.text ?? "", /Turn record closed/u);

    await tools.get("agent_knock_knock_status")?.execute?.(
      "status-before-authority-change",
      { turn_id: "turn-approve" }
    );
    const approveCallsBeforeChange = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter(([action]) => action === "approve").length;
    fs.writeFileSync(changedAuthorityPath, "changed", "utf8");
    await assert.rejects(
      () => approveTool.execute!("approval-authority-changed", {
        turn_id: "turn-approve"
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /approval request changed after it was shown/u);
        assert.doesNotMatch(
          error.message,
          /(?:a{64}|b{64}|terminal-token|fingerprint)/iu
        );
        return true;
      }
    );

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter(([action]) => action === "approve").length,
      approveCallsBeforeChange,
      "changed authority must fail before the approve CLI is spawned"
    );
    const callFor = (action: string): string[] | undefined =>
      calls.find(([candidate]) => candidate === action);
    assert.deepEqual(callFor("watch-terminal"), [
      "watch-terminal",
      "--terminal",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--hard-timeout-minutes",
      "30",
      "--openclaw-session",
      "agent:test:controls"
    ]);
    assert.deepEqual(callFor("unwatch-terminal"), [
      "unwatch-terminal",
      "--watch",
      "terminal-watch-status"
    ]);
    assert.deepEqual(callFor("reconcile-binding"), [
      "reconcile-binding",
      "--terminal",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--conflicting-session",
      "session-conflict",
      "--expected-session-revision",
      "7",
      "--expected-binding-token",
      "conflict-binding-current",
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    const approveCalls = calls.filter(([action]) => action === "approve");
    assert.deepEqual(approveCalls, [
      [
        "approve",
        "--turn",
        "turn-approve",
        "--decision",
        "approve_once",
        "--expected-approval-fingerprint",
        "a".repeat(64)
      ],
      [
        "approve",
        "--turn",
        "turn-approve",
        "--decision",
        "reject",
        "--expected-approval-fingerprint",
        "c".repeat(64)
      ],
      [
        "approve",
        "--conversation",
        "terminal:v2:tmux:codex:work:0.0:1234",
        "--decision",
        "approve_once",
        "--expected-approval-fingerprint",
        "a".repeat(64),
        "--expected-terminal-token",
        "terminal-token-current"
      ]
    ]);
    const handoffClose = calls.find((args) =>
      args[0] === "close" &&
      args.includes("superseded_by_human_context_switch")
    );
    assert.deepEqual(handoffClose, [
      "close",
      "--turn",
      "turn-active-with-recovery-id",
      "--reason",
      "superseded_by_human_context_switch",
      "--expected-message-id",
      "message-current"
    ]);
    const recoveryClose = calls.find((args) =>
      args[0] === "close" && args.includes("transition-current")
    );
    assert.deepEqual(recoveryClose?.slice(0, 5), [
      "close",
      "--conversation",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--expected-transition-id",
      "transition-current"
    ]);
    const slashRecoveryClose = calls.find((args) =>
      args[0] === "close" && args.includes("transition-from-list")
    );
    assert.deepEqual(slashRecoveryClose, [
      "close",
      "--turn",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--reason",
      "Native-thread lifecycle transition recovered from /akk command",
      "--expected-transition-id",
      "transition-from-list"
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw status includes purpose context and a bounded terminal screen", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-status-"));
  const fakeCli = path.join(tempDir, "status.cjs");
  let statusTool: ToolDefinition | undefined;
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const result = {
  conversation_id: "managed-terminal-1",
  session_id: "session-status",
  turn_id: "managed-terminal-1",
  conversation: {
    conversation_id: "managed-terminal-1",
    session_id: "session-status",
    turn_id: "managed-terminal-1",
    status: "waiting_for_agent",
    callback_delivery: {
      status: "pending",
      attempts: 2,
      next_attempt_at: "2026-08-06T12:30:00.000Z"
    }
  },
  summary: {
    conversation_id: "managed-terminal-1",
    session_id: "session-status",
    turn_id: "managed-terminal-1",
    agent: "codex",
    status: "waiting_for_agent",
    session: "work:0.0",
    callback_delivery: {
      status: "pending",
      attempts: 2,
      attempt_state: "in_flight",
      next_attempt_at: "2026-08-06T12:30:00.000Z"
    }
  },
  about: "Review the current branch",
  confidence: "high",
  limitations: ["history is bounded"],
  terminal_status: {
    agent: "codex",
    activity_state: "working"
  },
  terminal_screen: {
    excerpt: "Running focused tests"
  }
};
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { workspace: tempDir },
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name === "agent_knock_knock_status") {
          statusTool = definition;
        }
      }
    });

    const toolResult = await statusTool?.execute?.("tool-call-status", {
      conversation_id: "only"
    });
    assert.equal(toolResult?.details?.about, "Review the current branch");
    assert.equal(toolResult?.details?.confidence, "high");
    assert.deepEqual(toolResult?.details?.limitations, ["history is bounded"]);

    const slashResult = await command?.handler?.({
      args: "status only",
      sessionKey: "agent:test:main"
    });
    assert.match(slashResult?.text ?? "", /about: Review the current branch/u);
    assert.match(slashResult?.text ?? "", /terminal screen:\nRunning focused tests/u);
    assert.match(slashResult?.text ?? "", /^session: session-status$/mu);
    assert.match(slashResult?.text ?? "", /^turn: managed-terminal-1$/mu);
    assert.match(
      slashResult?.text ?? "",
      /^turn status: waiting_for_agent$/mu
    );
    assert.match(
      slashResult?.text ?? "",
      /^terminal activity: working$/mu
    );
    assert.doesNotMatch(slashResult?.text ?? "", /AKK Watch available/u);
    assert.doesNotMatch(slashResult?.text ?? "", /^status:/mu);
    assert.match(
      slashResult?.text ?? "",
      /^callback: pending, attempt 2, in flight, next retry 2026-08-06T12:30:00\.000Z$/mu
    );
    assert.doesNotMatch(slashResult?.text ?? "", /^conversation:/mu);
    assert.doesNotMatch(slashResult?.text ?? "", /work:0\.0/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public command results label AKK sessions and turns instead of native sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-public-wording-"));
  const fakeCli = path.join(tempDir, "public-wording.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const turnId = \`turn-\${action}\`;
const sessionId = \`session-\${action}\`;
const conversation = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  status: action === "close" ? "closed" : "waiting_for_agent",
  executor: { kind: "codex", session: \`native-\${action}\` }
};
const result = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  conversation,
  summary: {
    conversation_id: turnId,
    session_id: sessionId,
    turn_id: turnId,
    agent: "codex",
    status: conversation.status,
    session: \`native-summary-\${action}\`
  },
  executor: conversation.executor,
  terminal_control: { target: \`native-pane-\${action}\` },
  delivered: true,
  background: true,
  approved: action === "approve",
  cancel_requested: action === "cancel",
  agent_timeout_minutes: 20,
  agent_hard_timeout_minutes: 120
};
if (action === "retry-callback") {
  delete result.session_id;
  delete result.turn_id;
  delete result.conversation.session_id;
  delete result.conversation.turn_id;
  delete result.summary.session_id;
  delete result.summary.turn_id;
  result.conversation.callback_delivery = { attempts: 2 };
}
process.stdout.write(JSON.stringify(result));
`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool() {}
    });

    const cases = [
      {
        args: "Review public wording",
        action: "delegate",
        sessionId: "session-delegate",
        turnId: "turn-delegate"
      },
      {
        args: "status turn-status",
        action: "status",
        sessionId: "session-status",
        turnId: "turn-status"
      },
      {
        args: "renew turn-renew 20",
        action: "renew",
        sessionId: "session-renew",
        turnId: "turn-renew"
      },
      {
        args: "retry-callback turn-retry-callback",
        action: "retry-callback",
        sessionId: "turn-retry-callback",
        turnId: "turn-retry-callback"
      },
      {
        args: "cancel turn-cancel",
        action: "cancel",
        sessionId: "session-cancel",
        turnId: "turn-cancel"
      },
      {
        args: "close turn-close done",
        action: "close",
        sessionId: "session-close",
        turnId: "turn-close"
      }
    ];

    for (const item of cases) {
      const result = await command?.handler?.({
        args: item.args,
        sessionKey: "agent:test:public-wording"
      });
      const text = String(result?.text ?? "");
      assert.match(text, new RegExp(`^session: ${item.sessionId}$`, "mu"), item.action);
      assert.match(text, new RegExp(`^turn: ${item.turnId}$`, "mu"), item.action);
      assert.doesNotMatch(text, /^conversation:/mu, item.action);
      assert.doesNotMatch(text, /native-/u, item.action);
    }

    const closeResult = await command?.handler?.({
      args: "close turn-close done",
      sessionKey: "agent:test:public-wording"
    });
    assert.match(closeResult?.text ?? "", /AKK Turn record closed\./u);
    assert.doesNotMatch(closeResult?.text ?? "", /AKK session closed/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw reports user-priority unmanaged Send without inventing a Turn", async () => {
  const tempDir = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-plugin-user-priority-send-"
  ));
  const fakeCli = path.join(tempDir, "user-priority-send.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;
  try {
    const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
    const fallbackResult = {
      delivered: true,
      delivered_unmanaged: true,
      terminal_input_dispatched: true,
      agent_acceptance: "unproven",
      callback_expected: true,
      callback_mode: "terminal_watch",
      watch_id: "terminal-watch-user-send-fixture",
      terminal_id: terminalId,
      message_id: "message-user-priority-send",
      scope: "terminal_user_explicit",
      management_mode: "unmanaged",
      observation_mode: "terminal_watch",
      capabilities: {
        callback: true,
        interaction_notify: true,
        interaction_respond: false
      },
      legacy_management_mode: "unmanaged_fallback"
    };
    const managedReplayResult = {
      delivered: true,
      replayed: true,
      status: "submission_pending_acceptance",
      submission_outcome: "pending_acceptance",
      delivery_receipt: "enter_dispatched",
      do_not_retry: true,
      terminal_id: terminalId,
      message_id: "message-managed-replay",
      scope: "terminal_user_explicit",
      management_mode: "managed"
    };
    const textOnlyResult = {
      delivered: false,
      status: "submission_uncertain",
      submission_outcome: "uncertain",
      delivery_receipt: "text_injected",
      terminal_input_dispatched: true,
      do_not_retry: true,
      terminal_id: terminalId,
      message_id: "message-text-only",
      scope: "terminal_user_explicit",
      management_mode: "managed"
    };
    fs.writeFileSync(
      fakeCli,
      [
        "const args = process.argv.slice(2);",
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `const fallback = ${JSON.stringify(fallbackResult)};`,
        `const managedReplay = ${JSON.stringify(managedReplayResult)};`,
        `const textOnly = ${JSON.stringify(textOnlyResult)};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: { send: {`,
        `    tool: "agent_knock_knock_send", arguments: {`,
        `      selector: terminalId, expected_terminal_token: "private-physical-token"`,
        `    }`,
        `  } }`,
        `}] } : args.includes("pending-managed") ? managedReplay : ` +
          `args.includes("text-only") ? textOnly : fallback;`,
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:user-priority-send",
              sessionId: "openclaw-user-priority-send"
            } as never)
          : tool;
        if (options?.name === "agent_knock_knock_send") {
          sendTool = definition;
        }
      }
    });

    const result = await command?.handler?.({
      args: "only: Continue despite broken AKK state",
      sessionKey: "agent:test:user-priority-send"
    });
    const text = String(result?.text ?? "");
    assert.match(text, /delivered the user's request directly/u);
    assert.match(text, /^delivery: unmanaged fallback$/mu);
    assert.match(
      text,
      /^callback: Terminal Watch terminal-watch-user-send-fixture; no managed AKK Turn was created/mu
    );
    assert.match(text, /wait for the Terminal Watch callback/u);
    assert.doesNotMatch(text, /AKK turn sent|session: unknown|turn: unknown/iu);
    assert.notEqual(result?.isError, true);

    const bareResult = await command?.handler?.({
      args: "Continue despite broken AKK state",
      sessionKey: "agent:test:user-priority-send"
    });
    const bareText = String(bareResult?.text ?? "");
    assert.notEqual(bareResult?.isError, true);
    assert.match(bareText, /delivered the user's request directly/u);
    assert.match(
      bareText,
      /^callback: Terminal Watch terminal-watch-user-send-fixture; no managed AKK Turn was created/mu
    );
    assert.match(bareText, /wait for the Terminal Watch callback/u);
    assert.doesNotMatch(bareText, /session: unknown|turn: unknown/iu);

    const toolResult = await sendTool?.execute?.("tool-user-priority-send", {
      terminal_id: terminalId,
      request: "Continue despite broken AKK state"
    });
    assert.notEqual(toolResult?.isError, true);
    assert.equal(toolResult?.details?.delivered, true);
    assert.equal(toolResult?.details?.delivered_unmanaged, true);
    assert.equal(toolResult?.details?.terminal_input_dispatched, true);
    assert.equal(toolResult?.details?.agent_acceptance, "unproven");
    assert.equal(toolResult?.details?.management_mode, "unmanaged");
    assert.equal(toolResult?.details?.observation_mode, "terminal_watch");
    assert.deepEqual(toolResult?.details?.capabilities, {
      callback: true,
      interaction_notify: true,
      interaction_respond: false
    });
    assert.equal(toolResult?.details?.scope, "terminal_user_explicit");
    assert.equal(
      JSON.stringify(toolResult?.details).includes("private-physical-token"),
      false
    );

    const delegatedToolResult = await sendTool?.execute?.(
      "tool-user-priority-delegate",
      { request: "Continue through the unique physical terminal" }
    );
    assert.notEqual(delegatedToolResult?.isError, true);
    assert.equal(delegatedToolResult?.details?.delivered, true);
    assert.equal(
      delegatedToolResult?.details?.management_mode,
      "unmanaged"
    );
    assert.equal(
      delegatedToolResult?.details?.legacy_management_mode,
      "unmanaged_fallback"
    );
    assert.equal(delegatedToolResult?.details?.scope, "terminal_user_explicit");

    const pendingCommand = await command?.handler?.({
      args: "only: pending-managed",
      sessionKey: "agent:test:user-priority-send"
    });
    assert.notEqual(pendingCommand?.isError, true);
    assert.match(
      String(pendingCommand?.text ?? ""),
      /confirmed this managed terminal Send was already delivered/u
    );
    assert.match(String(pendingCommand?.text ?? ""), /do not resend/u);

    const pendingTool = await sendTool?.execute?.("tool-managed-replay", {
      terminal_id: terminalId,
      request: "pending-managed"
    });
    assert.notEqual(pendingTool?.isError, true);
    assert.equal(pendingTool?.details?.delivered, true);
    assert.equal(pendingTool?.details?.delivery_receipt, "enter_dispatched");
    assert.equal(pendingTool?.details?.do_not_retry, true);

    const textOnlyCommand = await command?.handler?.({
      args: "only: text-only",
      sessionKey: "agent:test:user-priority-send"
    });
    assert.equal(textOnlyCommand?.isError, true);
    assert.match(
      String(textOnlyCommand?.text ?? ""),
      /could not prove that Enter was dispatched/u
    );

    const textOnlyTool = await sendTool?.execute?.("tool-text-only", {
      terminal_id: terminalId,
      request: "text-only"
    });
    assert.equal(textOnlyTool?.isError, true);
    assert.equal(textOnlyTool?.details?.terminal_input_dispatched, true);
    assert.equal(textOnlyTool?.details?.agent_acceptance, "unproven");
    assert.equal(textOnlyTool?.details?.do_not_retry, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw reports delivered-but-unfenced sends as successful dispatches that must not be retried", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-unfenced-"));
  const fakeCli = path.join(tempDir, "unfenced.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        conversation_id: "turn-unfenced",
        session_id: "session-unfenced",
        turn_id: "turn-unfenced",
        status: "delivered_unfenced",
        submission_outcome: "submitted",
        do_not_retry: true,
        reason: "native identity did not bind",
        conversation: {
          conversation_id: "turn-unfenced",
          session_id: "session-unfenced",
          turn_id: "turn-unfenced",
          status: "stalled",
          executor: { kind: "codex", session: "native-unfenced" }
        }
      }))});`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({ sessionKey: "agent:test:unfenced" } as never)
            : tool;
        }
      },
      registerCommand(value: typeof command) {
        command = value;
      }
    });

    for (const args of [
      "Inspect the repository",
      "codex: Inspect the repository"
    ]) {
      const result = await command?.handler?.({
        args,
        sessionKey: "agent:test:unfenced"
      });
      assert.notEqual(result?.isError, true, args);
      assert.match(result?.text ?? "", /could not bind|could not fence/u, args);
      assert.match(result?.text ?? "", /do not retry/u, args);
      assert.doesNotMatch(result?.text ?? "", /yield now/u, args);
    }

    assert.equal(typeof sendTool?.execute, "function");
    const toolResponse = await sendTool?.execute?.("unfenced-send", {
      request: "Inspect the repository"
    });
    assert.notEqual(toolResponse?.isError, true);
    assert.equal(toolResponse?.details?.status, "submission_unfenced");
    assert.equal(toolResponse?.details?.delivered, true);
    assert.equal(toolResponse?.details?.terminal_input_dispatched, true);
    assert.equal(toolResponse?.details?.agent_acceptance, "unproven");
    assert.equal(toolResponse?.details?.do_not_retry, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw preserves safe and unsafe aborted submission retry boundaries", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-aborted-"));
  const fakeCli = path.join(tempDir, "aborted.cjs");
  const modePath = path.join(tempDir, "mode.txt");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const safe = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim() === "safe";`,
        `process.stdout.write(JSON.stringify({`,
        `  conversation_id: "turn-aborted",`,
        `  session_id: "session-aborted",`,
        `  turn_id: "turn-aborted",`,
        `  status: "submission_aborted",`,
        `  submission_outcome: "aborted",`,
        `  delivered: false,`,
        `  safe_to_retry: safe,`,
        `  do_not_retry: !safe,`,
        `  reason: safe ? "durable safe abort" : "aborted receipt was not durable",`,
        `  conversation: {`,
        `    conversation_id: "turn-aborted",`,
        `    session_id: "session-aborted",`,
        `    turn_id: "turn-aborted",`,
        `    status: "idle",`,
        `    executor: { kind: "codex", session: "native-aborted" }`,
        `  }`,
        `}));`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({ sessionKey: "agent:test:aborted" } as never)
            : tool;
        }
      },
      registerCommand(value: typeof command) {
        command = value;
      }
    });

    for (const safe of [true, false]) {
      fs.writeFileSync(modePath, safe ? "safe" : "unsafe", "utf8");
      const slashResult = await command?.handler?.({
        args: "Inspect the repository",
        sessionKey: "agent:test:aborted"
      });
      assert.equal(slashResult?.isError, true);
      if (safe) {
        assert.match(slashResult?.text ?? "", /may be retried/u);
        assert.doesNotMatch(slashResult?.text ?? "", /do not retry/u);
      } else {
        assert.match(slashResult?.text ?? "", /do not retry/u);
        assert.match(slashResult?.text ?? "", /inspect/u);
        assert.doesNotMatch(slashResult?.text ?? "", /may be retried/u);
      }

      const toolResult = await sendTool?.execute?.(
        safe ? "safe-abort" : "unsafe-abort",
        { request: "Inspect the repository" }
      );
      assert.equal(toolResult?.isError, true);
      assert.equal(toolResult?.details?.submission_outcome, "aborted");
      assert.equal(toolResult?.details?.safe_to_retry, safe);
      assert.equal(toolResult?.details?.do_not_retry, !safe);
      assert.match(
        String(toolResult?.details?.note ?? ""),
        safe ? /may be retried/u : /do not retry/iu
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin tool results reject partial identity and do not invent Turn ids for raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-result-identity-"));
  const fakeCli = path.join(tempDir, "identity.cjs");
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const result = action === "status"
  ? { source: "terminal_control", conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
  : { conversation: { conversation_id: "turn-partial", session_id: "session-partial" } };
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    await assert.rejects(
      () => tools.get("agent_knock_knock_send")!.execute!("partial", {
        session_id: "session-partial",
        request: "Do not expose partial identity"
      }),
      /partial session_id\/turn_id identity/u
    );
    const rawStatus = await tools.get("agent_knock_knock_status")?.execute?.(
      "raw-status",
      { conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
    );
    assert.equal(rawStatus?.details?.conversation_id,
      "terminal:v2:tmux:codex:work:0.0:123");
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "session_id"), false);
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "turn_id"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bundled OpenClaw skills exist and are included in the npm artifact", () => {
  const manifest = readManifest();
  const skillPaths = requiredStringArray(manifest.skills, "skills");

  for (const skillPath of skillPaths) {
    assert.equal(path.isAbsolute(skillPath), false, `${skillPath} must be relative`);
    const skillRoot = path.resolve(packageRoot, skillPath);
    assert.equal(
      path.relative(packageRoot, skillRoot).startsWith(".."),
      false,
      `${skillPath} must stay inside the package`
    );
    assert.equal(
      fs.existsSync(path.join(skillRoot, "SKILL.md")),
      true,
      `${skillPath} must contain SKILL.md`
    );
  }

  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const result = JSON.parse(packed.stdout) as Array<{
    files?: Array<{
      path?: string;
    }>;
  }>;
  const packedFiles = new Set(
    (result[0]?.files ?? [])
      .map((file) => file.path)
      .filter((file): file is string => typeof file === "string")
  );

  for (const skillPath of skillPaths) {
    assert.equal(
      packedFiles.has(path.posix.join(skillPath, "SKILL.md")),
      true,
      `${skillPath}/SKILL.md must be included by npm pack`
    );
  }
  for (const documentationPath of [
    "README.md",
    "docs/quickstart-herdr.md",
    "docs/quickstart-tmux.md"
  ]) {
    assert.equal(
      packedFiles.has(documentationPath),
      true,
      `${documentationPath} must be included for ClawHub rendering and first-run help`
    );
  }
  assert.equal(
    packedFiles.has("assets/icon.png"),
    true,
    "assets/icon.png must be included for OpenClaw plugin branding"
  );
});
