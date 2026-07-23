import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { ClaudeHookStore } from "../src/claude-hook-store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const CODEX_ACPX_SELECTOR = ["--agent", "npx -y @agentclientprotocol/codex-acp@1.1.7"];
const sessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const cwd = "/repo/agent-knock-knock";
const rolloutPath = "/tmp/codex-rollout.jsonl";

test("hookless Claude tmux approval is bound to a managed callback and sends exactly one C-m", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-hookless-approval-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42300;
  const claudeSessionId = "44444444-4444-4444-8444-444444444444";
  const rawConversationId = `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`;
  const approvalScreen = [
    " Bash command",
    "",
    "   npm test -- --runInBand",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend"
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, approvalScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: claudePid,
      ppid: 999,
      command: "claude",
      cwd: workspace
    }]);
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const claudeAgentArgs = [
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([claudeAgentRow(claudePid, claudeSessionId, workspace)])
    ];
    const controlMCount = () => readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[1] === "-t" &&
        call.args[2] === terminalTarget &&
        call.args[3] === "C-m"
      ).length;

    const rawApproval = runAgentCli([
      "approve",
      "--conversation",
      rawConversationId,
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(rawApproval.status, 0, rawApproval.stderr || rawApproval.stdout);
    const rawApprovalParsed = JSON.parse(rawApproval.stdout);
    assert.equal(rawApprovalParsed.approved, false);
    assert.equal(rawApprovalParsed.blocked, true);
    assert.match(rawApprovalParsed.reason, /send --background/u);
    assert.equal(controlMCount(), 0, "raw Claude terminal control must not send approval keys");

    fs.writeFileSync(screenPath, "❯ ");
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Run the focused tests",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      ...claudeAgentArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.executor.kind, "claude");
    const conversation = sentParsed.conversation;
    const nativeTakeover = conversation.native_session_takeover;
    assert.deepEqual(
      Object.keys(nativeTakeover).filter((key) => key.startsWith("claude_hook_")),
      [],
      "default Claude tmux sends must not persist hook lease metadata"
    );
    assert.equal(nativeTakeover.claude_hook_mode, undefined);
    assert.equal(
      nativeTakeover.terminal_control.capabilities.includes("durable_completion"),
      true
    );
    assert.doesNotMatch(
      fs.readFileSync(conversation.event_log_path, "utf8"),
      /claude_hook_(?:lease|mode|store)/u
    );
    // The managed send itself submits its prompt with C-m. Reset the transport log so
    // the assertions below count only keys emitted by the approval path.
    fs.writeFileSync(tmuxCallsPath, "");

    fs.writeFileSync(screenPath, approvalScreen);
    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: approvalScreen
    });
    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      conversation.state_path,
      "--log",
      conversation.event_log_path,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...staticArgs
    ], testEnv);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.type, "question");
    assert.equal(monitoredParsed.message.metadata.reason, "approval_required");
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");
    const terminalStatus = monitoredParsed.message.metadata.terminal_status;
    const approvalState = terminalStatus.approval_state;
    const approvalFingerprint = monitoredParsed.message.metadata.approval_fingerprint;
    assert.equal(terminalStatus.capabilities.durableCompletion, true);
    assert.equal(approvalState.approvable, true);
    assert.equal(approvalState.decision_mode, "keys");
    assert.equal(approvalState.key, "C-m");
    assert.deepEqual(approvalState.keys, ["C-m"]);
    assert.equal(typeof approvalFingerprint, "string");
    assert.ok(approvalFingerprint.length > 0);
    assert.deepEqual(monitoredParsed.message.metadata.approval_candidate, {
      agent: "claude",
      kind: "claude_permission",
      command: "npm test -- --runInBand",
      tool_name: "Bash",
      cwd: workspace,
      fingerprint: approvalFingerprint,
      terminal_target: terminalTarget,
      decision_mode: "keys"
    });
    const callbackCall = readJsonLines(openclawCallsPath).at(-1);
    const callbackParamsIndex = callbackCall.args.indexOf("--params");
    assert.notEqual(callbackParamsIndex, -1);
    const callbackParams = JSON.parse(callbackCall.args[callbackParamsIndex + 1]);
    assert.equal(callbackParams.message.metadata.approval_fingerprint, approvalFingerprint);
    assert.equal(callbackParams.message.metadata.approval_candidate.decision_mode, "keys");
    assert.deepEqual(
      callbackParams.message.metadata.terminal_status.approval_state.keys,
      ["C-m"]
    );
    assert.equal(controlMCount(), 0);

    const safePolicy = {
      enabled: true,
      rules: [{
        id: "hookless-claude-test",
        agents: ["claude"],
        workspaces: [workspace],
        commands: [["npm", "test", "--", "--runInBand"]]
      }]
    };
    const autoApproved = runAgentCli([
      "approve",
      "--state",
      conversation.state_path,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "hookless-claude-test",
      "--auto-approval-policy-json",
      JSON.stringify(safePolicy),
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(autoApproved.status, 0, autoApproved.stderr || autoApproved.stdout);
    const autoApprovedParsed = JSON.parse(autoApproved.stdout);
    assert.equal(autoApprovedParsed.approved, false);
    assert.match(autoApprovedParsed.reason, /approval mode keys|structured|decision mode/u);
    assert.equal(controlMCount(), 0, "hookless Claude approval must never be automatic");

    const uncertainStatePath = writeConversationClone(
      storeDir,
      monitoredParsed.conversation,
      "claude-hookless-uncertain-dispatch",
      (state) => ({
        ...state,
        native_session_takeover: {
          ...state.native_session_takeover,
          terminal_bridge_approval_dispatch: {
            state: "reserved",
            attempt_id: "interrupted-attempt",
            fingerprint: approvalFingerprint,
            keys: ["C-m"],
            terminal_target: terminalTarget,
            terminal_bridge_message_id:
              state.native_session_takeover.terminal_bridge_message_id,
            reserved_at: new Date().toISOString()
          }
        }
      })
    );
    const uncertainReplay = runAgentCli([
      "approve",
      "--state",
      uncertainStatePath,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(uncertainReplay.status, 0, uncertainReplay.stderr || uncertainReplay.stdout);
    assert.equal(JSON.parse(uncertainReplay.stdout).approved, false);
    assert.match(JSON.parse(uncertainReplay.stdout).reason, /uncertain outcome/u);
    assert.equal(
      controlMCount(),
      0,
      "an interrupted approval dispatch must fail closed instead of replaying C-m"
    );

    const approved = runAgentCli([
      "approve",
      "--state",
      conversation.state_path,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.decision_mode, "keys");
    assert.equal(approvedParsed.key, "C-m");
    assert.deepEqual(approvedParsed.keys, ["C-m"]);
    assert.equal(approvedParsed.approval_fingerprint, approvalFingerprint);
    assert.equal(controlMCount(), 1, "manual approval must submit exactly one C-m");
    const approvedState = JSON.parse(fs.readFileSync(conversation.state_path, "utf8"));
    assert.equal(
      approvedState.native_session_takeover.terminal_bridge_approval_dispatch,
      undefined
    );
    assert.equal(
      approvedState.native_session_takeover.terminal_bridge_last_approval_fingerprint,
      approvalFingerprint
    );

    const closedStatePath = writeConversationClone(
      storeDir,
      monitoredParsed.conversation,
      "claude-hookless-closed",
      (state) => ({ ...state, status: "closed" })
    );
    const closedReplay = runAgentCli([
      "approve",
      "--state",
      closedStatePath,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.notEqual(closedReplay.status, 0);
    assert.match(closedReplay.stderr, /cannot approve .* conversation is closed/u);
    assert.equal(controlMCount(), 1, "a closed conversation must never replay approval keys");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed Claude tmux send binds hook identity and structured approval/cancel never sends dialog keys", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-terminal-permission-"));
  const storeDir = path.join(tempDir, "conversations");
  const hookStoreDir = path.join(tempDir, "claude-hooks");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42301;
  const claudeSessionId = "claude-session-permission";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );

    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      hookStoreDir,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Run the focused tests"
    });
    const conversation = task.conversation;
    const nativeTakeover = conversation.native_session_takeover;
    const messageId = nativeTakeover.terminal_bridge_message_id;
    assert.equal(nativeTakeover.claude_hook_mode, "enabled");
    assert.equal(nativeTakeover.claude_hook_store_dir, hookStoreDir);
    assert.equal(nativeTakeover.terminal_agent_pid, claudePid);
    assert.equal(nativeTakeover.terminal_agent_session_id, claudeSessionId);
    assert.equal(typeof nativeTakeover.claude_hook_lease_id, "string");
    assert.equal(typeof messageId, "string");

    const hookStore = new ClaudeHookStore({ rootDir: hookStoreDir });
    const lease = hookStore.resolveLease({
      sessionId: claudeSessionId,
      pid: claudePid,
      cwd: workspace
    });
    assert.equal(lease?.authorizationEligible, true);
    assert.equal(lease?.lease.conversationId, conversation.conversation_id);
    assert.equal(lease?.lease.messageId, messageId);
    assert.equal(lease?.lease.terminalTarget, terminalTarget);

    const promptId = "prompt-permission";
    hookStore.record(claudePromptHookInput(claudeSessionId, workspace, promptId), {
      claudePid
    });
    const pendingAllow = hookStore.record(
      claudePermissionHookInput(claudeSessionId, workspace, promptId, "npm test -- --runInBand"),
      { claudePid }
    ).permission;
    assert.ok(pendingAllow);

    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: "❯ "
    });
    const status = runAgentCli([
      "status",
      "--conversation",
      conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--claude-hook-store-dir",
      hookStoreDir,
      ...staticArgs
    ]);
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "awaiting_approval");
    assert.equal(statusParsed.terminal_status.approval_state.approvable, true);
    assert.equal(statusParsed.terminal_status.approval_state.decision_mode, "structured");
    assert.equal(statusParsed.terminal_status.approval_state.request_id, pendingAllow.requestId);
    assert.equal(statusParsed.terminal_status.approval_state.command, "npm test -- --runInBand");
    assert.equal(typeof statusParsed.terminal_status.approval_state.fingerprint, "string");

    const monitored = runAgentCli(claudeMonitorArgs({
      task,
      hookStoreDir,
      staticArgs
    }));
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.type, "question");
    assert.equal(monitoredParsed.message.metadata.reason, "approval_required");
    assert.equal(monitoredParsed.message.metadata.approval_candidate.agent, "claude");
    assert.equal(monitoredParsed.message.metadata.approval_candidate.decision_mode, "structured");
    assert.equal(monitoredParsed.message.metadata.terminal_status.approval_state.request_id, pendingAllow.requestId);
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");

    const approvalFingerprint = monitoredParsed.message.metadata.approval_fingerprint;
    const sendKeysBeforeApproval = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const approved = runAgentCli([
      "approve",
      "--conversation",
      conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--claude-hook-store-dir",
      hookStoreDir,
      ...staticArgs
    ]);
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.decision_mode, "structured");
    assert.equal(approvedParsed.request_id, pendingAllow.requestId);
    assert.equal(approvedParsed.key, undefined);
    assert.deepEqual(approvedParsed.keys ?? [], []);
    assert.equal(approvedParsed.conversation.status, "waiting_for_agent");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBeforeApproval
    );

    const allowed = hookStore.consumePermissionDecision({
      sessionId: pendingAllow.sessionId,
      requestId: pendingAllow.requestId,
      fingerprint: pendingAllow.fingerprint,
      conversationId: pendingAllow.conversationId,
      messageId: pendingAllow.messageId
    });
    assert.deepEqual(allowed?.hookOutput, {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" }
      }
    });

    const pendingDeny = hookStore.record(
      claudePermissionHookInput(claudeSessionId, workspace, promptId, "git push origin main"),
      { claudePid }
    ).permission;
    assert.ok(pendingDeny);
    const sendKeysBeforeCancel = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--claude-hook-store-dir",
      hookStoreDir,
      "--claude-agents-json",
      JSON.stringify([claudeAgentRow(claudePid, claudeSessionId, workspace)])
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.denied_approval, true);
    assert.equal(cancelledParsed.request_id, pendingDeny.requestId);
    assert.equal(cancelledParsed.key, undefined);
    assert.equal(cancelledParsed.conversation.status, "cancelled");
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBeforeCancel,
      "structured deny must not send Escape or any other tmux key"
    );
    const deniedPermission = hookStore.resolveSession({ sessionId: claudeSessionId })?.permissions
      .find((permission) => permission.requestId === pendingDeny.requestId);
    assert.equal(deniedPermission?.decision?.behavior, "deny");
    assert.equal(deniedPermission?.decision?.interrupt, true);

    fs.writeFileSync(screenPath, [
      "Bash command",
      "npm publish",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for npm publish commands",
      "  3. No",
      "Esc to cancel"
    ].join("\n"));
    const sendKeysBeforeBlockedSend = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const blockedSend = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      "This must not be submitted over the permission dialog",
      "--claude-hook-store-dir",
      hookStoreDir,
      "--claude-agents-json",
      JSON.stringify([claudeAgentRow(claudePid, claudeSessionId, workspace)])
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.notEqual(blockedSend.status, 0);
    assert.match(blockedSend.stderr, /permission|refusing to send/iu);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBeforeBlockedSend,
      "a new message must never be typed over a Claude permission dialog"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Claude Stop and StopFailure callbacks are exactly once and background work is not completion", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-terminal-completion-"));
  const storeDir = path.join(tempDir, "conversations");
  const hookStoreDir = path.join(tempDir, "claude-hooks");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42302;
  const claudeSessionId = "claude-session-completion";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const hookStore = new ClaudeHookStore({ rootDir: hookStoreDir });
    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: "❯ "
    });

    const successCallsPath = path.join(tempDir, "openclaw-success.ndjson");
    writeFakeOpenClaw(fakeBinDir, successCallsPath);
    const successTask = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      hookStoreDir,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Finish the implementation"
    });
    const successPromptId = "prompt-success";
    hookStore.record(claudePromptHookInput(claudeSessionId, workspace, successPromptId), { claudePid });
    hookStore.record(claudeStopHookInput(claudeSessionId, workspace, successPromptId, {
      last_assistant_message: "Implementation complete; focused tests pass.",
      background_tasks: [],
      session_crons: []
    }), { claudePid });

    const successMonitorArgs = claudeMonitorArgs({
      task: successTask,
      hookStoreDir,
      staticArgs
    });
    const [successFirst, successSecond] = await Promise.all([
      runAgentCliAsync(successMonitorArgs),
      runAgentCliAsync(successMonitorArgs)
    ]);
    assert.equal(successFirst.status, 0, successFirst.stderr || successFirst.stdout);
    assert.equal(successSecond.status, 0, successSecond.stderr || successSecond.stdout);
    const successResults = [successFirst, successSecond].map((result) => JSON.parse(result.stdout));
    const deliveredSuccess = successResults.filter((result) => result.delivered === true);
    assert.equal(deliveredSuccess.length, 1);
    assert.equal(deliveredSuccess[0].message.type, "done");
    assert.equal(deliveredSuccess[0].message.body, "Implementation complete; focused tests pass.");
    assert.equal(deliveredSuccess[0].message.metadata.match, "claude_stop_hook");
    assert.equal(deliveredSuccess[0].conversation.status, "closed");
    assert.equal(readJsonLines(successCallsPath).length, 1);
    const successEvents = fs.readFileSync(successTask.logPath, "utf8");
    assert.equal((successEvents.match(/terminal_bridge_completion_detected/gu) ?? []).length, 1);
    assert.equal((successEvents.match(/terminal_bridge_completion_claimed/gu) ?? []).length, 1);
    const completionClaim = readJsonLines(successTask.logPath)
      .find((event) => event.event === "terminal_bridge_completion_claimed");
    assert.match(completionClaim.callback_message_id, /^msg-terminal-[a-f0-9]{32}$/u);

    const failureCallsPath = path.join(tempDir, "openclaw-failure.ndjson");
    writeFakeOpenClaw(fakeBinDir, failureCallsPath);
    const failureTask = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      hookStoreDir,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Run the release command"
    });
    const failurePromptId = "prompt-failure";
    hookStore.record(claudePromptHookInput(claudeSessionId, workspace, failurePromptId), { claudePid });
    hookStore.record(claudeStopFailureHookInput(claudeSessionId, workspace, failurePromptId), { claudePid });

    const failureMonitorArgs = claudeMonitorArgs({
      task: failureTask,
      hookStoreDir,
      staticArgs
    });
    const failed = runAgentCli(failureMonitorArgs);
    assert.equal(failed.status, 0, failed.stderr || failed.stdout);
    const failedParsed = JSON.parse(failed.stdout);
    assert.equal(failedParsed.delivered, true);
    assert.equal(failedParsed.message.type, "error");
    assert.match(failedParsed.message.body, /rate_limit/u);
    assert.match(failedParsed.message.body, /429 Too Many Requests/u);
    assert.equal(failedParsed.message.metadata.match, "claude_stop_failure_hook");
    assert.equal(failedParsed.conversation.status, "failed");
    const failedAgain = runAgentCli(failureMonitorArgs);
    assert.equal(failedAgain.status, 0, failedAgain.stderr || failedAgain.stdout);
    assert.equal(JSON.parse(failedAgain.stdout).reason, "conversation_no_longer_waiting");
    assert.equal(readJsonLines(failureCallsPath).length, 1);

    const backgroundCallsPath = path.join(tempDir, "openclaw-background.ndjson");
    writeFakeOpenClaw(fakeBinDir, backgroundCallsPath);
    const backgroundTask = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      hookStoreDir,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Wait for the background test run"
    });
    const backgroundPromptId = "prompt-background";
    hookStore.record(claudePromptHookInput(claudeSessionId, workspace, backgroundPromptId), { claudePid });
    hookStore.record(claudeStopHookInput(claudeSessionId, workspace, backgroundPromptId, {
      last_assistant_message: "The foreground turn ended but tests are still running.",
      background_tasks: [{
        id: "task-1",
        type: "bash",
        status: "running",
        description: "npm test"
      }],
      session_crons: []
    }), { claudePid });
    const backgroundMonitor = runAgentCli(claudeMonitorArgs({
      task: backgroundTask,
      hookStoreDir,
      staticArgs,
      timeoutMinutes: "0.001"
    }));
    assert.equal(backgroundMonitor.status, 0, backgroundMonitor.stderr || backgroundMonitor.stdout);
    const backgroundParsed = JSON.parse(backgroundMonitor.stdout);
    assert.equal(backgroundParsed.stalled, true);
    assert.equal(backgroundParsed.completed, undefined);
    assert.match(backgroundParsed.reason, /observed no activity/u);
    assert.doesNotMatch(fs.readFileSync(backgroundTask.logPath, "utf8"), /terminal_bridge_completion_detected/u);
    const backgroundCallbacks = fs.existsSync(backgroundCallsPath)
      ? readJsonLines(backgroundCallsPath).flatMap((call) => {
          const paramsIndex = call.args.indexOf("--params");
          return paramsIndex >= 0 ? [JSON.parse(call.args[paramsIndex + 1])] : [];
        })
      : [];
    assert.equal(backgroundCallbacks.some((params) => params.message?.type === "done"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hookless Claude send is refused when no transcript boundary can be bound", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-anchor-required-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude-without-projects");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42311;
  const claudeSessionId = "33333333-3333-4333-8333-333333333333";
  const message = "This request must not be sent without an anchor";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: claudePid,
      ppid: 999,
      command: "claude",
      cwd: workspace
    }]);

    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([{
        ...claudeAgentRow(claudePid, claudeSessionId, workspace),
        startedAt: undefined
      }]),
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(
      sent.stderr,
      /could not bind an owner-private Claude transcript boundary/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) =>
        call.args[0] === "send-keys" && call.args.includes(message)
      ),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hookless Claude transcript completion closes a managed tmux task exactly once", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-transcript-cli-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42312;
  const claudeSessionId = "22222222-2222-4222-8222-222222222222";
  const request = "Reply after the hookless transcript turn   \t";
  const submittedRequest = request.trimEnd();

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const projectDirectory = path.join(
      claudeHome,
      "projects",
      workspace.replace(/[^A-Za-z0-9]/gu, "-")
    );
    fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: request
    });
    assert.equal(
      task.conversation.native_session_takeover.claude_transcript_anchor,
      undefined,
      "the local transcript anchor must not be returned through CLI output"
    );
    const storedConversation = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    const anchor = storedConversation.native_session_takeover.claude_transcript_anchor;
    assert.equal(anchor.session_id, claudeSessionId);
    assert.equal(anchor.pid, claudePid);
    assert.equal(anchor.file_existed, false);
    assert.equal(anchor.offset_bytes, 0);
    assert.equal(
      task.conversation.native_session_takeover.terminal_control.capabilities
        .includes("durable_completion"),
      true
    );

    const promptAt = new Date(
      Date.parse(anchor.captured_at) + 100
    ).toISOString();
    const completedAt = new Date(Date.parse(promptAt) + 100).toISOString();
    const promptUuid = "00000000-0000-4000-8000-000000000001";
    const thinkingUuid = "00000000-0000-4000-8000-000000000002";
    const textUuid = "00000000-0000-4000-8000-000000000003";
    const durationUuid = "00000000-0000-4000-8000-000000000004";
    const messageId = "00000000-0000-4000-8000-000000000101";
    const base = (uuid: string, parentUuid: string | null, timestamp: string) => ({
      uuid,
      parentUuid,
      isSidechain: false,
      entrypoint: "cli",
      timestamp,
      cwd: workspace,
      sessionId: claudeSessionId,
      version: "2.1.198"
    });
    const transcriptPath = path.join(projectDirectory, `${claudeSessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, [
      {
        ...base(promptUuid, null, promptAt),
        type: "user",
        promptId: "00000000-0000-4000-8000-000000000201",
        message: { role: "user", content: submittedRequest }
      },
      {
        ...base(thinkingUuid, promptUuid, promptAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...base(textUuid, thinkingUuid, completedAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Hookless Claude completion detected." }]
        }
      },
      {
        ...base(durationUuid, textUuid, completedAt),
        type: "system",
        subtype: "turn_duration",
        durationMs: 100
      }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });
    fs.chmodSync(transcriptPath, 0o600);

    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: "❯ "
    });
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      task.statePath,
      "--log",
      task.logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      "--claude-home",
      claudeHome,
      ...staticArgs
    ];
    const [first, second] = await Promise.all([
      runAgentCliAsync(monitorArgs, {}, 10_000),
      runAgentCliAsync(monitorArgs, {}, 10_000)
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const results = [first, second].map((result) => JSON.parse(result.stdout));
    const delivered = results.filter((result) => result.delivered === true);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].message.type, "done");
    assert.equal(delivered[0].message.body, "Hookless Claude completion detected.");
    assert.equal(
      delivered[0].message.metadata.match,
      "claude_transcript_turn_duration"
    );
    assert.equal(delivered[0].conversation.status, "closed");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
    assert.equal(
      eventCount(task.logPath, "terminal_bridge_completion_detected"),
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent takeover terminal_control attaches tmux pane and send writes to the terminal", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-terminal-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 1234,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd: workspace
    }]);

    const plan = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 888,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }, {
        pid: 1235,
        ppid: 1234,
        command: `/vendor/bin/codex resume ${sessionId}`,
        cwd: workspace
      }, {
        pid: 888,
        ppid: 999,
        command: "zsh -lc launch-codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);

    assert.equal(plan.status, 0, plan.stderr || plan.stdout);
    const planned = JSON.parse(plan.stdout);
    assert.equal(planned.status, "requires_confirmation");
    assert.equal(planned.plan.mode, "terminal_control");
    assert.equal(planned.plan.targets.length, 1);
    assert.deepEqual(planned.plan.targets[0].childPids, [1235]);
    assert.equal(planned.plan.targets[0].terminalControl.target, "codex-work:0.0");

    const attached = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--create-conversation",
      "--confirm-terminal",
      "--terminal-target",
      "codex-work:0.0",
      "--request",
      "Take over tmux Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);

    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);
    assert.equal(parsed.status, "attached");
    assert.equal(parsed.conversation.native_session_takeover.strategy, "terminal_control");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, false);
    assert.equal(parsed.conversation.native_session_takeover.terminal_bridge, true);
    assert.equal(parsed.conversation.native_session_takeover.terminal_control.target, "codex-work:0.0");

    const legacyState = JSON.parse(fs.readFileSync(parsed.paths.statePath, "utf8"));
    delete legacyState.native_session_takeover.terminal_agent_pid;
    fs.writeFileSync(parsed.paths.statePath, `${JSON.stringify(legacyState, null, 2)}\n`);
    const upgradedStatus = runAgentCli([
      "status",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(upgradedStatus.status, 0, upgradedStatus.stderr || upgradedStatus.stdout);
    assert.equal(JSON.parse(upgradedStatus.stdout).terminal_status.reachable, true);
    const migratedState = JSON.parse(fs.readFileSync(parsed.paths.statePath, "utf8"));
    assert.equal(migratedState.native_session_takeover.terminal_agent_pid, 1234);
    assert.equal(
      typeof migratedState.native_session_takeover.terminal_agent_identity_migrated_at,
      "string"
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "继续当前任务"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, true);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, true);
    assert.equal(sentParsed.terminal_control.target, "codex-work:0.0");
    let calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(calls.at(-2).args, ["send-keys", "-t", "codex-work:0.0", "-l", "继续当前任务"]);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "C-m"]);

    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.terminal_control.target, "codex-work:0.0");
    assert.equal(cancelledParsed.key, "C-c");
    assert.equal(cancelledParsed.conversation.status, "cancelled");
    calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "C-c"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed send reloads state while holding the callback transaction lock", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-state-lock-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runAgentCli([
      "new",
      "--agent",
      "codex",
      "--request",
      "state lock test",
      "--store-dir",
      storeDir
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const parsed = JSON.parse(created.stdout);
    const statePath = parsed.paths.statePath;
    const lockPath = `${statePath}.lock`;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "test-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );

    let settled = false;
    const sending = runAgentCliAsync([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--message",
      "must not overwrite the callback state",
      "--store-dir",
      storeDir
    ]).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(settled, false);

    const callbackState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    callbackState.status = "closed";
    callbackState.close_reason = "simulated concurrent callback";
    callbackState.updated_at = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(callbackState, null, 2)}\n`);
    fs.unlinkSync(lockPath);

    const result = await sending;
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /conversation is closed/);
    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.close_reason, "simulated concurrent callback");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rejected managed Claude send leaves callback state and event log unchanged", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-rejected-send-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42309;
  const claudeSessionId = "55555555-5555-4555-8555-555555555555";
  const rawConversationId = `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`;
  const rejectedMessage = "This answer must not be recorded or sent";
  const approvalScreen = [
    " Bash command",
    "",
    "   npm test -- --runInBand",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend"
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: claudePid,
      ppid: 999,
      command: "claude",
      cwd: workspace
    }]);
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const claudeAgentArgs = [
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([claudeAgentRow(claudePid, claudeSessionId, workspace)])
    ];

    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Initial managed Claude task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      ...claudeAgentArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversation = sentParsed.conversation;

    fs.writeFileSync(screenPath, approvalScreen);
    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: approvalScreen
    });
    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      conversation.state_path,
      "--log",
      conversation.event_log_path,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      ...staticArgs
    ], testEnv);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");
    assert.equal(
      monitoredParsed.conversation.native_session_takeover
        .terminal_bridge_approval.approval_state.approvable,
      true
    );

    const beforeStateRaw = fs.readFileSync(conversation.state_path, "utf8");
    const beforeState = JSON.parse(beforeStateRaw);
    const beforeEventLog = fs.readFileSync(conversation.event_log_path, "utf8");
    const beforeMessageEvents = readJsonLines(conversation.event_log_path)
      .filter((event) => event.event === "message");
    fs.writeFileSync(tmuxCallsPath, "");

    const rejected = runAgentCli([
      "send",
      "--conversation",
      conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      rejectedMessage,
      "--disable-terminal-bridge-monitor",
      ...staticArgs
    ], testEnv);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /verified idle terminal|permission dialog/u);

    const afterStateRaw = fs.readFileSync(conversation.state_path, "utf8");
    const afterState = JSON.parse(afterStateRaw);
    assert.equal(afterStateRaw, beforeStateRaw, "a rejected send must not rewrite state");
    assert.equal(afterState.status, beforeState.status);
    assert.equal(
      afterState.native_session_takeover.terminal_bridge_message_id,
      beforeState.native_session_takeover.terminal_bridge_message_id
    );
    assert.equal(afterState.response_rounds_used, beforeState.response_rounds_used);
    assert.deepEqual(
      afterState.native_session_takeover.terminal_bridge_approval,
      beforeState.native_session_takeover.terminal_bridge_approval
    );
    assert.equal(
      fs.readFileSync(conversation.event_log_path, "utf8"),
      beforeEventLog,
      "a rejected send must not append any event"
    );
    assert.deepEqual(
      readJsonLines(conversation.event_log_path).filter((event) => event.event === "message"),
      beforeMessageEvents,
      "a rejected send must not append a message event"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false,
      "a rejected send must not write a payload or Enter to tmux"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed terminal send cannot overwrite a concurrent terminal cancellation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-cancel-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const tmuxGatePath = path.join(tempDir, "tmux-send-gate");
  const tmuxSession = `akk-send-cancel-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const racedMessage = "This prepared message must never reach tmux";
  let holder: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const managed = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Initial managed terminal task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const conversationId = managedParsed.conversation.conversation_id;
    const statePath = managedParsed.conversation.state_path;
    const initialRounds = managedParsed.conversation.response_rounds_used;
    const initialStateRaw = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(tmuxCallsPath, "");

    holder = spawnAgentCliCaptured([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Hold the terminal lock",
      "--store-dir",
      storeDir
    ], {
      ...testEnv,
      AKK_TEST_TMUX_SEND_GATE_PATH: tmuxGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${tmuxGatePath}.entered`),
      "raw terminal send to enter the fake tmux gate"
    );

    let cancelSettled = false;
    const cancelling = runAgentCliAsync([
      "cancel",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir
    ], testEnv).finally(() => {
      cancelSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cancelSettled, false, "cancel must wait behind the gated terminal owner");

    sending = spawnAgentCliCaptured([
      "send",
      "--conversation",
      conversationId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      sending.child.exitCode,
      null,
      "managed send must wait behind the current terminal owner"
    );
    assert.equal(
      fs.readFileSync(statePath, "utf8"),
      initialStateRaw,
      "a send waiting for the terminal lock must not prepare or persist its message"
    );
    assert.ok(sending.child.pid);
    process.kill(sending.child.pid, "SIGSTOP");
    sendingStopped = true;
    fs.writeFileSync(`${tmuxGatePath}.release`, "");

    const holderResult = await holder.result;
    assert.equal(holderResult.status, 0, holderResult.stderr || holderResult.stdout);
    const cancelled = await cancelling;
    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.conversation.status, "cancelled");
    assert.equal(cancelledParsed.key, "C-c");

    process.kill(sending.child.pid, "SIGCONT");
    sendingStopped = false;
    const sendResult = await sending.result;
    assert.notEqual(sendResult.status, 0);
    assert.match(sendResult.stderr, /conversation is cancelled/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "cancelled");
    assert.equal(finalState.response_rounds_used, initialRounds);
    assert.equal(finalState.cancelled_at, cancelledParsed.conversation.cancelled_at);
    assert.equal(finalState.updated_at, cancelledParsed.conversation.updated_at);
    const calls = readJsonLines(tmuxCallsPath);
    assert.equal(
      calls.some((call) =>
        call.args[0] === "send-keys" &&
        call.args.includes("-l") &&
        call.args.at(-1) === racedMessage
      ),
      false,
      "a stale prepared send must not write its message to tmux"
    );
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[1] === "-t" &&
        call.args[2] === terminalTarget &&
        call.args.at(-1) === "C-c"
      ).length,
      1,
      "the concurrent cancellation should be the only control action after the gate"
    );
  } finally {
    if (!fs.existsSync(`${tmuxGatePath}.release`)) {
      fs.writeFileSync(`${tmuxGatePath}.release`, "");
    }
    if (sendingStopped && sending?.child.pid) {
      try {
        process.kill(sending.child.pid, "SIGCONT");
      } catch {
        // The send process already exited.
      }
    }
    killPidBestEffort(holder?.child.pid);
    killPidBestEffort(sending?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed terminal close locks terminal before state and prevents queued sends or approvals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-close-terminal-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const tmuxSession = `akk-close-race-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const racedMessage = "This message must never be sent after close";
  let closing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;
  let stateLockHeld = false;
  let stateLockPath = "";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const managed = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Initial managed terminal task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const conversationId = managedParsed.conversation.conversation_id;
    const statePath = managedParsed.conversation.state_path;
    stateLockPath = `${statePath}.lock`;
    fs.writeFileSync(tmuxCallsPath, "");

    fs.writeFileSync(
      stateLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "close-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    stateLockHeld = true;

    closing = spawnAgentCliCaptured([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      "--reason",
      "closed during terminal mutation race"
    ], testEnv);
    await waitForCondition(() => {
      const terminalLocks = fs.readdirSync(storeDir)
        .filter((name) =>
          name.startsWith(".terminal-bridge-send-") &&
          name.endsWith(".lock")
        );
      return terminalLocks.some((name) => {
        const owner = JSON.parse(fs.readFileSync(path.join(storeDir, name), "utf8"));
        return owner.pid === closing?.child.pid;
      });
    }, "close to acquire the terminal lock before waiting for state");
    assert.equal(closing.child.exitCode, null);

    sending = spawnAgentCliCaptured([
      "send",
      "--conversation",
      conversationId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sending.child.exitCode, null);
    assert.ok(sending.child.pid);
    process.kill(sending.child.pid, "SIGSTOP");
    sendingStopped = true;

    const concurrentState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    concurrentState.close_race_marker = "state written while close held the terminal lock";
    concurrentState.updated_at = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify(concurrentState, null, 2)}\n`);
    fs.unlinkSync(stateLockPath);
    stateLockHeld = false;

    const closeResult = await closing.result;
    assert.equal(closeResult.status, 0, closeResult.stderr || closeResult.stdout);
    const closeParsed = JSON.parse(closeResult.stdout);
    assert.equal(closeParsed.closed, true);
    assert.equal(closeParsed.conversation.status, "closed");
    assert.equal(
      closeParsed.conversation.close_race_marker,
      "state written while close held the terminal lock",
      "close must reload state after acquiring the state lock"
    );

    process.kill(sending.child.pid, "SIGCONT");
    sendingStopped = false;
    const sendResult = await sending.result;
    assert.notEqual(sendResult.status, 0);
    assert.match(sendResult.stderr, /conversation is closed/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.close_reason, "closed during terminal mutation race");
    assert.equal(
      finalState.close_race_marker,
      "state written while close held the terminal lock"
    );
    const sendKeyCalls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.equal(
      sendKeyCalls.some((call) => call.args.includes("-l") && call.args.at(-1) === racedMessage),
      false,
      "a send queued behind close must not write its payload to tmux"
    );

    const approval = runAgentCli([
      "approve",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir
    ], testEnv);
    assert.notEqual(approval.status, 0);
    assert.match(approval.stderr, /conversation is closed/u);
    const afterApprovalCalls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(
      afterApprovalCalls,
      sendKeyCalls,
      "approval after close must not send any terminal keys"
    );
  } finally {
    if (stateLockHeld && stateLockPath) {
      fs.rmSync(stateLockPath, { force: true });
    }
    if (sendingStopped && sending?.child.pid) {
      try {
        process.kill(sending.child.pid, "SIGCONT");
      } catch {
        // The send process already exited.
      }
    }
    killPidBestEffort(closing?.child.pid);
    killPidBestEffort(sending?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("idle cleanup locks and reloads a stale candidate before closing it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-idle-cleanup-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const preloadPath = path.join(tempDir, "state-read-gate.cjs");
  const snapshotReadPath = path.join(tempDir, "snapshot-read");
  const snapshotReleasePath = path.join(tempDir, "snapshot-release");
  const lockAttemptPath = path.join(tempDir, "state-lock-attempted");
  let listing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let stateLockHeld = false;
  let stateLockPath = "";

  try {
    const created = runAgentCli([
      "new",
      "--agent",
      "codex",
      "--request",
      "idle cleanup race",
      "--store-dir",
      storeDir
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const parsed = JSON.parse(created.stdout);
    const statePath = parsed.paths.statePath;
    const eventLogPath = parsed.paths.logPath;
    stateLockPath = `${statePath}.lock`;
    const staleState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "idle",
      idle_since: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    fs.writeFileSync(statePath, `${JSON.stringify(staleState, null, 2)}\n`);
    fs.writeFileSync(
      stateLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "idle-cleanup-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );
    stateLockHeld = true;
    fs.writeFileSync(
      preloadPath,
      `const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve(process.env.AKK_TEST_STATE_READ_TARGET);
const targetLock = target + ".lock";
const snapshotReadPath = process.env.AKK_TEST_STATE_SNAPSHOT_READ_PATH;
const snapshotReleasePath = process.env.AKK_TEST_STATE_SNAPSHOT_RELEASE_PATH;
const lockAttemptPath = process.env.AKK_TEST_STATE_LOCK_ATTEMPT_PATH;
const originalOpenSync = fs.openSync;
const originalReadFileSync = fs.readFileSync;
const originalCloseSync = fs.closeSync;
const trackedStateFds = new Set();
let snapshotCaptured = false;
let lockAttemptReported = false;
fs.openSync = function(file, ...args) {
  const resolved = typeof file === "string" ? path.resolve(file) : "";
  if (resolved === targetLock && !lockAttemptReported) {
    lockAttemptReported = true;
    fs.writeFileSync(lockAttemptPath, "");
  }
  const fd = originalOpenSync.call(this, file, ...args);
  if (resolved === target) {
    trackedStateFds.add(fd);
  }
  return fd;
};
fs.readFileSync = function(file, ...args) {
  const value = originalReadFileSync.call(this, file, ...args);
  if (!snapshotCaptured && typeof file === "number" && trackedStateFds.has(file)) {
    snapshotCaptured = true;
    fs.writeFileSync(snapshotReadPath, "");
    while (!fs.existsSync(snapshotReleasePath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return value;
};
fs.closeSync = function(fd, ...args) {
  trackedStateFds.delete(fd);
  return originalCloseSync.call(this, fd, ...args);
};
`,
      "utf8"
    );

    let settled = false;
    listing = spawnAgentCliCaptured([
      "list",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1",
      "--managed-only",
      "--all"
    ], {
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${preloadPath}`
      ].filter(Boolean).join(" "),
      AKK_TEST_STATE_READ_TARGET: statePath,
      AKK_TEST_STATE_SNAPSHOT_READ_PATH: snapshotReadPath,
      AKK_TEST_STATE_SNAPSHOT_RELEASE_PATH: snapshotReleasePath,
      AKK_TEST_STATE_LOCK_ATTEMPT_PATH: lockAttemptPath
    });
    void listing.result.finally(() => {
      settled = true;
    });
    await waitForCondition(
      () => fs.existsSync(snapshotReadPath),
      "idle cleanup to capture its stale candidate snapshot"
    );

    const activeState = {
      ...staleState,
      status: "waiting_for_agent",
      cleanup_race_marker: "became active while cleanup held a stale snapshot",
      updated_at: new Date().toISOString()
    };
    delete activeState.idle_since;
    fs.writeFileSync(statePath, `${JSON.stringify(activeState, null, 2)}\n`);
    fs.writeFileSync(snapshotReleasePath, "");
    await waitForCondition(
      () => fs.existsSync(lockAttemptPath),
      "idle cleanup to attempt the candidate state lock"
    );
    assert.equal(
      settled,
      false,
      "cleanup must wait for the candidate state lock before acting on its snapshot"
    );

    fs.unlinkSync(stateLockPath);
    stateLockHeld = false;
    const result = await listing.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const listed = JSON.parse(result.stdout);
    assert.equal(listed.cleanup.closed, 0);
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].status, "waiting_for_agent");

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "waiting_for_agent");
    assert.equal(
      finalState.cleanup_race_marker,
      "became active while cleanup held a stale snapshot"
    );
    assert.equal(finalState.closed_at, undefined);
    assert.doesNotMatch(
      fs.readFileSync(eventLogPath, "utf8"),
      /"event":"conversation_closed"/u
    );
  } finally {
    fs.writeFileSync(snapshotReleasePath, "");
    if (stateLockHeld && stateLockPath) {
      fs.rmSync(stateLockPath, { force: true });
    }
    killPidBestEffort(listing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve sends y only when the terminal screen shows a primary Codex approval option", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-approve-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  ARK_API_KEY=ark-test-secret-value",
      "",
      "  Would you like to run the following command?",
      "",
      "  $ curl -I https://example.com",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 1234,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd: workspace
    }]);

    const attached = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminal_control",
      "--create-conversation",
      "--confirm-terminal",
      "--terminal-target",
      "codex-work:0.0",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--processes-json",
      JSON.stringify([{
        pid: 1234,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })])
    ]);
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);

    const status = runAgentCli([
      "status",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.match(statusParsed.terminal_screen.excerpt, /Would you like to run the following command/);
    assert.match(statusParsed.terminal_screen.excerpt, /ARK_API_KEY=\[REDACTED\]/);
    assert.doesNotMatch(statusParsed.terminal_screen.excerpt, /ark-test-secret-value/);
    assert.equal(statusParsed.terminal_screen.approval.approvable, true);
    assert.equal(statusParsed.terminal_status.reachable, true);
    assert.equal(statusParsed.terminal_status.target, "codex-work:0.0");
    assert.equal(statusParsed.terminal_status.activity_state, "awaiting_approval");
    assert.equal(statusParsed.terminal_status.approval_state.blocked, true);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, true);

    const approved = runAgentCli([
      "approve",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    const calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.0", "y"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approval scan ignores stale Codex prompts left in terminal scrollback", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-stale-approve-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  Would you like to run the following command?",
      "",
      "  $ git status -sb",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "✔ You approved codex to run git status -sb",
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:v2:tmux:codex:codex-work:0.1:33389";
    const status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, false);
    assert.match(statusParsed.terminal_status.approval_state.reason, /stale/);
    assert.equal(statusParsed.terminal_screen.approval.approvable, false);
    assert.equal(statusParsed.terminal_status.activity_state, "working");

    const approved = runAgentCli([
      "approve",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, false);
    assert.match(approvedParsed.reason, /stale/);
    assert.deepEqual(readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys"), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status detects tmux Codex working idle and unknown activity states", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-activity-state-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const conversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    fs.writeFileSync(screenPath, [
      "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
      "",
      "› Find and fix a bug in @filename"
    ].join("\n"));
    let status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    let statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Working/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);

    fs.writeFileSync(screenPath, [
      "• Waiting for background terminal · autoreview",
      "  3 background terminals running · /ps to view · /stop to close",
      "",
      "› Steer the current task"
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Waiting for background terminal/);

    fs.writeFileSync(screenPath, [
      "The words background terminal running are part of the final answer.",
      "Working is also ordinary prose here, without a Codex status-line shape.",
      "",
      "› "
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");

    fs.writeFileSync(screenPath, [
      "  Model: GPT-5",
      "",
      "› "
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "idle");
    assert.match(statusParsed.terminal_status.activity_reason, /input prompt/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);

    fs.writeFileSync(screenPath, [
      "last command output",
      "no recognizable Codex tui footer"
    ].join("\n"));
    status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "unknown");
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw terminal send rejects a stale agent pid without sending tmux keys", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-stale-pid-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "$ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tzsh\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 33389,
      ppid: 1,
      command: "zsh",
      cwd: workspace
    }]);

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:v2:tmux:codex:codex-work:0.1:33389",
      "--message",
      "printf should-not-run"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /no longer available|no longer active/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("approve supports terminal-controlled conversation ids without AKK state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-approve-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, [
      "  Would you like to run the following command?",
      "",
      "  $ ls -la",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)"
    ].join("\n"));
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const status = runAgentCli([
      "status",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    const statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.conversation_id, conversationId);
    assert.equal(statusParsed.source, "terminal_control");
    assert.equal(statusParsed.terminal_status.reachable, true);
    assert.equal(statusParsed.terminal_status.approval_state.approvable, true);

    const approved = runAgentCli([
      "approve",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.conversation_id, conversationId);
    assert.equal(approvedParsed.source, "terminal_control");
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    assert.equal(approvedParsed.terminal_control.target, "codex-work:0.1");

    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "y"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("send and cancel support terminal-controlled conversation ids without AKK state", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "你好\n"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.conversation_id, conversationId);
    assert.equal(sentParsed.source, "terminal_control");
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, false);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, false);
    assert.equal(sentParsed.terminal_control.target, "codex-work:0.1");

    const calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(calls.at(-2).args, ["send-keys", "-t", "codex-work:0.1", "-l", "你好"]);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-m"]);

    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      conversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
    const cancelledParsed = JSON.parse(cancelled.stdout);
    assert.equal(cancelledParsed.conversation_id, conversationId);
    assert.equal(cancelledParsed.source, "terminal_control");
    assert.equal(cancelledParsed.cancel_requested, true);
    assert.equal(cancelledParsed.key, "C-c");

    const callsAfterCancel = readJsonLines(tmuxCallsPath);
    assert.deepEqual(callsAfterCancel.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-c"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("background send to raw terminal id creates managed callback conversation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-background-send-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const rejected = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Do not send this",
      "--background",
      "--store-dir",
      storeDir,
      "--agent-hard-timeout-minutes",
      "0"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /must be a positive number/);
    assert.equal(fs.existsSync(tmuxCallsPath), false);

    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "查一下最新 tag",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.status, "async_pending");
    assert.equal(sentParsed.background, true);
    assert.equal(sentParsed.callback_expected, true);
    assert.equal(sentParsed.openclaw_next_action.action, "yield");
    assert.equal(sentParsed.openclaw_next_action.callback_expected, true);
    assert.notEqual(sentParsed.conversation.conversation_id, rawConversationId);
    assert.equal(sentParsed.conversation.openclaw_session, "agent:channel:original");
    assert.equal(sentParsed.conversation.gateway_session, "agent:channel:original");
    assert.equal(sentParsed.conversation.native_session_takeover.native_session_id, rawConversationId);
    assert.equal(sentParsed.conversation.native_session_takeover.needs_bootstrap, false);
    assert.equal(sentParsed.conversation.native_session_takeover.terminal_bridge, true);
    assert.equal(sentParsed.monitor_pid, null);

    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.conversation_id, sentParsed.conversation.conversation_id);
    assert.equal(typeof state.native_session_takeover.terminal_bridge_started_at, "string");
    assert.equal(state.native_session_takeover.terminal_bridge_message_id, sentParsed.message.id);

    const calls = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "C-m"]);
    assert.deepEqual(calls.at(-2).args.slice(0, 4), ["send-keys", "-t", "codex-work:0.1", "-l"]);
    const injectedPayload = calls.at(-2).args[4];
    assert.equal(injectedPayload, "查一下最新 tag");
    assert.doesNotMatch(injectedPayload, /callback --state/);
    assert.doesNotMatch(injectedPayload, /agent-knock-knock\.callback/);
    assert.doesNotMatch(injectedPayload, /[\r\n]$/u);

    const idleState = {
      ...state,
      status: "idle",
      idle_since: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(idleState, null, 2)}\n`);

    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      "--managed-only"
    ]);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.cleanup.closed, 1);
    assert.deepEqual(listedParsed.delegated, []);
    const closedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "terminal bridge task completed");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a newer raw terminal task supersedes the prior screen-only callback boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-supersede-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sendTask = (message: string) => runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = path.join(storeDir, firstParsed.conversation.conversation_id, "state.json");
    const firstLogPath = path.join(storeDir, firstParsed.conversation.conversation_id, "events.ndjson");

    const second = sendTask("Second task");
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "closed");
    assert.equal(firstState.superseded_by_conversation_id, secondParsed.conversation.conversation_id);
    assert.match(firstState.close_reason, /superseded by a newer task/);
    assert.match(fs.readFileSync(firstLogPath, "utf8"), /terminal_bridge_superseded/);

    fs.writeFileSync(screenPath, [
      "› First task",
      "The first result completed earlier.",
      "─ Worked for 1m ─────────────────────────────",
      "› Second task",
      "• Working (5s • esc to interrupt) · /stop to close"
    ].join("\n"));
    const oldMonitor = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      firstStatePath,
      "--log",
      firstLogPath,
      "--poll-interval-ms",
      "50",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": fs.readFileSync(screenPath, "utf8") })
    ]);
    assert.equal(oldMonitor.status, 0, oldMonitor.stderr || oldMonitor.stdout);
    const oldMonitorParsed = JSON.parse(oldMonitor.stdout);
    assert.equal(oldMonitorParsed.completed, false);
    assert.equal(oldMonitorParsed.reason, "conversation_no_longer_waiting");
    assert.equal(fs.existsSync(openclawCallsPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a failed replacement send keeps the prior terminal bridge active", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-send-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, undefined, listPanesOutput);

    const sendTask = (message: string) => runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = path.join(storeDir, firstParsed.conversation.conversation_id, "state.json");
    const firstLogPath = path.join(storeDir, firstParsed.conversation.conversation_id, "events.ndjson");

    writeFakeTmux(fakeBinDir, tmuxCallsPath, undefined, listPanesOutput, "Second task");
    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);

    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.doesNotMatch(fs.readFileSync(firstLogPath, "utf8"), /terminal_bridge_superseded/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent raw terminal sends serialize replacement state and terminal submission", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-concurrent-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-concurrent-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const sendArgs = (message: string) => [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_DELAY_MS: "300"
    };

    const [first, second] = await Promise.all([
      runAgentCliAsync(sendArgs("Concurrent task A"), env),
      runAgentCliAsync(sendArgs("Concurrent task B"), env)
    ]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const states = fs.readdirSync(storeDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => JSON.parse(fs.readFileSync(path.join(storeDir, entry.name, "state.json"), "utf8")));
    const active = states.filter((state) => state.status === "waiting_for_agent");
    const closed = states.filter((state) => state.status === "closed");
    assert.equal(active.length, 1);
    assert.equal(closed.length, 1);
    assert.equal(closed[0].superseded_by_conversation_id, active[0].conversation_id);

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 2);
    const firstEnterIndex = calls.findIndex(
      (call, index) => index > literalSendIndexes[0] && call.args.at(-1) === "C-m"
    );
    assert.ok(firstEnterIndex > literalSendIndexes[0]);
    assert.ok(firstEnterIndex < literalSendIndexes[1]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor trusts matching task_complete despite stale working screen text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-monitor-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "查一下最新 tag",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");

    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "查一下最新 tag"
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-current-task",
          last_agent_message: "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
        }
      })
    ].join("\n");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": [
          "最新 tag 是 v0.2.29。",
          "The words background terminal running are only part of this final answer.",
          "• Working (12s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
          "› Steer the current task"
        ].join("\n")
      }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.equal(
      parsed.message.body,
      "最新 tag 是 v0.2.29。The words background terminal running are only part of this final answer."
    );
    assert.equal(parsed.message.metadata.match, "rollout_task_complete");
    assert.equal(parsed.message.metadata.rollout_turn_id, "turn-current-task");
    assert.equal(parsed.conversation.status, "closed");
    assert.equal(parsed.conversation.close_reason, "terminal bridge task completed");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /callback_gateway_method_delivery/);
    const openclawCalls = readJsonLines(openclawCallsPath);
    assert.deepEqual(openclawCalls[0].args.slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.equal(openclawCalls[0].args.includes("--url"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor rejects low-confidence assistant and task_complete for a different request", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-progress-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "• Waited for background terminal · git merge --ff-only origin/main\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Pull main and inspect the changes",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "A different task in the reused Codex session" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The different task is complete."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-different-task",
          last_agent_message: "The different task is complete."
        }
      })
    ].join("\n");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        pane: 1,
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": "› \n"
      }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.stalled, true);
    assert.match(parsed.reason, /observed no activity/);
    const events = fs.readFileSync(logPath, "utf8");
    assert.doesNotMatch(events, /terminal_bridge_completion_detected/);
    const openclawCalls = readJsonLines(openclawCallsPath);
    const callbackParamsIndex = openclawCalls[0].args.indexOf("--params");
    assert.notEqual(callbackParamsIndex, -1);
    const callbackParams = JSON.parse(openclawCalls[0].args[callbackParamsIndex + 1]);
    assert.equal(callbackParams.message.type, "error");
    assert.notEqual(callbackParams.message.type, "done");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge working markers extend inactivity until the hard lifetime", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-activity-timeout-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const workingScreen = [
    "• Waiting for background terminal · autoreview",
    "  3 background terminals running · /ps to view · /stop to close",
    "",
    "› Steer the current task"
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, workingScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Run all review passes",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "0.004",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    const startedAt = JSON.parse(fs.readFileSync(statePath, "utf8"))
      .native_session_takeover.terminal_bridge_started_at;

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001",
      "--agent-hard-timeout-minutes",
      "0.004",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": workingScreen })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.stalled, true);
    assert.equal(parsed.hard_timeout, true);
    assert.match(parsed.reason, /hard lifetime/);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.status, "stalled");
    assert.ok(
      Date.parse(state.native_session_takeover.terminal_bridge_last_activity_at) > Date.parse(startedAt)
    );
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_activity_observed/);
    assert.match(events, /terminal_bridge_inactivity_deadline_extended/);
    assert.match(events, /terminal_bridge_hard_timeout_reached/);
    assert.doesNotMatch(parsed.reason, /no activity/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("renew restarts a stalled terminal bridge without input and completion callbacks once", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-renew-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Finish the long task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-hard-timeout-minutes",
      "60",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = path.join(storeDir, conversationId, "state.json");
    const logPath = path.join(storeDir, conversationId, "events.ndjson");
    const waitingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...waitingState,
      status: "stalled",
      stalled_at: new Date().toISOString(),
      stalled_reason: "test inactivity timeout",
      stalled_notification_sent_at: new Date().toISOString(),
      stalled_notification_message_id: "msg-stalled"
    }, null, 2)}\n`);

    const missingTerminal = runAgentCli([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--terminals-json",
      "[]",
      "--disable-terminal-bridge-monitor"
    ]);
    assert.equal(missingTerminal.status, 1);
    assert.match(missingTerminal.stderr, /no longer available/);
    assert.equal(JSON.parse(fs.readFileSync(statePath, "utf8")).status, "stalled");

    const sendKeyCountBeforeRenew = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const renewed = runAgentCli([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--agent-hard-timeout-minutes",
      "120",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(renewed.status, 0, renewed.stderr || renewed.stdout);
    const renewedParsed = JSON.parse(renewed.stdout);
    assert.equal(renewedParsed.renewed, true);
    assert.equal(renewedParsed.agent_timeout_minutes, 5);
    assert.equal(renewedParsed.agent_hard_timeout_minutes, 60);
    assert.equal(renewedParsed.monitor_pid, null);
    assert.equal(renewedParsed.conversation.status, "waiting_for_agent");
    assert.equal(renewedParsed.conversation.stalled_reason, undefined);
    const sendKeyCountAfterRenew = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    assert.equal(sendKeyCountAfterRenew, sendKeyCountBeforeRenew);

    const rollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Finish the long task" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: "The long task is complete." }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-renewed-task",
          last_agent_message: "The long task is complete."
        }
      })
    ].join("\n");
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "5",
      "--agent-hard-timeout-minutes",
      "60",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace, updated_at_ms: Date.parse("2099-07-04T00:01:00.000Z") })]),
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ];
    const monitored = runAgentCli(monitorArgs);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.body, "The long task is complete.");
    assert.equal(monitoredParsed.conversation.status, "closed");

    const monitoredAgain = runAgentCli(monitorArgs);
    assert.equal(monitoredAgain.status, 0, monitoredAgain.stderr || monitoredAgain.stdout);
    assert.equal(JSON.parse(monitoredAgain.stdout).reason, "conversation_no_longer_waiting");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_renewed/);
    assert.match(events, /terminal_bridge_completion_detected/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("renew reloads stalled state after pane discovery and cannot overwrite a concurrent close", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-renew-close-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const tmuxListGatePath = path.join(tempDir, "tmux-list-gate");
  const terminalTarget = "codex-renew-race:0.1";
  let renewing: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      undefined,
      `codex-renew-race\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Create a terminal task that will become stalled",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const waitingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...waitingState,
      status: "stalled",
      stalled_at: new Date().toISOString(),
      stalled_reason: "race test inactivity timeout",
      updated_at: new Date().toISOString()
    }, null, 2)}\n`);

    renewing = spawnAgentCliCaptured([
      "renew",
      "--state",
      statePath,
      "--minutes",
      "5",
      "--disable-terminal-bridge-monitor"
    ], {
      ...testEnv,
      AKK_TEST_TMUX_LIST_GATE_PATH: tmuxListGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${tmuxListGatePath}.entered`),
      "renew to load its stale snapshot and enter pane discovery"
    );

    const closed = runAgentCli([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      "--reason",
      "closed while renew was checking the pane"
    ], testEnv);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedParsed = JSON.parse(closed.stdout);
    assert.equal(closedParsed.conversation.status, "closed");

    fs.writeFileSync(`${tmuxListGatePath}.release`, "");
    const renewed = await renewing.result;
    assert.notEqual(renewed.status, 0);
    assert.match(renewed.stderr, /conversation is closed, not stalled/u);

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.closed_at, closedParsed.conversation.closed_at);
    assert.equal(finalState.updated_at, closedParsed.conversation.updated_at);
    assert.equal(finalState.close_reason, "closed while renew was checking the pane");
    assert.doesNotMatch(
      fs.readFileSync(logPath, "utf8"),
      /"event":"terminal_bridge_renewed"/u
    );
  } finally {
    fs.writeFileSync(`${tmuxListGatePath}.release`, "");
    killPidBestEffort(renewing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor singleton rejects a live owner and reclaims a dead owner", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-monitor-singleton-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const childProcesses: Array<ReturnType<typeof spawn>> = [];

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(
      screenPath,
      "• Working (12s • esc to interrupt) · 1 background terminal running\n› Steer the current task\n"
    );
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Keep working while AKK monitors",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const monitorArgs = [
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120"
    ];
    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;

    const first = spawnAgentCliProcess(monitorArgs, testEnv);
    childProcesses.push(first);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_monitor_started") === 1,
      "first terminal bridge monitor to start"
    );
    const lockFiles = fs.readdirSync(path.dirname(statePath))
      .filter((name) => name.includes(".terminal-bridge-monitor-") && name.endsWith(".lock"));
    assert.equal(lockFiles.length, 1);

    const duplicate = runAgentCli(monitorArgs, testEnv);
    assert.equal(duplicate.status, 0, duplicate.stderr || duplicate.stdout);
    const duplicateParsed = JSON.parse(duplicate.stdout);
    assert.equal(duplicateParsed.already_running, true);
    assert.equal(duplicateParsed.reason, "terminal_bridge_monitor_already_running");
    assert.equal(eventCount(logPath, "terminal_bridge_monitor_started"), 1);

    first.kill("SIGKILL");
    await waitForChildExit(first);
    assert.equal(fs.existsSync(path.join(path.dirname(statePath), lockFiles[0])), true);

    const replacement = spawnAgentCliProcess(monitorArgs, testEnv);
    childProcesses.push(replacement);
    await waitForCondition(
      () => eventCount(logPath, "terminal_bridge_monitor_started") === 2,
      "replacement terminal bridge monitor to reclaim the stale lock"
    );
    const closed = runAgentCli(["close", "--state", statePath, "--reason", "singleton test cleanup"]);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    await waitForChildExit(replacement);
    assert.equal(
      fs.readdirSync(path.dirname(statePath))
        .some((name) => name.includes(".terminal-bridge-monitor-") && name.endsWith(".lock")),
      false
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );
  } finally {
    for (const child of childProcesses) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors launches only recoverable waiting terminal bridges", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-monitor-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  let monitorPid: number | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
      "--message",
      "Finish the restart-safe task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--agent-timeout-minutes",
      "1",
      "--agent-hard-timeout-minutes",
      "2",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const baseStatePath = JSON.parse(sent.stdout).conversation.state_path;
    const baseState = JSON.parse(fs.readFileSync(baseStatePath, "utf8"));
    const expiredStartedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const expiredActivityAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const recoverableState = {
      ...baseState,
      native_session_takeover: {
        ...baseState.native_session_takeover,
        terminal_bridge_started_at: expiredStartedAt,
        terminal_bridge_last_activity_at: expiredActivityAt,
        terminal_bridge_inactivity_timeout_minutes: 1,
        terminal_bridge_hard_timeout_minutes: 2,
        terminal_bridge_inactivity_deadline_at: new Date(
          Date.parse(expiredActivityAt) + 60_000
        ).toISOString(),
        terminal_bridge_hard_deadline_at: new Date(
          Date.parse(expiredStartedAt) + 2 * 60_000
        ).toISOString()
      }
    };
    fs.writeFileSync(baseStatePath, `${JSON.stringify(recoverableState, null, 2)}\n`);

    writeConversationClone(storeDir, recoverableState, "waiting-for-openclaw", (state) => ({
      ...state,
      status: "waiting_for_openclaw"
    }));
    writeConversationClone(storeDir, recoverableState, "already-stalled", (state) => ({
      ...state,
      status: "stalled"
    }));
    writeConversationClone(storeDir, recoverableState, "missing-gateway", (state) => ({
      ...state,
      gateway_method: undefined
    }));
    writeConversationClone(storeDir, recoverableState, "legacy-owner-unknown", (state) => {
      const nativeTakeover = { ...state.native_session_takeover };
      delete nativeTakeover.terminal_bridge_monitor_lock_version;
      return {
        ...state,
        native_session_takeover: nativeTakeover
      };
    });
    writeConversationClone(storeDir, recoverableState, "non-terminal-task", (state) => ({
      ...state,
      native_session_takeover: {
        ...state.native_session_takeover,
        terminal_bridge: false
      }
    }));

    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--monitor-poll-interval-ms",
      "20"
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const parsed = JSON.parse(reconciled.stdout);
    assert.equal(parsed.checked, 6);
    assert.equal(parsed.ignored, 1);
    assert.equal(parsed.launched, 1);
    assert.equal(parsed.already_running, 0);
    assert.equal(parsed.skipped, 4);
    assert.equal(parsed.errors, 0);
    assert.equal(
      parsed.items.find((item) => item.conversation_id === "legacy-owner-unknown")?.reason,
      "legacy_monitor_ownership_unknown"
    );
    const launchedItem = parsed.items.find((item) => item.status === "launched");
    assert.equal(launchedItem.conversation_id, recoverableState.conversation_id);
    monitorPid = launchedItem.monitor_pid;

    await waitForCondition(
      () => JSON.parse(fs.readFileSync(baseStatePath, "utf8")).status === "stalled",
      "reconciled monitor to classify the elapsed deadline"
    );
    await waitForPidExit(monitorPid);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(storeDir, "waiting-for-openclaw", "state.json"), "utf8")).status,
      "waiting_for_openclaw"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(storeDir, "already-stalled", "state.json"), "utf8")).status,
      "stalled"
    );
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors refreshes exact Claude leases and reports unsafe refresh failures", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-monitor-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const hookStoreDir = path.join(tempDir, "claude-hooks");
  const invalidHookStorePath = path.join(tempDir, "invalid-hook-store");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42301;
  const claudeSessionId = "claude-session-reconcile";
  let monitorPid: number | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    fs.writeFileSync(invalidHookStorePath, "not a directory\n");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      hookStoreDir,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Continue after the Gateway restart"
    });
    const nativeTakeover = task.conversation.native_session_takeover;
    const hookStore = new ClaudeHookStore({ rootDir: hookStoreDir });
    hookStore.releaseLease({ leaseId: nativeTakeover.claude_hook_lease_id });

    writeConversationClone(storeDir, task.conversation, "claude-unsafe-refresh", (state) => ({
      ...state,
      native_session_takeover: {
        ...state.native_session_takeover,
        terminal_bridge_message_id: "msg-claude-unsafe-refresh",
        claude_hook_store_dir: invalidHookStorePath,
        claude_hook_lease_id: "invalid-lease"
      }
    }));

    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--monitor-poll-interval-ms",
      "20"
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const parsed = JSON.parse(reconciled.stdout);
    assert.equal(parsed.checked, 2);
    assert.equal(parsed.launched, 1);
    assert.equal(parsed.skipped, 1);
    assert.equal(parsed.errors, 0);
    const failedItem = parsed.items.find((item) =>
      item.conversation_id === "claude-unsafe-refresh"
    );
    assert.equal(failedItem.status, "skipped");
    assert.equal(failedItem.reason, "claude_hook_lease_refresh_failed");
    const launchedItem = parsed.items.find((item) => item.status === "launched");
    monitorPid = launchedItem.monitor_pid;

    const renewed = hookStore.resolveLease({
      sessionId: claudeSessionId,
      pid: claudePid,
      cwd: workspace
    });
    assert.equal(renewed?.authorizationEligible, true);
    assert.equal(renewed?.lease.conversationId, task.conversation.conversation_id);
    assert.equal(renewed?.lease.messageId, nativeTakeover.terminal_bridge_message_id);
    const renewedState = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(renewedState.native_session_takeover.claude_hook_lease_id, renewed?.lease.id);

    const closed = runAgentCli([
      "close",
      "--state",
      task.statePath,
      "--reason",
      "Claude reconciliation test cleanup"
    ]);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    await waitForPidExit(monitorPid);
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors restarts hookless Claude bridges without a hook lease", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-hookless-claude-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-work:0.0";
  const claudePid = 42311;
  const claudeSessionId = "66666666-6666-4666-8666-666666666666";
  let monitorPid: number | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-work\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: "Continue the hookless task after restart"
    });
    assert.equal(task.conversation.native_session_takeover.claude_hook_mode, undefined);
    assert.equal(task.conversation.native_session_takeover.claude_hook_lease_id, undefined);
    const sendKeysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys").length;
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const reconciled = runAgentCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--monitor-poll-interval-ms",
      "20"
    ], testEnv);
    assert.equal(reconciled.status, 0, reconciled.stderr || reconciled.stdout);
    const parsed = JSON.parse(reconciled.stdout);
    assert.equal(parsed.checked, 1);
    assert.equal(parsed.launched, 1);
    assert.equal(parsed.skipped, 0);
    assert.equal(parsed.errors, 0);
    assert.notEqual(
      parsed.items[0]?.reason,
      "claude_hook_lease_refresh_failed"
    );
    monitorPid = parsed.items[0]?.monitor_pid;
    await waitForCondition(
      () => eventCount(task.logPath, "terminal_bridge_monitor_started") === 1,
      "hookless Claude monitor to start after reconciliation"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );

    const closed = runAgentCli([
      "close",
      "--state",
      task.statePath,
      "--reason",
      "Hookless Claude reconciliation test cleanup"
    ]);
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    await waitForPidExit(monitorPid);
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor callbacks when the completed prompt has scrolled out of the screen excerpt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-screen-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const request = "git pull 完后看一下最近的 commits，告诉我都更新了哪些特性";
    fs.writeFileSync(screenPath, "Codex is ready\n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `my-work\t0\t0\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:my-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      request,
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = path.join(storeDir, sentParsed.conversation.conversation_id, "state.json");
    const logPath = path.join(storeDir, sentParsed.conversation.conversation_id, "events.ndjson");
    assert.equal(
      typeof sentParsed.conversation.native_session_takeover.terminal_bridge_pre_send_screen_fingerprint,
      "string"
    );

    fs.writeFileSync(screenPath, [
      "  这次 pull 实际只更新了 1 个 commit：",
      "",
      "  71afa78 fix(daemon): stop logging client disconnects as connection errors (#328)",
      "",
      "  更新内容：",
      "  - 新增 is_client_disconnect() 识别客户端主动断开连接",
      "  - daemon 不再把 BrokenPipe/ConnectionReset 等正常断连记录为服务端错误",
      "",
      "─ Worked for 4m 48s ───────────────────────────────────────────────",
      "",
      "› Find and fix a bug in @filename",
      "",
      "  gpt-5.6-sol high · ~/github/coven"
    ].join("\n"));

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "my-work:0.0",
        session: "my-work",
        window: 0,
        pane: 0,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "my-work:0.0": fs.readFileSync(screenPath, "utf8")
      })
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.match(parsed.message.body, /这次 pull 实际只更新了 1 个 commit/);
    assert.doesNotMatch(parsed.message.body, /Worked for|Find and fix|gpt-5\.6/);
    assert.equal(parsed.message.metadata.confidence, "screen_only");
    assert.equal(parsed.conversation.status, "closed");
    assert.equal(parsed.conversation.close_reason, "terminal bridge task completed");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /"match":"terminal_screen"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal approval notification keeps the state lock through callback delivery before close", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-callback-close-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const openclawGatePath = path.join(tempDir, "openclaw-gate");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "codex-approval-lock:0.1";
  const approvalScreen = [
    "  Would you like to run the following command?",
    "",
    "  $ npm install",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
  let monitoring: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let closing: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, approvalScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-approval-lock\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Install dependencies if needed",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const stateLockPath = `${statePath}.lock`;

    monitoring = spawnAgentCliCaptured([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: "codex-approval-lock",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: approvalScreen })
    ], {
      ...testEnv,
      AKK_TEST_OPENCLAW_GATE_PATH: openclawGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${openclawGatePath}.entered`),
      "approval callback delivery to enter the OpenClaw gate"
    );

    assert.equal(fs.existsSync(stateLockPath), true);
    const callbackLockOwner = JSON.parse(fs.readFileSync(stateLockPath, "utf8"));
    assert.equal(
      callbackLockOwner.pid,
      monitoring.child.pid,
      "the monitor must retain the notification state lock while OpenClaw delivery is blocked"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(statePath, "utf8")).status,
      "waiting_for_openclaw"
    );

    closing = spawnAgentCliCaptured([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      "--reason",
      "closed while approval callback was in flight"
    ], testEnv);
    await waitForCondition(() => {
      const terminalLocks = fs.readdirSync(storeDir)
        .filter((name) =>
          name.startsWith(".terminal-bridge-send-") &&
          name.endsWith(".lock")
        );
      return terminalLocks.some((name) => {
        const owner = JSON.parse(fs.readFileSync(path.join(storeDir, name), "utf8"));
        return owner.pid === closing?.child.pid;
      });
    }, "close to acquire the terminal lock while waiting for callback delivery");
    assert.equal(
      closing.child.exitCode,
      null,
      "close must wait until the notification callback releases the state lock"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(stateLockPath, "utf8")).pid,
      monitoring.child.pid
    );

    fs.writeFileSync(`${openclawGatePath}.release`, "");
    const monitored = await monitoring.result;
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    assert.equal(JSON.parse(monitored.stdout).delivered, true);

    const closed = await closing.result;
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedParsed = JSON.parse(closed.stdout);
    assert.equal(closedParsed.conversation.status, "closed");

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.closed_at, closedParsed.conversation.closed_at);
    assert.equal(finalState.updated_at, closedParsed.conversation.updated_at);
    assert.equal(finalState.close_reason, "closed while approval callback was in flight");
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_notification_recorded/u);
    assert.match(events, /callback_gateway_method_delivery/u);
    assert.match(events, /conversation_closed/u);
  } finally {
    fs.writeFileSync(`${openclawGatePath}.release`, "");
    killPidBestEffort(monitoring?.child.pid);
    killPidBestEffort(closing?.child.pid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal bridge monitor callbacks for Codex approval and approve resumes waiting", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-bridge-approval-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const approvalScreen = [
      "  Would you like to run the following command?",
      "",
      "  $ npm install",
      "",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel"
    ].join("\n");
    fs.writeFileSync(screenPath, approvalScreen);
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Install dependencies if needed",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:channel:original",
      "--openclaw-session",
      "agent:channel:original",
      "--openclaw-bin",
      openclawBin,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const statePath = path.join(storeDir, conversationId, "state.json");
    const logPath = path.join(storeDir, conversationId, "events.ndjson");

    const monitored = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      statePath,
      "--log",
      logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.1": approvalScreen
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.type, "question");
    assert.equal(monitoredParsed.message.metadata.reason, "approval_required");
    assert.deepEqual(monitoredParsed.message.metadata.approval_candidate, {
      agent: "codex",
      kind: "run_command",
      command: "npm install",
      cwd: workspace,
      fingerprint: monitoredParsed.message.metadata.approval_fingerprint,
      terminal_target: "codex-work:0.1",
      decision_mode: "keys"
    });
    assert.match(monitoredParsed.message.body, new RegExp(`AKK approve ${conversationId}`));
    assert.match(monitoredParsed.message.body, new RegExp(`AKK cancel ${conversationId}`));
    assert.match(monitoredParsed.message.body, /agent_knock_knock_approve/);
    assert.match(monitoredParsed.message.body, /agent_knock_knock_cancel/);
    assert.match(monitoredParsed.message.body, /\$ npm install/);
    assert.equal(monitoredParsed.conversation.status, "waiting_for_openclaw");

    const openclawCalls = readJsonLines(openclawCallsPath);
    const paramsIndex = openclawCalls[0].args.indexOf("--params");
    assert.notEqual(paramsIndex, -1);
    const gatewayParams = JSON.parse(openclawCalls[0].args[paramsIndex + 1]);
    assert.equal(gatewayParams.message.type, "question");
    assert.equal(
      gatewayParams.message.metadata.approve_command,
      `AKK approve ${conversationId} --expected-approval-fingerprint ${monitoredParsed.message.metadata.approval_fingerprint}`
    );
    assert.equal(gatewayParams.message.metadata.deny_command, `AKK cancel ${conversationId}`);
    assert.equal(gatewayParams.message.metadata.approval_candidate.command, "npm install");

    fs.writeFileSync(screenPath, approvalScreen.replace("$ npm install", "$ npm install left-pad"));
    const persistedFingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      persistedFingerprintMismatch.status,
      0,
      persistedFingerprintMismatch.stderr || persistedFingerprintMismatch.stdout
    );
    assert.match(JSON.parse(persistedFingerprintMismatch.stdout).reason, /fingerprint changed/);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"),
      false
    );
    fs.writeFileSync(screenPath, approvalScreen);

    const fingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      "different-fingerprint",
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--policy-fingerprint",
      "policy-123",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(fingerprintMismatch.status, 0, fingerprintMismatch.stderr || fingerprintMismatch.stdout);
    const mismatchParsed = JSON.parse(fingerprintMismatch.stdout);
    assert.equal(mismatchParsed.approved, false);
    assert.match(mismatchParsed.reason, /fingerprint changed/);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"),
      false
    );

    const forgedCallbackPolicy = {
      enabled: true,
      rules: [{
        id: "test-rule",
        agents: ["codex"],
        workspaces: [workspace],
        commands: [["pwd"]]
      }]
    };
    const executorSideRejected = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      monitoredParsed.message.metadata.approval_fingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--auto-approval-policy-json",
      JSON.stringify(forgedCallbackPolicy),
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      executorSideRejected.status,
      0,
      executorSideRejected.stderr || executorSideRejected.stdout
    );
    assert.equal(JSON.parse(executorSideRejected.stdout).approved, false);
    assert.match(
      JSON.parse(executorSideRejected.stdout).reason,
      /executor-side auto-approval policy rejected/
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some(
        (call) => call.args[0] === "send-keys" && call.args.at(-1) === "y"
      ),
      false,
      "a callback-declared safe command must not authorize the different live prompt"
    );

    const safePolicy = {
      enabled: true,
      rules: [{
        id: "test-rule",
        agents: ["codex"],
        workspaces: [workspace],
        commands: [["npm", "install"]]
      }]
    };
    const approved = runAgentCli([
      "approve",
      "--state",
      statePath,
      "--expected-approval-fingerprint",
      monitoredParsed.message.metadata.approval_fingerprint,
      "--auto-approved",
      "--policy-rule-id",
      "test-rule",
      "--auto-approval-policy-json",
      JSON.stringify(safePolicy),
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.key, "y");
    assert.equal(approvedParsed.auto_approved, true);
    assert.equal(approvedParsed.policy_rule_id, "test-rule");
    assert.equal(approvedParsed.conversation.status, "waiting_for_agent");
    assert.equal(approvedParsed.conversation.native_session_takeover.terminal_bridge_approval, undefined);
    const calls = readJsonLines(tmuxCallsPath);
    assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "codex-work:0.1", "y"]);

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_detected/);
    assert.match(events, /terminal_bridge_approval_notification_recorded/);
    assert.match(events, /terminal_auto_approval_decision/);
    assert.match(events, /"action":"rejected"/);
    assert.match(events, /"action":"approved"/);
    assert.match(events, /callback_gateway_method_delivery/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal-controlled conversation ids use Codex pid, not tmux pane pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-pid-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "Codex is ready\n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t0\t999\tnode\t${workspace}\n`
    );

    const conversationId = "terminal:tmux:codex-work:0.0:33389";
    const sent = runAgentCli([
      "send",
      "--conversation",
      conversationId,
      "--message",
      "继续",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "node /Users/scotthuang/.npm-global/bin/codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 999,
        currentPath: workspace
      })])
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.conversation_id, conversationId);
    assert.equal(sentParsed.terminal_control.panePid, 999);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});


