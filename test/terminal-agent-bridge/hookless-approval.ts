import {
  test,
  assert,
  createHash,
  createTerminalAgentAdapterRegistry,
  terminalApprovalPromptEvidence,
  createClaudeTerminalAgentAdapter,
  TerminalAgentBridge,
  PANE,
  MANAGED_CLAUDE_RUNTIME,
  RecordingTerminalProvider,
  TimelineTerminalProvider,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  strictClaudeBashApprovalScreen,
  type TerminalAgentAdapter,
  type TerminalDurableCompletionRequest
} from "../support/terminal-agent-bridge-contract-support.js";

test("approval revalidates fingerprint A to B and sends zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:command A"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const initialStatus = await bridge.status("claude", control);
  const fingerprintA = initialStatus.approval_state.fingerprint;
  assert.ok(fingerprintA);

  provider.setScreen(PANE.target, "approval:command B");
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprintA
  });

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed/);
  assert.notEqual(result.fingerprint, fingerprintA);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("keys approval rejects a prompt switch after authorization and sends zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:command A"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  let authorizationCalls = 0;
  const status = await bridge.status("claude", control);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    authorize(context) {
      authorizationCalls += 1;
      assert.equal(context.inspection.approval.approvable, true);
      if (context.inspection.approval.approvable) {
        assert.equal(context.inspection.approval.command, "command A");
      }
      provider.setScreen(PANE.target, "approval:command B");
      return { approved: true };
    }
  });

  assert.equal(authorizationCalls, 1);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.command, "command B");
  assert.match(result.reason ?? "", /fingerprint changed after authorization/);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude approval sends one Enter only after a stable double capture", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(status.approval_state.approvable, true);
  assert.equal(status.approval_state.decision_mode, "keys");
  assert.deepEqual(status.approval_state.keys, ["C-m"]);
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(result.approved, true);
  assert.equal(result.blocked, false);
  assert.equal(result.key, "C-m");
  assert.deepEqual(result.keys, ["C-m"]);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{
      kind: "keys",
      target: PANE.target,
      keys: ["C-m"],
      socketPath: PANE.socketPath
    }]
  );
});

test("hookless Claude exposes only transcript hashes publicly and keeps raw policy evidence local", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const commandSha256 = createHash("sha256").update(command).digest("hex");
  const evidenceFingerprint = "d".repeat(64);
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture",
    requestHash: "request-hash",
    startedAt: "2026-07-25T02:00:00.000Z",
    context: { managed: true }
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval(request) {
      detectorCalls += 1;
      assert.equal(request, durableRequest);
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256,
        evidenceFingerprint,
        observedEndOffsetBytes: 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const poll = await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  });
  const fingerprint = poll.status.approval_state.fingerprint;
  assert.ok(fingerprint);
  assert.deepEqual(poll.status.approval_state.policy_evidence, {
    source: "claude_transcript",
    kind: "run_command",
    command_sha256: commandSha256,
    evidence_fingerprint: evidenceFingerprint,
    request_id: "toolu_bridge_approval"
  });
  assert.equal(poll.status.approval_state.command, undefined);
  assert.equal(JSON.stringify(poll.status).includes(command), false);

  let authorizeSawRawEvidence = false;
  let dispatchSawFreshEvidence = false;
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    requiredDecisionMode: "keys",
    authorize({ inspection }) {
      assert.equal(
        inspection.approval.approvable
          ? inspection.approval.policyEvidence?.command
          : undefined,
        command
      );
      authorizeSawRawEvidence = true;
      return { approved: true };
    },
    beforeKeyDispatch({ inspection }) {
      assert.equal(
        inspection.approval.approvable
          ? inspection.approval.policyEvidence?.evidenceFingerprint
          : undefined,
        evidenceFingerprint
      );
      dispatchSawFreshEvidence = true;
    }
  });

  assert.equal(result.approved, true);
  assert.equal(authorizeSawRawEvidence, true);
  assert.equal(dispatchSawFreshEvidence, true);
  assert.equal(detectorCalls, 4);
  assert.equal(JSON.stringify(result).includes(command), false);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    1
  );
});

