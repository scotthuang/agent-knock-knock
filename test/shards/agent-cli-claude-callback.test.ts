import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  storeConversationsDir,
  storeManifestPath,
  storeSessionsDir
} from "../../src/store.js";
import {
  listManagedSessions,
  loadManagedSession,
  pathsForManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "../../src/session-store.js";
import {
  captureCodexRolloutAcceptanceAnchor,
  detectCodexRolloutAcceptance
} from "../../src/terminal-submission-acceptance.js";
import { createOpenClawPluginForTest } from "../../src/openclaw-plugin.js";
import {
  binPath,
  cwd,
  sessionId,
  rolloutPath,
  startManagedClaudeTerminalTask,
  claudeTerminalStaticArgs,
  claudeAgentRow,
  codexNativeIdentityArgs,
  runAgentCliInProcess,
  runAgentCliAsync,
  spawnAgentCliCaptured,
  spawnAgentCliProcess,
  waitForCondition,
  waitForChildExit,
  waitForPidExit,
  pidIsAlive,
  killPidBestEffort,
  eventCount,
  writeConversationClone,
  threadRow,
  tmuxPane,
  writeFakeTmux,
  writeFakeProcessTools,
  writeTrackedFakeProcessTools,
  writeFakeOpenClaw,
  writeFakeClaudeAgents,
  currentClaudeApprovalScreenForTest,
  writeAutoApprovingFakeOpenClaw,
  writeSequentialAutoApprovingFakeOpenClaw,
  findTerminalDispatchLedgerPath,
  readJsonLines
} from "../agent-cli-fixtures.js";

test("hookless Claude tmux approval is bound to a managed callback and sends exactly one C-m", async () => {
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
    "   Run the repository test suite",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don’t ask again for: npm test *",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
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

    const rawApproval = await runAgentCliInProcess([
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
    const sent = await runAgentCliInProcess([
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

    const storedAfterSend = JSON.parse(fs.readFileSync(conversation.state_path, "utf8"));
    const transcriptAnchor =
      storedAfterSend.native_session_takeover.claude_transcript_anchor;
    assert.equal(transcriptAnchor.session_id, claudeSessionId);
    const projectDirectory = path.join(
      claudeHome,
      "projects",
      workspace.replace(/[^A-Za-z0-9]/gu, "-")
    );
    fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const transcriptPath = path.join(projectDirectory, `${claudeSessionId}.jsonl`);
    const promptAt = new Date(
      Date.parse(transcriptAnchor.captured_at) + 100
    ).toISOString();
    const pendingCommand = "npm test -- --runInBand";
    const promptUuid = "00000000-0000-4000-8000-000000000501";
    const thinkingUuid = "00000000-0000-4000-8000-000000000502";
    const toolUuid = "00000000-0000-4000-8000-000000000503";
    const assistantMessageId = "00000000-0000-4000-8000-000000000504";
    const transcriptBase = (uuid: string, parentUuid: string | null) => ({
      uuid,
      parentUuid,
      isSidechain: false,
      entrypoint: "cli",
      timestamp: promptAt,
      cwd: workspace,
      sessionId: claudeSessionId,
      version: "2.1.218"
    });
    fs.writeFileSync(transcriptPath, [
      {
        ...transcriptBase(promptUuid, null),
        type: "user",
        promptId: "00000000-0000-4000-8000-000000000505",
        message: { role: "user", content: "Run the focused tests" }
      },
      {
        ...transcriptBase(thinkingUuid, promptUuid),
        type: "assistant",
        message: {
          role: "assistant",
          id: assistantMessageId,
          stop_reason: "tool_use",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...transcriptBase(toolUuid, thinkingUuid),
        type: "assistant",
        message: {
          role: "assistant",
          id: assistantMessageId,
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: "toolu_cli_hookless_approval",
            name: "Bash",
            input: { command: pendingCommand }
          }]
        }
      }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n", { mode: 0o600 });

    fs.writeFileSync(screenPath, approvalScreen);
    const staticArgs = claudeTerminalStaticArgs({
      workspace,
      terminalTarget,
      claudePid,
      claudeSessionId,
      screen: approvalScreen
    });
    const monitored = await runAgentCliInProcess([
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
      "--claude-home",
      claudeHome,
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
    const commandSha256 = createHash("sha256").update(pendingCommand).digest("hex");
    assert.equal(approvalState.command, undefined);
    assert.deepEqual(approvalState.policy_evidence, {
      source: "claude_transcript",
      kind: "run_command",
      command_sha256: commandSha256,
      evidence_fingerprint:
        monitoredParsed.message.metadata.approval_candidate.policy_evidence
          .evidence_fingerprint,
      request_id: "toolu_cli_hookless_approval"
    });
    assert.deepEqual(monitoredParsed.message.metadata.approval_candidate, {
      agent: "claude",
      kind: "run_command",
      tool_name: "Bash",
      request_detail: `Verified local Bash request (sha256:${commandSha256.slice(0, 12)})`,
      cwd: workspace,
      fingerprint: approvalFingerprint,
      terminal_target: terminalTarget,
      decision_mode: "keys",
      command_source: "executor_local",
      policy_evidence: approvalState.policy_evidence
    });
    const callbackCall = readJsonLines(openclawCallsPath).at(-1);
    const callbackParamsIndex = callbackCall.args.indexOf("--params");
    assert.notEqual(callbackParamsIndex, -1);
    const callbackParams = JSON.parse(callbackCall.args[callbackParamsIndex + 1]);
    assert.equal(callbackParams.message.metadata.approval_fingerprint, approvalFingerprint);
    assert.equal(callbackParams.message.metadata.approval_candidate.decision_mode, "keys");
    assert.match(
      callbackParams.message.body,
      /personally inspect the live tmux pane claude-work:0\.0/u
    );
    assert.match(
      callbackParams.message.body,
      /do not approve from the summary alone/u
    );
    assert.equal(
      callbackParams.message.body.includes(
        `- turn_id: ${conversation.conversation_id}`
      ),
      true
    );
    assert.doesNotMatch(
      callbackParams.message.body,
      /expected_approval_fingerprint|conversation_id:/u
    );
    assert.deepEqual(
      callbackParams.message.metadata.terminal_status.approval_state.keys,
      ["C-m"]
    );
    for (const serialized of [
      JSON.stringify(monitoredParsed.message),
      JSON.stringify(callbackParams),
      fs.readFileSync(conversation.state_path, "utf8"),
      fs.readFileSync(conversation.event_log_path, "utf8")
    ]) {
      assert.equal(
        serialized.includes(pendingCommand),
        false,
        "raw transcript commands must not leave the local approval executor"
      );
    }
    assert.equal(controlMCount(), 0);

    const wrongPolicy = {
      enabled: true,
      rules: [{
        id: "hookless-claude-wrong-command",
        agents: ["claude"],
        workspaces: [workspace],
        commands: [["npm", "test"]]
      }]
    };
    const rejected = await runAgentCliInProcess([
      "approve",
      "--state",
      conversation.state_path,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--auto-approved",
      "--auto-approval-policy-json",
      JSON.stringify(wrongPolicy),
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
    const rejectedParsed = JSON.parse(rejected.stdout);
    assert.equal(rejectedParsed.approved, false);
    assert.match(rejectedParsed.reason, /executor-side auto-approval policy rejected/u);
    assert.equal(controlMCount(), 0, "an unmatched Claude rule must send no key");

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
    const uncertainReplay = await runAgentCliInProcess([
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

    const safePolicy = {
      enabled: true,
      rules: [{
        id: "hookless-claude-test",
        agents: ["claude"],
        workspaces: [workspace],
        commands: [["npm", "test", "--", "--runInBand"]]
      }]
    };
    const autoApproved = await runAgentCliInProcess([
      "approve",
      "--state",
      conversation.state_path,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--auto-approved",
      "--auto-approval-policy-json",
      JSON.stringify(safePolicy),
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(autoApproved.status, 0, autoApproved.stderr || autoApproved.stdout);
    const autoApprovedParsed = JSON.parse(autoApproved.stdout);
    assert.equal(autoApprovedParsed.approved, true);
    assert.equal(autoApprovedParsed.auto_approved, true);
    assert.equal(autoApprovedParsed.decision_mode, "keys");
    assert.equal(autoApprovedParsed.key, "C-m");
    assert.deepEqual(autoApprovedParsed.keys, ["C-m"]);
    assert.equal(autoApprovedParsed.approval_fingerprint, approvalFingerprint);
    assert.equal(autoApprovedParsed.policy_rule_id, "hookless-claude-test");
    assert.equal(typeof autoApprovedParsed.policy_fingerprint, "string");
    assert.equal(
      controlMCount(),
      1,
      "a matching verified Claude rule must submit exactly one C-m"
    );
    const approvedState = JSON.parse(fs.readFileSync(conversation.state_path, "utf8"));
    assert.equal(
      approvedState.native_session_takeover.terminal_bridge_approval_dispatch,
      undefined
    );
    assert.equal(
      approvedState.native_session_takeover.terminal_bridge_last_approval_fingerprint,
      approvalFingerprint
    );
    assert.equal(
      fs.readFileSync(conversation.state_path, "utf8").includes(pendingCommand),
      false
    );
    assert.equal(
      fs.readFileSync(conversation.event_log_path, "utf8").includes(pendingCommand),
      false
    );

    const replay = await runAgentCliInProcess([
      "approve",
      "--state",
      conversation.state_path,
      "--store-dir",
      storeDir,
      "--expected-approval-fingerprint",
      approvalFingerprint,
      "--auto-approved",
      "--auto-approval-policy-json",
      JSON.stringify(safePolicy),
      "--disable-terminal-bridge-monitor",
      ...claudeAgentArgs
    ], testEnv);
    assert.equal(replay.status, 0, replay.stderr || replay.stdout);
    const replayParsed = JSON.parse(replay.stdout);
    assert.equal(replayParsed.approved, false);
    assert.equal(replayParsed.already_approved, true);
    assert.equal(controlMCount(), 1, "a consumed fingerprint must never replay C-m");
    assert.equal(
      eventCount(conversation.event_log_path, "terminal_approval_send"),
      1
    );
    assert.equal(
      readJsonLines(conversation.event_log_path)
        .filter((event) =>
          event.event === "terminal_auto_approval_decision" &&
          event.action === "approved"
        ).length,
      1
    );

    const closedStatePath = writeConversationClone(
      storeDir,
      monitoredParsed.conversation,
      "claude-hookless-closed",
      (state) => ({ ...state, status: "closed" })
    );
    const closedReplay = await runAgentCliInProcess([
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

test("hookless Claude Gateway auto approval keeps the original monitor through completion", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-autoapprove-handoff-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "claude-autoapprove:0.0";
  const claudePid = 42301;
  const claudeSessionId = "55555555-5555-4555-8555-555555555555";
  const request = "Remove the exact handoff fixture";
  const command = `rm ${path.join(workspace, ".akk-autoapprove-handoff")}`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-autoapprove\t0\t0\t999\tnode\t${workspace}\n`
    );
    const task = await startManagedClaudeTerminalTask({
      fakeBinDir,
      workspace,
      storeDir,
      claudeHome,
      terminalTarget,
      claudePid,
      claudeSessionId,
      message: request
    });
    fs.writeFileSync(tmuxCallsPath, "");

    const storedConversation = JSON.parse(
      fs.readFileSync(task.statePath, "utf8")
    );
    const anchor =
      storedConversation.native_session_takeover.claude_transcript_anchor;
    const promptAt = new Date(
      Date.parse(anchor.captured_at) + 100
    ).toISOString();
    const completedAt = new Date(
      Date.parse(promptAt) + 200
    ).toISOString();
    const projectDirectory = path.join(
      claudeHome,
      "projects",
      workspace.replace(/[^A-Za-z0-9]/gu, "-")
    );
    fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
    const transcriptPath = path.join(
      projectDirectory,
      `${claudeSessionId}.jsonl`
    );
    const promptUuid = "00000000-0000-4000-8000-000000000601";
    const thinkingUuid = "00000000-0000-4000-8000-000000000602";
    const toolUuid = "00000000-0000-4000-8000-000000000603";
    const resultUuid = "00000000-0000-4000-8000-000000000604";
    const finalUuid = "00000000-0000-4000-8000-000000000605";
    const durationUuid = "00000000-0000-4000-8000-000000000606";
    const assistantMessageId =
      "00000000-0000-4000-8000-000000000607";
    const toolUseId = "toolu_autoapprove_handoff";
    const transcriptBase = (
      uuid: string,
      parentUuid: string | null,
      timestamp: string
    ) => ({
      uuid,
      parentUuid,
      isSidechain: false,
      entrypoint: "cli",
      timestamp,
      cwd: workspace,
      sessionId: claudeSessionId,
      version: "2.1.218"
    });
    const pendingRecords = [
      {
        ...transcriptBase(promptUuid, null, promptAt),
        type: "user",
        promptId: "00000000-0000-4000-8000-000000000608",
        message: { role: "user", content: request }
      },
      {
        ...transcriptBase(thinkingUuid, promptUuid, promptAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: assistantMessageId,
          stop_reason: "tool_use",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...transcriptBase(toolUuid, thinkingUuid, promptAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: assistantMessageId,
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: toolUseId,
            name: "Bash",
            input: { command }
          }]
        }
      }
    ];
    const completionRecords = [
      {
        ...transcriptBase(resultUuid, toolUuid, completedAt),
        type: "user",
        sourceToolAssistantUUID: toolUuid,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: ""
          }]
        }
      },
      {
        ...transcriptBase(finalUuid, resultUuid, completedAt),
        type: "assistant",
        message: {
          role: "assistant",
          id: "00000000-0000-4000-8000-000000000609",
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "AKK auto-approval handoff completed."
          }]
        }
      },
      {
        ...transcriptBase(durationUuid, finalUuid, completedAt),
        type: "system",
        subtype: "turn_duration",
        durationMs: 200
      }
    ];
    fs.writeFileSync(
      transcriptPath,
      pendingRecords.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 }
    );
    const approvalScreen = currentClaudeApprovalScreenForTest(command);
    fs.writeFileSync(screenPath, approvalScreen);
    const autoApprovalPolicy = {
      enabled: true,
      rules: [{
        id: "claude-handoff-exact",
        agents: ["claude"],
        workspaces: [workspace],
        commands: [["rm", path.join(workspace, ".akk-autoapprove-handoff")]]
      }]
    };
    writeAutoApprovingFakeOpenClaw({
      fakeBinDir,
      callsPath: openclawCallsPath,
      statePath: task.statePath,
      cliPath: binPath,
      claudeHome,
      claudeAgents: [
        claudeAgentRow(claudePid, claudeSessionId, workspace)
      ],
      policy: autoApprovalPolicy,
      screenPath,
      transcriptPath,
      toolResultAppend: `${JSON.stringify(completionRecords[0])}\n`,
      completionAppend:
        completionRecords
          .slice(1)
          .map((record) => JSON.stringify(record))
          .join("\n") +
        "\n"
    });

    const monitor = await runAgentCliAsync([
      "monitor",
      "--terminal-bridge",
      "--state",
      task.statePath,
      "--log",
      task.logPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([
        claudeAgentRow(claudePid, claudeSessionId, workspace)
      ])
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    }, 20_000);
    assert.equal(monitor.status, 0, monitor.stderr || monitor.stdout);
    const monitorResult = JSON.parse(monitor.stdout);
    assert.equal(monitorResult.delivered, true);
    assert.equal(monitorResult.message.type, "done");
    assert.equal(
      monitorResult.message.body,
      "AKK auto-approval handoff completed."
    );
    assert.equal(monitorResult.conversation.status, "idle");
    assert.equal(typeof monitorResult.conversation.idle_since, "string");

    const tmuxCalls = readJsonLines(tmuxCallsPath);
    assert.equal(
      tmuxCalls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[3] === "C-m"
      ).length,
      1
    );
    const events = readJsonLines(task.logPath);
    const approvalScreenDigest = createHash("sha256")
      .update(approvalScreen)
      .digest("hex");
    const approvalNotification = events.find((event) =>
      event.event === "terminal_bridge_approval_notification_recorded"
    );
    assert.equal(
      approvalNotification?.screen_digest,
      approvalScreenDigest
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_approval_notification_recorded"
      ).length,
      1
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_monitor_continued_after_approval"
      ).length,
      1
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_monitor_reused" &&
        event.reason === "approval_resolved"
      ).length,
      1,
      "the nested approval must detect and reuse the callback-delivering monitor"
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_completion_detected"
      ).length,
      1
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_monitor_launch" &&
        event.reason === "approval_resolved"
      ).length,
      0,
      "Gateway auto-approval must reuse the callback-delivering monitor"
    );
    assert.equal(
      events.filter((event) =>
        event.event === "terminal_bridge_approval_detected"
      ).length,
      1,
      "the consumed prompt must not create another approval callback before repaint"
    );
    const finalState = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(
      finalState.native_session_takeover
        .terminal_bridge_last_approval_screen_digest,
      approvalScreenDigest
    );
    assert.equal(
      finalState.response_rounds_used,
      storedConversation.response_rounds_used + 1,
      "the unchanged consumed prompt must not spend another response round"
    );
    const gatewayMessages = readJsonLines(openclawCallsPath)
      .filter((entry) => entry.kind === "gateway")
      .map((entry) => {
        const paramsIndex = entry.args.indexOf("--params");
        return JSON.parse(entry.args[paramsIndex + 1]).message;
      });
    assert.deepEqual(
      gatewayMessages.map((message) => message.type),
      ["question", "done"]
    );

    const approvalCallbackMessage = gatewayMessages[0];
    const claudeAgents = [
      claudeAgentRow(claudePid, claudeSessionId, workspace)
    ];
    writeFakeClaudeAgents(fakeBinDir, claudeAgents);
    const pendingTranscript = pendingRecords
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n";
    const secondToolUuid = "00000000-0000-4000-8000-000000000610";
    const secondResultUuid = "00000000-0000-4000-8000-000000000611";
    const sequentialFinalUuid = "00000000-0000-4000-8000-000000000612";
    const sequentialDurationUuid =
      "00000000-0000-4000-8000-000000000613";
    const secondToolUseId = "toolu_autoapprove_handoff_second";
    const secondToolAt = new Date(
      Date.parse(completedAt) + 100
    ).toISOString();
    const secondResultAt = new Date(
      Date.parse(secondToolAt) + 100
    ).toISOString();
    const sequentialCompletedAt = new Date(
      Date.parse(secondResultAt) + 100
    ).toISOString();
    const secondToolRecord = {
      ...transcriptBase(secondToolUuid, resultUuid, secondToolAt),
      type: "assistant",
      message: {
        role: "assistant",
        id: "00000000-0000-4000-8000-000000000614",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: secondToolUseId,
          name: "Bash",
          input: { command }
        }]
      }
    };
    const secondResultRecord = {
      ...transcriptBase(
        secondResultUuid,
        secondToolUuid,
        secondResultAt
      ),
      type: "user",
      sourceToolAssistantUUID: secondToolUuid,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: secondToolUseId,
          content: ""
        }]
      }
    };
    const sequentialCompletionRecords = [
      {
        ...transcriptBase(
          sequentialFinalUuid,
          secondResultUuid,
          sequentialCompletedAt
        ),
        type: "assistant",
        message: {
          role: "assistant",
          id: "00000000-0000-4000-8000-000000000615",
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "AKK sequential auto-approvals completed."
          }]
        }
      },
      {
        ...transcriptBase(
          sequentialDurationUuid,
          sequentialFinalUuid,
          sequentialCompletedAt
        ),
        type: "system",
        subtype: "turn_duration",
        durationMs: 400
      }
    ];
    const sequentialStatePath = writeConversationClone(
      storeDir,
      storedConversation,
      "claude-autoapprove-sequential-identities",
      (state) => {
        const {
          callback_delivery: _callbackDelivery,
          ...withoutCallback
        } = state;
        return {
          ...withoutCallback,
          status: "waiting_for_agent"
        };
      }
    );
    const terminalDispatchLedgerPath = findTerminalDispatchLedgerPath(
      task.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const assignTerminalDispatchOwner = (statePath: string) => {
      const ownerState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const messageId =
        ownerState.native_session_takeover.terminal_bridge_message_id;
      const ledger = JSON.parse(
        fs.readFileSync(terminalDispatchLedgerPath, "utf8")
      );
      delete ledger.resolved_at;
      delete ledger.reason;
      fs.writeFileSync(
        terminalDispatchLedgerPath,
        `${JSON.stringify({
          ...ledger,
          status: "submitted",
          generation_id: messageId,
          conversation_id: ownerState.conversation_id,
          session_id: ownerState.session_id,
          turn_id: ownerState.turn_id,
          state_path: statePath,
          event_log_path: path.join(path.dirname(statePath), "events.ndjson"),
          message_id: messageId,
          terminal_submission_receipts: [],
          submitted_at: new Date().toISOString()
        }, null, 2)}\n`
      );
    };
    assignTerminalDispatchOwner(sequentialStatePath);
    const sequentialLogPath = path.join(
      path.dirname(sequentialStatePath),
      "events.ndjson"
    );
    const redrawnFirstScreen = `\n${approvalScreen}`;
    const clearedScreen = "✻ Running approved command…\n";
    fs.writeFileSync(transcriptPath, pendingTranscript, { mode: 0o600 });
    fs.writeFileSync(screenPath, approvalScreen);
    const sequentialCallsStart = readJsonLines(openclawCallsPath).length;
    const sequentialEnterStart = readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[3] === "C-m"
      ).length;
    writeSequentialAutoApprovingFakeOpenClaw({
      fakeBinDir,
      callsPath: openclawCallsPath,
      statePath: sequentialStatePath,
      cliPath: binPath,
      claudeHome,
      claudeAgents,
      policy: autoApprovalPolicy,
      screenPath,
      transcriptPath,
      firstRequestId: toolUseId,
      secondRequestId: secondToolUseId,
      firstSchedulePath: path.join(tempDir, "sequential-first-scheduled"),
      secondSchedulePath: path.join(tempDir, "sequential-second-scheduled"),
      promptClearedLogPath: sequentialLogPath,
      redrawnFirstScreen,
      clearedScreen,
      repeatedApprovalScreen: approvalScreen,
      firstResultAppend: `${JSON.stringify(completionRecords[0])}\n`,
      secondRequestAppend: `${JSON.stringify(secondToolRecord)}\n`,
      secondResultAppend: `${JSON.stringify(secondResultRecord)}\n`,
      completionAppend:
        sequentialCompletionRecords
          .map((record) => JSON.stringify(record))
          .join("\n") +
        "\n"
    });
    const sequentialMonitor = await runAgentCliAsync([
      "monitor",
      "--terminal-bridge",
      "--state",
      sequentialStatePath,
      "--log",
      sequentialLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify(claudeAgents)
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    }, 20_000);
    assert.equal(
      sequentialMonitor.status,
      0,
      sequentialMonitor.stderr || sequentialMonitor.stdout
    );
    const sequentialResult = JSON.parse(sequentialMonitor.stdout);
    assert.equal(sequentialResult.message.type, "done");
    assert.equal(
      sequentialResult.message.body,
      "AKK sequential auto-approvals completed."
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args[3] === "C-m"
        ).length,
      sequentialEnterStart + 2,
      "a redraw of the first request must not replay Enter, while the second request must approve once"
    );
    const sequentialCalls = readJsonLines(openclawCallsPath)
      .slice(sequentialCallsStart);
    const sequentialQuestions = sequentialCalls
      .filter((entry) => entry.kind === "gateway")
      .map((entry) => {
        const paramsIndex = entry.args.indexOf("--params");
        return JSON.parse(entry.args[paramsIndex + 1]).message;
      })
      .filter((message) =>
        message.metadata?.reason === "approval_required"
      );
    assert.deepEqual(
      sequentialQuestions.map((message) =>
        message.metadata.approval_candidate.policy_evidence.request_id
      ),
      [toolUseId, secondToolUseId],
      "a changed render of one transcript request must stay consumed, while a new transcript request may reuse the original screen"
    );
    const sequentialEvents = readJsonLines(sequentialLogPath);
    const sequentialApprovalIndexes = sequentialEvents
      .map((event, index) =>
        event.event === "terminal_bridge_approval_detected" ? index : -1
      )
      .filter((index) => index >= 0);
    const promptClearedIndex = sequentialEvents.findIndex((event) =>
      event.event === "terminal_bridge_approval_prompt_cleared"
    );
    assert.equal(sequentialApprovalIndexes.length, 2);
    assert.ok(
      promptClearedIndex > sequentialApprovalIndexes[0] &&
      promptClearedIndex < sequentialApprovalIndexes[1],
      "the monitor must observe a cleared prompt generation before the repeated screen becomes a new request"
    );
    const sequentialState = JSON.parse(
      fs.readFileSync(sequentialStatePath, "utf8")
    );
    assert.equal(
      sequentialState.native_session_takeover
        .terminal_bridge_last_approval_request_id,
      secondToolUseId
    );
    assert.equal(
      typeof sequentialState.native_session_takeover
        .terminal_bridge_last_approval_evidence_fingerprint,
      "string"
    );
    for (const nestedApproval of sequentialCalls.filter((entry) =>
      entry.kind === "nested_approve"
    )) {
      await waitForPidExit(
        JSON.parse(nestedApproval.stdout).monitor_handoff_pid
      );
    }

    const callbackDeliveryForRetry = (state: any) => ({
      status: "failed",
      message: {
        ...approvalCallbackMessage,
        conversation_id: state.conversation_id
      },
      attempts: 1,
      attempt_id: "dead-approval-callback-attempt",
      attempt_pid: 2_147_483_000,
      created_at: approvalCallbackMessage.ts,
      last_attempt_at: approvalCallbackMessage.ts,
      gateway_method: state.gateway_method,
      gateway_session: state.gateway_session,
      gateway_url: state.gateway_url,
      openclaw_bin: state.openclaw_bin,
      close_terminal_bridge_on_done: false,
      track_delivery: true,
      final_status: "waiting_for_openclaw",
      preserve_conversation_status: true,
      kind: "approval_notification",
      last_error: "simulated monitor crash before Gateway settlement"
    });
    const writeApprovalMessageEvent = (logPath: string, message: any) => {
      fs.writeFileSync(logPath, `${JSON.stringify({
        ts: message.ts,
        conversation_id: message.conversation_id,
        event: "message",
        from: message.from,
        to: message.to,
        type: message.type,
        requires_response: message.requires_response,
        round: message.round,
        body: message.body,
        message
      })}\n`, { mode: 0o600 });
    };
    const configureRetryGateway = (statePath: string) => {
      writeAutoApprovingFakeOpenClaw({
        fakeBinDir,
        callsPath: openclawCallsPath,
        statePath,
        cliPath: binPath,
        claudeHome,
        claudeAgents,
        policy: autoApprovalPolicy,
        screenPath,
        transcriptPath,
        toolResultAppend: `${JSON.stringify(completionRecords[0])}\n`,
        completionAppend:
          completionRecords
            .slice(1)
            .map((record) => JSON.stringify(record))
            .join("\n") +
          "\n"
      });
    };
    const retryBeforeApprovalStoreDir = path.join(
      tempDir,
      "retry-before-approval-store"
    );
    const crashAfterDeliveryStatePath = writeConversationClone(
      storeDir,
      storedConversation,
      "claude-autoapprove-crash-after-delivery",
      (state) => {
        const {
          callback_delivery: _callbackDelivery,
          ...withoutCallback
        } = state;
        return {
          ...withoutCallback,
          status: "waiting_for_agent"
        };
      }
    );
    const crashAfterDeliveryLogPath = path.join(
      path.dirname(crashAfterDeliveryStatePath),
      "events.ndjson"
    );
    assignTerminalDispatchOwner(crashAfterDeliveryStatePath);
    fs.writeFileSync(transcriptPath, pendingTranscript, { mode: 0o600 });
    fs.writeFileSync(screenPath, approvalScreen);
    configureRetryGateway(crashAfterDeliveryStatePath);
    const callsBeforeCrashAfterDelivery =
      readJsonLines(openclawCallsPath).length;
    const enterCountBeforeCrashAfterDelivery = readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[3] === "C-m"
      ).length;
    const crashedAfterDelivery = await runAgentCliAsync([
      "monitor",
      "--terminal-bridge",
      "--state",
      crashAfterDeliveryStatePath,
      "--log",
      crashAfterDeliveryLogPath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "120",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify(claudeAgents)
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_EXIT_AFTER_APPROVAL_CALLBACK_DELIVERED: "1"
    }, 20_000);
    assert.equal(
      crashedAfterDelivery.status,
      86,
      crashedAfterDelivery.stderr || crashedAfterDelivery.stdout
    );
    await waitForCondition(
      () => {
        try {
          const state = JSON.parse(
            fs.readFileSync(crashAfterDeliveryStatePath, "utf8")
          );
          return state.status === "idle" &&
            state.callback_delivery?.status === "delivered" &&
            state.callback_delivery?.message?.type === "done";
        } catch {
          return false;
        }
      },
      "handoff watchdog to replace a monitor and deliver completion after callback delivery",
      15_000
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args[3] === "C-m"
        ).length,
      enterCountBeforeCrashAfterDelivery + 1,
      "handoff recovery must never replay the approval key"
    );
    const crashAfterDeliveryEvents = readJsonLines(
      crashAfterDeliveryLogPath
    );
    const approvalDeliverySettledIndex =
      crashAfterDeliveryEvents.findIndex((event) =>
        event.event === "callback_delivery_succeeded" &&
        event.message_id !== undefined &&
        event.status === "waiting_for_agent"
      );
    const forcedExitIndex = crashAfterDeliveryEvents.findIndex((event) =>
      event.event ===
        "terminal_bridge_test_exit_after_approval_callback_delivered"
    );
    const handoffLaunchIndex = crashAfterDeliveryEvents.findIndex((event) =>
      event.event === "terminal_bridge_monitor_launch" &&
      event.reason === "approval_handoff_reconciliation"
    );
    assert.ok(
      approvalDeliverySettledIndex >= 0 &&
      forcedExitIndex > approvalDeliverySettledIndex,
      "the failpoint must exit only after the approval callback is durable"
    );
    assert.ok(
      handoffLaunchIndex > forcedExitIndex,
      "the detached handoff watchdog must launch the replacement after owner loss"
    );
    assert.equal(
      crashAfterDeliveryEvents.filter((event) =>
        event.event === "terminal_bridge_monitor_continued_after_approval"
      ).length,
      0,
      "the forced exit must happen before the original monitor continues"
    );
    assert.equal(
      crashAfterDeliveryEvents.filter((event) =>
        event.event === "terminal_bridge_monitor_reused" &&
        event.reason === "approval_resolved"
      ).length,
      1
    );
    assert.equal(
      crashAfterDeliveryEvents.filter((event) =>
        event.event ===
          "terminal_bridge_monitor_handoff_watchdog_started"
      ).length,
      1,
      "one state/message handoff watchdog must own recovery"
    );
    const crashAfterDeliveryCalls = readJsonLines(openclawCallsPath)
      .slice(callsBeforeCrashAfterDelivery);
    assert.deepEqual(
      crashAfterDeliveryCalls
        .filter((entry) => entry.kind === "gateway")
        .map((entry) => {
          const paramsIndex = entry.args.indexOf("--params");
          return JSON.parse(entry.args[paramsIndex + 1]).message.type;
        }),
      ["question", "done"]
    );
    const crashNestedApproval = crashAfterDeliveryCalls.find(
      (entry) => entry.kind === "nested_approve"
    );
    assert.ok(crashNestedApproval);
    const crashApproval = JSON.parse(crashNestedApproval.stdout);
    assert.equal(crashApproval.approved, true);
    assert.ok(Number(crashApproval.monitor_handoff_pid) > 1);
    const replacementLaunch = crashAfterDeliveryEvents.find((event) =>
      event.event === "terminal_bridge_monitor_launch" &&
      event.reason === "approval_handoff_reconciliation"
    );
    await waitForPidExit(crashApproval.monitor_handoff_pid);
    await waitForPidExit(Number(replacementLaunch?.pid));

    const retryBeforeApprovalStatePath = writeConversationClone(
      retryBeforeApprovalStoreDir,
      storedConversation,
      storedConversation.conversation_id,
      (state) => ({
        ...state,
        status: "waiting_for_openclaw",
        response_rounds_used: approvalCallbackMessage.round,
        native_session_takeover: {
          ...state.native_session_takeover,
          terminal_bridge_approval: {
            fingerprint:
              approvalCallbackMessage.metadata.approval_fingerprint,
            notified_at: approvalCallbackMessage.ts,
            terminal_control:
              approvalCallbackMessage.metadata.terminal_control,
            approval_state:
              approvalCallbackMessage.metadata.terminal_status.approval_state,
            screen_digest:
              approvalCallbackMessage.metadata.terminal_status.screen.digest,
            callback_message_id: approvalCallbackMessage.id,
            callback_message_ts: approvalCallbackMessage.ts
          }
        },
        callback_delivery: callbackDeliveryForRetry(state),
        updated_at: approvalCallbackMessage.ts
      })
    );
    const retryBeforeApprovalLogPath = path.join(
      path.dirname(retryBeforeApprovalStatePath),
      "events.ndjson"
    );
    assignTerminalDispatchOwner(retryBeforeApprovalStatePath);
    fs.writeFileSync(transcriptPath, pendingTranscript, { mode: 0o600 });
    fs.writeFileSync(screenPath, approvalScreen);
    writeApprovalMessageEvent(
      retryBeforeApprovalLogPath,
      JSON.parse(fs.readFileSync(retryBeforeApprovalStatePath, "utf8"))
        .callback_delivery.message
    );
    configureRetryGateway(retryBeforeApprovalStatePath);
    const callsBeforeFirstRetry = readJsonLines(openclawCallsPath).length;
    const enterCountBeforeFirstRetry = readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[3] === "C-m"
      ).length;
    const retriedBeforeApproval = await runAgentCliAsync([
      "retry-callback",
      "--state",
      retryBeforeApprovalStatePath
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      retriedBeforeApproval.status,
      0,
      retriedBeforeApproval.stderr || retriedBeforeApproval.stdout
    );
    await waitForCondition(
      () => {
        try {
          const state = JSON.parse(
            fs.readFileSync(retryBeforeApprovalStatePath, "utf8")
          );
          return state.status === "idle" &&
            state.callback_delivery?.status === "delivered" &&
            state.callback_delivery?.message?.type === "done";
        } catch {
          return false;
        }
      },
      "replacement monitor to complete after a pre-approval callback retry"
    );
    const firstRetryCalls = readJsonLines(openclawCallsPath)
      .slice(callsBeforeFirstRetry);
    const firstRetryNested = firstRetryCalls.find(
      (entry) => entry.kind === "nested_approve"
    );
    assert.ok(firstRetryNested);
    const firstRetryApproval = JSON.parse(firstRetryNested.stdout);
    assert.equal(firstRetryApproval.approved, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args[3] === "C-m"
        ).length,
      enterCountBeforeFirstRetry + 1
    );
    const firstRetryEvents = readJsonLines(retryBeforeApprovalLogPath);
    assert.equal(
      firstRetryEvents.filter((event) =>
        event.event === "terminal_bridge_monitor_launch" &&
        event.reason === "approval_resolved"
      ).length,
      1,
      "a dead callback owner must be replaced after sending approval"
    );
    assert.deepEqual(
      firstRetryCalls
        .filter((entry) => entry.kind === "gateway")
        .map((entry) => {
          const paramsIndex = entry.args.indexOf("--params");
          return JSON.parse(entry.args[paramsIndex + 1]).message.type;
        }),
      ["question", "done"]
    );
    await waitForPidExit(firstRetryApproval.monitor_pid);

    const approvedBeforeSettlement = {
      ...firstRetryApproval.conversation,
      native_session_takeover: {
        ...firstRetryApproval.conversation.native_session_takeover,
        claude_transcript_anchor:
          storedConversation.native_session_takeover
            .claude_transcript_anchor,
        claude_home: claudeHome
      }
    };
    const retryAfterApprovalStoreDir = path.join(
      tempDir,
      "retry-after-approval-store"
    );
    const retryAfterApprovalStatePath = writeConversationClone(
      retryAfterApprovalStoreDir,
      approvedBeforeSettlement,
      storedConversation.conversation_id,
      (state) => {
        const nativeTakeover = {
          ...state.native_session_takeover
        };
        delete nativeTakeover.terminal_bridge_approval;
        delete nativeTakeover.terminal_bridge_approval_dispatch;
        return {
          ...state,
          status: "waiting_for_agent",
          response_rounds_used: approvalCallbackMessage.round,
          native_session_takeover: nativeTakeover,
          callback_delivery: callbackDeliveryForRetry(state),
          updated_at:
            nativeTakeover.terminal_bridge_approval_resolved_at
        };
      }
    );
    const retryAfterApprovalLogPath = path.join(
      path.dirname(retryAfterApprovalStatePath),
      "events.ndjson"
    );
    assignTerminalDispatchOwner(retryAfterApprovalStatePath);
    fs.writeFileSync(transcriptPath, pendingTranscript, { mode: 0o600 });
    fs.writeFileSync(screenPath, approvalScreen);
    writeApprovalMessageEvent(
      retryAfterApprovalLogPath,
      JSON.parse(fs.readFileSync(retryAfterApprovalStatePath, "utf8"))
        .callback_delivery.message
    );
    configureRetryGateway(retryAfterApprovalStatePath);
    const callsBeforeSecondRetry = readJsonLines(openclawCallsPath).length;
    const enterCountBeforeSecondRetry = readJsonLines(tmuxCallsPath)
      .filter((call) =>
        call.args[0] === "send-keys" &&
        call.args[3] === "C-m"
      ).length;
    const retriedAfterApproval = await runAgentCliAsync([
      "retry-callback",
      "--state",
      retryAfterApprovalStatePath
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      retriedAfterApproval.status,
      0,
      retriedAfterApproval.stderr || retriedAfterApproval.stdout
    );
    await waitForCondition(
      () => {
        try {
          const state = JSON.parse(
            fs.readFileSync(retryAfterApprovalStatePath, "utf8")
          );
          return state.status === "idle" &&
            state.callback_delivery?.status === "delivered" &&
            state.callback_delivery?.message?.type === "done";
        } catch {
          return false;
        }
      },
      "replacement monitor to complete after an already-consumed callback retry"
    );
    const secondRetryCalls = readJsonLines(openclawCallsPath)
      .slice(callsBeforeSecondRetry);
    const secondRetryNested = secondRetryCalls.find(
      (entry) => entry.kind === "nested_approve"
    );
    assert.ok(secondRetryNested);
    const secondRetryApproval = JSON.parse(secondRetryNested.stdout);
    assert.equal(secondRetryApproval.already_approved, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args[3] === "C-m"
        ).length,
      enterCountBeforeSecondRetry,
      "a callback replay after approval commit must not send Enter again"
    );
    const secondRetryEvents = readJsonLines(retryAfterApprovalLogPath);
    assert.equal(
      secondRetryEvents.filter((event) =>
        event.event === "terminal_bridge_monitor_launch" &&
        event.reason === "approval_already_resolved"
      ).length,
      1,
      "an already-consumed approval with no live owner must launch a monitor"
    );
    assert.deepEqual(
      secondRetryCalls
        .filter((entry) => entry.kind === "gateway")
        .map((entry) => {
          const paramsIndex = entry.args.indexOf("--params");
          return JSON.parse(entry.args[paramsIndex + 1]).message.type;
        }),
      ["question", "done"]
    );
    await waitForPidExit(secondRetryApproval.monitor_pid);

    const consumedTimeoutStatePath = writeConversationClone(
      storeDir,
      approvedBeforeSettlement,
      "claude-consumed-screen-hard-timeout",
      (state) => {
        const nativeTakeover = {
          ...state.native_session_takeover,
          terminal_bridge_started_at:
            new Date(Date.now() - 60_000).toISOString()
        };
        delete nativeTakeover.terminal_bridge_approval;
        delete nativeTakeover.terminal_bridge_approval_dispatch;
        const {
          callback_delivery: _callbackDelivery,
          ...withoutCallback
        } = state;
        return {
          ...withoutCallback,
          status: "waiting_for_agent",
          native_session_takeover: nativeTakeover,
          updated_at:
            nativeTakeover.terminal_bridge_approval_resolved_at
        };
      }
    );
    assignTerminalDispatchOwner(consumedTimeoutStatePath);
    fs.writeFileSync(transcriptPath, pendingTranscript, { mode: 0o600 });
    fs.writeFileSync(screenPath, approvalScreen);
    const consumedTimeout = await runAgentCliInProcess([
      "monitor",
      "--terminal-bridge",
      "--state",
      consumedTimeoutStatePath,
      "--log",
      path.join(path.dirname(consumedTimeoutStatePath), "events.ndjson"),
      "--poll-interval-ms",
      "20",
      "--agent-timeout-minutes",
      "60",
      "--agent-hard-timeout-minutes",
      "0.001",
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify(claudeAgents)
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      consumedTimeout.status,
      0,
      consumedTimeout.stderr || consumedTimeout.stdout
    );
    const consumedTimeoutParsed = JSON.parse(consumedTimeout.stdout);
    assert.equal(consumedTimeoutParsed.stalled, true);
    assert.equal(consumedTimeoutParsed.hard_timeout, true);
  } finally {
    fs.rmSync(tempDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
});

test("hookless Claude send is refused when no transcript boundary can be bound", async () => {
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

    const sent = await runAgentCliInProcess([
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
        status: "busy"
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

test("hookless Claude completion releases the same Session for a repeated request", async () => {
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
    const task = await startManagedClaudeTerminalTask({
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
      version: "2.1.218"
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
    assert.equal(delivered[0].conversation.status, "idle");
    assert.equal(typeof delivered[0].conversation.idle_since, "string");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
    assert.equal(
      eventCount(task.logPath, "terminal_bridge_completion_detected"),
      1
    );

    const firstTurn = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.equal(firstTurn.status, "idle");
    assert.equal(
      firstTurn.native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted"
    );
    fs.writeFileSync(tmuxCallsPath, "");
    const repeated = await runAgentCliInProcess([
      "send",
      "--session",
      String(task.conversation.session_id),
      "--message",
      request,
      "--message-id",
      `msg-openclaw-${"b".repeat(64)}`,
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
      "--claude-home",
      claudeHome,
      ...staticArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
    const repeatedOutput = JSON.parse(repeated.stdout);
    assert.equal(repeatedOutput.delivered, true);
    assert.equal(repeatedOutput.session_id, task.conversation.session_id);
    assert.notEqual(repeatedOutput.turn_id, task.conversation.turn_id);
    assert.equal(
      repeatedOutput.conversation.native_session_takeover
        .terminal_bridge_submission.status,
      "agent_accepted"
    );
    assert.equal(
      repeatedOutput.conversation.native_session_takeover
        .terminal_bridge_submission.message_body_hash,
      firstTurn.native_session_takeover.terminal_bridge_submission
        .message_body_hash,
      "the fresh Claude Turn must carry the same request hash"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(task.statePath, "utf8"))
        .native_session_takeover.terminal_bridge_submission.status,
      "agent_accepted",
      "the released Turn keeps its append-only native acceptance proof"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("rejected managed Claude send leaves callback state and event log unchanged", async () => {
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

    const sent = await runAgentCliInProcess([
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
    const monitored = await runAgentCliInProcess([
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

    const rejected = await runAgentCliInProcess([
      "send",
      "--session",
      conversation.session_id,
      "--store-dir",
      storeDir,
      "--message",
      rejectedMessage,
      "--disable-terminal-bridge-monitor",
      ...staticArgs
    ], testEnv);
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /terminal .* still has unresolved Turn .* \(waiting_for_openclaw\)/u
    );

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
