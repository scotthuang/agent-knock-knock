import test from "node:test";
import assert from "node:assert/strict";
import { formatTranscript, parseNdjson } from "../src/transcript.js";

test("parses NDJSON logs", () => {
  const events = parseNdjson([
    '{"event":"conversation_created","conversation_id":"task-1"}',
    '{"event":"message","from":"openclaw","to":"claude-code","type":"task","requires_response":true,"round":1,"body":"Build it."}'
  ].join("\n"));

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "task");
});

test("formats readable transcript for conversation messages", () => {
  const transcript = formatTranscript([
    {
      event: "conversation_created",
      conversation_id: "task-1",
      conversation: {
        status: "waiting_for_claude",
        user_request: "Build a feature"
      }
    },
    {
      event: "message",
      from: "openclaw",
      to: "claude-code",
      type: "task",
      requires_response: true,
      round: 1,
      body: "Build a feature"
    },
    {
      event: "conversation_closed",
      status: "done",
      response_rounds_used: 1,
      manager_final: "Delivered."
    }
  ]);

  assert.match(transcript, /\[conversation_created\] task-1 status=waiting_for_claude/);
  assert.match(transcript, /Request: Build a feature/);
  assert.match(transcript, /\[message\] openclaw -> claude-code type=task round=1 requires_response=true/);
  assert.match(transcript, /\[conversation_closed\] status=done rounds=1/);
});

test("hides raw exchange events unless requested", () => {
  const events = [
    {
      event: "raw_exchange",
      from: "openclaw",
      to: "claude-code",
      round: 1,
      response: "raw response"
    }
  ];

  assert.equal(formatTranscript(events), "\n");
  assert.match(formatTranscript(events, { includeRaw: true }), /\[raw_exchange\] openclaw -> claude-code round=1/);
});

test("hides normalized acpx messages by default and shows them with raw output", () => {
  const events = [
    {
      event: "message",
      source: "normalized_acpx",
      from: "claude-code",
      to: "openclaw",
      type: "question",
      requires_response: true,
      round: 2,
      body: "A normalized duplicate."
    },
    {
      event: "tool_call_started",
      source: "normalized_acpx",
      from: "claude-code",
      to: "openclaw",
      round: 2,
      tool_name: "Bash",
      body: "Tool call started: Bash"
    }
  ];

  assert.equal(formatTranscript(events), "\n");
  const rawTranscript = formatTranscript(events, { includeRaw: true });
  assert.match(rawTranscript, /\[message\] claude-code -> openclaw round=2 type=question/);
  assert.match(rawTranscript, /\[tool_call_started\] claude-code -> openclaw round=2 tool=Bash/);
});

test("reports invalid NDJSON line numbers", () => {
  assert.throws(
    () => parseNdjson('{"event":"ok"}\nnot-json'),
    /invalid NDJSON at line 2/
  );
});
