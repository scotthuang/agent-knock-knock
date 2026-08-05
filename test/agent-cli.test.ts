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
} from "../src/store.js";
import {
  listManagedSessions,
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "../src/session-store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-agent-cli-runtime-")
);
const cwd = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-agent-cli-workspace-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
const sessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
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
      /do not approve from the hash or summary alone/u
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
    const rejected = runAgentCli([
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

    const replay = runAgentCli([
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
          conversation_id: ownerState.conversation_id,
          state_path: statePath,
          message_id:
            ownerState.native_session_takeover.terminal_bridge_message_id,
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
          return JSON.parse(
            fs.readFileSync(crashAfterDeliveryStatePath, "utf8")
          ).status === "idle";
        } catch {
          return false;
        }
      },
      "handoff watchdog to replace a monitor that exited after callback delivery",
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
    const retriedBeforeApproval = runAgentCli([
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
          return JSON.parse(
            fs.readFileSync(retryBeforeApprovalStatePath, "utf8")
          ).status === "idle";
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
    const retriedAfterApproval = runAgentCli([
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
          return JSON.parse(
            fs.readFileSync(retryAfterApprovalStatePath, "utf8")
          ).status === "idle";
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
    const consumedTimeout = runAgentCli([
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
      /already has active turn|verified idle terminal|permission dialog|still owned by active AKK conversation/u
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

test("managed terminal send cannot overwrite a concurrent terminal cancellation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-send-cancel-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxSession = `akk-send-cancel-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: terminalTarget,
      socket_path: null
    }))
    .digest("hex")
    .slice(0, 20);
  const terminalLockPath = path.join(
    tempDir,
    ".akk-cli-test-runtime",
    "terminal-locks",
    `terminal-bridge-send-${terminalKey}.lock`
  );
  const racedMessage = "This prepared message must never reach tmux";
  const codexIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c450",
    processUuid: "codex-send-cancel-process",
    rolloutPath: path.join(tempDir, "codex-send-cancel-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
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
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const turnId = managedParsed.conversation.turn_id;
    const statePath = managedParsed.conversation.state_path;
    const waitingState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(waitingState, null, 2)}\n`);
    const initialRounds = waitingState.response_rounds_used;
    const initialStateRaw = fs.readFileSync(statePath, "utf8");
    fs.writeFileSync(tmuxCallsPath, "");

    fs.mkdirSync(path.dirname(terminalLockPath), { recursive: true });
    fs.writeFileSync(
      terminalLockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "send-cancel-race-owner",
        created_at: new Date().toISOString()
      })}\n`,
      { mode: 0o600 }
    );

    let cancelSettled = false;
    const cancelling = runAgentCliAsync([
      "cancel",
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs
    ], testEnv).finally(() => {
      cancelSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(cancelSettled, false, "cancel must wait behind the gated terminal owner");

    sending = spawnAgentCliCaptured([
      "respond",
      "--turn",
      turnId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
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
    fs.rmSync(terminalLockPath, { force: true });
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
    assert.match(sendResult.stderr, /turn is cancelled|conversation is cancelled/u);

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
    fs.rmSync(terminalLockPath, { force: true });
    if (sendingStopped && sending?.child.pid) {
      try {
        process.kill(sending.child.pid, "SIGCONT");
      } catch {
        // The send process already exited.
      }
    }
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
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxSession = `akk-close-race-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const terminalLockDir = path.join(
    tempDir,
    ".akk-cli-test-runtime",
    "terminal-locks"
  );
  const racedMessage = "This message must never be sent after close";
  const codexIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c451",
    processUuid: "codex-close-race-process",
    rolloutPath: path.join(tempDir, "codex-close-race-rollout.jsonl")
  });
  let closing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let sendingStopped = false;
  let stateLockHeld = false;
  let stateLockPath = "";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
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
      ...codexIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const turnId = managedParsed.conversation.turn_id;
    const statePath = managedParsed.conversation.state_path;
    const waitingState = {
      ...JSON.parse(fs.readFileSync(statePath, "utf8")),
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(waitingState, null, 2)}\n`);
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
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
      "--reason",
      "closed during terminal mutation race"
    ], testEnv);
    await waitForCondition(() => {
      if (!fs.existsSync(terminalLockDir)) {
        return false;
      }
      const terminalLocks = fs.readdirSync(terminalLockDir)
        .filter((name) =>
          name.startsWith("terminal-bridge-send-") &&
          name.endsWith(".lock")
        );
      return terminalLocks.some((name) => {
        const owner = JSON.parse(
          fs.readFileSync(path.join(terminalLockDir, name), "utf8")
        );
        return owner.pid === closing?.child.pid;
      });
    }, "close to acquire the terminal lock before waiting for state");
    assert.equal(closing.child.exitCode, null);

    sending = spawnAgentCliCaptured([
      "respond",
      "--turn",
      turnId,
      "--message",
      racedMessage,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs,
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
    assert.match(sendResult.stderr, /turn is closed|conversation is closed/u);

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
      "--turn",
      turnId,
      "--store-dir",
      storeDir,
      ...codexIdentityArgs
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
  const workspace = path.join(tempDir, "workspace");
  const preloadPath = path.join(tempDir, "state-read-gate.cjs");
  const snapshotReadPath = path.join(tempDir, "snapshot-read");
  const snapshotReleasePath = path.join(tempDir, "snapshot-release");
  const lockAttemptPath = path.join(tempDir, "state-lock-attempted");
  let listing: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let stateLockHeld = false;
  let stateLockPath = "";

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const created = runAgentCli([
      "send",
      "--conversation",
      "terminal:v2:tmux:codex:codex-work:0.0:33389",
      "--message",
      "idle cleanup race",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:main",
      "--openclaw-session",
      "agent:test:main",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: "codex-work:0.0",
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({
        "codex-work:0.0": "› "
      })
    ]);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const parsed = JSON.parse(created.stdout);
    const statePath = parsed.conversation.state_path;
    const eventLogPath = parsed.conversation.event_log_path;
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
      "--reconcile",
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
    assert.equal(listed.reconciliation.closed, 0);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    assert.equal(
      listed.unavailable_managed_turns[0].status,
      "waiting_for_agent"
    );

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
    const approvalScreen = [
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
    ].join("\n");
    fs.writeFileSync(screenPath, "› \n");
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

    const rawConversationId =
      "terminal:v2:tmux:codex:codex-work:0.0:1234";
    const attached = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Prepare the approval request",
      "--background",
      "--disable-terminal-bridge-monitor",
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
      JSON.stringify([tmuxPane({ panePid: 999, currentPath: workspace })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.0": "› \n" })
    ]);
    assert.equal(attached.status, 0, attached.stderr || attached.stdout);
    const parsed = JSON.parse(attached.stdout);
    fs.writeFileSync(screenPath, approvalScreen);

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

    const rawStatus = runAgentCli([
      "status",
      "--conversation",
      rawConversationId
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(rawStatus.status, 0, rawStatus.stderr || rawStatus.stdout);
    const rawStatusParsed = JSON.parse(rawStatus.stdout);
    const approved = runAgentCli([
      "approve",
      "--conversation",
      rawConversationId,
      "--expected-approval-fingerprint",
      rawStatusParsed.terminal_status.approval_state.fingerprint,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(approved.status, 0, approved.stderr || approved.stdout);
    const approvedParsed = JSON.parse(approved.stdout);
    assert.equal(approvedParsed.approved, true);
    assert.equal(approvedParsed.conversation_id, rawConversationId);
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
  const codexHome = path.join(tempDir, "empty-codex-home");
  const conversationId = "terminal:tmux:codex-work:0.1:33389";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
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
      conversationId,
      "--codex-home",
      codexHome
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(status.status, 0, status.stderr || status.stdout);
    let statusParsed = JSON.parse(status.stdout);
    assert.equal(statusParsed.terminal_status.activity_state, "working");
    assert.match(statusParsed.terminal_status.activity_reason, /Working/);
    assert.equal(statusParsed.terminal_status.approval_state.blocked, false);
    assert.equal(statusParsed.confidence, "low");
    assert.match(
      statusParsed.limitations[0],
      /historical session context is unavailable/iu
    );

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

test("raw and managed Codex sends fail closed unless the locked pane is verifiably idle", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-idle-gate-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-idle-gate-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-idle-gate-process",
    rolloutPath: path.join(tempDir, "codex-idle-gate-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const baseEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const managed = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Create the managed turn",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], baseEnv);
    assert.equal(managed.status, 0, managed.stderr || managed.stdout);
    const managedParsed = JSON.parse(managed.stdout);
    const managedConversationId = managedParsed.conversation.conversation_id;
    const managedSessionId = managedParsed.conversation.session_id;
    const managedStatePath = managedParsed.conversation.state_path;
    const completedAt = new Date().toISOString();
    const managedState = JSON.parse(
      fs.readFileSync(managedStatePath, "utf8")
    );
    fs.writeFileSync(
      managedStatePath,
      `${JSON.stringify({
        ...managedState,
        status: "idle",
        idle_since: completedAt,
        updated_at: completedAt
      }, null, 2)}\n`
    );
    const managedLedgerPath = findTerminalDispatchLedgerPath(
      managedConversationId,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const managedLedger = JSON.parse(
      fs.readFileSync(managedLedgerPath, "utf8")
    );
    fs.writeFileSync(
      managedLedgerPath,
      `${JSON.stringify({
        ...managedLedger,
        status: "resolved",
        resolved_at: completedAt,
        reason: "simulated durable completion"
      }, null, 2)}\n`
    );

    const scenarios = [
      {
        name: "working",
        screen: "• Working (12s • esc to interrupt)\n\n› Steer the current task\n",
        env: {},
        expected: /Codex terminal is working, not idle/u
      },
      {
        name: "unknown",
        screen: "last command output\nno recognizable Codex TUI footer\n",
        env: {},
        expected: /Codex terminal is unknown, not idle/u
      },
      {
        name: "capture failure",
        screen: "› \n",
        env: { AKK_TEST_TMUX_CAPTURE_FAIL: "1" },
        expected: /Codex terminal status is unavailable/u
      }
    ];

    for (const scenario of scenarios) {
      fs.writeFileSync(screenPath, scenario.screen);
      const scenarioEnv = { ...baseEnv, ...scenario.env };

      for (const target of [
        { option: "--conversation", id: rawConversationId },
        { option: "--session", id: managedSessionId }
      ]) {
        fs.writeFileSync(tmuxCallsPath, "");
        const sendArgs = [
          "send",
          target.option,
          target.id,
          "--message",
          `Must not send while terminal status is ${scenario.name}`,
          "--background",
          "--store-dir",
          storeDir,
          ...nativeIdentityArgs,
          "--disable-terminal-bridge-monitor"
        ];
        const sent = runAgentCli(sendArgs, scenarioEnv);

        assert.notEqual(
          sent.status,
          0,
          `${scenario.name} ${target.id}: ${sent.stderr || sent.stdout}`
        );
        assert.match(sent.stderr, scenario.expected);
        assert.equal(
          readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
          false,
          `${scenario.name} ${target.id} must not write terminal keys`
        );
      }
    }
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

test("raw terminal send uses the target pid cwd from partial lsof output", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-partial-lsof-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const processCallsPath = path.join(tempDir, "process-calls.ndjson");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-partial-lsof-${process.pid}`;
  const targetPid = 5101;
  const panePid = 9001;
  const unrelatedPid = 7777;
  const terminalTarget = `${tmuxSession}:0.1`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: targetPid,
    sessionId,
    processUuid: "codex-partial-lsof-process",
    rolloutPath: path.join(tempDir, "codex-partial-lsof-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tzsh\t${workspace}\n`
    );
    writeTrackedFakeProcessTools({
      fakeBinDir,
      callsPath: processCallsPath,
      processes: [
        { pid: panePid, ppid: 1, command: "zsh", cwd: workspace },
        {
          pid: targetPid,
          ppid: panePid,
          command: `codex resume ${sessionId}`,
          cwd: workspace
        },
        {
          pid: unrelatedPid,
          ppid: 1,
          command: "unrelated-worker",
          cwd: path.join(tempDir, "unrelated")
        }
      ],
      lsofStatus: 1,
      lsofRows: [
        {
          command: "codex",
          pid: targetPid,
          cwd: workspace
        }
      ]
    });

    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${targetPid}`,
      "--message",
      "Verify partial lsof handling",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const processCalls = readJsonLines(processCallsPath);
    const lsofCalls = processCalls.filter((call) => call.command === "lsof");
    assert.ok(
      lsofCalls.length >= 2,
      "raw resolution and the pre-send identity gate must both verify cwd"
    );
    for (const call of lsofCalls) {
      assert.deepEqual(call.args.slice(-2), ["-p", String(targetPid)]);
      assert.equal(call.args.includes(String(unrelatedPid)), false);
      assert.equal(call.args.includes(String(panePid)), false);
    }

    const tmuxSends = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(
      tmuxSends.at(-2)?.args,
      ["send-keys", "-t", terminalTarget, "-l", "Verify partial lsof handling"]
    );
    assert.deepEqual(
      tmuxSends.at(-1)?.args,
      ["send-keys", "-t", terminalTarget, "C-m"]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw terminal send fails closed when partial lsof output omits the target pid", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-missing-lsof-cwd-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const processCallsPath = path.join(tempDir, "process-calls.ndjson");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-missing-lsof-cwd-${process.pid}`;
  const targetPid = 5201;
  const panePid = 9002;
  const unrelatedPid = 8888;
  const terminalTarget = `${tmuxSession}:0.1`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t${panePid}\tzsh\t${workspace}\n`
    );
    writeTrackedFakeProcessTools({
      fakeBinDir,
      callsPath: processCallsPath,
      processes: [
        { pid: panePid, ppid: 1, command: "zsh", cwd: workspace },
        {
          pid: targetPid,
          ppid: panePid,
          command: `codex resume ${sessionId}`,
          cwd: workspace
        },
        {
          pid: unrelatedPid,
          ppid: 1,
          command: "unrelated-worker",
          cwd: workspace
        }
      ],
      lsofStatus: 1,
      lsofRows: [
        {
          command: "worker",
          pid: unrelatedPid,
          cwd: workspace
        }
      ]
    });

    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${targetPid}`,
      "--message",
      "Must not reach tmux without a verified cwd",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /no longer available/u);
    const lsofCalls = readJsonLines(processCallsPath)
      .filter((call) => call.command === "lsof");
    assert.equal(lsofCalls.length, 1);
    assert.deepEqual(lsofCalls[0].args.slice(-2), ["-p", String(targetPid)]);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );
    assert.equal(fs.existsSync(storeDir), false);
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

test("raw terminal send requires managed background mode while cancel remains direct", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-send-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
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

    assert.notEqual(sent.status, 0);
    assert.match(sent.stderr, /raw tmux terminal sends require --background/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );

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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-background-send-process",
    rolloutPath: path.join(tempDir, "codex-background-send-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-work\t0\t1\t33389\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: 33389,
      ppid: 999,
      command: `codex resume ${sessionId}`,
      cwd: workspace
    }]);

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
      "0",
      ...nativeIdentityArgs
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
      ...nativeIdentityArgs,
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

    const statePath = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    ).statePath;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.conversation_id, sentParsed.conversation.conversation_id);
    assert.equal(typeof state.native_session_takeover.terminal_bridge_started_at, "string");
    assert.equal(state.native_session_takeover.terminal_bridge_message_id, sentParsed.message.id);
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.message_id,
      sentParsed.message.id
    );
    assert.equal(
      typeof state.native_session_takeover.terminal_bridge_submission.prepared_at,
      "string"
    );
    assert.equal(
      typeof state.native_session_takeover.terminal_bridge_submission.submitted_at,
      "string"
    );

    const events = readJsonLines(path.join(path.dirname(statePath), "events.ndjson"));
    const messageIndex = events.findIndex((event) => event.event === "message");
    const preparedIndex = events.findIndex(
      (event) => event.event === "terminal_message_submit_prepared"
    );
    const sentIndex = events.findIndex((event) => event.event === "terminal_message_send");
    assert.ok(messageIndex >= 0);
    assert.ok(preparedIndex > messageIndex);
    assert.ok(sentIndex > preparedIndex);

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
      idle_since: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(statePath, `${JSON.stringify(idleState, null, 2)}\n`);

    const listed = runAgentCli([
      "list",
      "--reconcile",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1",
      "--managed-only"
    ]);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.reconciliation.closed, 1);
    assert.deepEqual(listedParsed.unavailable_managed_turns, []);
    const closedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "idle timeout after 1 minutes");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("v0.8.1 terminal state without native identity metadata remains bound to its live pane", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-legacy-terminal-binding-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = `akk-legacy-binding-${process.pid}:0.1`;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-legacy-binding-process",
    rolloutPath: path.join(tempDir, "codex-legacy-binding-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalTarget.split(":")[0]}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Legacy managed terminal binding",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const parsed = JSON.parse(sent.stdout);
    const statePath = parsed.conversation.state_path;
    const modernState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const legacyTakeover = { ...modernState.native_session_takeover };
    delete legacyTakeover.terminal_agent_identity_protocol;
    delete legacyTakeover.terminal_agent_session_id;
    delete legacyTakeover.terminal_agent_process_uuid;
    delete legacyTakeover.terminal_agent_process_birth;
    delete legacyTakeover.terminal_agent_rollout;
    delete legacyTakeover.terminal_agent_identity_evidence;
    const {
      session_id: _sessionId,
      turn_id: _turnId,
      ...legacyIdentityState
    } = modernState;
    const idleAt = new Date().toISOString();
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...legacyIdentityState,
      status: "idle",
      idle_since: idleAt,
      updated_at: idleAt,
      native_session_takeover: legacyTakeover
    }, null, 2)}\n`);
    // Recreate the actual predecessor layout: v0.8.1 had neither first-class
    // Session state nor writer protocol 3. Keeping the modern Session beside a
    // stripped legacy Turn would be an impossible mixed-generation Store.
    fs.rmSync(storeSessionsDir(storeDir), { recursive: true, force: true });
    const manifestPath = storeManifestPath(storeDir);
    const legacyManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      ...legacyManifest,
      writer_protocol: 2
    }, null, 2)}\n`);
    const ledgerPath = findTerminalDispatchLedgerPath(
      modernState.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      ...ledger,
      status: "resolved",
      resolved_at: idleAt,
      reason: "legacy compatibility fixture"
    }, null, 2)}\n`);

    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      "--all",
      "--processes-json",
      JSON.stringify([{
        pid: 33389,
        ppid: 999,
        command: `codex resume ${sessionId}`,
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: terminalTarget.split(":")[0],
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: "› \n" }),
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.terminals.length, 1);
    const terminal = listedParsed.terminals[0];
    assert.equal(terminal.managed.session_id, modernState.conversation_id);
    assert.equal(
      terminal.managed.recent_turn.conversation_id,
      modernState.conversation_id
    );
    assert.equal(
      terminal.available_actions.send.arguments.session_id,
      modernState.conversation_id
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw Claude send fails closed when agent observation fails", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-observer-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-observer-failure:0.0";
  const claudePid = 42377;
  const claudeCallsPath = path.join(tempDir, "claude-agents-called");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "❯ ");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `claude-observer-failure\t0\t0\t999\tnode\t${workspace}\n`
    );
    writeFakeProcessTools(fakeBinDir, [{
      pid: claudePid,
      ppid: 999,
      command: "claude",
      cwd: workspace
    }]);
    const fakeClaude = path.join(fakeBinDir, "claude");
    fs.writeFileSync(
      fakeClaude,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(claudeCallsPath)}, "");
process.stderr.write("simulated agents failure\\n");
process.exit(7);
`,
      "utf8"
    );
    fs.chmodSync(fakeClaude, 0o755);
    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      "This must not reach Claude",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.notEqual(sent.status, 0);
    assert.equal(fs.existsSync(claudeCallsPath), true);
    assert.match(sent.stderr, /observation failed|no longer available/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("ordinary sends create distinct turns in one session and respond stays on its turn", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-turn-send-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = `akk-session-turn-${process.pid}:0.1`;
  const codexPid = 33389;
  const rawTerminalId = `terminal:tmux:${terminalTarget}:${codexPid}`;
  const nativeSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
  const originalProcessUuid = `codex-pid:${codexPid}:birth:original`;
  const replacementProcessUuid = `codex-pid:${codexPid}:birth:replacement`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalTarget.replace(/:\d+$/u, "").replace(/:\d+\.\d+$/u, "")}\t0\t1\t${codexPid}\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const baseCommonArgs = [
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ];
    const identityArgs = (processUuid: string) => codexNativeIdentityArgs({
      pid: codexPid,
      sessionId: nativeSessionId,
      processUuid,
      rolloutPath: path.join(tempDir, `${processUuid}.jsonl`)
    });
    const commonArgs = [
      ...baseCommonArgs,
      ...identityArgs(originalProcessUuid)
    ];

    const first = runAgentCli([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "First session turn",
      ...commonArgs
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    assert.equal(firstParsed.session_id, firstParsed.conversation.session_id);
    assert.equal(firstParsed.turn_id, firstParsed.conversation.turn_id);
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_session_id,
      nativeSessionId
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover
        .terminal_agent_identity_protocol,
      1
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_process_uuid,
      originalProcessUuid
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_process_birth,
      originalProcessUuid
    );
    assert.equal(
      firstParsed.conversation.native_session_takeover.terminal_agent_rollout.fd,
      "12r"
    );

    const firstStatePath = firstParsed.conversation.state_path;
    const firstIdle = {
      ...JSON.parse(fs.readFileSync(firstStatePath, "utf8")),
      status: "idle",
      idle_since: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    fs.writeFileSync(firstStatePath, `${JSON.stringify(firstIdle, null, 2)}\n`);

    const keysBeforeWrongType = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    const wrongType = runAgentCli([
      "send",
      "--session",
      firstParsed.session_id,
      "--type",
      "answer",
      "--message",
      "Ordinary send must not continue a Turn",
      ...commonArgs
    ], testEnv);
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stderr, /ordinary send only accepts message type task/u);
    assert.equal(
      readJsonLines(tmuxCallsPath).filter(
        (call) => call.args[0] === "send-keys"
      ).length,
      keysBeforeWrongType
    );

    const second = runAgentCli([
      "send",
      "--session",
      firstParsed.session_id,
      "--message",
      "Second session turn",
      "--agent-timeout-minutes",
      "7",
      "--agent-hard-timeout-minutes",
      "19",
      ...commonArgs
    ], testEnv);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.session_id, firstParsed.session_id);
    assert.notEqual(secondParsed.turn_id, firstParsed.turn_id);
    assert.notEqual(
      secondParsed.conversation.state_path,
      firstParsed.conversation.state_path
    );
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "idle"
    );
    assert.equal(
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      2
    );

    const entersBeforeRejectedTurn = readJsonLines(tmuxCallsPath).filter((call) =>
      call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
    ).length;
    const turnTargetRejected = runAgentCli([
      "send",
      "--session",
      firstParsed.turn_id,
      "--message",
      "A turn id must not be a send target",
      ...commonArgs
    ], testEnv);
    assert.notEqual(turnTargetRejected.status, 0);
    assert.match(
      turnTargetRejected.stderr,
      /turn .* is an execution identity, not an ordinary send target/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      entersBeforeRejectedTurn
    );

    const secondStatePath = secondParsed.conversation.state_path;
    const waitingForOpenClaw = {
      ...JSON.parse(fs.readFileSync(secondStatePath, "utf8")),
      status: "waiting_for_openclaw",
      updated_at: new Date().toISOString()
    };
    const secondLegStartedAt =
      waitingForOpenClaw.native_session_takeover.terminal_bridge_started_at;
    fs.writeFileSync(
      secondStatePath,
      `${JSON.stringify(waitingForOpenClaw, null, 2)}\n`
    );
    const keysBeforeIdentityChange = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    for (const action of ["approve", "cancel"]) {
      const fenced = runAgentCli([
        action,
        "--turn",
        secondParsed.turn_id,
        ...baseCommonArgs,
        ...identityArgs(replacementProcessUuid)
      ], testEnv);
      assert.notEqual(fenced.status, 0);
      assert.match(
        fenced.stderr,
        /native codex session identity changed|native codex process incarnation cannot be verified/u
      );
      assert.equal(
        readJsonLines(tmuxCallsPath).filter(
          (call) => call.args[0] === "send-keys"
        ).length,
        keysBeforeIdentityChange,
        `${action} must send zero terminal keys after native identity replacement`
      );
    }
    const responded = runAgentCli([
      "respond",
      "--turn",
      secondParsed.turn_id,
      "--message",
      "The requested clarification",
      ...commonArgs
    ], testEnv);
    assert.equal(responded.status, 0, responded.stderr || responded.stdout);
    const respondedParsed = JSON.parse(responded.stdout);
    assert.equal(respondedParsed.session_id, secondParsed.session_id);
    assert.equal(respondedParsed.turn_id, secondParsed.turn_id);
    assert.equal(
      respondedParsed.conversation.state_path,
      secondParsed.conversation.state_path
    );
    assert.equal(respondedParsed.message.type, "answer");
    assert.equal(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_inactivity_timeout_minutes,
      7
    );
    assert.equal(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_hard_timeout_minutes,
      19
    );
    assert.notEqual(
      respondedParsed.conversation.native_session_takeover
        .terminal_bridge_started_at,
      secondLegStartedAt,
      "respond starts a new response-leg clock while keeping the Turn identity"
    );
    assert.equal(
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).length,
      2
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) =>
        call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ).length,
      3
    );

    const incompleteIdentity = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    );
    delete incompleteIdentity.native_session_takeover.terminal_agent_rollout;
    fs.writeFileSync(
      secondStatePath,
      `${JSON.stringify(incompleteIdentity, null, 2)}\n`
    );
    const keysBeforeIncompleteIdentity = readJsonLines(tmuxCallsPath).filter(
      (call) => call.args[0] === "send-keys"
    ).length;
    const incompleteCancel = runAgentCli([
      "cancel",
      "--turn",
      secondParsed.turn_id,
      ...commonArgs
    ], testEnv);
    assert.notEqual(incompleteCancel.status, 0);
    assert.match(
      incompleteCancel.stderr,
      /native Codex session identity changed|rollout incarnation cannot be verified/iu
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter(
        (call) => call.args[0] === "send-keys"
      ).length,
      keysBeforeIncompleteIdentity,
      "an incomplete Codex rollout tuple must authorize zero terminal keys"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("virgin terminal send stalls after delivery when no exact native session can be bound", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-bind-timeout-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const target = "codex-virgin:0.0";
  const pid = 33401;
  const rawTerminalId = `terminal:v2:tmux:codex:${target}:${pid}`;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const startedAt = Date.now();
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "Start the first native session",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{ pid, ppid: 1, command: "codex", cwd: workspace }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "codex-virgin",
        window: 0,
        pane: 0,
        panePid: pid,
        currentCommand: "codex",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "› \n" }),
      "--codex-active-session-identities-json",
      "{}"
    ]);
    const elapsedMs = Date.now() - startedAt;
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const parsed = JSON.parse(sent.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.status, "delivered_unfenced");
    assert.equal(parsed.do_not_retry, true);
    assert.equal(parsed.conversation.status, "stalled");
    assert.equal(
      parsed.conversation.native_session_takeover.terminal_agent_identity_status,
      "unresolved_after_submit"
    );
    assert.equal(
      parsed.conversation.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    assert.ok(
      elapsedMs >= 1_800,
      `native identity binding window ended too early (${elapsedMs}ms)`
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("modern Claude send requires a session id and process-incarnation timestamp", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-incarnation-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const target = "claude-incarnation:0.0";
  const pid = 33402;
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const rawTerminalId = `terminal:v2:tmux:claude:${target}:${pid}`;
  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawTerminalId,
      "--message",
      "Do not trust a reusable numeric PID",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--processes-json",
      JSON.stringify([{ pid, ppid: 1, command: "claude", cwd: workspace }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "claude-incarnation",
        window: 0,
        pane: 0,
        panePid: pid,
        currentCommand: "claude",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "❯ " }),
      "--claude-agents-json",
      JSON.stringify([{ pid, cwd: workspace, sessionId }])
    ]);
    assert.notEqual(sent.status, 0);
    assert.match(
      sent.stderr,
      /native Claude process incarnation cannot be verified|process-incarnation startedAt is unavailable|no longer available/u
    );
    const stateFiles = fs.existsSync(storeConversationsDir(storeDir))
      ? fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(
            storeConversationsDir(storeDir),
            entry.name,
            "state.json"
          ))
          .filter((statePath) => fs.existsSync(statePath))
      : [];
    assert.deepEqual(
      stateFiles,
      [],
      "the incomplete Claude identity must fail before a managed Turn is persisted"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("raw background send durably prepares its terminal submission before tmux accepts it", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-prepare-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxGatePath = path.join(tempDir, "tmux-send-gate");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-submit-prepare-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-submit-prepare-process",
    rolloutPath: path.join(tempDir, "codex-submit-prepare-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );

    sending = spawnAgentCliCaptured([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Persist before sending",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_GATE_PATH: tmuxGatePath
    });

    await waitForCondition(
      () => fs.existsSync(`${tmuxGatePath}.entered`),
      "terminal submission to enter the fake tmux gate"
    );

    const conversationDirs = fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(conversationDirs.length, 1);
    const conversationDir = path.join(
      storeConversationsDir(storeDir),
      conversationDirs[0].name
    );
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    const preparedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      preparedState.native_session_takeover.terminal_bridge_submission.status,
      "prepared"
    );
    assert.equal(
      preparedState.native_session_takeover.terminal_bridge_submission.message_id,
      preparedState.native_session_takeover.terminal_bridge_message_id
    );
    assert.equal(
      typeof preparedState.native_session_takeover.terminal_bridge_submission.request_hash,
      "string"
    );
    const preparedEvents = readJsonLines(logPath);
    assert.equal(
      preparedEvents.some((event) => event.event === "terminal_message_submit_prepared"),
      true
    );
    assert.equal(
      preparedEvents.some((event) => event.event === "terminal_message_send"),
      false
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some(
        (call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m"
      ),
      false
    );

    fs.writeFileSync(`${tmuxGatePath}.release`, "");
    const result = await sending.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      submittedState.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    assert.equal(
      readJsonLines(logPath).some((event) => event.event === "terminal_message_send"),
      true
    );
  } finally {
    if (sending?.child.exitCode === null) {
      fs.writeFileSync(`${tmuxGatePath}.release`, "");
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned prepared submission becomes uncertain without terminal attribution", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-orphan-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-orphan:0.1";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-orphan-submission-process",
    rolloutPath: path.join(tempDir, "codex-orphan-submission-rollout.jsonl")
  });
  let dispatchLedgerPath: string | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(fakeBinDir, openclawCallsPath);
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `codex-orphan\t0\t1\t33389\tnode\t${workspace}\n`
    );

    const sent = runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:33389`,
      "--message",
      "Original AKK task",
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const statePath = sentParsed.conversation.state_path;
    const logPath = sentParsed.conversation.event_log_path;
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const submitted =
      submittedState.native_session_takeover.terminal_bridge_submission;
    const { submitted_at: _submittedAt, ...preparedSubmission } = submitted;
    const preparedState = {
      ...submittedState,
      native_session_takeover: {
        ...submittedState.native_session_takeover,
        terminal_bridge_submission: {
          ...preparedSubmission,
          status: "prepared",
          dispatcher_pid: 99999999
        }
      },
      updated_at: submitted.prepared_at
    };
    fs.writeFileSync(statePath, `${JSON.stringify(preparedState, null, 2)}\n`);
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const submittedLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    const { submitted_at: _ledgerSubmittedAt, ...preparedLedger } =
      submittedLedger;
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...preparedLedger,
        status: "prepared",
        dispatcher_pid: 99999999
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
    fs.writeFileSync(screenPath, [
      "A human completed an unrelated task.",
      "─ Worked for 1m ─────────────────────────────",
      "› "
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
        session: "codex-orphan",
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: fs.readFileSync(screenPath, "utf8") }),
      ...nativeIdentityArgs
    ]);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.completed, false);
    assert.equal(monitoredParsed.submission_outcome, "uncertain");
    assert.equal(monitoredParsed.do_not_retry, true);

    const uncertainState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const uncertain =
      uncertainState.native_session_takeover.terminal_bridge_submission;
    assert.equal(uncertain.status, "uncertain");
    assert.equal(typeof uncertain.uncertain_at, "string");
    assert.equal(uncertainState.updated_at, uncertain.uncertain_at);
    assert.equal(fs.existsSync(openclawCallsPath), false);
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /dispatcher_exited_before_submitted_receipt/u);
    assert.doesNotMatch(events, /terminal_bridge_completion_detected/u);
    assert.doesNotMatch(events, /terminal_bridge_approval_detected/u);
  } finally {
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a released terminal owner permits the same task text as a new Turn in its Store", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-submit-receipt-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxGatePath = path.join(tempDir, "tmux-send-gate");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-submit-receipt-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const request = "Do this exactly once";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-submit-receipt-process",
    rolloutPath: path.join(tempDir, "codex-submit-receipt-rollout.jsonl")
  });
  let sending: ReturnType<typeof spawnAgentCliCaptured> | undefined;
  let dispatchLedgerPath: string | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const args = [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      request,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    sending = spawnAgentCliCaptured(args, {
      ...testEnv,
      AKK_TEST_TMUX_SEND_GATE_PATH: tmuxGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${tmuxGatePath}.entered`),
      "terminal submission to enter the post-submit receipt gate"
    );

    const conversationDir = path.join(
      storeConversationsDir(storeDir),
      fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
        .find((entry) => entry.isDirectory())!.name
    );
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    fs.appendFileSync(logPath, "{invalid-event\n");
    fs.writeFileSync(`${tmuxGatePath}.release`, "");

    const result = await sending.result;
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.delivery_receipt, "submitted");
    assert.ok(parsed.bookkeeping_warning);
    fs.writeFileSync(
      logPath,
      fs.readFileSync(logPath, "utf8")
        .split(/\r?\n/u)
        .filter((line) => line !== "{invalid-event")
        .filter(Boolean)
        .map((line) => `${line}\n`)
        .join("")
    );
    const submittedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      submittedState.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      parsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const preparedLedger = JSON.parse(
      fs.readFileSync(dispatchLedgerPath, "utf8")
    );
    delete preparedLedger.submitted_at;
    fs.writeFileSync(
      dispatchLedgerPath,
      `${JSON.stringify({
        ...preparedLedger,
        status: "prepared"
      }, null, 2)}\n`
    );
    const workingScreen = [
      "• Working on the task",
      "",
      "› Steer the current task"
    ].join("\n");
    const recovered = runAgentCli([
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
      "--agent-hard-timeout-minutes",
      "0.001",
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
        session: tmuxSession,
        window: 0,
        pane: 1,
        panePid: 33389,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: workingScreen }),
      ...nativeIdentityArgs
    ], testEnv);
    assert.equal(
      recovered.status,
      0,
      recovered.stderr || recovered.stdout
    );
    assert.equal(JSON.parse(recovered.stdout).hard_timeout, true);
    assert.equal(
      JSON.parse(fs.readFileSync(dispatchLedgerPath, "utf8")).status,
      "submitted",
      "a durable submitted state must repair a prepared terminal ledger"
    );
    const entersBeforeRetry = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersBeforeRetry, 1);

    const closedAt = new Date().toISOString();
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        ...submittedState,
        status: "closed",
        closed_at: closedAt,
        close_reason: "simulated callback completion",
        updated_at: closedAt
      }, null, 2)}\n`
    );
    const retryArgs = [...args];
    const retried = runAgentCli(retryArgs, testEnv);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    const retriedParsed = JSON.parse(retried.stdout);
    assert.equal(retriedParsed.delivered, true);
    assert.notEqual(retriedParsed.replayed, true);
    assert.equal(retriedParsed.delivery_receipt, "submitted");
    assert.notEqual(
      retriedParsed.conversation.conversation_id,
      parsed.conversation.conversation_id
    );
    assert.equal(
      retriedParsed.conversation.session_id,
      parsed.conversation.session_id,
      "a released Turn must continue the native thread in its authoritative Store Session"
    );
    assert.notEqual(retriedParsed.message.id, parsed.message.id);
    assert.equal(listManagedSessions(storeDir).length, 1);
    assert.equal(listConversations(storeDir).length, 2);
    const entersAfterRetry = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersAfterRetry, 2);
  } finally {
    if (sending?.child.exitCode === null) {
      fs.writeFileSync(`${tmuxGatePath}.release`, "");
    }
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned terminal dispatch requires its exact listed generation before recovery", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-orphan-recovery-"));
  const storeDir = path.join(tempDir, "conversations");
  const retryStoreDir = path.join(tempDir, "retry-conversations");
  const runtimeDir = path.join(tempDir, ".akk-cli-test-runtime");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const terminalSession = `akk-orphan-recovery-${process.pid}`;
  const terminalTarget = `${terminalSession}:0.1`;
  const panePid = 33389;
  const rawConversationId =
    `terminal:v2:tmux:codex:${terminalTarget}:${panePid}`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${terminalSession}\t0\t1\t${panePid}\tcodex\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sent = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "Recover this dispatch safely",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const messageId = sentParsed.message.id;
    const statePath = sentParsed.conversation.state_path;
    const stateBackupPath = `${statePath}.orphaned`;
    const ledgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      runtimeDir
    );
    const staticTerminalArgs = [
      "--processes-json",
      JSON.stringify([{
        pid: panePid,
        ppid: 999,
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([tmuxPane({
        target: terminalTarget,
        session: terminalSession,
        window: 0,
        pane: 1,
        panePid,
        currentCommand: "codex",
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ [terminalTarget]: "› \n" })
    ];
    const closeArgs = [
      "close",
      "--conversation",
      rawConversationId,
      "--store-dir",
      storeDir,
      ...staticTerminalArgs
    ];

    const owned = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      messageId
    ], testEnv);
    assert.notEqual(owned.status, 0);
    assert.match(owned.stderr, /owned by AKK conversation/u);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "submitted"
    );

    fs.renameSync(statePath, stateBackupPath);
    const listed = runAgentCli([
      "list",
      "--store-dir",
      storeDir,
      ...staticTerminalArgs
    ], testEnv);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedParsed = JSON.parse(listed.stdout);
    assert.equal(listedParsed.terminals.length, 1);
    const orphaned =
      listedParsed.terminals[0].orphaned_terminal_dispatch;
    assert.equal(orphaned.message_id, messageId);
    assert.equal("commands" in listedParsed.terminals[0], false);
    assert.deepEqual(
      listedParsed.terminals[0].available_actions.close.arguments,
      {
        conversation_id: rawConversationId,
        expected_message_id: messageId
      }
    );
    assert.equal(
      listedParsed.terminals[0]
        .available_actions.close.requires_explicit_user_confirmation,
      true
    );
    assert.equal(
      orphaned.recovery,
      `/akk close ${rawConversationId} --expected-message-id ${messageId}`
    );

    const missingIdentity = runAgentCli(closeArgs, testEnv);
    assert.notEqual(missingIdentity.status, 0);
    assert.match(missingIdentity.stderr, /expected-message-id is required/u);
    const wrongIdentity = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      "wrong-generation"
    ], testEnv);
    assert.notEqual(wrongIdentity.status, 0);
    assert.match(wrongIdentity.stderr, /identity changed/u);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "submitted"
    );

    const recovered = runAgentCli([
      ...closeArgs,
      "--expected-message-id",
      messageId,
      "--reason",
      "operator inspected the pane"
    ], testEnv);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    const recoveredParsed = JSON.parse(recovered.stdout);
    assert.equal(recoveredParsed.terminal_dispatch_resolved, true);
    assert.equal(recoveredParsed.coding_agent_stopped, false);
    assert.equal(recoveredParsed.tmux_pane_closed, false);
    assert.equal(
      JSON.parse(fs.readFileSync(ledgerPath, "utf8")).status,
      "resolved"
    );

    const retried = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "A new generation after recovery",
      "--background",
      "--store-dir",
      retryStoreDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a newer raw terminal task cannot replace an active callback boundary", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-supersede-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-callback-process",
    rolloutPath: path.join(tempDir, "codex-active-callback-rollout.jsonl")
  });

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
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.doesNotMatch(
      fs.readFileSync(firstLogPath, "utf8"),
      /terminal_bridge_superseded/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    return;

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

test("durable completion must settle before a newer raw task can send", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-reconcile-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const rawConversationId = "terminal:tmux:codex-work:0.1:33389";
  const completedSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const completedRolloutPath = path.join(tempDir, "completed.jsonl");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: completedSessionId,
    processUuid: "codex-durable-reconcile-process",
    rolloutPath: completedRolloutPath
  });

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

    const baseSendArgs = [
      "send",
      "--conversation",
      rawConversationId,
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const first = runAgentCli([
      ...baseSendArgs,
      "--message",
      "First durable task"
    ], env);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;
    const stalledStatePath = writeConversationClone(
      storeDir,
      firstParsed.conversation,
      "terminal-stalled-before-durable-reconcile",
      (state) => ({
        ...state,
        status: "stalled",
        stalled_reason: "monitor timed out just before task_complete was persisted",
        updated_at: new Date().toISOString()
      })
    );
    const stalledLogPath = path.join(
      path.dirname(stalledStatePath),
      "events.ndjson"
    );

    const completedRollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "First durable task"
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The first durable task completed."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-before-replacement",
          last_agent_message: "The first durable task completed."
        }
      })
    ].join("\n");
    const second = runAgentCli([
      ...baseSendArgs,
      "--message",
      "Second task",
      "--threads-json",
      JSON.stringify([{
        id: completedSessionId,
        cwd: workspace,
        rollout_path: completedRolloutPath,
        updated_at_ms: Date.parse("2099-07-04T00:01:01.000Z"),
        archived: false
      }]),
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
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({ [completedRolloutPath]: completedRollout })
    ], env);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "waiting_for_agent"
    );
    assert.equal(fs.existsSync(openclawCallsPath), false);
    return;
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    const secondStatePath = pathsForConversation(
      secondParsed.conversation.conversation_id,
      storeDir
    ).statePath;

    const reconciledState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(reconciledState.status, "closed");
    assert.equal(reconciledState.callback_delivery.status, "delivered");
    assert.equal(reconciledState.callback_delivery.attempts, 1);
    assert.equal(reconciledState.superseded_by_conversation_id, undefined);
    const firstEvents = fs.readFileSync(firstLogPath, "utf8");
    assert.match(firstEvents, /terminal_bridge_completion_reconciled_before_supersede/);
    assert.doesNotMatch(firstEvents, /terminal_bridge_superseded/);
    assert.equal(
      JSON.parse(fs.readFileSync(secondStatePath, "utf8")).status,
      "waiting_for_agent"
    );
    const stalledState = JSON.parse(fs.readFileSync(stalledStatePath, "utf8"));
    assert.equal(stalledState.status, "closed");
    assert.equal(stalledState.callback_delivery.status, "delivered");
    assert.equal(stalledState.callback_delivery.attempts, 1);
    assert.equal(stalledState.superseded_by_conversation_id, undefined);
    assert.match(
      fs.readFileSync(stalledLogPath, "utf8"),
      /terminal_bridge_completion_reconciled_before_supersede/
    );
    assert.doesNotMatch(
      fs.readFileSync(stalledLogPath, "utf8"),
      /terminal_bridge_superseded/
    );

    await waitForCondition(
      () => JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status === "closed",
      "reconciled callback delivery",
      12_000
    );
    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.close_reason, "terminal bridge task completed");
    assert.equal(firstState.callback_delivery.status, "delivered");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    assert.equal(readJsonLines(openclawCallsPath).length, 2);

    const ambiguousRollout = (turnId: string) => [
      JSON.stringify({
        timestamp: "2099-07-04T00:02:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Second task" }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `Ambiguous completion ${turnId}`
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: `Ambiguous completion ${turnId}`
        }
      })
    ].join("\n");
    const ambiguousRolloutA = path.join(tempDir, "ambiguous-a.jsonl");
    const ambiguousRolloutB = path.join(tempDir, "ambiguous-b.jsonl");
    const third = runAgentCli([
      ...baseSendArgs,
      "--message",
      "Third task",
      "--threads-json",
      JSON.stringify([
        {
          id: "019ee559-7bb8-7fd1-970c-0f7b6978c453",
          cwd: workspace,
          rollout_path: ambiguousRolloutA,
          updated_at_ms: Date.parse("2099-07-04T00:03:01.000Z"),
          archived: false
        },
        {
          id: "019ee559-7bb8-7fd1-970c-0f7b6978c454",
          cwd: workspace,
          rollout_path: ambiguousRolloutB,
          updated_at_ms: Date.parse("2099-07-04T00:03:02.000Z"),
          archived: false
        }
      ]),
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
      JSON.stringify({ "codex-work:0.1": "› \n" }),
      "--rollouts-json",
      JSON.stringify({
        [ambiguousRolloutA]: ambiguousRollout("turn-ambiguous-a"),
        [ambiguousRolloutB]: ambiguousRollout("turn-ambiguous-b")
      })
    ], env);
    assert.equal(third.status, 0, third.stderr || third.stdout);
    const protectedSecondState = JSON.parse(
      fs.readFileSync(secondStatePath, "utf8")
    );
    assert.equal(protectedSecondState.status, "stalled");
    assert.match(
      protectedSecondState.stalled_reason,
      /newer task reused the same terminal/
    );
    assert.equal(protectedSecondState.superseded_by_conversation_id, undefined);
    const secondEvents = fs.readFileSync(
      path.join(path.dirname(secondStatePath), "events.ndjson"),
      "utf8"
    );
    assert.match(secondEvents, /terminal_bridge_pre_supersede_reconciliation_failed/);
    assert.match(secondEvents, /multiple same-cwd Codex sessions match/);
    assert.match(secondEvents, /terminal_bridge_reconciliation_fenced/);
    assert.doesNotMatch(secondEvents, /terminal_bridge_superseded/);

    const protectedMonitor = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      secondStatePath,
      "--log",
      path.join(path.dirname(secondStatePath), "events.ndjson"),
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
      JSON.stringify({
        "codex-work:0.1": [
          "› Third task",
          "The third task is complete.",
          "─ Worked for 1m ─────────────────────────────",
          "› "
        ].join("\n")
      })
    ]);
    assert.equal(
      protectedMonitor.status,
      0,
      protectedMonitor.stderr || protectedMonitor.stdout
    );
    assert.equal(
      JSON.parse(protectedMonitor.stdout).reason,
      "conversation_no_longer_waiting"
    );
    assert.equal(readJsonLines(openclawCallsPath).length, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an active dispatch blocks a replacement before tmux input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-send-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-dispatch-process",
    rolloutPath: path.join(tempDir, "codex-active-dispatch-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput);

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
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    const first = sendTask("First task");
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstPaths = pathsForConversation(
      firstParsed.conversation.conversation_id,
      storeDir
    );
    const firstStatePath = firstPaths.statePath;
    const firstLogPath = firstPaths.logPath;

    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput, "Second task");
    const second = sendTask("Second task");
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);

    const firstState = JSON.parse(fs.readFileSync(firstStatePath, "utf8"));
    assert.equal(firstState.status, "waiting_for_agent");
    assert.equal(firstState.superseded_by_conversation_id, undefined);
    const firstEvents = fs.readFileSync(firstLogPath, "utf8");
    assert.doesNotMatch(
      firstEvents,
      /terminal_bridge_stalled_by_uncertain_dispatch/u
    );
    assert.doesNotMatch(firstEvents, /terminal_bridge_superseded/u);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an active managed task blocks a follow-up before tmux input", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-managed-send-failure-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-managed-failure-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-active-managed-process",
    rolloutPath: path.join(tempDir, "codex-active-managed-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const listPanesOutput = `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
    writeFakeTmux(fakeBinDir, tmuxCallsPath, screenPath, listPanesOutput);
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const first = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "First managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const managedSessionId = firstParsed.conversation.session_id;
    const statePath = firstParsed.conversation.state_path;
    const firstMessageId =
      firstParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput,
      "Second managed task"
    );
    const second = runAgentCli([
      "send",
      "--session",
      managedSessionId,
      "--message",
      "Second managed task",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /session .* already has active turn/u);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      state.native_session_takeover.terminal_bridge_message_id,
      firstMessageId
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_request_text,
      "First managed task"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    assert.equal(
      state.native_session_takeover.terminal_bridge_submission.message_id,
      firstMessageId
    );
    assert.equal(state.status, "waiting_for_agent");
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed pre-submit setup failure restores the previous boundary and is retryable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-managed-send-abort-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-managed-abort-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-managed-abort-process",
    rolloutPath: path.join(tempDir, "codex-managed-abort-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const first = runAgentCli([
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      "First managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const managedSessionId = firstParsed.conversation.session_id;
    const statePath = firstParsed.conversation.state_path;
    const firstMessageId =
      firstParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;
    const entersBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    const idleAt = new Date().toISOString();
    const firstState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(
      statePath,
      `${JSON.stringify({
        ...firstState,
        status: "idle",
        idle_since: idleAt,
        updated_at: idleAt
      }, null, 2)}\n`
    );
    const second = runAgentCli([
      "send",
      "--session",
      managedSessionId,
      "--message",
      "Second managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "0",
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      ...testEnv,
      AKK_TEST_TERMINAL_SETUP_FAILURE: "1"
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondParsed = JSON.parse(second.stdout);
    assert.equal(secondParsed.submission_outcome, "aborted");
    assert.equal(secondParsed.safe_to_retry, true);
    assert.equal(secondParsed.delivered, false);
    assert.equal(secondParsed.session_id, managedSessionId);
    assert.notEqual(secondParsed.turn_id, firstParsed.turn_id);
    assert.notEqual(
      secondParsed.conversation.state_path,
      statePath
    );

    const firstAfterFailure = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_message_id,
      firstMessageId
    );
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_request_text,
      "First managed task"
    );
    assert.equal(
      firstAfterFailure.native_session_takeover.terminal_bridge_submission.status,
      "submitted"
    );
    assert.equal(firstAfterFailure.status, "idle");
    const secondState = JSON.parse(
      fs.readFileSync(secondParsed.conversation.state_path, "utf8")
    );
    assert.equal(secondState.user_request, "Second managed task");
    assert.equal(
      secondState.native_session_takeover.terminal_bridge_submission.status,
      "aborted"
    );
    assert.equal(secondState.status, "idle");
    const entersAfter = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.at(-1) === "C-m")
      .length;
    assert.equal(entersAfter, entersBefore);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("concurrent raw terminal sends allow exactly one active generation", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-task-concurrent-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-concurrent-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-concurrent-send-process",
    rolloutPath: path.join(tempDir, "codex-concurrent-send-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
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
      "--threads-json",
      JSON.stringify([]),
      ...nativeIdentityArgs,
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
    assert.deepEqual(
      [first.status, second.status].sort(),
      [0, 1]
    );
    const rejected = first.status === 0 ? second : first;
    assert.match(
      rejected.stderr,
      /session .* already has active turn/u
    );

    const states = fs.readdirSync(storeConversationsDir(storeDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(storeConversationsDir(storeDir), entry.name, "state.json"))
      .filter((statePath) => fs.existsSync(statePath))
      .map((statePath) =>
        JSON.parse(fs.readFileSync(statePath, "utf8"))
      );
    const active = states.filter((state) => state.status === "waiting_for_agent");
    assert.equal(active.length, 1);

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 1);
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args.at(-1) === "C-m"
      ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("native thread Store authority spans concurrent terminal sends", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cross-store-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-cross-store-${process.pid}`;
  const rawConversationId = `terminal:tmux:${tmuxSession}:0.1:33389`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-cross-store-owner-process",
    rolloutPath: path.join(tempDir, "codex-cross-store-owner-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const sendArgs = (message: string, storeDir: string) => [
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];
    const env = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_TEST_TMUX_SEND_DELAY_MS: "300"
    };

    const [first, second] = await Promise.all([
      runAgentCliAsync(sendArgs("Cross-store identical task", firstStoreDir), env),
      runAgentCliAsync(sendArgs("Cross-store identical task", secondStoreDir), env)
    ]);
    assert.deepEqual(
      [first.status, second.status].sort(),
      [0, 1]
    );
    const rejected = first.status === 0 ? second : first;
    const accepted = first.status === 0 ? first : second;
    const acceptedStoreDir = first.status === 0
      ? firstStoreDir
      : secondStoreDir;
    const rejectedStoreDir = first.status === 0
      ? secondStoreDir
      : firstStoreDir;
    assert.match(
      rejected.stderr,
      /authoritative in another Store/u
    );
    const acceptedParsed = JSON.parse(accepted.stdout);
    assert.notEqual(acceptedParsed.replayed, true);
    assert.equal(
      acceptedParsed.message.conversation_id,
      acceptedParsed.conversation.turn_id
    );
    assert.equal(
      acceptedParsed.message.session_id,
      acceptedParsed.conversation.session_id
    );
    assert.equal(
      acceptedParsed.message.turn_id,
      acceptedParsed.conversation.turn_id
    );
    assert.equal(
      listManagedSessions(rejectedStoreDir).length,
      0,
      "the rejected Store must not retain a duplicate Session"
    );
    assert.equal(
      listConversations(rejectedStoreDir).length,
      0,
      "the rejected Store must not retain a duplicate Turn"
    );
    const sessions = [
      ...listManagedSessions(acceptedStoreDir),
      ...listManagedSessions(rejectedStoreDir)
    ];
    assert.equal(sessions.length, 1);
    assert.equal(
      sessions.filter((session) =>
        session.binding?.native_thread_id === sessionId
      ).length,
      1
    );

    const calls = readJsonLines(tmuxCallsPath);
    const literalSendIndexes = calls
      .map((call, index) => call.args.includes("-l") ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(literalSendIndexes.length, 1);
    assert.equal(
      calls.filter((call) =>
        call.args[0] === "send-keys" &&
        call.args.at(-1) === "C-m"
      ).length,
      1
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("only the uncertain owner can resolve its fence without moving native Store authority", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cross-store-fence-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const thirdStoreDir = path.join(tempDir, "third-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-cross-store-fence-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;
  const rawConversationId = `terminal:tmux:${terminalTarget}:33389`;
  const listPanesOutput =
    `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`;
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-cross-store-fence-process",
    rolloutPath: path.join(tempDir, "codex-cross-store-fence-rollout.jsonl")
  });
  let dispatchLedgerPath: string | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const openclawBin = writeFakeOpenClaw(
      fakeBinDir,
      openclawCallsPath
    );
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const sendArgs = (
      message: string,
      storeDir: string,
      withCallback = false
    ) => [
      "send",
      "--conversation",
      rawConversationId,
      "--message",
      message,
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      withCallback ? openclawBin : "/usr/bin/true",
      ...(withCallback
        ? [
            "--gateway-method",
            "agent-knock-knock.callback",
            "--gateway-session",
            "agent:channel:original",
            "--openclaw-session",
            "agent:channel:original"
          ]
        : []),
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ];

    const first = runAgentCli(
      sendArgs("First cross-store task", firstStoreDir, true),
      testEnv
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    dispatchLedgerPath = findTerminalDispatchLedgerPath(
      firstParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput,
      "Second cross-store task"
    );
    const second = runAgentCli(
      sendArgs("Second cross-store task", secondStoreDir),
      testEnv
    );
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /authoritative in another Store/u);
    assert.equal(listManagedSessions(secondStoreDir).length, 0);
    assert.equal(listConversations(secondStoreDir).length, 0);
    assert.equal(
      JSON.parse(fs.readFileSync(firstStatePath, "utf8")).status,
      "waiting_for_agent"
    );

    const oldClosed = runAgentCli([
      "close",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "closing the old cross-store generation"
    ], testEnv);
    assert.equal(oldClosed.status, 0, oldClosed.stderr || oldClosed.stdout);
    assert.equal(
      JSON.parse(oldClosed.stdout).terminal_dispatch_resolved,
      true
    );

    const uncertain = runAgentCli(
      sendArgs("Second cross-store task", firstStoreDir),
      testEnv
    );
    assert.equal(
      uncertain.status,
      0,
      uncertain.stderr || uncertain.stdout
    );
    const secondParsed = JSON.parse(uncertain.stdout);
    assert.equal(secondParsed.submission_outcome, "uncertain");
    assert.equal(secondParsed.do_not_retry, true);

    const staleClose = runAgentCli([
      "close",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "stale owner cannot resolve the replacement generation"
    ], testEnv);
    assert.equal(
      staleClose.status,
      0,
      staleClose.stderr || staleClose.stdout
    );
    assert.equal(
      JSON.parse(staleClose.stdout).terminal_dispatch_resolved,
      false
    );

    const blocked = runAgentCli(
      sendArgs("Third cross-store task", thirdStoreDir),
      testEnv
    );
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /authoritative in another Store/u);
    assert.equal(listManagedSessions(thirdStoreDir).length, 0);
    assert.equal(listConversations(thirdStoreDir).length, 0);

    const ownerClosed = runAgentCli([
      "close",
      "--conversation",
      secondParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir,
      ...nativeIdentityArgs,
      "--reason",
      "operator inspected the uncertain terminal dispatch"
    ], testEnv);
    assert.equal(
      ownerClosed.status,
      0,
      ownerClosed.stderr || ownerClosed.stdout
    );
    assert.equal(
      JSON.parse(ownerClosed.stdout).terminal_dispatch_resolved,
      true
    );

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      listPanesOutput
    );
    const third = runAgentCli(
      sendArgs("Third cross-store task", firstStoreDir),
      testEnv
    );
    assert.equal(third.status, 0, third.stderr || third.stdout);
    assert.equal(JSON.parse(third.stdout).delivered, true);
    assert.equal(listManagedSessions(firstStoreDir).length, 1);
    assert.equal(listManagedSessions(secondStoreDir).length, 0);
    assert.equal(listManagedSessions(thirdStoreDir).length, 0);
    assert.equal(listConversations(secondStoreDir).length, 0);
    assert.equal(listConversations(thirdStoreDir).length, 0);
    assert.equal(
      [
        ...listManagedSessions(firstStoreDir),
        ...listManagedSessions(secondStoreDir),
        ...listManagedSessions(thirdStoreDir)
      ].filter((session) =>
        session.binding?.native_thread_id === sessionId
      ).length,
      1
    );
  } finally {
    if (dispatchLedgerPath) {
      fs.rmSync(dispatchLedgerPath, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal receipt fingerprints preserve exact whitespace", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-exact-receipt-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-exact-receipt-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const send = (message: string, storeDir: string) => runAgentCli([
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
    ], testEnv);

    const first = send("Review:\n  alpha", firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstState = JSON.parse(
      fs.readFileSync(firstStatePath, "utf8")
    );
    const closedAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "closed",
        closed_at: closedAt,
        updated_at: closedAt
      }, null, 2)}\n`
    );

    const second = send("Review: alpha", secondStoreDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.notEqual(JSON.parse(second.stdout).replayed, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a recreated tmux pane does not replay the prior incarnation receipt", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-pane-incarnation-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-pane-incarnation-${process.pid}`;
  const terminalTarget = `${tmuxSession}:0.1`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const send = (
      panePid: number,
      storeDir: string
    ) => runAgentCli([
      "send",
      "--conversation",
      `terminal:tmux:${terminalTarget}:${panePid}`,
      "--message",
      "Run the same request",
      "--background",
      "--store-dir",
      storeDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], testEnv);

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const first = send(33389, firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);

    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t44489\tnode\t${workspace}\n`
    );
    const second = send(44489, secondStoreDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.notEqual(JSON.parse(second.stdout).replayed, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an orphaned prepared ledger without owner state is safely abandoned", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-orphan-ledger-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-orphan-ledger-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const send = (message: string, storeDir: string) => runAgentCli([
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
    ], testEnv);

    const first = send("First task", firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const ledgerPath = findTerminalDispatchLedgerPath(
      firstParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    delete ledger.submitted_at;
    fs.writeFileSync(
      ledgerPath,
      `${JSON.stringify({
        ...ledger,
        status: "prepared",
        dispatcher_pid: 99999999
      }, null, 2)}\n`
    );
    fs.rmSync(firstParsed.conversation.state_path, { force: true });

    const second = send("Second task", secondStoreDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(JSON.parse(second.stdout).delivered, true);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stale managed approve and cancel cannot control a newer cross-store generation", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-stale-control-"));
  const firstStoreDir = path.join(tempDir, "first-conversations");
  const secondStoreDir = path.join(tempDir, "second-conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const tmuxSession = `akk-stale-control-${process.pid}`;
  const rawConversationId =
    `terminal:tmux:${tmuxSession}:0.1:33389`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
      `${tmuxSession}\t0\t1\t33389\tnode\t${workspace}\n`
    );
    const testEnv = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };
    const send = (message: string, storeDir: string) => runAgentCli([
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
    ], testEnv);

    const first = send("First task", firstStoreDir);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstParsed = JSON.parse(first.stdout);
    const firstStatePath = firstParsed.conversation.state_path;
    const firstState = JSON.parse(
      fs.readFileSync(firstStatePath, "utf8")
    );
    const idleAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "idle",
        idle_since: idleAt,
        updated_at: idleAt
      }, null, 2)}\n`
    );

    const second = send("Second task", secondStoreDir);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const staleAt = new Date().toISOString();
    fs.writeFileSync(
      firstStatePath,
      `${JSON.stringify({
        ...firstState,
        status: "waiting_for_openclaw",
        updated_at: staleAt
      }, null, 2)}\n`
    );
    fs.writeFileSync(screenPath, [
      "Would you like to run the following command?",
      "",
      "› 1. Yes, allow (y)",
      "  2. No (n)"
    ].join("\n"));
    const keysBefore = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .length;

    const approved = runAgentCli([
      "approve",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir
    ], testEnv);
    assert.notEqual(approved.status, 0);
    assert.match(
      approved.stderr,
      /Session binding generation is no longer current|does not own the current terminal dispatch generation/u
    );

    const cancelled = runAgentCli([
      "cancel",
      "--conversation",
      firstParsed.conversation.conversation_id,
      "--store-dir",
      firstStoreDir
    ], testEnv);
    assert.notEqual(cancelled.status, 0);
    assert.match(
      cancelled.stderr,
      /Session binding generation is no longer current|does not own the current terminal dispatch generation/u
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys")
        .length,
      keysBefore
    );
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-task-complete-process",
    rolloutPath
  });

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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

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
        panePid: 33389,
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
      JSON.stringify({ [rolloutPath]: rollout }),
      ...nativeIdentityArgs
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
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(typeof parsed.conversation.idle_since, "string");
    const completedLedgerPath = findTerminalDispatchLedgerPath(
      parsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    assert.equal(
      JSON.parse(fs.readFileSync(completedLedgerPath, "utf8")).status,
      "resolved"
    );
    const keysBeforeStaleActions = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys")
      .length;
    const staleApprove = runAgentCli([
      "approve",
      "--conversation",
      parsed.conversation.conversation_id,
      "--expected-approval-fingerprint",
      "stale-fingerprint",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ]);
    assert.notEqual(staleApprove.status, 0);
    assert.match(staleApprove.stderr, /conversation is idle/u);
    const staleCancel = runAgentCli([
      "cancel",
      "--conversation",
      parsed.conversation.conversation_id,
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs
    ]);
    assert.notEqual(staleCancel.status, 0);
    assert.match(staleCancel.stderr, /conversation is idle/u);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) => call.args[0] === "send-keys")
        .length,
      keysBeforeStaleActions
    );

    const followUp = runAgentCli([
      "send",
      "--session",
      parsed.conversation.session_id,
      "--message",
      "Now summarize the release notes",
      "--background",
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(followUp.status, 0, followUp.stderr || followUp.stdout);
    const followUpParsed = JSON.parse(followUp.stdout);
    assert.equal(followUpParsed.delivered, true);
    assert.equal(followUpParsed.conversation.status, "waiting_for_agent");
    assert.equal(followUpParsed.session_id, parsed.conversation.session_id);
    assert.notEqual(followUpParsed.turn_id, parsed.conversation.turn_id);
    assert.notEqual(
      followUpParsed.conversation.state_path,
      parsed.conversation.state_path
    );
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .filter((call) =>
          call.args[0] === "send-keys" &&
          call.args.at(-1) === "C-m"
        ).length,
      2
    );

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

test("terminal bridge searches all same-cwd rollouts for the matching task_complete", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-cwd-rollouts-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");
  const correctSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44f";
  const newerSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c450";
  const newestSessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const correctRolloutPath = path.join(tempDir, "correct.jsonl");
  const newerRolloutPath = path.join(tempDir, "newer.jsonl");
  const newestRolloutPath = path.join(tempDir, "newest.jsonl");
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId: correctSessionId,
    processUuid: "codex-cwd-rollout-process",
    rolloutPath: correctRolloutPath
  });

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

    const request = "Summarize the release gate";
    const sent = runAgentCli([
      "send",
      "--conversation",
      "terminal:tmux:codex-work:0.1:33389",
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, "• Working (12s • esc to interrupt)\n");
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

    const completedRollout = [
      JSON.stringify({
        timestamp: "2099-07-04T00:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "The release gate is ready."
        }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:01:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: "turn-correct-cwd-session",
          last_agent_message: "The release gate is ready."
        }
      })
    ].join("\n");
    const unrelatedRollout = (message: string, turnId: string) => [
      JSON.stringify({
        timestamp: "2099-07-04T00:02:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:00.000Z",
        type: "event_msg",
        payload: { type: "agent_message", message: `${message} finished.` }
      }),
      JSON.stringify({
        timestamp: "2099-07-04T00:03:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: turnId,
          last_agent_message: `${message} finished.`
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
      JSON.stringify([
        {
          id: newestSessionId,
          cwd: workspace,
          rollout_path: newestRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:06:00.000Z"),
          archived: false
        },
        {
          id: newerSessionId,
          cwd: workspace,
          rollout_path: newerRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:05:00.000Z"),
          archived: false
        },
        {
          id: correctSessionId,
          cwd: workspace,
          rollout_path: correctRolloutPath,
          updated_at_ms: Date.parse("2099-07-04T00:01:01.000Z"),
          archived: false
        }
      ]),
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
        panePid: 999,
        currentPath: workspace
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.1": fs.readFileSync(screenPath, "utf8") }),
      "--rollouts-json",
      JSON.stringify({
        [newestRolloutPath]: unrelatedRollout("Newest unrelated task", "turn-newest"),
        [newerRolloutPath]: unrelatedRollout("Newer unrelated task", "turn-newer"),
        [correctRolloutPath]: completedRollout
      }),
      ...nativeIdentityArgs
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.body, "The release gate is ready.");
    assert.equal(parsed.message.metadata.match, "rollout_task_complete");
    assert.equal(parsed.message.metadata.context_match, "cwd_request_hash");
    assert.equal(parsed.message.metadata.session.sessionId, correctSessionId);
    assert.equal(parsed.message.metadata.rollout_turn_id, "turn-correct-cwd-session");
    assert.equal(readJsonLines(openclawCallsPath).length, 1);
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-low-confidence-process",
    rolloutPath
  });

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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
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
      JSON.stringify({ [rolloutPath]: rollout }),
      ...nativeIdentityArgs
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-working-timeout-process",
    rolloutPath: path.join(tempDir, "codex-working-timeout-rollout.jsonl")
  });

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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, workingScreen);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
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
      JSON.stringify({ "codex-work:0.1": workingScreen }),
      ...nativeIdentityArgs
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-renew-process",
    rolloutPath
  });

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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const conversationId = sentParsed.conversation.conversation_id;
    const storedPaths = pathsForConversation(conversationId, storeDir);
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
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
      ...nativeIdentityArgs,
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
      ...nativeIdentityArgs,
      "--rollouts-json",
      JSON.stringify({ [rolloutPath]: rollout })
    ];
    const monitored = runAgentCli(monitorArgs);
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.message.body, "The long task is complete.");
    assert.equal(monitoredParsed.conversation.status, "idle");
    assert.equal(typeof monitoredParsed.conversation.idle_since, "string");

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
  const screenPath = path.join(tempDir, "screen.txt");
  const tmuxListGatePath = path.join(tempDir, "tmux-list-gate");
  const terminalTarget = "codex-renew-race:0.1";
  let renewing: ReturnType<typeof spawnAgentCliCaptured> | undefined;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
    writeFakeTmux(
      fakeBinDir,
      tmuxCallsPath,
      screenPath,
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-singleton-process",
    rolloutPath: path.join(tempDir, "codex-monitor-singleton-rollout.jsonl")
  });
  const childProcesses: Array<ReturnType<typeof spawn>> = [];

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const workingScreen =
      "• Working (12s • esc to interrupt) · 1 background terminal running\n› Steer the current task\n";
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, workingScreen);
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
      "120",
      ...nativeIdentityArgs
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
    const closed = runAgentCli([
      "close",
      "--state",
      statePath,
      ...nativeIdentityArgs,
      "--reason",
      "singleton test cleanup"
    ]);
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

    const handoffStatePath = writeConversationClone(
      storeDir,
      sentParsed.conversation,
      "terminal-handoff-transient-callback",
      (state) => ({
        ...state,
        status: "waiting_for_openclaw",
        updated_at: new Date().toISOString()
      })
    );
    const handoffLogPath = path.join(
      path.dirname(handoffStatePath),
      "events.ndjson"
    );
    const handoffMessageId =
      sentParsed.conversation.native_session_takeover
        .terminal_bridge_message_id;
    const handoffLedgerPath = findTerminalDispatchLedgerPath(
      sentParsed.conversation.conversation_id,
      path.join(tempDir, ".akk-cli-test-runtime")
    );
    const handoffState = JSON.parse(
      fs.readFileSync(handoffStatePath, "utf8")
    );
    const handoffLedger = JSON.parse(
      fs.readFileSync(handoffLedgerPath, "utf8")
    );
    delete handoffLedger.resolved_at;
    delete handoffLedger.reason;
    fs.writeFileSync(
      handoffLedgerPath,
      `${JSON.stringify({
        ...handoffLedger,
        status: "submitted",
        conversation_id: handoffState.conversation_id,
        state_path: handoffStatePath,
        message_id: handoffMessageId,
        submitted_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    const handoffArgs = [
      "monitor",
      "--terminal-bridge-handoff",
      "--state",
      handoffStatePath,
      "--log",
      handoffLogPath,
      "--expected-terminal-message-id",
      handoffMessageId,
      "--monitor-handoff-poll-interval-ms",
      "20",
      "--monitor-poll-interval-ms",
      "20",
      ...nativeIdentityArgs
    ];
    const handoff = spawnAgentCliCaptured(handoffArgs, testEnv);
    childProcesses.push(handoff.child);
    await waitForCondition(
      () =>
        eventCount(
          handoffLogPath,
          "terminal_bridge_monitor_handoff_watchdog_started"
        ) === 1,
      "handoff watchdog to stay alive across the callback state"
    );
    const duplicateHandoff = runAgentCli(handoffArgs, testEnv);
    assert.equal(
      duplicateHandoff.status,
      0,
      duplicateHandoff.stderr || duplicateHandoff.stdout
    );
    assert.equal(
      JSON.parse(duplicateHandoff.stdout).reason,
      "terminal_bridge_monitor_handoff_watchdog_already_running"
    );
    const transientState = JSON.parse(
      fs.readFileSync(handoffStatePath, "utf8")
    );
    fs.writeFileSync(
      handoffStatePath,
      `${JSON.stringify({
        ...transientState,
        status: "waiting_for_agent",
        updated_at: new Date().toISOString()
      }, null, 2)}\n`
    );
    const handoffResult = await handoff.result;
    assert.equal(
      handoffResult.status,
      0,
      handoffResult.stderr || handoffResult.stdout
    );
    const handoffParsed = JSON.parse(handoffResult.stdout);
    assert.equal(handoffParsed.launched, true);
    assert.equal(
      handoffParsed.reason,
      "approval_handoff_reconciliation"
    );
    assert.equal(
      eventCount(handoffLogPath, "terminal_bridge_monitor_launch"),
      1,
      "the original watchdog must survive the transient callback state and take over"
    );
    const handoffClosed = runAgentCli([
      "close",
      "--state",
      handoffStatePath,
      ...nativeIdentityArgs,
      "--reason",
      "handoff transient test cleanup"
    ], testEnv);
    assert.equal(
      handoffClosed.status,
      0,
      handoffClosed.stderr || handoffClosed.stdout
    );
    await waitForPidExit(handoffParsed.monitor_pid);

    for (const finalCallbackStatus of ["callback_pending", "callback_failed"]) {
      const completedCallbackStatePath = writeConversationClone(
        storeDir,
        sentParsed.conversation,
        `terminal-handoff-${finalCallbackStatus}`,
        (state) => ({
          ...state,
          status: finalCallbackStatus,
          updated_at: new Date().toISOString()
        })
      );
      const completedCallbackLogPath = path.join(
        path.dirname(completedCallbackStatePath),
        "events.ndjson"
      );
      const completedCallbackHandoff = runAgentCli([
        "monitor",
        "--terminal-bridge-handoff",
        "--state",
        completedCallbackStatePath,
        "--log",
        completedCallbackLogPath,
        "--expected-terminal-message-id",
        handoffMessageId,
        "--monitor-handoff-poll-interval-ms",
        "20",
        "--monitor-poll-interval-ms",
        "20"
      ], testEnv);
      assert.equal(
        completedCallbackHandoff.status,
        0,
        completedCallbackHandoff.stderr || completedCallbackHandoff.stdout
      );
      assert.equal(
        eventCount(
          completedCallbackLogPath,
          "terminal_bridge_monitor_handoff_watchdog_finished"
        ),
        1
      );
      assert.equal(
        eventCount(completedCallbackLogPath, "terminal_bridge_monitor_launch"),
        0,
        `${finalCallbackStatus} is a terminal callback state, not an approval handoff`
      );
    }
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-monitor-reconcile-process",
    rolloutPath: path.join(tempDir, "codex-monitor-reconcile-rollout.jsonl")
  });
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
      ...nativeIdentityArgs,
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
      "20",
      ...nativeIdentityArgs
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
      JSON.parse(fs.readFileSync(pathsForConversation("waiting-for-openclaw", storeDir).statePath, "utf8")).status,
      "waiting_for_openclaw"
    );
    assert.equal(
      JSON.parse(fs.readFileSync(pathsForConversation("already-stalled", storeDir).statePath, "utf8")).status,
      "stalled"
    );
  } finally {
    killPidBestEffort(monitorPid);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("reconcile-monitors restarts transcript-backed Claude bridges without sending terminal input", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-reconcile-"));
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
      message: "Continue the transcript-backed task after restart"
    });
    const storedAfterSend = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    const nativeTakeover = storedAfterSend.native_session_takeover;
    assert.equal(typeof nativeTakeover.claude_transcript_anchor, "object");
    assert.deepEqual(
      Object.keys(nativeTakeover).filter((key) => key.startsWith("claude_hook_")),
      []
    );
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
    monitorPid = parsed.items[0]?.monitor_pid;
    await waitForCondition(
      () => eventCount(task.logPath, "terminal_bridge_monitor_started") === 1,
      "Claude transcript monitor to start after reconciliation"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).filter((call) => call.args[0] === "send-keys").length,
      sendKeysBefore
    );
    const reconciledState = JSON.parse(fs.readFileSync(task.statePath, "utf8"));
    assert.deepEqual(
      Object.keys(reconciledState.native_session_takeover)
        .filter((key) => key.startsWith("claude_hook_")),
      []
    );
    assert.doesNotMatch(fs.readFileSync(task.logPath, "utf8"), /claude_hook_/u);

    const closed = runAgentCli([
      "close",
      "--state",
      task.statePath,
      "--reason",
      "Claude transcript reconciliation test cleanup"
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-screen-completion-process",
    rolloutPath: path.join(tempDir, "codex-screen-completion-rollout.jsonl")
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const request = "git pull 完后看一下最近的 commits，告诉我都更新了哪些特性";
    fs.writeFileSync(screenPath, "› \n");
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    const storedPaths = pathsForConversation(
      sentParsed.conversation.conversation_id,
      storeDir
    );
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;
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
      }),
      ...nativeIdentityArgs
    ]);

    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const parsed = JSON.parse(monitored.stdout);
    assert.equal(parsed.delivered, true);
    assert.equal(parsed.message.type, "done");
    assert.match(parsed.message.body, /这次 pull 实际只更新了 1 个 commit/);
    assert.doesNotMatch(parsed.message.body, /Worked for|Find and fix|gpt-5\.6/);
    assert.equal(parsed.message.metadata.confidence, "screen_only");
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(typeof parsed.conversation.idle_since, "string");

    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_completion_detected/);
    assert.match(events, /"match":"terminal_screen"/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("terminal approval notification releases the state lock during callback delivery and preserves concurrent close", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-callback-close-race-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const openclawCallsPath = path.join(tempDir, "openclaw-calls.ndjson");
  const openclawGatePath = path.join(tempDir, "openclaw-gate");
  const screenPath = path.join(tempDir, "screen.txt");
  const terminalTarget = "codex-approval-lock:0.1";
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-approval-close-race-process",
    rolloutPath: path.join(tempDir, "codex-approval-close-race-rollout.jsonl")
  });
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
    fs.writeFileSync(screenPath, "› \n");
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], testEnv);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, approvalScreen);
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
      JSON.stringify({ [terminalTarget]: approvalScreen }),
      ...nativeIdentityArgs
    ], {
      ...testEnv,
      AKK_TEST_OPENCLAW_GATE_PATH: openclawGatePath
    });
    await waitForCondition(
      () => fs.existsSync(`${openclawGatePath}.entered`),
      "approval callback delivery to enter the OpenClaw gate"
    );

    assert.equal(
      fs.existsSync(stateLockPath),
      false,
      "the monitor must release the notification state lock before calling OpenClaw"
    );
    const pendingState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(pendingState.status, "waiting_for_openclaw");
    assert.equal(pendingState.callback_delivery.status, "pending");
    assert.equal(pendingState.callback_delivery.kind, "approval_notification");
    assert.equal(pendingState.callback_delivery.preserve_conversation_status, true);
    assert.equal(pendingState.callback_delivery.attempt_pid, monitoring.child.pid);
    assert.equal(typeof pendingState.callback_delivery.attempt_id, "string");

    closing = spawnAgentCliCaptured([
      "close",
      "--conversation",
      conversationId,
      "--store-dir",
      storeDir,
      ...nativeIdentityArgs,
      "--reason",
      "closed while approval callback was in flight"
    ], testEnv);
    await waitForChildExit(closing.child);
    const closed = await closing.result;
    assert.equal(closed.status, 0, closed.stderr || closed.stdout);
    const closedParsed = JSON.parse(closed.stdout);
    assert.equal(closedParsed.conversation.status, "closed");
    assert.equal(
      monitoring.child.exitCode,
      null,
      "the callback should remain blocked while close completes independently"
    );
    const closedWhilePending = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(closedWhilePending.status, "closed");
    assert.equal(closedWhilePending.callback_delivery.status, "pending");

    fs.writeFileSync(`${openclawGatePath}.release`, "");
    const monitored = await monitoring.result;
    assert.equal(monitored.status, 0, monitored.stderr || monitored.stdout);
    const monitoredParsed = JSON.parse(monitored.stdout);
    assert.equal(monitoredParsed.delivered, true);
    assert.equal(monitoredParsed.conversation.status, "closed");
    assert.equal(monitoredParsed.conversation.callback_delivery.status, "delivered");

    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(finalState.status, "closed");
    assert.equal(finalState.callback_delivery.status, "delivered");
    assert.equal(finalState.closed_at, closedParsed.conversation.closed_at);
    assert.equal(finalState.updated_at, closedParsed.conversation.updated_at);
    assert.equal(finalState.close_reason, "closed while approval callback was in flight");
    const events = fs.readFileSync(logPath, "utf8");
    assert.match(events, /terminal_bridge_approval_notification_recorded/u);
    assert.match(events, /callback_gateway_method_delivery/u);
    assert.match(events, /"state_preserved":true/u);
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
  const nativeIdentityArgs = codexNativeIdentityArgs({
    pid: 33389,
    sessionId,
    processUuid: "codex-approval-monitor-process",
    rolloutPath: path.join(tempDir, "codex-approval-monitor-rollout.jsonl")
  });

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
    fs.writeFileSync(screenPath, "› \n");
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
      ...nativeIdentityArgs,
      "--disable-terminal-bridge-monitor"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    fs.writeFileSync(screenPath, approvalScreen);
    const conversationId = sentParsed.conversation.conversation_id;
    const storedPaths = pathsForConversation(conversationId, storeDir);
    const statePath = storedPaths.statePath;
    const logPath = storedPaths.logPath;

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
      }),
      ...nativeIdentityArgs
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

    const writeApprovalRecoveryClone = (
      name: string,
      mutate: (state: any) => any
    ) => writeConversationClone(
      path.join(tempDir, `${name}-store`),
      monitoredParsed.conversation,
      monitoredParsed.conversation.conversation_id,
      mutate
    );
    const recoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-outbox-recovery",
      (state) => {
        const { callback_delivery: _missingOutbox, ...withoutOutbox } = state;
        return {
          ...withoutOutbox,
          status: "waiting_for_agent",
          response_rounds_used: Math.max(
            0,
            monitoredParsed.message.round - 1
          ),
          updated_at:
            state.native_session_takeover.terminal_bridge_approval.notified_at
        };
      }
    );
    const recoveryLogPath = path.join(
      path.dirname(recoveryStatePath),
      "events.ndjson"
    );
    const recoveryMessage = {
      ...monitoredParsed.message,
      conversation_id: monitoredParsed.conversation.conversation_id
    };
    fs.writeFileSync(recoveryLogPath, `${JSON.stringify({
      ts: recoveryMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: recoveryMessage.from,
      to: recoveryMessage.to,
      type: recoveryMessage.type,
      requires_response: recoveryMessage.requires_response,
      round: recoveryMessage.round,
      body: recoveryMessage.body,
      message: recoveryMessage
    })}\n`, { mode: 0o600 });
    const recoveredNotification = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      recoveryStatePath,
      "--log",
      recoveryLogPath,
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      recoveredNotification.status,
      0,
      recoveredNotification.stderr || recoveredNotification.stdout
    );
    const recoveredParsed = JSON.parse(recoveredNotification.stdout);
    assert.equal(recoveredParsed.delivered, true);
    assert.equal(recoveredParsed.message.id, monitoredParsed.message.id);
    assert.equal(recoveredParsed.conversation.callback_delivery.status, "delivered");
    const recoveryEvents = readJsonLines(recoveryLogPath);
    assert.equal(
      recoveryEvents.filter((event) => event.event === "message").length,
      1,
      "outbox recovery must not duplicate the fixed callback message"
    );
    assert.equal(
      recoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );

    const markerOnlyRecoveryMessageId =
      "msg-approval-marker-before-message-event";
    const markerOnlyRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-marker-only-recovery",
      (state) => {
        const {
          callback_delivery: _missingOutbox,
          ...withoutOutbox
        } = state;
        return {
          ...withoutOutbox,
          status: "waiting_for_agent",
          response_rounds_used: Math.max(
            0,
            monitoredParsed.message.round - 1
          ),
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: {
              ...state.native_session_takeover.terminal_bridge_approval,
              callback_message_id: markerOnlyRecoveryMessageId
            }
          },
          updated_at:
            state.native_session_takeover.terminal_bridge_approval.notified_at
        };
      }
    );
    const markerOnlyRecoveryLogPath = path.join(
      path.dirname(markerOnlyRecoveryStatePath),
      "events.ndjson"
    );
    const markerOnlyRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      markerOnlyRecoveryStatePath,
      "--log",
      markerOnlyRecoveryLogPath,
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      markerOnlyRecovered.status,
      0,
      markerOnlyRecovered.stderr || markerOnlyRecovered.stdout
    );
    const markerOnlyRecoveredParsed = JSON.parse(
      markerOnlyRecovered.stdout
    );
    assert.equal(markerOnlyRecoveredParsed.delivered, true);
    assert.equal(
      markerOnlyRecoveredParsed.message.id,
      markerOnlyRecoveryMessageId
    );
    const markerOnlyRecoveryEvents = readJsonLines(
      markerOnlyRecoveryLogPath
    );
    assert.equal(
      markerOnlyRecoveryEvents.filter((event) =>
        event.event === "message"
      ).length,
      1,
      "recovery after the stable marker save must create one message event"
    );
    assert.equal(
      markerOnlyRecoveryEvents.some((event) =>
        event.event ===
          "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );

    const recoveredCallbackMessageId = "msg-new-approval-after-crash";
    const staleOutboxRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-stale-outbox-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: recoveredCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "delivered",
            attempts: 3,
            final_status: "closed",
            kind: "completion",
            message: {
              ...state.callback_delivery.message,
              id: "msg-old-delivered-callback"
            }
          }
        };
      }
    );
    const staleOutboxRecoveryLogPath = path.join(
      path.dirname(staleOutboxRecoveryStatePath),
      "events.ndjson"
    );
    const staleOutboxRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      staleOutboxRecoveryStatePath,
      "--log",
      staleOutboxRecoveryLogPath,
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      staleOutboxRecovered.status,
      0,
      staleOutboxRecovered.stderr || staleOutboxRecovered.stdout
    );
    const staleOutboxRecoveredParsed = JSON.parse(staleOutboxRecovered.stdout);
    assert.equal(staleOutboxRecoveredParsed.delivered, true);
    assert.equal(
      staleOutboxRecoveredParsed.message.id,
      recoveredCallbackMessageId
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.attempts,
      1,
      "a new approval notification must not inherit stale callback attempts"
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.kind,
      "approval_notification"
    );
    assert.equal(
      staleOutboxRecoveredParsed.conversation.callback_delivery.final_status,
      "waiting_for_openclaw"
    );
    const staleOutboxRecoveryEvents = readJsonLines(
      staleOutboxRecoveryLogPath
    );
    assert.equal(
      staleOutboxRecoveryEvents.filter((event) => event.event === "message").length,
      1
    );
    assert.equal(
      staleOutboxRecoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );
    assert.equal(
      staleOutboxRecoveryEvents.some((event) =>
        event.event === "callback_retry_monitor_launched"
      ),
      true,
      "the fresh first attempt must retain callback retry coverage"
    );

    const exhaustedCallbackMessageId =
      "msg-new-approval-after-exhausted-callback";
    const exhaustedOutboxRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-exhausted-outbox-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: exhaustedCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "failed",
            attempts: 5,
            final_status: "closed",
            kind: "completion",
            message: {
              ...state.callback_delivery.message,
              id: "msg-exhausted-failed-callback"
            }
          }
        };
      }
    );
    const exhaustedOutboxRecoveryLogPath = path.join(
      path.dirname(exhaustedOutboxRecoveryStatePath),
      "events.ndjson"
    );
    const olderSameBodyMessage = {
      ...monitoredParsed.message,
      id: "msg-older-same-body-callback"
    };
    fs.writeFileSync(exhaustedOutboxRecoveryLogPath, `${JSON.stringify({
      ts: olderSameBodyMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: olderSameBodyMessage.from,
      to: olderSameBodyMessage.to,
      type: olderSameBodyMessage.type,
      requires_response: olderSameBodyMessage.requires_response,
      round: olderSameBodyMessage.round,
      body: olderSameBodyMessage.body,
      message: olderSameBodyMessage
    })}\n`, { mode: 0o600 });
    const exhaustedOutboxRecovered = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      exhaustedOutboxRecoveryStatePath,
      "--log",
      exhaustedOutboxRecoveryLogPath,
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(
      exhaustedOutboxRecovered.status,
      0,
      exhaustedOutboxRecovered.stderr || exhaustedOutboxRecovered.stdout
    );
    const exhaustedOutboxRecoveredParsed = JSON.parse(
      exhaustedOutboxRecovered.stdout
    );
    assert.equal(exhaustedOutboxRecoveredParsed.delivered, true);
    assert.equal(
      exhaustedOutboxRecoveredParsed.message.id,
      exhaustedCallbackMessageId
    );
    assert.equal(
      exhaustedOutboxRecoveredParsed.conversation.callback_delivery.attempts,
      1
    );
    const exhaustedRecoveryEvents = readJsonLines(
      exhaustedOutboxRecoveryLogPath
    );
    assert.equal(
      exhaustedRecoveryEvents.some((event) =>
        event.event === "terminal_bridge_approval_notification_outbox_recovered"
      ),
      true
    );
    assert.equal(
      exhaustedRecoveryEvents.filter((event) => event.event === "message").length,
      2,
      "a same-body event with another id must not suppress the fixed recovery message"
    );
    assert.equal(
      exhaustedRecoveryEvents.some((event) =>
        event.event === "message" &&
        event.message?.id === exhaustedCallbackMessageId
      ),
      true
    );

    const conflictingCallbackMessageId =
      "msg-conflicting-approval-recovery";
    const conflictingRecoveryStatePath = writeApprovalRecoveryClone(
      "codex-approval-conflicting-log-recovery",
      (state) => {
        const approval = {
          ...state.native_session_takeover.terminal_bridge_approval,
          callback_message_id: conflictingCallbackMessageId
        };
        return {
          ...state,
          status: "waiting_for_agent",
          updated_at: approval.notified_at,
          native_session_takeover: {
            ...state.native_session_takeover,
            terminal_bridge_approval: approval
          },
          callback_delivery: {
            ...state.callback_delivery,
            status: "delivered",
            message: {
              ...state.callback_delivery.message,
              id: "msg-old-before-conflicting-recovery"
            }
          }
        };
      }
    );
    const conflictingRecoveryLogPath = path.join(
      path.dirname(conflictingRecoveryStatePath),
      "events.ndjson"
    );
    const conflictingLoggedMessage = {
      ...monitoredParsed.message,
      id: conflictingCallbackMessageId,
      body: "A different payload was already logged under this stable id."
    };
    fs.writeFileSync(conflictingRecoveryLogPath, `${JSON.stringify({
      ts: conflictingLoggedMessage.ts,
      conversation_id: monitoredParsed.conversation.conversation_id,
      event: "message",
      from: conflictingLoggedMessage.from,
      to: conflictingLoggedMessage.to,
      type: conflictingLoggedMessage.type,
      requires_response: conflictingLoggedMessage.requires_response,
      round: conflictingLoggedMessage.round,
      body: conflictingLoggedMessage.body,
      message: conflictingLoggedMessage
    })}\n`, { mode: 0o600 });
    const openclawCallCountBeforeConflict =
      readJsonLines(openclawCallsPath).length;
    const conflictingRecovery = runAgentCli([
      "monitor",
      "--terminal-bridge",
      "--state",
      conflictingRecoveryStatePath,
      "--log",
      conflictingRecoveryLogPath,
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
      JSON.stringify({ "codex-work:0.1": approvalScreen }),
      ...nativeIdentityArgs
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.notEqual(conflictingRecovery.status, 0);
    assert.match(
      conflictingRecovery.stderr,
      /conflicts with its logged payload/u
    );
    assert.equal(
      readJsonLines(openclawCallsPath).length,
      openclawCallCountBeforeConflict,
      "a conflicting stable message id must fail before Gateway delivery"
    );

    fs.writeFileSync(screenPath, approvalScreen.replace("$ npm install", "$ npm install left-pad"));
    const persistedFingerprintMismatch = runAgentCli([
      "approve",
      "--state",
      statePath,
      ...nativeIdentityArgs,
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
      ...nativeIdentityArgs,
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
      ...nativeIdentityArgs,
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
      ...nativeIdentityArgs,
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
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const screenPath = path.join(tempDir, "screen.txt");
  const workspace = path.join(tempDir, "workspace");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, "› \n");
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
      "--background",
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor",
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
      })]),
      "--terminal-screens-json",
      JSON.stringify({ "codex-work:0.0": "› \n" })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const sentParsed = JSON.parse(sent.stdout);
    assert.equal(
      sentParsed.conversation.native_session_takeover.native_session_id,
      conversationId
    );
    assert.equal(
      sentParsed.conversation.native_session_takeover.terminal_agent_pid,
      33389
    );
    assert.equal(sentParsed.terminal_control.panePid, 999);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status includes terminal-controlled Codex context from rollout history", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-07-04T00:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Add AKK status context"
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

  const status = runAgentCli([
    "status",
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

  assert.equal(status.status, 0, status.stderr || status.stdout);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.source, "terminal_control");
  assert.equal(parsed.confidence, "high");
  assert.match(parsed.about, /Add AKK status context/);
  assert.match(parsed.about, /OpenClaw tool/);
  assert.deepEqual(parsed.limitations, []);
});

test("status context prefers Codex title over injected environment context", () => {
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

  const status = runAgentCli([
    "status",
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

  assert.equal(status.status, 0, status.stderr || status.stdout);
  const parsed = JSON.parse(status.stdout);
  assert.match(parsed.about, /Read the README and explain this project/);
  assert.doesNotMatch(parsed.about, /environment_context/);
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

function codexNativeIdentityArgs(options: {
  pid: number;
  sessionId: string;
  processUuid: string;
  rolloutPath: string;
}): string[] {
  return [
    "--codex-active-session-identities-json",
    JSON.stringify({
      [options.pid]: {
        sessionId: options.sessionId,
        processUuid: options.processUuid,
        processBirth: options.processUuid,
        rollout: {
          fd: "12r",
          device: "1",
          inode: "2",
          path: options.rolloutPath
        }
      }
    })
  ];
}

function agentCliTestEnv(
  args: string[],
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  let inferredRuntimeDir: string | undefined;
  const storeIndex = args.indexOf("--store-dir");
  if (storeIndex >= 0 && args[storeIndex + 1]) {
    inferredRuntimeDir = path.join(
      path.dirname(path.resolve(args[storeIndex + 1])),
      ".akk-cli-test-runtime"
    );
  } else {
    const stateIndex = args.indexOf("--state");
    if (stateIndex >= 0 && args[stateIndex + 1]) {
      const statePath = path.resolve(args[stateIndex + 1]);
      const inferredStoreDir = path.dirname(
        path.dirname(path.dirname(statePath))
      );
      inferredRuntimeDir = path.join(
        path.dirname(inferredStoreDir),
        ".akk-cli-test-runtime"
      );
    }
  }
  return {
    ...process.env,
    ...(inferredRuntimeDir && env.AKK_RUNTIME_DIR === undefined
      ? { AKK_RUNTIME_DIR: inferredRuntimeDir }
      : {}),
    ...env
  };
}

function runAgentCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: agentCliTestEnv(args, env)
  });
}

function runAgentCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 30_000
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: agentCliTestEnv(args, env)
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
    env: agentCliTestEnv(args, env)
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
    env: agentCliTestEnv(args, env)
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
  ensureStoreWritable(storeDir);
  copyManagedSessionForConversationClone(storeDir, sourceState);
  const paths = pathsForConversation(conversationId, storeDir);
  const conversationDir = paths.conversationDir;
  const statePath = paths.statePath;
  const eventLogPath = paths.logPath;
  fs.mkdirSync(conversationDir, { recursive: true });
  const cloned = mutate({
    ...sourceState,
    conversation_id: conversationId,
    ...(sourceState.session_id && sourceState.turn_id
      ? { turn_id: conversationId }
      : {}),
    store_dir: storeDir,
    conversation_dir: conversationDir,
    state_path: statePath,
    event_log_path: eventLogPath
  });
  fs.writeFileSync(statePath, `${JSON.stringify(cloned, null, 2)}\n`);
  return statePath;
}

function copyManagedSessionForConversationClone(
  targetStoreDir: string,
  sourceState: any
): void {
  const sessionId = typeof sourceState?.session_id === "string"
    ? sourceState.session_id
    : undefined;
  const nativeTakeover = sourceState?.native_session_takeover;
  if (!sessionId || nativeTakeover?.terminal_bridge !== true) {
    return;
  }

  const sourceStoreDir = typeof sourceState.store_dir === "string"
    ? sourceState.store_dir
    : undefined;
  assert.ok(
    sourceStoreDir,
    `managed Turn clone ${sourceState.conversation_id} has no source Store`
  );
  const sourceSession = loadManagedSession(sourceStoreDir, sessionId);
  const existingTarget = tryLoadManagedSession(targetStoreDir, sessionId);
  const withoutRevision = (state: typeof sourceSession) => {
    const { revision: _revision, ...rest } = state;
    return rest;
  };
  if (existingTarget) {
    assert.deepEqual(
      withoutRevision(existingTarget),
      withoutRevision(sourceSession),
      `managed Session ${sessionId} differs in cloned Store`
    );
    return;
  }

  saveManagedSession(
    targetStoreDir,
    withoutRevision(sourceSession),
    { expectedRevision: null }
  );
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
  if (process.env.AKK_TEST_TMUX_CAPTURE_FAIL === "1") {
    process.stderr.write("capture failed\\n");
    process.exit(1);
  }
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

  const fakeLsof = path.join(fakeBinDir, "lsof");
  const lsofOutput = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    ...processes.map((entry) =>
      `${path.basename(entry.command.split(/\s+/u)[0] || "agent")} ${entry.pid} me cwd DIR 1,18 64 123 ${entry.cwd}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakeLsof,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(lsofOutput)});