test("agent takeover terminate_then_resume returns a confirmation plan for an exact active session", () => {
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "terminate_then_resume",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 2000,
      ppid: 1,
      command: `codex resume ${sessionId}`,
      cwd
    }])
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "requires_confirmation");
  assert.equal(parsed.sideEffectsExecuted, false);
  assert.equal(parsed.plan.mode, "takeover");
  assert.equal(parsed.plan.targets[0].pid, 2000);
  assert.equal(parsed.plan.resumeAfterExit.sessionId, sessionId);
});

test("agent takeover terminate_then_resume requires explicit pid confirmation before terminating", () => {
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "terminate_then_resume",
    "--create-conversation",
    "--confirm-terminate",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 2000,
      ppid: 1,
      command: `codex resume ${sessionId}`,
      cwd
    }])
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--expected-pid is required/);
});

test("agent takeover terminate_then_resume can terminate a confirmed process and attach a conversation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-terminate-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const child = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: false
  });

  try {
    assert.ok(child.pid);
    const result = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminate_then_resume",
      "--create-conversation",
      "--confirm-terminate",
      "--expected-pid",
      String(child.pid),
      "--terminate-timeout-ms",
      "50",
      "--request",
      "Take over active terminal Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: nativeModelRollout() }),
      "--processes-json",
      JSON.stringify([[{
        pid: child.pid,
        ppid: 1,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }], []])
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "attached", result.stdout);
    assert.equal(parsed.sideEffectsExecuted, true);
    assert.equal(parsed.termination.target.pid, child.pid);
    assert.equal(parsed.termination.signals[0].status, "sent");
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.executor.session, sessionId);
    assert.equal(parsed.conversation.native_session_takeover.strategy, "terminate_then_resume");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, true);
  } finally {
    try {
      if (child.pid) {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // Already terminated by the command under test.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent takeover terminate_then_resume can explicitly accept a cwd-only confirmed pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-cwd-only-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const child = spawn("/bin/sleep", ["60"], {
    stdio: "ignore",
    detached: false
  });

  try {
    assert.ok(child.pid);
    const result = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "terminate_then_resume",
      "--create-conversation",
      "--confirm-terminate",
      "--allow-cwd-only",
      "--expected-pid",
      String(child.pid),
      "--terminate-timeout-ms",
      "50",
      "--request",
      "Take over cwd-only terminal Codex",
      "--store-dir",
      storeDir,
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: nativeModelRollout() }),
      "--processes-json",
      JSON.stringify([[{
        pid: child.pid,
        ppid: 1,
        command: "codex",
        cwd: workspace
      }], []])
    ]);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.status, "attached", result.stdout);
    assert.equal(parsed.matchKind, "cwd_only_confirmed");
    assert.equal(parsed.conversation.native_session_takeover.takeover_match_kind, "cwd_only_confirmed");
    assert.equal(parsed.conversation.native_session_takeover.needs_bootstrap, true);
  } finally {
    try {
      if (child.pid) {
        process.kill(child.pid, "SIGKILL");
      }
    } catch {
      // Already terminated by the command under test.
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("agent takeover fork returns bounded context for OpenClaw summary confirmation", () => {
  const rollout = [
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review this branch" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "I found one issue." } }),
    JSON.stringify({ type: "response_item", payload: { command: "git status", cwd, status: "0" } })
  ].join("\n");
  const result = runAgentCli([
    "agent",
    "takeover",
    "--agent",
    "codex",
    "--session-id",
    sessionId,
    "--strategy",
    "fork",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, "awaiting_openclaw_summary");
  assert.equal(parsed.sideEffectsExecuted, false);
  assert.equal(parsed.plan.mode, "fork");
  assert.equal(parsed.plan.requiresOpenClawSummary, true);
  assert.equal(parsed.plan.contextPackage.source.sessionId, sessionId);
  assert.equal(parsed.plan.contextPackage.messages.length, 2);
  assert.match(parsed.summaryPrompt, /Produce a concise, user-reviewable summary/);
  assert.match(parsed.summaryPrompt, /do not pass raw rollout history/);
  assert.equal(parsed.nextAction.action, "summarize_and_confirm_fork");
  assert.equal(parsed.nextAction.followUpTool, "agent_knock_knock_agent_takeover");
  assert.deepEqual(parsed.nextAction.followUpParams, {
    agent: "codex",
    sessionId,
    strategy: "fork",
    createConversation: true,
    forkSummary: "<confirmed OpenClaw summary>"
  });
});

test("agent takeover fork can create a new AKK conversation from approved summary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-agent-fork-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const acpxCallsPath = path.join(tempDir, "acpx-calls.ndjson");
  const rollout = [
    JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "raw private source context" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "raw assistant context" } }),
    nativeModelRollout()
  ].join("\n");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2)
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const forked = runAgentCli([
      "agent",
      "takeover",
      "--agent",
      "codex",
      "--session-id",
      sessionId,
      "--strategy",
      "fork",
      "--create-conversation",
      "--request",
      "Fork my terminal Codex session",
      "--fork-summary",
      "Approved summary: inspect the ACPX branch and continue carefully.",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:wechat",
      "--threads-json",
      JSON.stringify([threadRow({ cwd: workspace })]),
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout }),
      "--processes-json",
      JSON.stringify([{
        pid: 2000,
        ppid: 1,
        command: "codex",
        cwd: workspace
      }])
    ]);

    assert.equal(forked.status, 0, forked.stderr || forked.stdout);
    const parsed = JSON.parse(forked.stdout);
    assert.equal(parsed.status, "forked");
    assert.equal(parsed.sideEffectsExecuted, true);
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.notEqual(parsed.conversation.executor.session, sessionId);
    assert.match(parsed.conversation.executor.session, /^akk-codex-/);
    assert.equal(parsed.conversation.executor_model, "gpt-5.5[medium]");
    assert.equal(parsed.conversation.fork_context_takeover.source_session_id, sessionId);
    assert.equal(parsed.conversation.fork_context_takeover.summary, "Approved summary: inspect the ACPX branch and continue carefully.");
    assert.equal(parsed.conversation.fork_context_takeover.needs_bootstrap, true);

    const sent = runAgentCli([
      "send",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Start from the approved fork summary.",
      "--type",
      "task"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(sentParsed.delivered, true);
    assert.equal(sentParsed.conversation.fork_context_takeover.needs_bootstrap, false);

    const calls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].args, [...CODEX_ACPX_SELECTOR, "sessions", "ensure", "--name", parsed.conversation.executor.session]);
    assert.deepEqual(calls[1].args.slice(0, 7), ["--approve-all", "--model", "gpt-5.5[medium]", ...CODEX_ACPX_SELECTOR, "prompt", "-s"]);
    assert.equal(calls[1].args[7], parsed.conversation.executor.session);
    assert.match(calls[1].args[8], /This AKK conversation is a fork/);
    assert.match(calls[1].args[8], /Approved summary: inspect the ACPX branch/);
    assert.doesNotMatch(calls[1].args[8], /raw private source context/);
    assert.doesNotMatch(calls[1].args[8], /--resume-session/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("describe terminal-controlled Codex session from rollout history", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Add AKK describe command"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I am wiring the OpenClaw tool."
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:02:00.000Z",
      type: "response_item",
      payload: {
        command: "npm test",
        status: "completed"
      }
    })
  ].join("\n");

  const described = runAgentCli([
    "describe",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow()]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Working\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.source, "terminal_control");
  assert.equal(parsed.confidence, "high");
  assert.equal(parsed.match, "session_id");
  assert.match(parsed.about, /Add AKK describe command/);
  assert.match(parsed.about, /OpenClaw tool/);
  assert.equal(parsed.evidence.initial_request, "Add AKK describe command");
  assert.equal(parsed.evidence.recent_commands.at(-1).command, "npm test");
});

