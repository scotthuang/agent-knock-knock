import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTerminalWatchCliAdapter
} from "../../src/terminal-watch-cli-adapter.js";
import {
  type TerminalWatchCallbackInput
} from "../../src/terminal-watch-callback-cli-adapter.js";
import {
  exactTerminalObservation
} from "./fixtures.js";

test("Claude fallback Watches freeze acceptance before a repeated request and survive terminal exit", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-terminal-watch-claude-fallback-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, ".claude");
  const workspace = path.join(root, "workspace");
  const sessionId = "019f0000-0000-7000-8000-000000000295";
  const projectsDirectory = path.join(
    claudeHome,
    "projects",
    workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  const transcriptPath = path.join(projectsDirectory, `${sessionId}.jsonl`);
  const storeDir = path.join(root, "store");
  fs.mkdirSync(projectsDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true });
  const pid = 6295;
  const startedAt = 1784870000000;
  const agentRows = [{
    pid,
    cwd: workspace,
    kind: "interactive" as const,
    sessionId,
    startedAt,
    status: "idle" as const
  }];
  const terminal: Record<string, any> = {
    id: "terminal:v2:claude:fallback-fixture",
    source: "terminal",
    agent: "claude",
    pid,
    workspace,
    cwd: workspace,
    native_agent_session_id: sessionId,
    agent_version: "2.1.237",
    lifecycle_binding_token: "c".repeat(64),
    activity_state: "idle",
    approval_state: { scanned: true, blocked: false, approvable: false },
    terminal_control: {
      kind: "tmux",
      target: "claude-fallback:0.0",
      session: "claude-fallback",
      window: 0,
      pane: 0,
      panePid: 6290,
      currentCommand: "claude",
      currentPath: workspace,
      capabilities: ["screen_status", "durable_completion"]
    }
  };
  let terminals = [terminal];
  let now = new Date("2026-08-21T01:00:00.100Z");
  const callbacks: TerminalWatchCallbackInput[] = [];
  const callbackRoute = {
    schema: "agent-knock-knock/callback-route" as const,
    version: 1 as const,
    transport: "openclaw_gateway_v1" as const,
    profile_id: "openclaw",
    profile_revision: "legacy-v1",
    controller_session_id: "agent:main:claude-fallback",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => agentRows,
    now: () => new Date(now),
    randomUUID: () => "00000000-0000-4000-8000-000000000295",
    storeDirFromOptions: () => storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {},
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  const request = "Return this exact Claude fallback result";
  const requestHash = createHash("sha256").update(request).digest("hex");
  const options = { storeDir, claudeHome, callbackRoute };
  const prepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "claude",
      pid,
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-claude-fallback-watch",
    physicalToken: "b".repeat(64)
  });
  assert.ok(prepared);
  assert.equal(
    prepared.anchor.schema,
    "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  );

  const promptUuid = "019f0000-0000-7000-8000-000000000294";
  const thinkingUuid = "019f0000-0000-7000-8000-000000000293";
  const textUuid = "019f0000-0000-7000-8000-000000000292";
  const durationUuid = "019f0000-0000-7000-8000-000000000291";
  const messageId = "019f0000-0000-7000-8000-000000000290";
  const base = (
    uuid: string,
    parentUuid: string | null,
    timestamp: string
  ) => ({
    uuid,
    parentUuid,
    isSidechain: false,
    entrypoint: "cli",
    timestamp,
    sessionId,
    version: terminal.agent_version,
    cwd: workspace
  });
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      ...base(promptUuid, null, "2026-08-21T01:00:00.200Z"),
      type: "user",
      promptId: "019f0000-0000-7000-8000-000000000289",
      message: { role: "user", content: request }
    })}\n`,
    { mode: 0o600 }
  );
  await facade.attachUserExplicitFallbackWatch({ options, prepared });
  const repeatedPrepared = await facade.prepareUserExplicitFallbackWatch({
    options,
    terminal: {
      conversationId: String(terminal.id),
      agent: "claude",
      pid,
      terminalControl: terminal.terminal_control as never
    },
    requestHash,
    messageId: "message-repeated-claude-fallback-watch",
    physicalToken: "8".repeat(64)
  });
  assert.ok(repeatedPrepared);
  assert.equal(callbacks.length, 0);

  const repeatedPromptUuid = "019f0000-0000-7000-8000-000000000288";
  const repeatedTextUuid = "019f0000-0000-7000-8000-000000000286";
  const repeatedDurationUuid = "019f0000-0000-7000-8000-000000000285";
  const repeatedMessageId = "019f0000-0000-7000-8000-000000000284";
  fs.appendFileSync(
    transcriptPath,
    [
      {
        ...base(thinkingUuid, promptUuid, "2026-08-21T01:00:00.250Z"),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{ type: "thinking", thinking: "not returned" }]
        }
      },
      {
        ...base(textUuid, thinkingUuid, "2026-08-21T01:00:00.300Z"),
        type: "assistant",
        message: {
          role: "assistant",
          id: messageId,
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "Claude fallback completion"
          }]
        }
      },
      {
        ...base(durationUuid, textUuid, "2026-08-21T01:00:00.400Z"),
        type: "system",
        subtype: "turn_duration",
        durationMs: 200
      },
      {
        ...base(
          repeatedPromptUuid,
          null,
          "2026-08-21T01:00:00.500Z"
        ),
        type: "user",
        promptId: "019f0000-0000-7000-8000-000000000287",
        message: { role: "user", content: request }
      },
      {
        ...base(
          repeatedTextUuid,
          repeatedPromptUuid,
          "2026-08-21T01:00:00.600Z"
        ),
        type: "assistant",
        message: {
          role: "assistant",
          id: repeatedMessageId,
          stop_reason: "end_turn",
          content: [{
            type: "text",
            text: "Repeated Claude fallback completion"
          }]
        }
      },
      {
        ...base(
          repeatedDurationUuid,
          repeatedTextUuid,
          "2026-08-21T01:00:00.700Z"
        ),
        type: "system",
        subtype: "turn_duration",
        durationMs: 100
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
  );
  await facade.attachUserExplicitFallbackWatch({
    options,
    prepared: repeatedPrepared
  });
  terminals = [];
  now = new Date("2026-08-21T01:00:02.000Z");
  await facade.runReconcileWatches(options);
  await facade.runReconcileWatches(options);

  assert.equal(callbacks.length, 2);
  assert.deepEqual(
    callbacks.map(({ completionText }) => completionText).sort(),
    [
      "Claude fallback completion",
      "Repeated Claude fallback completion"
    ]
  );
});
