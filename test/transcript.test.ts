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
        status: "waiting_for_agent",
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

  assert.match(transcript, /\[conversation_created\] task-1 status=waiting_for_agent/);
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

test("reports invalid NDJSON line numbers", () => {
  assert.throws(
    () => parseNdjson('{"event":"ok"}\nnot-json'),
    /invalid NDJSON at line 2/
  );
});