test("describe native Codex session falls back to cwd match", () => {
  const otherSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44f";
  const otherRolloutPath = "/tmp/other-codex-rollout.jsonl";
  const rollout = JSON.stringify({
    timestamp: "2026-07-04T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "user_message",
      message: "Most recent cwd task"
    }
  });

  const described = runAgentCli([
    "describe",
    "--conversation",
    "native:codex:4444",
    "--threads-json",
    JSON.stringify([
      threadRow({ updated_at_ms: 1000, title: "older task" }),
      {
        id: otherSessionId,
        cwd,
        rollout_path: otherRolloutPath,
        title: "newer task",
        updated_at_ms: 2000,
        archived: false
      }
    ]),
    "--processes-json",
    JSON.stringify([{
      pid: 4444,
      ppid: 1,
      command: "codex",
      cwd
    }]),
    "--rollouts-json",
    JSON.stringify({ [otherRolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.source, "native_active");
  assert.equal(parsed.confidence, "low");
  assert.equal(parsed.match, "cwd_latest");
  assert.match(parsed.about, /Most recent cwd task/);
  assert.equal(parsed.evidence.candidates.length, 2);
  assert.match(parsed.limitations[0], /most recent of 2 sessions/);
});

test("describe prefers Codex title over injected environment context", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "<environment_context> <cwd>/repo/project</cwd> </environment_context>"
      }
    }),
    JSON.stringify({
      timestamp: "2026-07-04T00:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "I checked the README and summarized the project."
      }
    })
  ].join("\n");

  const described = runAgentCli([
    "describe",
    "--conversation",
    "terminal:tmux:codex-work:0.0:33389",
    "--threads-json",
    JSON.stringify([threadRow({ title: "Read the README and explain this project" })]),
    "--processes-json",
    JSON.stringify([{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd
    }]),
    "--terminals-json",
    JSON.stringify([tmuxPane()]),
    "--terminal-screens-json",
    JSON.stringify({
      "codex-work:0.0": "Codex is ready\n"
    }),
    "--rollouts-json",
    JSON.stringify({ [rolloutPath]: rollout })
  ]);

  assert.equal(described.status, 0, described.stderr || described.stdout);
  const parsed = JSON.parse(described.stdout);
  assert.equal(parsed.evidence.initial_request, "Read the README and explain this project");
  assert.match(parsed.about, /Read the README and explain this project/);
  assert.doesNotMatch(parsed.about, /environment_context/);
  assert.equal(parsed.evidence.recent_messages.some((message) => message.text.includes("environment_context")), false);
});

