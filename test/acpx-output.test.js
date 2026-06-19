import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAcpxOutput } from "../dist/src/acpx-output.js";

const base = {
  conversationId: "task-1",
  from: "openclaw",
  to: "claude-code",
  round: 3,
  now: new Date("2026-05-16T00:00:00.000Z")
};

test("normalizes structured protocol JSON as message event", () => {
  const events = normalizeAcpxOutput({
    ...base,
    output: '{"from":"claude-code","to":"openclaw","type":"question","requires_response":true,"body":"Choose REST or GraphQL?"}'
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].event, "message");
  assert.equal(events[0].source, "normalized_acpx");
  assert.equal(events[0].type, "question");
  assert.equal(events[0].body, "Choose REST or GraphQL?");
});

test("normalizes JSON tool and permission events", () => {
  const events = normalizeAcpxOutput({
    ...base,
    output: [
      '{"event":"tool_call_started","tool_name":"Read","message":"reading file"}',
      '{"event":"permission_request","permission":"filesystem.write","message":"Need write access"}',
      '{"event":"tool_call","status":"finished","tool":"Read","message":"done"}'
    ].join("\n")
  });

  assert.deepEqual(events.map((event) => event.event), [
    "tool_call_started",
    "permission_request",
    "tool_call_finished"
  ]);
  assert.equal(events[0].tool_name, "Read");
  assert.equal(events[1].permission, "filesystem.write");
  assert.equal(events[2].tool_name, "Read");
});

test("normalizes common textual acpx status lines", () => {
  const events = normalizeAcpxOutput({
    ...base,
    output: [
      "Agent queued for session bidirectional",
      "Tool call started: Bash",
      "Permission request: approve filesystem write",
      "Tool call finished: Bash",
      "Agent completed"
    ].join("\n")
  });

  assert.deepEqual(events.map((event) => event.event), [
    "agent_status",
    "tool_call_started",
    "permission_request",
    "tool_call_finished",
    "agent_status"
  ]);
  assert.equal(events[0].status, "queued");
  assert.equal(events[1].tool_name, "Bash");
  assert.equal(events[4].status, "completed");
});

test("ignores unclassified text lines", () => {
  const events = normalizeAcpxOutput({
    ...base,
    output: "ordinary model prose without status markers"
  });

  assert.deepEqual(events, []);
});