`,
    "utf8"
  );
  fs.chmodSync(fakeLsof, 0o755);
}

function writeTrackedFakeProcessTools(options: {
  fakeBinDir: string;
  callsPath: string;
  processes: Array<{
    pid: number;
    ppid: number;
    command: string;
    cwd: string;
  }>;
  lsofStatus: number;
  lsofRows: Array<{ command: string; pid: number; cwd: string }>;
}) {
  const fakePs = path.join(options.fakeBinDir, "ps");
  const psOutput = [
    "  PID  PPID ELAPSED COMMAND",
    ...options.processes.map((entry) =>
      `${entry.pid} ${entry.ppid} 00:01 ${entry.command}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakePs,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ command: "ps", args }) + "\\n",
  "utf8"
);
process.stdout.write(${JSON.stringify(psOutput)});
`,
    "utf8"
  );
  fs.chmodSync(fakePs, 0o755);

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  const lsofOutput = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    ...options.lsofRows.map((entry) =>
      `${entry.command} ${entry.pid} me cwd DIR 1,18 64 123 ${entry.cwd}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakeLsof,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ command: "lsof", args }) + "\\n",
  "utf8"
);
process.stdout.write(${JSON.stringify(lsofOutput)});
process.exit(${options.lsofStatus});
`,
    "utf8"
  );
  fs.chmodSync(fakeLsof, 0o755);
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

function writeFakeClaudeAgents(fakeBinDir: string, agents: unknown[]) {
  const fakeClaude = path.join(fakeBinDir, "claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(agents))});
`,
    "utf8"
  );
  fs.chmodSync(fakeClaude, 0o755);
  return fakeClaude;
}