test("hookless Claude sends zero keys when transcript evidence changes after authorization", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture"
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval() {
      detectorCalls += 1;
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256: createHash("sha256").update(command).digest("hex"),
        evidenceFingerprint: (detectorCalls >= 3 ? "e" : "d").repeat(64),
        observedEndOffsetBytes: detectorCalls >= 3 ? 8193 : 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = (await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  })).status;
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    authorize: () => ({ approved: true })
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed after authorization/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude sends zero keys when transcript evidence changes after reservation", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture"
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval() {
      detectorCalls += 1;
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256: createHash("sha256").update(command).digest("hex"),
        evidenceFingerprint: (detectorCalls >= 4 ? "e" : "d").repeat(64),
        observedEndOffsetBytes: detectorCalls >= 4 ? 8193 : 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = (await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  })).status;
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    authorize: () => ({ approved: true }),
    beforeKeyDispatch: () => undefined
  });

  assert.equal(detectorCalls, 4);
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed after dispatch reservation/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude dispatch reservation is followed by recapture and identity validation", async () => {
  const timeline: string[] = [];
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new TimelineTerminalProvider(timeline, [PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity(request) {
      assert.equal(request.agent, "claude");
      assert.equal(request.pid, MANAGED_CLAUDE_RUNTIME.pid);
      assert.equal(request.terminalControl.target, PANE.target);
      timeline.push("identity");
    }
  });
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(status.approval_state.fingerprint);
  timeline.length = 0;

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    async beforeKeyDispatch(context) {
      assert.deepEqual(timeline, [
        "identity",
        "capture",
        "identity",
        "capture",
        "identity"
      ]);
      assert.equal(context.agent, "claude");
      assert.equal(context.fingerprint, status.approval_state.fingerprint);
      assert.equal(context.terminalControl.target, PANE.target);
      assert.equal(context.inspection.approval.approvable, true);
      assert.deepEqual(context.keys, ["C-m"]);
      assert.equal(context.runtime, MANAGED_CLAUDE_RUNTIME);
      timeline.push("beforeKeyDispatch");
    }
  });

  assert.equal(result.approved, true);
  assert.deepEqual(timeline, [
    "identity",
    "capture",
    "identity",
    "capture",
    "identity",
    "beforeKeyDispatch",
    "identity",
    "capture",
    "identity",
    "sendKeys:C-m"
  ]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{
      kind: "keys",
      target: PANE.target,
      keys: ["C-m"],
      socketPath: PANE.socketPath
    }]
  );
});

test("hookless Claude revalidates terminal identity after reservation and sends zero keys on reuse", async () => {
  let reservationPersisted = false;
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      if (reservationPersisted) {
        throw new Error("terminal pane was reused after approval reservation");
      }
    }
  });
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  await assert.rejects(
    () => bridge.approve("claude", control, {
      expectedFingerprint: fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch() {
        reservationPersisted = true;
      }
    }),
    /pane was reused after approval reservation/u
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude rejects a changed terminal ref from the final identity check", async () => {
  let verificationCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity({ terminalControl }) {
      verificationCalls += 1;
      if (verificationCalls === 6) {
        return {
          terminalControl: {
            ...terminalControl,
            socketPath: "/tmp/reused-tmux.sock"
          }
        };
      }
      return { terminalControl };
    }
  });
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  await assert.rejects(
    bridge.approve("claude", control, {
      expectedFingerprint: fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch: () => undefined
    }),
    /terminal control identity changed/u
  );
  assert.equal(verificationCalls, 6);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude recaptures the one-time choice after reservation and sends zero keys on selection change", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    beforeKeyDispatch() {
      provider.setScreen(PANE.target, strictClaudeBashApprovalScreen(2));
    }
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /no longer approvable after dispatch reservation/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude sends zero keys when the dispatch callback throws", async () => {
  const timeline: string[] = [];
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new TimelineTerminalProvider(timeline, [PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      timeline.push("identity");
    }
  });
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(status.approval_state.fingerprint);
  timeline.length = 0;

  await assert.rejects(
    () => bridge.approve("claude", control, {
      expectedFingerprint: status.approval_state.fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch() {
        assert.deepEqual(timeline, [
          "identity",
          "capture",
          "identity",
          "capture",
          "identity"
        ]);
        timeline.push("beforeKeyDispatch");
        throw new Error("dispatch reservation failed");
      }
    }),
    /dispatch reservation failed/u
  );

  assert.deepEqual(timeline, [
    "identity",
    "capture",
    "identity",
    "capture",
    "identity",
    "beforeKeyDispatch"
  ]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude approval sends zero keys when Yes changes before the second capture", async (t) => {
  for (const [label, selectedChoice] of [
    ["persistent permission", 2],
    ["No", 3]
  ] as const) {
    await t.test(label, async () => {
      const adapter = createClaudeTerminalAgentAdapter();
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: strictClaudeBashApprovalScreen()
      });
      const bridge = createBridge(adapter, provider);
      const control = terminalControl(adapter);
      const status = await bridge.status("claude", control, {
        runtime: MANAGED_CLAUDE_RUNTIME
      });
      assert.ok(status.approval_state.fingerprint);

      const result = await bridge.approve("claude", control, {
        expectedFingerprint: status.approval_state.fingerprint,
        runtime: MANAGED_CLAUDE_RUNTIME,
        authorize() {
          provider.setScreen(
            PANE.target,
            strictClaudeBashApprovalScreen(selectedChoice)
          );
          return { approved: true };
        }
      });

      assert.equal(result.approved, false);
      assert.equal(result.blocked, true);
      assert.match(result.reason ?? "", /no longer approvable after authorization/u);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        []
      );
    });
  }
});

