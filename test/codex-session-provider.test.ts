import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildForkContextPackage,
  codexSessionsFromThreadRows,
  discoverCodexProcesses,
  extractResumeSessionId,
  listActiveCodexCli,
  normalizeCodexAcpxModel,
  parseCodexRolloutJsonl,
  parseCodexRolloutModel
} from "../src/codex-session-provider.js";

const SESSION_ID = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";

test("Codex session provider normalizes thread rows and degrades missing rollout paths", () => {
  const sessions = codexSessionsFromThreadRows([
    {
      id: "older",
      cwd: "/repo/old",
      title: "old work",
      updated_at_ms: 10
    },
    {
      id: SESSION_ID,
      cwd: "/repo/acpx",
      rollout_path: "/Users/me/.codex/sessions/rollout.jsonl",
      title: "  inspect ACPX changes  ",
      preview: "unused preview",
      first_user_message: "pull latest code",
      updated_at_ms: 20,
      archived: 0
    },
    {
      id: "missing-cwd",
      title: "invalid"
    }
  ]);

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, SESSION_ID);
  assert.equal(sessions[0].capability, "full");
  assert.equal(sessions[0].title, "inspect ACPX changes");
  assert.equal(sessions[1].capability, "metadata_only");
  assert.equal(sessions[1].capabilityReason, "missing rollout_path");
});

test("Codex process discovery separates native CLI from ACP adapter processes", () => {
  const processes = discoverCodexProcesses([
    {
      pid: 100,
      ppid: 1,
      cwd: "/repo/acpx",
      command: `node /Users/me/.npm-global/bin/codex resume ${SESSION_ID}`
    },
    {
      pid: 101,
      ppid: 100,
      cwd: "/repo/acpx",
      command: `/vendor/bin/codex resume ${SESSION_ID}`
    },
    {
      pid: 200,
      cwd: "/repo/openclaw",
      command: "node /Users/me/.npm-global/bin/codex -- --full-auto"
    },
    {
      pid: 300,
      cwd: "/repo/openclaw",
      command: "/Users/me/.npm/_npx/pkg/node_modules/@zed-industries/codex-acp-darwin-arm64/bin/codex-acp"
    },
    {
      pid: 350,
      cwd: "/repo/openclaw",
      command: "node /Users/me/.npm-global/bin/codex app-server --listen stdio://"
    },
    {
      pid: 400,
      cwd: "/repo/openclaw",
      command: "rg codex"
    }
  ]);

  assert.equal(processes.length, 4);
  assert.deepEqual(processes.map((process) => process.kind), [
    "codex_cli",
    "codex_cli",
    "codex_cli",
    "codex_acp"
  ]);
  assert.equal(processes[0].sessionId, SESSION_ID);
  assert.equal(processes[0].confidence, "high");
  assert.equal(processes[2].confidence, "medium");
  assert.equal(listActiveCodexCli(processes).length, 3);
});

test("Codex resume session ids are extracted only from resume commands", () => {
  assert.equal(extractResumeSessionId(`codex resume ${SESSION_ID}`), SESSION_ID);
  assert.equal(extractResumeSessionId(`node bin/codex -- --full-auto`), undefined);
});

test("Codex rollout parser extracts bounded user assistant and command context", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-06-20T14:05:25.750Z",
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        base_instructions: { text: "very long instructions that should not be extracted" }
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:25.758Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "帮我拉取一下最新的代码"
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:38.452Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "已经拉取并总结完成" }]
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:39.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-1",
        last_agent_message: "已经拉取并总结完成"
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:40.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        command: "git pull",
        cwd: "/repo/acpx",
        status: "0"
      }
    }),
    "{not-json"
  ].join("\n");

  const excerpt = parseCodexRolloutJsonl(rollout, {
    maxMessages: 2,
    maxCommands: 1
  });

  assert.deepEqual(excerpt.messages.map((message) => [message.role, message.text]), [
    ["user", "帮我拉取一下最新的代码"],
    ["assistant", "已经拉取并总结完成"]
  ]);
  assert.deepEqual(excerpt.commands, [{
    command: "git pull",
    cwd: "/repo/acpx",
    status: "0",
    timestamp: "2026-06-20T14:05:40.000Z"
  }]);
  assert.deepEqual(excerpt.turns, [{
    userText: "帮我拉取一下最新的代码",
    userTextHash: createHash("sha256").update("帮我拉取一下最新的代码").digest("hex"),
    userTimestamp: "2026-06-20T14:05:25.758Z",
    turnId: "turn-1",
    completedAt: "2026-06-20T14:05:39.000Z",
    lastAssistantMessage: "已经拉取并总结完成"
  }]);
  assert.equal(excerpt.skippedLines, 1);
});

test("Codex rollout parser retains the latest bounded task-completion turns", () => {
  const rollout = ["first", "second", "third"].flatMap((message, index) => [
    JSON.stringify({
      timestamp: `2026-06-20T14:0${index}:00.000Z`,
      type: "event_msg",
      payload: { type: "user_message", message }
    }),
    JSON.stringify({
      timestamp: `2026-06-20T14:0${index}:30.000Z`,
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: `turn-${index}`,
        last_agent_message: `${message} complete`
      }
    })
  ]).join("\n");

  const excerpt = parseCodexRolloutJsonl(rollout, { maxTurns: 2 });
  assert.deepEqual(excerpt.turns.map((turn) => [turn.userText, turn.lastAssistantMessage]), [
    ["second", "second complete"],
    ["third", "third complete"]
  ]);
  assert.equal(excerpt.truncated, true);
});

test("Codex rollout parser discovers the native model for ACPX resume", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-06-20T14:05:25.750Z",
      type: "session_meta",
      payload: {
        id: SESSION_ID
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:25.758Z",
      type: "turn_context",
      payload: {
        model: "gpt-5.5",
        collaboration_mode: {
          settings: {
            model: "gpt-5.4"
          }
        }
      }
    })
  ].join("\n");

  assert.deepEqual(parseCodexRolloutModel(rollout), {
    model: "gpt-5.5",
    acpxModel: "gpt-5.5[medium]",
    source: "turn_context"
  });
  assert.equal(normalizeCodexAcpxModel("gpt-5.5[high]"), "gpt-5.5[high]");
});

test("Codex rollout parser bounds long fork context before OpenClaw summarization", () => {
  const rollout = [
    JSON.stringify({
      timestamp: "2026-06-20T14:05:25.758Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "first"
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:38.452Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "x".repeat(100)
      }
    }),
    JSON.stringify({
      timestamp: "2026-06-20T14:05:39.452Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "overflow"
      }
    })
  ].join("\n");
  const session = codexSessionsFromThreadRows([{
    id: SESSION_ID,
    cwd: "/repo/acpx",
    rollout_path: "/rollout.jsonl",
    title: "ACPX work",
    updated_at_ms: 100
  }])[0];

  const excerpt = parseCodexRolloutJsonl(rollout, {
    maxMessages: 2,
    maxTextLength: 30
  });
  const context = buildForkContextPackage(session, excerpt);

  assert.equal(context.source.sessionId, SESSION_ID);
  assert.equal(context.source.cwd, "/repo/acpx");
  assert.equal(context.messages.length, 2);
  assert.match(context.messages[1].text, /\[truncated\]$/);
  assert.equal(context.truncated, true);
});