function currentClaudeApprovalScreenForTest(command: string): string {
  return [
    " Bash command",
    "",
    `   ${command}`,
    "   Remove the exact handoff fixture",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don’t ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}

function writeAutoApprovingFakeOpenClaw(options: {
  fakeBinDir: string;
  callsPath: string;
  statePath: string;
  cliPath: string;
  claudeHome: string;
  claudeAgents: unknown[];
  policy: unknown;
  screenPath: string;
  transcriptPath: string;
  toolResultAppend: string;
  completionAppend: string;
}): string {
  const fakeOpenClaw = path.join(options.fakeBinDir, "openclaw");
  const updaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.toolResultAppend)},
  { mode: 0o600 }
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Claude is working after approval.\\n");
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.completionAppend)},
  { mode: 0o600 }
);
`;
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ kind: "gateway", args }) + "\\n",
  "utf8"
);
const paramsIndex = args.indexOf("--params");
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
const message = params.message || {};
if (
  message.metadata &&
  message.metadata.reason === "approval_required"
) {
  if (params.statePath !== ${JSON.stringify(options.statePath)}) {
    process.stderr.write("unexpected callback state path\\n");
    process.exit(2);
  }
  const fingerprint = message.metadata.approval_fingerprint;
  const approved = spawnSync(process.execPath, [
    ${JSON.stringify(options.cliPath)},
    "approve",
    "--state",
    params.statePath,
    "--expected-approval-fingerprint",
    fingerprint,
    "--auto-approved",
    "--monitor-poll-interval-ms",
    "50",
    "--auto-approval-policy-json",
    ${JSON.stringify(JSON.stringify(options.policy))},
    "--claude-home",
    ${JSON.stringify(options.claudeHome)},
    "--claude-agents-json",
    ${JSON.stringify(JSON.stringify(options.claudeAgents))}
  ], {
    encoding: "utf8",
    env: process.env
  });
  fs.appendFileSync(
    ${JSON.stringify(options.callsPath)},
    JSON.stringify({
      kind: "nested_approve",
      status: approved.status,
      stdout: approved.stdout,
      stderr: approved.stderr
    }) + "\\n",
    "utf8"
  );
  if (approved.status !== 0) {
    process.stderr.write(approved.stderr || approved.stdout);
    process.exit(approved.status || 2);
  }
  const approval = JSON.parse(approved.stdout);
  if (approval.approved !== true && approval.already_approved !== true) {
    process.stderr.write("nested auto approval was rejected: " + approved.stdout);
    process.exit(2);
  }
  const updater = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(updaterSource)}],
    { detached: true, stdio: "ignore", env: process.env }
  );
  updater.unref();
  process.stdout.write(JSON.stringify({ ok: true, auto_approved: true }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

function writeSequentialAutoApprovingFakeOpenClaw(options: {
  fakeBinDir: string;
  callsPath: string;
  statePath: string;
  cliPath: string;
  claudeHome: string;
  claudeAgents: unknown[];
  policy: unknown;
  screenPath: string;
  transcriptPath: string;
  firstRequestId: string;
  secondRequestId: string;
  firstSchedulePath: string;
  secondSchedulePath: string;
  promptClearedLogPath: string;
  redrawnFirstScreen: string;
  clearedScreen: string;
  repeatedApprovalScreen: string;
  firstResultAppend: string;
  secondRequestAppend: string;
  secondResultAppend: string;
  completionAppend: string;
}): string {
  const fakeOpenClaw = path.join(options.fakeBinDir, "openclaw");
  const firstUpdaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.redrawnFirstScreen)}
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.firstResultAppend)},
  { mode: 0o600 }
);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.clearedScreen)}
);
const promptClearedDeadline = Date.now() + 5000;
while (
  !(
    fs.existsSync(${JSON.stringify(options.promptClearedLogPath)}) &&
    fs.readFileSync(
      ${JSON.stringify(options.promptClearedLogPath)},
      "utf8"
    ).includes('"event":"terminal_bridge_approval_prompt_cleared"')
  )
) {
  if (Date.now() >= promptClearedDeadline) {
    process.exit(3);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.secondRequestAppend)},
  { mode: 0o600 }
);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.repeatedApprovalScreen)}
);
`;
  const secondUpdaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.secondResultAppend)},
  { mode: 0o600 }
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.clearedScreen)}
);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.completionAppend)},
  { mode: 0o600 }
);
`;
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ kind: "gateway", args }) + "\\n",
  "utf8"
);
const paramsIndex = args.indexOf("--params");
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
const message = params.message || {};
if (
  message.metadata &&
  message.metadata.reason === "approval_required"
) {
  if (params.statePath !== ${JSON.stringify(options.statePath)}) {
    process.stderr.write("unexpected callback state path\\n");
    process.exit(2);
  }
  const fingerprint = message.metadata.approval_fingerprint;
  const requestId =
    message.metadata.approval_candidate &&
    message.metadata.approval_candidate.policy_evidence &&
    message.metadata.approval_candidate.policy_evidence.request_id;
  const approved = spawnSync(process.execPath, [
    ${JSON.stringify(options.cliPath)},
    "approve",
    "--state",
    params.statePath,
    "--expected-approval-fingerprint",
    fingerprint,
    "--auto-approved",
    "--monitor-poll-interval-ms",
    "50",
    "--auto-approval-policy-json",
    ${JSON.stringify(JSON.stringify(options.policy))},
    "--claude-home",
    ${JSON.stringify(options.claudeHome)},
    "--claude-agents-json",
    ${JSON.stringify(JSON.stringify(options.claudeAgents))}
  ], {
    encoding: "utf8",
    env: process.env
  });
  fs.appendFileSync(
    ${JSON.stringify(options.callsPath)},
    JSON.stringify({
      kind: "nested_approve",
      request_id: requestId,
      status: approved.status,
      stdout: approved.stdout,
      stderr: approved.stderr
    }) + "\\n",
    "utf8"
  );
  if (approved.status !== 0) {
    process.stderr.write(approved.stderr || approved.stdout);
    process.exit(approved.status || 2);
  }
  const approval = JSON.parse(approved.stdout);
  if (approval.approved !== true && approval.already_approved !== true) {
    process.stderr.write("nested auto approval was rejected: " + approved.stdout);
    process.exit(2);
  }
  const scheduleOnce = (markerPath, source) => {
    try {
      const fd = fs.openSync(markerPath, "wx", 0o600);
      fs.closeSync(fd);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      return;
    }
    const updater = spawn(
      process.execPath,
      ["-e", source],
      { detached: true, stdio: "ignore", env: process.env }
    );
    updater.unref();
  };
  if (requestId === ${JSON.stringify(options.firstRequestId)}) {
    scheduleOnce(
      ${JSON.stringify(options.firstSchedulePath)},
      ${JSON.stringify(firstUpdaterSource)}
    );
  } else if (requestId === ${JSON.stringify(options.secondRequestId)}) {
    scheduleOnce(
      ${JSON.stringify(options.secondSchedulePath)},
      ${JSON.stringify(secondUpdaterSource)}
    );
  } else {
    process.stderr.write("unexpected approval request id: " + String(requestId) + "\\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: true, auto_approved: true }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

function findTerminalDispatchLedgerPath(
  conversationId: string,
  runtimeDir: string
): string {
  const ledgerDir = path.join(
    runtimeDir,
    "terminal-dispatch"
  );
  const match = fs.readdirSync(ledgerDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(ledgerDir, name))
    .find((ledgerPath) => {
      try {
        return JSON.parse(
          fs.readFileSync(ledgerPath, "utf8")
        ).conversation_id === conversationId;
      } catch {
        return false;
      }
    });
  assert.ok(match, `terminal dispatch ledger for ${conversationId}`);
  return match;
}

function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
