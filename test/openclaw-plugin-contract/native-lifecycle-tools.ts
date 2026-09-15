import {
  test,
  assert,
  fs,
  os,
  path,
  plugin,
  createOpenClawPluginForTest,
  openclawPluginRuntime,
  approveParameters,
  sendParameters,
  registerOpenClawCallbackGateway,
  registerOpenClawCommands,
  consumeOpenClawPrivateAuthorityOffer,
  assertNoModelOpaqueAuthority,
  assertModelToolResultHasNoOpaqueAuthority,
  packageRoot,
  manifestPath,
  skillSource,
  sorted,
  isRecord,
  type ToolDefinition,
  type ToolFactory
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw list, threads, and status results expose semantic ids only", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-model-boundary-")
  );
  const fakeCli = path.join(tempDir, "model-boundary.cjs");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const tools = new Map<string, ToolDefinition>();
  const fixtures = {
    list: {
      expected_session_revision: 7,
      session_revisions: [6, 7],
      binding_ids: ["private-binding-id"],
      terminal_binding_id: "private-terminal-binding-id",
      terminal_binding_generation: 5,
      binding_token: "private-binding-token",
      lifecycle_binding_token: "private-lifecycle-token",
      recovery: {
        expected_message_id: "message-semantic-id",
        expected_transition_id: "transition-semantic-id"
      },
      terminals: [{
        id: terminalId,
        _user_explicit_composer_ready: true,
        composer_digest: "private-composer-digest",
        composer_draft: "private-composer-draft",
        handoff_decision: {
          live_native_thread_id: "private-handoff-live-native-id"
        },
        approval_state: {
          approvable: true,
          fingerprint: "private-approval-fingerprint"
        },
        available_actions: {
          send: {
            tool: "agent_knock_knock_send",
            scope: "terminal_user_explicit",
            composer_policy: "replace_current_composer_and_submit",
            arguments: {
              selector: terminalId,
              expected_terminal_token: "private-terminal-token",
              request: "continue"
            }
          },
          approve: {
            tool: "agent_knock_knock_approve",
            arguments: {
              conversation_id: terminalId,
              expected_approval_fingerprint: "private-approval-fingerprint",
              expected_terminal_token: "private-terminal-token"
            }
          },
          close: {
            tool: "agent_knock_knock_close",
            arguments: {
              turn_id: "turn-handoff",
              reason: "superseded_by_human_context_switch",
              expected_handoff_token: "private-handoff-token"
            }
          }
        }
      }]
    },
    "list-resumable-threads": {
      terminal_id: terminalId,
      expected_binding_token: "private-binding-token",
      selection_snapshot: {
        snapshot_id: "private-selection-snapshot",
        expected_session_revision: 9
      },
      threads: [{
        native_thread_id: "22222222-2222-4222-8222-222222222222",
        resumable: true,
        candidate_token: "private-candidate-token",
        selection_handle: "private-selection-handle"
      }]
    },
    status: {
      conversation_id: "turn-status",
      session_id: "session-status",
      turn_id: "turn-status",
      conversation: {
        conversation_id: "turn-status",
        session_id: "session-status",
        turn_id: "turn-status",
        openclaw_session: "private-openclaw-session",
        gateway_session: "private-gateway-session",
        gateway_method: "private-gateway-method",
        gateway_url: "ws://private-gateway.example",
        openclaw_bin: "/private/bin/openclaw",
        callback_route: {
          schema: "agent-knock-knock/callback-route",
          version: 1,
          transport: "openclaw_gateway_v1",
          profile_id: "private-callback-profile",
          profile_revision: "private-callback-profile-revision",
          controller_session_id: "private-controller-session",
          capabilities: { wake: true, respond: true }
        },
        callback_delivery: {
          callback_envelope: {
            schema: "agent-knock-knock/callback-envelope",
            version: 1,
            delivery_id: "private-callback-delivery",
            message_id: "private-callback-message"
          },
          attempt_outcome: {
            disposition: "accepted",
            acceptance_id: "private-callback-acceptance"
          },
          message: {
            body:
              `Approval authority\nexpected_approval_fingerprint: ${"f".repeat(64)}\n` +
              "inspect token_fingerprint.ts after approval\n" +
              "expected_session_revision: 7\n" +
              "--expected-binding-token business-callback-example"
          }
        },
        native_session_takeover: {
          codex_rollout_acceptance_anchor: {
            candidate_rollouts: [{
              native_thread_id: "private-anchor-thread",
              rollout: {
                path: "/private/rollout.jsonl",
                device: 1,
                inode: 2
              },
              offset_bytes: 123
            }]
          },
          terminal_bridge_submission: {
            acceptance_evidence: {
              requestHash: "c".repeat(64),
              acceptanceId: "private-acceptance-id"
            }
          }
        }
      },
      status: "waiting_for_agent",
      bookkeeping_warning: "expected revision 5, actual revision 6",
      request:
        `inspect token_fingerprint.ts at commit ${"1".repeat(64)}; ` +
        "tokens, fingerprints, revisions, and CAS are ordinary request text\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-example",
      completion:
        `completed token_fingerprint.ts at commit ${"2".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-completion-example",
      terminal_screen:
        `screen mentions token_fingerprint.ts at commit ${"3".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-screen-example",
      recent_events: [{
        body:
          `Equivalent command: --expected-approval-fingerprint ${"f".repeat(64)}\n` +
          "ordinary token wording remains visible\n" +
          "expected_session_revision: 7\n" +
          "--expected-binding-token business-event-example"
      }],
      approval_state: {
        approvable: true,
        fingerprint: "private-status-fingerprint",
        policy_evidence: {
          command_sha256: "d".repeat(64)
        },
        request_detail:
          "inspect token_fingerprint.ts at commit eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n" +
          "expected_session_revision: 7\n" +
          "--expected-binding-token business-request-detail-example"
      },
      nested: {
        reason: "expected revision 7, actual revision 8",
        stalledReason: "expected revision 9, actual revision 10",
        expected_binding_token: "private-status-token",
        expected_session_revision: 11,
        expectedSessionRevision: 12,
        "expected-session-revision": 13,
        terminal_binding_id: "private-status-binding-id",
        terminal_binding_generation: 6,
        terminalBindingGeneration: 7,
        nonce: "private-status-nonce",
        terminal_bridge_request_hash: "a".repeat(64),
        approval_snapshot_digest: "b".repeat(64),
        screen: {
          approval: {
            policyEvidence: {
              commandSha256: "e".repeat(64)
            }
          }
        },
        missing_required: [
          "expected_terminal_token",
          "expected_message_id"
        ],
        expected_message_id: "message-status-id",
        expected_transition_id: "transition-status-id"
      }
    }
  };

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fixtures = ${JSON.stringify(fixtures)};`,
        `const action = process.argv[2];`,
        `if (action === "renew") { process.stderr.write("expected revision 7, actual revision 8; terminal token ${"f".repeat(64)}"); process.exit(9); }`,
        `process.stdout.write(JSON.stringify(fixtures[action] ?? {}));`
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
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({ sessionKey: "agent:test:model-boundary" } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    const listed = await tools.get("agent_knock_knock_list")?.execute?.(
      "list-model-boundary",
      {}
    );
    const threads = await tools
      .get("agent_knock_knock_list_resumable_threads")
      ?.execute?.("threads-model-boundary", { terminal_id: terminalId });
    const status = await tools.get("agent_knock_knock_status")?.execute?.(
      "status-model-boundary",
      { turn_id: "turn-status" }
    );

    for (const result of [listed, threads, status]) {
      assertModelToolResultHasNoOpaqueAuthority(result);
      const encoded = JSON.stringify(result);
      for (const privateValue of [
        "private-binding-token",
        "private-terminal-token",
        "private-candidate-token",
        "private-handoff-token",
        "private-approval-fingerprint",
        "private-status-fingerprint",
        "private-callback-profile",
        "private-controller-session",
        "private-callback-delivery",
        "private-callback-acceptance",
        "private-openclaw-session",
        "private-gateway-session",
        "private-gateway-method",
        "private-gateway.example",
        "/private/bin/openclaw"
      ]) {
        assert.equal(encoded.includes(privateValue), false, privateValue);
      }
    }

    const listDetails = listed?.details ?? {};
    const terminals = Array.isArray(listDetails.terminals)
      ? listDetails.terminals
      : [];
    const terminal = isRecord(terminals[0]) ? terminals[0] : {};
    const actions = isRecord(terminal.available_actions)
      ? terminal.available_actions
      : {};
    const actionInputs = isRecord(terminal.action_inputs)
      ? terminal.action_inputs
      : {};
    const sendAction = isRecord(actionInputs.send) ? actionInputs.send : {};
    const send = isRecord(sendAction.arguments)
      ? sendAction.arguments
      : {};
    assert.equal(actions.send, true);
    assert.equal(actions.approve, true);
    assert.equal(Object.keys(send).length, 0);
    assert.equal(Object.hasOwn(send, "selector"), false);
    assert.equal(sendAction.scope, "terminal_user_explicit");
    assert.equal(
      Object.hasOwn(sendAction, "composer_policy"),
      false
    );
    assert.equal(
      Object.hasOwn(terminal, "_user_explicit_composer_ready"),
      false
    );
    assert.equal(Object.hasOwn(terminal, "composer_digest"), false);
    assert.equal(Object.hasOwn(terminal, "composer_draft"), false);
    assert.equal(Object.hasOwn(actionInputs, "approve"), false);
    assert.equal(
      isRecord(listDetails.projection)
        ? listDetails.projection.skill
        : undefined,
      "agent-knock-knock"
    );
    assert.equal(Object.hasOwn(listDetails, "action_contracts"), false);
    assert.equal(Object.hasOwn(listDetails, "session_revisions"), false);
    assert.equal(Object.hasOwn(listDetails, "binding_ids"), false);
    assert.equal(Object.hasOwn(listDetails, "terminal_binding_id"), false);
    assert.equal(
      Object.hasOwn(listDetails, "terminal_binding_generation"),
      false
    );
    assert.equal(
      isRecord(terminal.handoff_decision) &&
        Object.hasOwn(terminal.handoff_decision, "live_native_thread_id"),
      false
    );
    assert.equal(
      isRecord(listDetails.recovery)
        ? listDetails.recovery.expected_message_id
        : undefined,
      "message-semantic-id"
    );
    assert.equal(
      isRecord(listDetails.recovery)
        ? listDetails.recovery.expected_transition_id
        : undefined,
      "transition-semantic-id"
    );
    const statusNested = isRecord(status?.details?.nested)
      ? status.details.nested
      : {};
    assert.equal(
      isRecord(status?.details?.conversation) &&
        Object.hasOwn(status.details.conversation, "native_session_takeover"),
      false
    );
    assert.equal(
      isRecord(status?.details?.conversation) &&
        Object.hasOwn(status.details.conversation, "callback_route"),
      false
    );
    for (const field of [
      "openclaw_session",
      "gateway_session",
      "gateway_method",
      "gateway_url",
      "openclaw_bin"
    ]) {
      assert.equal(
        isRecord(status?.details?.conversation) &&
          Object.hasOwn(status.details.conversation, field),
        false,
        field
      );
    }
    assert.equal(Object.hasOwn(statusNested, "terminal_binding_id"), false);
    assert.equal(
      Object.hasOwn(statusNested, "terminal_binding_generation"),
      false
    );
    assert.equal(
      isRecord(status?.details?.approval_state)
        ? status.details.approval_state.request_detail
        : undefined,
      "inspect token_fingerprint.ts at commit eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-detail-example"
    );
    const callbackBody = isRecord(status?.details?.conversation) &&
        isRecord(status.details.conversation.callback_delivery) &&
        isRecord(status.details.conversation.callback_delivery.message)
      ? String(status.details.conversation.callback_delivery.message.body)
      : "";
    assert.match(callbackBody, /inspect token_fingerprint\.ts after approval/u);
    assert.match(callbackBody, /expected_session_revision: 7/u);
    assert.match(
      callbackBody,
      /--expected-binding-token business-callback-example/u
    );
    assert.doesNotMatch(
      callbackBody,
      /expected_approval_fingerprint|[f]{64}/u
    );
    const recentEventBody = Array.isArray(status?.details?.recent_events) &&
        isRecord(status.details.recent_events[0])
      ? String(status.details.recent_events[0].body)
      : "";
    assert.match(recentEventBody, /ordinary token wording remains visible/u);
    assert.match(recentEventBody, /expected_session_revision: 7/u);
    assert.match(
      recentEventBody,
      /--expected-binding-token business-event-example/u
    );
    assert.doesNotMatch(
      recentEventBody,
      /expected-approval-fingerprint|[f]{64}/u
    );
    assert.match(String(statusNested.reason), /private authority changed/u);
    assert.doesNotMatch(String(statusNested.reason), /revision|7|8/iu);
    assert.match(
      String(status?.details?.bookkeeping_warning),
      /private authority changed/u
    );
    assert.match(String(statusNested.stalledReason), /private authority changed/u);
    assert.equal(Object.hasOwn(statusNested, "expectedSessionRevision"), false);
    assert.equal(Object.hasOwn(statusNested, "expected-session-revision"), false);
    assert.equal(Object.hasOwn(statusNested, "terminalBindingGeneration"), false);
    assert.equal(Object.hasOwn(statusNested, "nonce"), false);
    assert.equal(
      status?.details?.request,
      `inspect token_fingerprint.ts at commit ${"1".repeat(64)}; ` +
        "tokens, fingerprints, revisions, and CAS are ordinary request text\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-example"
    );
    assert.equal(
      status?.details?.completion,
      `completed token_fingerprint.ts at commit ${"2".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-completion-example"
    );
    assert.equal(
      status?.details?.terminal_screen,
      `screen mentions token_fingerprint.ts at commit ${"3".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-screen-example"
    );
    assert.deepEqual(statusNested.missing_required, ["expected_message_id"]);
    assert.equal(statusNested.expected_transition_id, "transition-status-id");
    await assert.rejects(
      () => tools.get("agent_knock_knock_renew")!.execute!(
        "renew-private-error",
        { turn_id: "turn-status" }
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /private authority changed/u);
        assert.doesNotMatch(
          error.message,
          /token|fingerprint|revision|[a-f0-9]{64}/iu
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw split authorities retain approval, lifecycle, and supervisor contracts", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const configProperties = manifest.configSchema.properties;
  assert.equal("workspace" in configProperties, false);
  const autoApproveRule = configProperties.autoApprove.properties.rules.items;
  assert.equal(autoApproveRule.required.includes("workspaces"), true);
  assert.equal(autoApproveRule.properties.workspaces.type, "array");
  assert.equal(autoApproveRule.properties.workspaces.minItems, 1);
  assert.equal("maxItems" in autoApproveRule.properties.workspaces, false);
  assert.equal(autoApproveRule.properties.workspaces.items.type, "string");
  assert.equal(autoApproveRule.properties.workspaces.items.minLength, 1);
  assert.equal(configProperties.agentTimeoutMinutes.type, "number");
  assert.equal(configProperties.agentHardTimeoutMinutes.type, "number");
  assert.equal(configProperties.agentHardTimeoutMinutes.exclusiveMinimum, 0);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_renew"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_renew.optional, true);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_respond"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_respond.optional, true);
  assert.equal(
    manifest.contracts.tools.includes("agent_knock_knock_respond_interaction"),
    true
  );
  assert.equal(
    manifest.toolMetadata.agent_knock_knock_respond_interaction.optional,
    true
  );
  assert.equal(manifest.contracts.tools.length, 22);
  for (const terminalWatchTool of [
    "agent_knock_knock_watch",
    "agent_knock_knock_unwatch"
  ]) {
    assert.equal(manifest.contracts.tools.includes(terminalWatchTool), true);
    assert.equal(manifest.toolMetadata[terminalWatchTool].optional, true);
  }
  for (const lifecycleTool of [
    "agent_knock_knock_list_resumable_threads",
    "agent_knock_knock_native_inspect",
    "agent_knock_knock_model_options",
    "agent_knock_knock_repair_model_control",
    "agent_knock_knock_set_model",
    "agent_knock_knock_identify_foreground",
    "agent_knock_knock_identify_and_send",
    "agent_knock_knock_new_thread",
    "agent_knock_knock_reconcile_binding",
    "agent_knock_knock_resume_thread"
  ]) {
    assert.equal(manifest.contracts.tools.includes(lifecycleTool), true);
    assert.equal(manifest.toolMetadata[lifecycleTool].optional, true);
  }

  const schemasSource = fs.readFileSync(
    path.join(packageRoot, "src", "semantic-tool-schemas.ts"),
    "utf8"
  );
  const schemaAdapterSource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin-schemas.ts"),
    "utf8"
  );
  const semanticRuntimeSource = fs.readFileSync(
    path.join(packageRoot, "src", "semantic-tool-runtime.ts"),
    "utf8"
  );
  const semanticPrivateAuthoritySource = fs.readFileSync(
    path.join(packageRoot, "src", "semantic-tool-private-authority.ts"),
    "utf8"
  );
  const supervisorSource = fs.readFileSync(
    path.join(packageRoot, "src", "host-monitor-reconciliation.ts"),
    "utf8"
  );
  const supervisorAdapterSource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin-supervisor.ts"),
    "utf8"
  );
  const hostLifecycleSource = fs.readFileSync(
    path.join(packageRoot, "src", "host-lifecycle-service.ts"),
    "utf8"
  );
  const terminalListSource = fs.readFileSync(
    path.join(packageRoot, "src", "terminal-list-cli-adapter.ts"),
    "utf8"
  );
  const entrySource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin.ts"),
    "utf8"
  );
  assert.match(
    schemasSource,
    /export const sendParameters =[\s\S]*?agentTimeoutMinutes:[\s\S]*?agentHardTimeoutMinutes:/u
  );
  assert.match(
    schemasSource,
    /export const approveParameters =[\s\S]*?not: \{ required: \["turn_id", "terminal_id"\] \}[\s\S]*?anyOf: \[[\s\S]*?required: \["turn_id"\][\s\S]*?required: \["terminal_id"\]/u
  );
  assert.match(
    schemaAdapterSource,
    /export \* from "\.\/semantic-tool-schemas\.js";/u
  );
  for (const privateCliFence of [
    "--expected-approval-fingerprint",
    "--expected-binding-token",
    "--expected-managed-terminal-token",
    "--expected-terminal-token",
    "--candidate-token"
  ]) {
    assert.match(
      semanticRuntimeSource,
      new RegExp(privateCliFence, "u"),
      `${privateCliFence} remains a runtime-private CLI fence`
    );
  }
  assert.match(
    semanticRuntimeSource,
    /expected_managed_terminal_token[\s\S]*?--expected-managed-terminal-token/u,
    "the private managed fast-path offer must reach the CLI fence"
  );
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_renew"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_watch"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_unwatch"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_new_thread"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_reconcile_binding"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_list_resumable_threads"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_native_inspect"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_model_options"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_repair_model_control"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_set_model"/u);
  assert.match(
    semanticRuntimeSource,
    /MODEL_OPTIONS_CLI_TIMEOUT_MS = 15 \* 60_000[\s\S]*?name: "agent_knock_knock_model_options"[\s\S]*?timeoutMs: MODEL_OPTIONS_CLI_TIMEOUT_MS/u
  );
  assert.match(
    semanticRuntimeSource,
    /SET_MODEL_CLI_TIMEOUT_MS = 30 \* 60_000[\s\S]*?name: "agent_knock_knock_set_model"[\s\S]*?timeoutMs: SET_MODEL_CLI_TIMEOUT_MS/u
  );
  assert.match(
    semanticRuntimeSource,
    /REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS = 2 \* 60_000[\s\S]*?name: "agent_knock_knock_repair_model_control"[\s\S]*?timeoutMs: REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS/u
  );
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_identify_foreground"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_identify_and_send"/u);
  assert.match(semanticRuntimeSource, /name: "agent_knock_knock_resume_thread"/u);
  assert.match(
    semanticRuntimeSource,
    /rememberDisplayedPrivateAuthorityOffers[\s\S]*?rememberDisplayedHandoffActions[\s\S]*?rememberDisplayedReconcileActions/u
  );
  assert.match(
    semanticRuntimeSource,
    /authoritativeHandoffActionArguments[\s\S]*?handoff_decision[\s\S]*?take_over_current/u
  );
  assert.match(
    semanticRuntimeSource,
    /authoritativeTerminalActionArguments[\s\S]*?available_actions/u
  );
  assert.doesNotMatch(
    semanticRuntimeSource,
    /collectToolActionArguments|collectApprovalFingerprints/u
  );
  assert.match(
    semanticRuntimeSource,
    /consumeDisplayedPrivateAction[\s\S]*?authority changed after it was shown/u
  );
  assert.match(
    semanticPrivateAuthoritySource,
    /buildPrivateApprovalArgs[\s\S]*?consumeSemanticPrivateAuthorityOffer[\s\S]*?currentFingerprint !== offeredFingerprint/u
  );
  assert.doesNotMatch(
    semanticRuntimeSource,
    /structured one-time Hook|pending structured permission/u
  );
  assert.doesNotMatch(semanticRuntimeSource, /install-claude-hooks/u);
  assert.match(
    supervisorSource,
    /createHostMonitorReconciliationService[\s\S]*?agent-knock-knock-monitor-reconciliation/u
  );
  assert.match(
    supervisorSource,
    /const args = \["reconcile-monitors", "--reason", reason\][\s\S]*?--terminal-monitors-only[\s\S]*?const args = \["reconcile-watches"\]/u
  );
  assert.match(
    supervisorSource,
    /managedReason[\s\S]*?startup_reconciliation[\s\S]*?monitor_supervision[\s\S]*?watchReason[\s\S]*?startup_reconciliation[\s\S]*?watch_supervision/u
  );
  assert.match(
    supervisorSource,
    /monitor reconciliation skipped after startup error[\s\S]*?monitor supervision deferred after error[\s\S]*?Terminal Watch reconciliation skipped after startup error[\s\S]*?Terminal Watch supervision deferred after error/u
  );
  assert.match(
    supervisorSource,
    /createHostLifecycleService\(\{[\s\S]*?name: MANAGED_MONITOR_PHASE[\s\S]*?reconciliationArgs\(reconciliationReason\)[\s\S]*?name: TERMINAL_WATCH_PHASE[\s\S]*?watchReconciliationArgs\(\)/u
  );
  assert.match(
    supervisorAdapterSource,
    /from "\.\/host-monitor-reconciliation\.js";[\s\S]*?createMonitorReconciliationService =\s*createHostMonitorReconciliationService/u
  );
  assert.match(
    hostLifecycleSource,
    /for \(const phase of options\.phases\)[\s\S]*?await phase\.run\(\{ reason \}\)[\s\S]*?options\.onPhaseError/u
  );
  assert.match(
    hostLifecycleSource,
    /const beginSweep = [\s\S]*?const execution = new Promise<void>[\s\S]*?const sweep = execution\.finally[\s\S]*?inFlight = sweep;[\s\S]*?void runSweep\(reason\)\.then\(settle, reject\)/u
  );
  assert.match(
    hostLifecycleSource,
    /beginSweep\("periodic", scheduleNext\)[\s\S]*?beginSweep\("startup", scheduleNext\)[\s\S]*?async stop\(\)[\s\S]*?cancelScheduled\?\.\(\)[\s\S]*?await stopDrain/u
  );
  assert.match(
    terminalListSource,
    /terminals: projection\.terminals,\s*terminalWatches,/u
  );
  assert.doesNotMatch(
    terminalListSource,
    /activeWatchedTerminals|withoutTerminalWatchAuthority/u
  );
  assert.match(
    entrySource,
    /registerOpenClawCallbackGateway[\s\S]*?registerOpenClawCommands/u
  );
  const skill = fs.readFileSync(skillSource, "utf8");
  assert.match(skill, /agent_knock_knock_renew/u);
  assert.match(skill, /agent_knock_knock_list_resumable_threads/u);
  assert.match(skill, /agent_knock_knock_native_inspect/u);
});

test("OpenClaw entry runtime and declaration expose only the stable plugin API", () => {
  assert.deepEqual(Object.keys(openclawPluginRuntime).sort(), [
    "createOpenClawPluginForTest",
    "default"
  ]);
  const declaration = fs.readFileSync(
    path.join(packageRoot, "dist", "src", "openclaw-plugin.d.ts"),
    "utf8"
  );
  assert.equal((declaration.match(/\bexport\b/gu) ?? []).length, 2);
  assert.match(
    declaration,
    /export declare function createOpenClawPluginForTest\(/u
  );
  assert.match(declaration, /export default plugin;/u);
});

test("OpenClaw plugin instances keep relay paths and config isolated by API", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-instance-isolation-")
  );
  const registerInstance = (
    relayPath: string,
    storeDir: string,
    tools: Map<string, ToolDefinition>
  ): void => {
    (
      createOpenClawPluginForTest(relayPath) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir },
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
  };

  try {
    const instances = ["left", "right"].map((label) => {
      const relayPath = path.join(tempDir, `${label}.cjs`);
      const callsPath = path.join(tempDir, `${label}.ndjson`);
      fs.writeFileSync(
        relayPath,
        [
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
          `process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(label)}, conversation_id: "turn-${label}", session_id: "session-${label}", turn_id: "turn-${label}" }));`
        ].join("\n"),
        "utf8"
      );
      const tools = new Map<string, ToolDefinition>();
      registerInstance(relayPath, `/stores/${label}`, tools);
      return { label, callsPath, tools };
    });

    const results = await Promise.all(instances.map(async (instance) => {
      const status = instance.tools.get("agent_knock_knock_status");
      assert.ok(status);
      return status.execute?.(`status-${instance.label}`, {
        turn_id: `turn-${instance.label}`
      });
    }));
    assert.deepEqual(
      results.map((result) => result?.details?.marker),
      ["left", "right"]
    );
    for (const instance of instances) {
      const calls = fs.readFileSync(instance.callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls, [[
        "status",
        "--reconcile",
        "--turn",
        `turn-${instance.label}`,
        "--store-dir",
        `/stores/${instance.label}`
      ]]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw native inspection is a closed status-only terminal action", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-native-inspect-")
  );
  const fakeCli = path.join(tempDir, "native-inspect.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: { native_inspect: {`,
        `    tool: "agent_knock_knock_native_inspect",`,
        `    arguments: { terminal_id: terminalId, expected_binding_token: "fresh-inspection-token" }`,
        `  } }`,
        `}] } : {`,
        `  status: "observed", inspection: "status", agent: "codex",`,
        `  agent_version: "0.146.1", terminal_id: terminalId,`,
        `  expected_binding_token: "must-not-reach-model",`,
        `  turn_created: false, session_created: false`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        storeDir: "/private/akk-store",
        codexHome: "/private/custom-codex"
      },
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

    const inspectTool = tools.get("agent_knock_knock_native_inspect");
    assert.ok(inspectTool);
    assert.deepEqual(inspectTool.parameters?.required, [
      "terminal_id",
      "inspection"
    ]);
    assert.equal(inspectTool.parameters?.additionalProperties, false);
    const properties = inspectTool.parameters?.properties ?? {};
    assert.deepEqual(sorted(Object.keys(properties)), [
      "inspection",
      "terminal_id"
    ]);
    assert.equal(Object.hasOwn(properties, "command"), false);
    const inspectionSchema = isRecord(properties.inspection)
      ? properties.inspection
      : {};
    assert.deepEqual(inspectionSchema.enum, ["status"]);
    const terminalSchema = isRecord(properties.terminal_id)
      ? properties.terminal_id
      : {};
    assert.match(String(terminalSchema.pattern ?? ""), /terminal:v/u);
    assert.match(
      String(inspectionSchema.description ?? ""),
      /Codex 0\.146\.0\/0\.146\.1\/0\.147\.0\/0\.148\.0/u
    );
    assert.match(
      String(inspectionSchema.description ?? ""),
      /Claude Code 2\.1\.218\/2\.1\.226\/2\.1\.237\/2\.1\.251/u
    );
    assert.match(
      inspectTool.description ?? "",
      /creates no AKK Session, Turn, receipt, monitor, or callback/u
    );
    assert.match(inspectTool.description ?? "", /arbitrary slash commands/iu);

    const result = await inspectTool.execute?.("native-status", {
      terminal_id: terminalId,
      inspection: "status"
    });
    assert.equal(result?.details?.status, "observed");
    assert.equal(result?.details?.turn_created, false);
    assertModelToolResultHasNoOpaqueAuthority(result);
    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(
      calls[1],
      [
        "native-inspect",
        "--terminal",
        terminalId,
        "--inspection",
        "status",
        "--expected-binding-token",
        "fresh-inspection-token",
        "--store-dir",
        "/private/akk-store",
        "--codex-home",
        "/private/custom-codex"
      ]
    );

    await assert.rejects(
      () => inspectTool.execute!("unsupported-inspection", {
        terminal_id: terminalId,
        inspection: "usage"
      }),
      /inspection must be status/u
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw foreground identification keeps physical authority private and atomic", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-identify-foreground-")
  );
  const fakeCli = path.join(tempDir, "identify-foreground.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:identify:0.0:1234";
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `let result;`,
        `if (args[0] === "list") result = { terminals: [{ id: terminalId, available_actions: {`,
        `  identify_foreground: { tool: "agent_knock_knock_identify_foreground", arguments: { terminal_id: terminalId, expected_terminal_token: "private-physical-token" } },`,
        `  identify_and_send: { tool: "agent_knock_knock_identify_and_send", arguments: { terminal_id: terminalId, expected_terminal_token: "private-physical-token" }, missing_required: ["request"] }`,
        `} }] };`,
        `else if (args[0] === "identify-foreground") result = { status: "observed", inspection: "identify_foreground", terminal_id: terminalId, native_thread_id: "11111111-1111-4111-8111-111111111111", foreground_proof: { scope: "ephemeral_diagnostic_only", grants_authority: false }, store_mutation: false, session_created: false, turn_created: false };`,
        `else result = { delivered: true, status: "submission_pending_acceptance", terminal_input_dispatched: true, agent_acceptance: "unproven", management_mode: "managed", observation_mode: "terminal_monitor", capabilities: { callback: true, interaction_notify: true, interaction_respond: true } };`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir: "/private/akk-store" },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) tools.set(options.name, definition);
      }
    });

    const identify = tools.get("agent_knock_knock_identify_foreground");
    const atomicSend = tools.get("agent_knock_knock_identify_and_send");
    assert.ok(identify);
    assert.ok(atomicSend);
    assert.deepEqual(identify.parameters?.required, ["terminal_id"]);
    assert.deepEqual(atomicSend.parameters?.required, ["terminal_id", "request"]);
    assertNoModelOpaqueAuthority(identify.parameters);
    assertNoModelOpaqueAuthority(atomicSend.parameters);

    const identified = await identify.execute?.("identify-call", {
      terminal_id: terminalId
    });
    assert.equal(identified?.details?.status, "observed");
    assert.equal(identified?.details?.store_mutation, false);
    assertModelToolResultHasNoOpaqueAuthority(identified);

    const sent = await atomicSend.execute?.("atomic-send-call", {
      terminal_id: terminalId,
      request: "Run one safe task"
    });
    assert.equal(sent?.details?.delivered, true);
    assert.equal(sent?.details?.management_mode, "managed");
    assertModelToolResultHasNoOpaqueAuthority(sent);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const authorityRefreshes = calls.filter((args) => args[0] === "list");
    assert.equal(authorityRefreshes.length, 2);
    assert.equal(
      authorityRefreshes.every((args) => !args.includes("--reconcile")),
      true,
      "P2 authority refresh must remain read-only before the explicit probe"
    );
    const identifyCall = calls.find((args) => args[0] === "identify-foreground");
    assert.deepEqual(identifyCall, [
      "identify-foreground",
      "--terminal",
      terminalId,
      "--expected-terminal-token",
      "private-physical-token",
      "--store-dir",
      "/private/akk-store"
    ]);
    const sendCall = calls.find((args) =>
      args[0] === "send" && args.includes("--identify-foreground")
    );
    assert.ok(sendCall);
    assert.deepEqual(sendCall?.slice(0, 8), [
      "send",
      "--conversation",
      terminalId,
      "--expected-terminal-token",
      "private-physical-token",
      "--identify-foreground",
      "--message",
      "Run one safe task"
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw native-thread tools keep CLI fences private while semantic calls refresh them", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-native-thread-")
  );
  const fakeCli = path.join(tempDir, "native-thread.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const currentThreadId = "11111111-1111-4111-8111-111111111111";
  const resumeThreadId = "22222222-2222-4222-8222-222222222222";
  const lifecycleFailurePath = path.join(tempDir, "lifecycle-failure.txt");
  const tools = new Map<string, ToolDefinition>();
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
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const action = args[0];`,
        `const failureStatus = fs.existsSync(${JSON.stringify(lifecycleFailurePath)}) ? fs.readFileSync(${JSON.stringify(lifecycleFailurePath)}, "utf8").trim() : "";`,
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `const currentThreadId = ${JSON.stringify(currentThreadId)};`,
        `const resumeThreadId = ${JSON.stringify(resumeThreadId)};`,
        `const result = action === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: {`,
        `    new_thread: { tool: "agent_knock_knock_new_thread", arguments: { terminal_id: terminalId, expected_binding_token: "fresh-binding-token" } },`,
        `    reconcile_binding: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 7, expected_binding_token: "fresh-conflict-binding-token", expected_terminal_token: "fresh-terminal-token" } }`,
        `  }`,
        `}] } : action === "list-resumable-threads" ? {`,
        `  terminal_id: terminalId,`,
        `  current_session_id: "session-current",`,
        `  current_native_thread_id: currentThreadId,`,
        `  expected_binding_token: "fresh-binding-token",`,
        `  threads: [{ native_thread_id: resumeThreadId, resumable: true, candidate_token: "fresh-candidate-token" }]`,
        `} : failureStatus && (action === "new-thread" || action === "resume-thread") ? {`,
        `  status: failureStatus, operation: action === "new-thread" ? "new_thread" : "resume_thread", terminal_id: terminalId,`,
        `  transition_id: "transition-recovery-required", do_not_retry: true, turn_created: false,`,
        `  reason: "expected revision 7, actual revision 8"`,
        `} : action === "new-thread" ? {`,
        `  status: "committed", operation: "new_thread", terminal_id: terminalId,`,
        `  previous_session_id: "session-current", session_id: "session-new",`,
        `  previous_native_thread_id: currentThreadId, native_thread_id: "33333333-3333-4333-8333-333333333333",`,
        `  binding_generation: 2, turn_created: false`,
        `} : action === "reconcile-binding" ? {`,
        `  status: "reconciled", outcome: "detached_conflicting_binding", terminal_id: terminalId,`,
        `  session_id: "session-conflict", session_revision: 8, terminal_input_sent: false, turn_created: false, refresh_required: true`,
        `} : {`,
        `  status: "committed", operation: "resume_thread", terminal_id: terminalId,`,
        `  previous_session_id: "session-current", session_id: "session-resumed",`,
        `  previous_native_thread_id: currentThreadId, native_thread_id: resumeThreadId,`,
        `  binding_generation: 2, turn_created: false`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        storeDir: "/private/akk-store",
        codexHome: "/private/custom-codex"
      },
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
              sessionKey: "agent:test:lifecycle",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    const listTool = tools.get("agent_knock_knock_list_resumable_threads");
    const terminalListTool = tools.get("agent_knock_knock_list");
    const newTool = tools.get("agent_knock_knock_new_thread");
    const reconcileTool = tools.get("agent_knock_knock_reconcile_binding");
    const resumeTool = tools.get("agent_knock_knock_resume_thread");
    assert.ok(listTool);
    assert.ok(terminalListTool);
    assert.ok(newTool);
    assert.ok(reconcileTool);
    assert.ok(resumeTool);
    assert.deepEqual(listTool.parameters?.required, ["terminal_id"]);
    assert.deepEqual(newTool.parameters?.required, ["terminal_id"]);
    assert.deepEqual(resumeTool.parameters?.required, [
      "terminal_id",
      "native_thread_id"
    ]);
    assert.deepEqual(reconcileTool.parameters?.required, [
      "terminal_id",
      "conflicting_session_id"
    ]);
    assert.equal(listTool.parameters?.additionalProperties, false);
    assert.equal(newTool.parameters?.additionalProperties, false);
    assert.equal(reconcileTool.parameters?.additionalProperties, false);
    assert.equal(resumeTool.parameters?.additionalProperties, false);
    for (const definition of [
      listTool,
      newTool,
      reconcileTool,
      resumeTool
    ]) {
      const terminalSchema = definition.parameters?.properties?.terminal_id;
      assert.match(
        isRecord(terminalSchema) ? String(terminalSchema.pattern ?? "") : "",
        /terminal:v/u
      );
    }
    assert.match(newTool.description ?? "", /no Turn/u);
    assert.match(reconcileTool.description ?? "", /explicit user confirmation/u);
    assert.match(reconcileTool.description ?? "", /creates no Turn/u);
    assert.match(resumeTool.description ?? "", /resumable=true/u);

    const listed = await listTool.execute?.("list-threads", {
      terminal_id: terminalId
    });
    assertModelToolResultHasNoOpaqueAuthority(listed);
    assert.equal(
      Object.hasOwn(listed?.details ?? {}, "expected_binding_token"),
      false
    );
    const created = await newTool.execute?.("new-thread", {
      terminal_id: terminalId
    });
    assert.equal(created?.details?.session_id, "session-new");
    assert.equal(Object.hasOwn(created?.details ?? {}, "turn_id"), false);
    const resumed = await resumeTool.execute?.("resume-thread", {
      terminal_id: terminalId,
      native_thread_id: resumeThreadId
    });
    assert.equal(resumed?.details?.session_id, "session-resumed");
    assert.equal(Object.hasOwn(resumed?.details ?? {}, "turn_id"), false);
    const terminalList = await terminalListTool.execute?.(
      "list-reconcile-authority",
      {}
    );
    assertModelToolResultHasNoOpaqueAuthority(terminalList);
    const reconciled = await reconcileTool.execute?.("reconcile-binding", {
      terminal_id: terminalId,
      conflicting_session_id: "session-conflict"
    });
    assert.equal(reconciled?.details?.status, "reconciled");
    assert.equal(reconciled?.details?.terminal_input_sent, false);
    assert.equal(reconciled?.details?.turn_created, false);
    const threadsSlash = await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(threadsSlash?.text ?? "", /1 resumable/u);
    const chooseSlash = await command?.handler?.({
      args: `resume-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(chooseSlash?.text ?? "", new RegExp(resumeThreadId, "u"));
    const newSlash = await command?.handler?.({
      args: `new-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(newSlash?.text ?? "", /No AKK Turn was created/u);
    const clearSlash = await command?.handler?.({
      args: `clear-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(clearSlash?.text ?? "", /started and verified/u);
    const resumeSlash = await command?.handler?.({
      args: `resume-thread ${terminalId} ${resumeThreadId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(resumeSlash?.text ?? "", /resumed and verified/u);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0], [
      "list-resumable-threads",
      "--terminal",
      terminalId,
      "--store-dir",
      "/private/akk-store",
      "--codex-home",
      "/private/custom-codex"
    ]);
    const newThreadCalls = calls.filter(([action]) => action === "new-thread");
    const resumeThreadCalls = calls.filter(
      ([action]) => action === "resume-thread"
    );
    const reconcileCalls = calls.filter(
      ([action]) => action === "reconcile-binding"
    );
    assert.equal(newThreadCalls.length, 3);
    assert.equal(resumeThreadCalls.length, 2);
    assert.equal(reconcileCalls.length, 1);
    for (const args of [...newThreadCalls, ...resumeThreadCalls]) {
      assert.equal(
        args[args.indexOf("--expected-binding-token") + 1],
        "fresh-binding-token"
      );
    }
    for (const args of resumeThreadCalls) {
      assert.equal(
        args[args.indexOf("--candidate-token") + 1],
        "fresh-candidate-token"
      );
    }
    assert.deepEqual(reconcileCalls[0]?.slice(0, 15), [
      "reconcile-binding",
      "--terminal",
      terminalId,
      "--conflicting-session",
      "session-conflict",
      "--expected-session-revision",
      "7",
      "--expected-binding-token",
      "fresh-conflict-binding-token",
      "--expected-terminal-token",
      "fresh-terminal-token",
      "--store-dir",
      "/private/akk-store",
      "--codex-home",
      "/private/custom-codex"
    ]);
    for (const args of calls.filter((candidate) =>
      candidate[0] !== "list"
    )) {
      assert.equal(
        args[args.indexOf("--codex-home") + 1],
        "/private/custom-codex"
      );
    }

    fs.writeFileSync(lifecycleFailurePath, "uncertain");
    const uncertainNewTool = await newTool.execute?.("new-thread-uncertain", {
      terminal_id: terminalId
    });
    const uncertainResumeTool = await resumeTool.execute?.(
      "resume-thread-uncertain",
      {
        terminal_id: terminalId,
        native_thread_id: resumeThreadId
      }
    );
    for (const failed of [uncertainNewTool, uncertainResumeTool]) {
      assert.equal(failed?.isError, true);
      assert.equal(failed?.details?.status, "uncertain");
      assert.equal(failed?.details?.do_not_retry, true);
      assert.match(String(failed?.details?.reason), /private authority changed/u);
      assert.doesNotMatch(String(failed?.details?.reason), /revision|7|8/iu);
    }

    fs.writeFileSync(lifecycleFailurePath, "verified_recovery_required");
    const failedResumeSlash = await command?.handler?.({
      args: `resume-thread ${terminalId} ${resumeThreadId}`,
      sessionKey: "agent:test:lifecycle-recovery-required"
    });
    assert.equal(failedResumeSlash?.isError, true);
    assert.match(failedResumeSlash?.text ?? "", /Session commit requires recovery/u);
    assert.match(failedResumeSlash?.text ?? "", /do not retry automatically/iu);
    assert.match(failedResumeSlash?.text ?? "", /exact lifecycle recovery action/u);
    assert.doesNotMatch(failedResumeSlash?.text ?? "", /resumed and verified/u);
    assert.match(failedResumeSlash?.text ?? "", /private authority changed/u);
    assert.doesNotMatch(failedResumeSlash?.text ?? "", /revision|7|8/iu);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw Resume shortcuts preserve the displayed snapshot and previous exact action", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-resume-navigation-")
  );
  const fakeCli = path.join(tempDir, "resume-navigation.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const firstThreadId = "11111111-1111-4111-8111-111111111111";
  const secondThreadId = "22222222-2222-4222-8222-222222222222";
  const snapshotId = "rs_abcdefghijklmnopqrstuv";
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
    fs.writeFileSync(fakeCli, [
      `const fs = require("node:fs");`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
      `const terminalId = ${JSON.stringify(terminalId)};`,
      `const first = ${JSON.stringify(firstThreadId)};`,
      `const second = ${JSON.stringify(secondThreadId)};`,
      `const snapshotId = ${JSON.stringify(snapshotId)};`,
      `const result = args[0] === "list-resumable-threads" ? {`,
      `  terminal_id: terminalId, current_session_id: "session-current", current_native_thread_id: first,`,
      `  expected_binding_token: "fresh-binding",`,
      `  selection_snapshot: { snapshot_id: snapshotId, expires_at: "2099-01-01T00:00:00.000Z" },`,
      `  previous: { native_thread_id: second, available_actions: { resume_thread: { arguments: { terminal_id: terminalId, native_thread_id: second, expected_binding_token: "previous-binding", candidate_token: "previous-candidate" } } } },`,
      `  threads: [`,
      `    { native_thread_id: first, selection_number: 1, short_id: "@11111111", selection_handle: snapshotId + ":1", resumable: true, candidate_token: "first-candidate" },`,
      `    { native_thread_id: second, selection_number: 2, short_id: "@22222222", selection_handle: snapshotId + ":2", resumable: true, candidate_token: "second-candidate" }`,
      `  ]`,
      `} : { status: "committed", operation: "resume_thread", terminal_id: terminalId, session_id: "session-resumed", native_thread_id: second, turn_created: false };`,
      `process.stdout.write(JSON.stringify(result));`
    ].join("\n"), "utf8");

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir: "/private/akk-store" },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool() {}
    });

    await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `resume-thread ${terminalId} 2`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    const resetRejected = await command?.handler?.({
      args: `resume-thread ${terminalId} @22222222`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-b"
    });
    assert.equal(resetRejected?.isError, true);
    assert.match(resetRejected?.text ?? "", /last displayed snapshot/u);
    await command?.handler?.({
      args: `resume-thread ${terminalId} @22222222`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `resume-thread ${terminalId} previous`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args[0]), [
      "list-resumable-threads",
      "resume-thread",
      "list-resumable-threads",
      "resume-thread",
      "list-resumable-threads",
      "resume-thread"
    ]);
    assert.deepEqual(
      calls[1].slice(0, 7),
      [
        "resume-thread",
        "--terminal",
        terminalId,
        "--selection-snapshot",
        snapshotId,
        "--selection-number",
        "2"
      ]
    );
    assert.equal(calls[3][calls[3].indexOf("--selection-short-id") + 1], "@22222222");
    assert.equal(calls[5][calls[5].indexOf("--native-thread") + 1], secondThreadId);
    assert.equal(calls[5][calls[5].indexOf("--expected-binding-token") + 1], "previous-binding");
    assert.equal(calls[5][calls[5].indexOf("--candidate-token") + 1], "previous-candidate");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