interface ManagedClaudeTerminalTask {
  conversation: any;
  statePath: string;
  logPath: string;
}

function startManagedClaudeTerminalTask(options: {
  fakeBinDir: string;
  workspace: string;
  storeDir: string;
  claudeHome?: string;
  hookStoreDir?: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  message: string;
}): ManagedClaudeTerminalTask {
  writeFakeProcessTools(options.fakeBinDir, [{
    pid: options.claudePid,
    ppid: 999,
    command: "claude",
    cwd: options.workspace
  }]);
  const openclawBin = path.join(options.fakeBinDir, "openclaw");
  const rawConversationId = `terminal:v2:tmux:claude:${options.terminalTarget}:${options.claudePid}`;
  const sent = runAgentCli([
    "send",
    "--conversation",
    rawConversationId,
    "--message",
    options.message,
    "--background",
    "--store-dir",
    options.storeDir,
    "--gateway-method",
    "agent-knock-knock.callback",
    "--gateway-session",
    "agent:channel:original",
    "--openclaw-session",
    "agent:channel:original",
    "--openclaw-bin",
    openclawBin,
    ...(options.hookStoreDir
      ? ["--claude-hook-store-dir", options.hookStoreDir]
      : []),
    ...(options.claudeHome
      ? ["--claude-home", options.claudeHome]
      : []),
    "--claude-agents-json",
    JSON.stringify([claudeAgentRow(options.claudePid, options.claudeSessionId, options.workspace)]),
    "--disable-terminal-bridge-monitor"
  ], {
    PATH: `${options.fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  });
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const parsed = JSON.parse(sent.stdout);
  assert.equal(parsed.delivered, true);
  assert.equal(parsed.status, "async_pending");
  assert.equal(parsed.background, true);
  assert.equal(parsed.executor.kind, "claude");
  assert.equal(parsed.terminal_control.target, options.terminalTarget);
  return {
    conversation: parsed.conversation,
    statePath: parsed.conversation.state_path,
    logPath: parsed.conversation.event_log_path
  };
}

function claudeMonitorArgs(options: {
  task: ManagedClaudeTerminalTask;
  hookStoreDir: string;
  staticArgs: string[];
  timeoutMinutes?: string;
}): string[] {
  return [
    "monitor",
    "--terminal-bridge",
    "--state",
    options.task.statePath,
    "--log",
    options.task.logPath,
    "--poll-interval-ms",
    "20",
    "--agent-timeout-minutes",
    options.timeoutMinutes ?? "60",
    "--agent-hard-timeout-minutes",
    "120",
    "--claude-hook-store-dir",
    options.hookStoreDir,
    ...options.staticArgs
  ];
}

function claudeTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  screen: string;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.claudePid,
      ppid: 999,
      elapsed: "00:30",
      command: "claude",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([{
      kind: "tmux",
      target: options.terminalTarget,
      session: "claude-work",
      window: 0,
      pane: 0,
      panePid: 999,
      currentCommand: "node",
      currentPath: options.workspace
    }]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen }),
    "--claude-agents-json",
    JSON.stringify([claudeAgentRow(options.claudePid, options.claudeSessionId, options.workspace)])
  ];
}

function claudeAgentRow(pid: number, sessionId: string, workspace: string) {
  return {
    kind: "interactive",
    pid,
    sessionId,
    startedAt: 1784870000000,
    cwd: workspace,
    status: "idle"
  };
}

function claudeHookBase(sessionId: string, workspace: string) {
  return {
    session_id: sessionId,
    transcript_path: path.join(workspace, ".claude", `${sessionId}.jsonl`),
    cwd: workspace,
    permission_mode: "default"
  };
}

function claudePromptHookInput(sessionId: string, workspace: string, promptId: string) {
  return {
    ...claudeHookBase(sessionId, workspace),
    hook_event_name: "UserPromptSubmit" as const,
    prompt_id: promptId,
    prompt: `prompt for ${promptId}`
  };
}

function claudePermissionHookInput(
  sessionId: string,
  workspace: string,
  promptId: string,
  command: string
) {
  return {
    ...claudeHookBase(sessionId, workspace),
    hook_event_name: "PermissionRequest" as const,
    prompt_id: promptId,
    tool_name: "Bash",
    tool_input: { command },
    permission_suggestions: []
  };
}

function claudeStopHookInput(
  sessionId: string,
  workspace: string,
  promptId: string,
  fields: Record<string, unknown>
) {
  return {
    ...claudeHookBase(sessionId, workspace),
    hook_event_name: "Stop" as const,
    prompt_id: promptId,
    stop_hook_active: false,
    ...fields
  };
}

function claudeStopFailureHookInput(sessionId: string, workspace: string, promptId: string) {
  return {
    ...claudeHookBase(sessionId, workspace),
    hook_event_name: "StopFailure" as const,
    prompt_id: promptId,
    error: "rate_limit" as const,
    error_details: "429 Too Many Requests",
    last_assistant_message: "Release command failed before completion."
  };
}

function runAgentCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });
}

function runAgentCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 30_000
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: {
        ...process.env,
        ...env
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`agent CLI child exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

function spawnAgentCliCaptured(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: {
      ...process.env,
      ...env
    }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  return { child, result };
}

function spawnAgentCliProcess(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: {
      ...process.env,
      ...env
    }
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for child ${child.pid} to exit`)),
      timeoutMs
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForPidExit(pid: number | undefined, timeoutMs = 5000): Promise<void> {
  if (!pid) {
    return;
  }
  await waitForCondition(() => !pidIsAlive(pid), `pid ${pid} to exit`, timeoutMs);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8"
    });
    return status.status === 0 && !status.stdout.trim().startsWith("Z");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPidBestEffort(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The monitor already exited.
  }
}

function eventCount(logPath: string, eventName: string): number {
  if (!fs.existsSync(logPath)) {
    return 0;
  }
  return fs.readFileSync(logPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === eventName)
    .length;
}

function writeConversationClone(
  storeDir: string,
  sourceState: any,
  conversationId: string,
  mutate: (state: any) => any
): string {
  const conversationDir = path.join(storeDir, conversationId);
  const statePath = path.join(conversationDir, "state.json");
  const eventLogPath = path.join(conversationDir, "events.ndjson");
  fs.mkdirSync(conversationDir, { recursive: true });
  const cloned = mutate({
    ...sourceState,
    conversation_id: conversationId,
    conversation_dir: conversationDir,
    state_path: statePath,
    event_log_path: eventLogPath
  });
  fs.writeFileSync(statePath, `${JSON.stringify(cloned, null, 2)}\n`);
  return statePath;
}

function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    cwd,
    rollout_path: rolloutPath,
    title: "review current branch",
    updated_at_ms: 1000,
    archived: false,
    ...overrides
  };
}

function nativeModelRollout() {
  return JSON.stringify({
    timestamp: "2026-06-20T14:05:25.758Z",
    type: "turn_context",
    payload: {
      model: "gpt-5.5"
    }
  });
}

function tmuxPane(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tmux",
    target: "codex-work:0.0",
    session: "codex-work",
    window: 0,
    pane: 0,
    panePid: 999,
    currentCommand: "node",
    currentPath: cwd,
    ...overrides
  };
}

function writeFakeTmux(
  fakeBinDir: string,
  callsPath: string,
  screenPath?: string,
  listPanesOutput = "",
  failSendText = ""
) {
  const fakeTmux = path.join(fakeBinDir, "tmux");
  fs.writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
if (${JSON.stringify(failSendText)} && args.includes(${JSON.stringify(failSendText)})) {
  process.exit(1);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const gatePath = process.env.AKK_TEST_TMUX_SEND_GATE_PATH;
  if (gatePath) {
    fs.writeFileSync(gatePath + ".entered", "");
    while (!fs.existsSync(gatePath + ".release")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const delayMs = Number(process.env.AKK_TEST_TMUX_SEND_DELAY_MS || 0);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
if (args[0] === "capture-pane") {
  process.stdout.write(fs.existsSync(${JSON.stringify(screenPath ?? "")}) ? fs.readFileSync(${JSON.stringify(screenPath ?? "")}, "utf8") : "");
} else if (args[0] === "list-panes") {
  const gatePath = process.env.AKK_TEST_TMUX_LIST_GATE_PATH;
  if (gatePath) {
    fs.writeFileSync(gatePath + ".entered", "");
    while (!fs.existsSync(gatePath + ".release")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  process.stdout.write(${JSON.stringify(listPanesOutput)});
}
`,
    "utf8"
  );
  fs.chmodSync(fakeTmux, 0o755);

  const paneProcesses = listPanesOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split("\t");
      const pid = Number(fields[3]);
      return Number.isInteger(pid)
        ? [{
            pid,
            ppid: 1,
            command: "codex",
            cwd: fields.slice(5).join("\t")
          }]
        : [];
    });
  if (paneProcesses.length > 0) {
    writeFakeProcessTools(fakeBinDir, paneProcesses);
  }
}

function writeFakeProcessTools(
  fakeBinDir: string,
  processes: Array<{ pid: number; ppid: number; command: string; cwd: string }>
) {
  const fakePs = path.join(fakeBinDir, "ps");
  const psOutput = [
    "  PID  PPID ELAPSED COMMAND",
    ...processes.map((entry) =>
      `${entry.pid} ${entry.ppid} 00:01 ${entry.command}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakePs,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(psOutput)});
`,
    "utf8"
  );
  fs.chmodSync(fakePs, 0o755);
}

function writeFakeOpenClaw(fakeBinDir: string, callsPath: string) {
  const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
const gatePath = process.env.AKK_TEST_OPENCLAW_GATE_PATH;
if (gatePath) {
  fs.writeFileSync(gatePath + ".entered", "");
  while (!fs.existsSync(gatePath + ".release")) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