test("hookless Claude fingerprints raw screen changes hidden by redaction", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const firstScreen = strictClaudeBashApprovalScreen(
    1,
    "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa' https://example.test"
  );
  const secondScreen = strictClaudeBashApprovalScreen(
    1,
    "curl -H 'Authorization: Bearer bbbbbbbbbbbbbbbbbbbbbbbb' https://example.test"
  );
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: firstScreen
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const firstStatus = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(firstStatus.approval_state.fingerprint);
  assert.equal(firstStatus.approval_state.command, undefined);
  assert.equal(
    firstStatus.approval_state.request_detail,
    "Bash request details omitted; inspect the live terminal pane directly"
  );
  assert.doesNotMatch(firstStatus.approval_state.request_detail, /Bearer/u);
  assert.doesNotMatch(firstStatus.screen.excerpt ?? "", /aaaaaaaa/u);

  provider.setScreen(PANE.target, secondScreen);
  const secondStatus = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(secondStatus.approval_state.fingerprint);
  assert.equal(
    secondStatus.approval_state.request_detail,
    firstStatus.approval_state.request_detail
  );
  assert.equal(secondStatus.screen.excerpt, firstStatus.screen.excerpt);
  assert.notEqual(
    secondStatus.approval_state.fingerprint,
    firstStatus.approval_state.fingerprint
  );

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: firstStatus.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed before execution/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude key approval requires the latest expected fingerprint", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);

  const result = await bridge.approve(
    "claude",
    terminalControl(adapter),
    { runtime: MANAGED_CLAUDE_RUNTIME }
  );

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /requires the latest expected fingerprint/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("cancel fails closed for an ambiguous non-approvable prompt without sending keys", async () => {
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "ambiguous permission state" },
        approval: {
          blocked: true,
          approvable: false,
          reason: "multiple pending permission requests are ambiguous"
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "ambiguous permission"
  });

  const result = await createBridge(adapter, provider).cancel(
    "claude",
    terminalControl(adapter)
  );

  assert.equal(result.cancelRequested, false);
  assert.match(result.reason ?? "", /ambiguous/);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("ordered approval keys participate in fingerprint revalidation", async () => {
  let approvalKeys: readonly string[] = ["Down", "C-m"];
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "test permission prompt" },
        approval: {
          blocked: true,
          approvable: true,
          promptKind: "test_permission",
          command: "npm test",
          promptEvidence: terminalApprovalPromptEvidence(
            "test-approval-prompt-v1",
            screen
          ),
          action: { keys: approvalKeys, label: "Allow once" }
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "same approval screen"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const fingerprintA = (await bridge.status("claude", control)).approval_state.fingerprint;
  assert.ok(fingerprintA);

  approvalKeys = ["C-m", "Down"];
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprintA
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed/);
  assert.notEqual(result.fingerprint, fingerprintA);
  assert.deepEqual(result.keys, ["C-m", "Down"]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("approval with an empty ordered key sequence fails closed", async () => {
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "test permission prompt" },
        approval: {
          blocked: true,
          approvable: true,
          promptKind: "test_permission",
          command: "npm test",
          promptEvidence: terminalApprovalPromptEvidence(
            "test-approval-prompt-v1",
            screen
          ),
          action: { keys: [], label: "Broken action" }
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);

  const result = await bridge.approve("claude", terminalControl(adapter));

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /approval action has no keys/);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});
