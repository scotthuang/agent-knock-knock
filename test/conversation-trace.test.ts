import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConversationTrace } from "../src/conversation-trace.js";
import { resolveExecutor, type Conversation } from "../src/protocol.js";
import type { EventRecord } from "../src/store.js";

function conversation(root: string): Conversation {
  return {
    session_id: "session-trace",
    turn_id: "turn-trace",
    conversation_id: "turn-trace",
    user_request: "trace the task",
    openclaw_session: "agent:main:trace",
    claude_session: "",
    executor: resolveExecutor({ kind: "codex", session: "codex-trace" }),
    workspace: root,
    status: "running",
    response_rounds_used: 0,
    soft_limit: 2,
    hard_limit: 4,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    conversation_dir: root
  };
}

test("conversation trace selects the latest launch and redacts bounded output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-trace-"));
  try {
    const oldOutput = path.join(root, "old.log");
    const outputPath = path.join(root, "current.log");
    fs.writeFileSync(oldOutput, "old output\n");
    fs.writeFileSync(outputPath, [
      "[client] session/request_permission (approved)",
      "[thinking] private chain of thought",
      "[tool] shell --message-json '{\"secret\":\"x\"}' --token top-secret (completed)",
      "input: gateway_token=secret-value",
      "output:",
      "password=hunter2",
      "ordinary tool output",
      "A sufficiently long agent response",
      "[done] completed"
    ].join("\n"));
    const events: EventRecord[] = [
      { event: "executor_launch", output_path: oldOutput },
      { event: "executor_message_launch", output_path: outputPath },
      {
        event: "callback_delivery",
        ts: "2026-08-14T00:00:01.000Z",
        status: "accepted",
        pid: 42
      }
    ];

    assert.deepEqual(
      buildConversationTrace(conversation(root), events, path.join(root, "events.ndjson")),
      {
        source: "executor_output_log",
        output_path: outputPath,
        thinking_redacted_count: 1,
        client_events: [{
          name: "session/request_permission",
          status: "approved"
        }],
        permission_requests: [{
          body: "[client] session/request_permission (approved)"
        }],
        tool_calls: [{
          name: "shell --message-json <redacted>",
          status: "completed",
          input_preview: "gateway_token=<redacted>",
          output_preview: "password=<redacted>\nordinary tool output\nA sufficiently long agent response"
        }],
        agent_messages: [{ kind: "thinking", body: "[redacted]" }],
        done_events: [{ status: "completed" }],
        monitor_events: [
          {
            ts: undefined,
            event: "executor_launch",
            status: undefined,
            pid: undefined,
            executor_pid: undefined,
            reason: undefined,
            output_path: oldOutput
          },
          {
            ts: undefined,
            event: "executor_message_launch",
            status: undefined,
            pid: undefined,
            executor_pid: undefined,
            reason: undefined,
            output_path: outputPath
          },
          {
            ts: "2026-08-14T00:00:01.000Z",
            event: "callback_delivery",
            status: "accepted",
            pid: 42,
            executor_pid: undefined,
            reason: undefined,
            output_path: undefined
          }
        ],
        safety: {
          thinking: "redacted",
          tool_output: "summarized",
          callback_payloads: "redacted"
        }
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversation trace keeps the historical events-only fallback path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-trace-fallback-"));
  try {
    const trace = buildConversationTrace(
      conversation(root),
      [],
      path.join(root, "events.ndjson")
    );
    assert.equal(trace.source, "events_only");
    assert.equal(trace.output_path, path.join(root, "codex-output.log"));
    assert.deepEqual(trace.monitor_events, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("conversation trace treats an empty launch output path as absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-trace-empty-launch-"));
  try {
    const fallbackPath = path.join(root, "codex-output.log");
    fs.writeFileSync(fallbackPath, "[done] fallback completed\n");
    const trace = buildConversationTrace(
      conversation(root),
      [{ event: "executor_launch", output_path: "" }],
      path.join(root, "events.ndjson")
    );
    assert.equal(trace.source, "executor_output_log");
    assert.equal(trace.output_path, fallbackPath);
    assert.deepEqual(trace.done_events, [{ status: "fallback completed" }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
