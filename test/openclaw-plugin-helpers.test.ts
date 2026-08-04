import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  formatAkkRespondCommandResult,
  parseAkkCommand,
  resolvePluginStoreDir
} from "../src/openclaw-plugin-helpers.js";

test("bare /akk task leaves routing unset for unique-pane selection", () => {
  assert.deepEqual(
    parseAkkCommand("inspect the configured workspace"),
    {
      action: "delegate",
      request: "inspect the configured workspace"
    }
  );
});

test("selector-first /akk messages target an existing tmux session", () => {
  assert.deepEqual(
    parseAkkCommand("claude: review the API"),
    {
      action: "send",
      selector: "claude",
      message: "review the API"
    }
  );
  assert.deepEqual(
    parseAkkCommand("@a1b2c3d4: check the diff"),
    {
      action: "send",
      selector: "@a1b2c3d4",
      message: "check the diff"
    }
  );
  assert.deepEqual(parseAkkCommand("codex review the API"), {
    action: "delegate",
    request: "codex review the API"
  });
});

test("/akk help lists the supported tmux executors", () => {
  const usage = akkUsageText();
  assert.match(usage, /\/akk <request>/);
  assert.match(usage, /\/akk codex: <request>/);
  assert.match(usage, /\/akk claude: <request>/);
  assert.match(usage, /\/akk <session-selector>: <message>/);
  assert.match(usage, /\/akk doctor/);
  assert.match(usage, /\/akk respond <turn-selector>: <answer>/);
  assert.match(usage, /\/akk approve <turn-selector>/);
  assert.doesNotMatch(
    usage,
    /\/akk (?:status|respond|approve|cancel)[^\n]*session-selector/u
  );
  assert.doesNotMatch(usage, /\/akk (?:describe|send|renew|retry-callback|close)\b/u);
});

test("/akk doctor ignores the removed top-level workspace and uses the OpenClaw binary", () => {
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("doctor"),
      {
        workspace: "/work/project",
        openclawBin: "/opt/openclaw/bin/openclaw"
      }
    ),
    [
      "doctor",
      "--openclaw-bin",
      "/opt/openclaw/bin/openclaw"
    ]
  );
  assert.throws(
    () => parseAkkCommand("doctor tmux"),
    /Usage: \/akk doctor/u
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(parseAkkCommand("doctor"), {}),
    ["doctor"]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(parseAkkCommand("doctor"), {
      workspace: "relative/project"
    }),
    ["doctor"]
  );
});

test("runtime command arguments never include the removed top-level workspace", () => {
  const commands = [
    "list",
    "status conversation-1",
    "@a1b2c3d4: continue",
    "respond conversation-1: use JSON",
    "approve conversation-1 --expected-approval-fingerprint approval-1",
    "cancel conversation-1",
    "renew conversation-1 20",
    "retry-callback conversation-1",
    "close conversation-1 done"
  ];

  for (const input of commands) {
    const args = buildAkkCommandCliArgs(parseAkkCommand(input), {
      workspace: "/legacy/project"
    });
    assert.ok(args, input);
    assert.equal(args.includes("--workspace"), false, input);
  }
});

test("/akk accepts selector-first sends without treating a Turn as the target", () => {
  assert.deepEqual(
    parseAkkCommand("latest: continue with the tests"),
    {
      action: "send",
      selector: "latest",
      message: "continue with the tests"
    }
  );
  assert.deepEqual(
    parseAkkCommand("codex: review the diff"),
    {
      action: "send",
      selector: "codex",
      message: "review the diff"
    }
  );
  assert.deepEqual(parseAkkCommand("status"), {
    action: "status",
    turnId: undefined
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("status"),
      { workspace: "/work/project" }
    ),
    ["status", "--reconcile"]
  );
  assert.throws(
    () => parseAkkCommand("send latest: continue"),
    /syntax changed/u
  );
  assert.throws(
    () => parseAkkCommand("describe latest"),
    /describe was removed/u
  );
});

test("/akk respond keeps an answer inside one exact in-flight Turn", () => {
  assert.deepEqual(
    parseAkkCommand("respond @a1b2c3d4: use the existing JSON format"),
    {
      action: "respond",
      turnId: "@a1b2c3d4",
      message: "use the existing JSON format"
    }
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("respond turn-123: use the existing JSON format"),
      { storeDir: "/private/akk-store" }
    ),
    [
      "respond",
      "--turn",
      "turn-123",
      "--message",
      "use the existing JSON format",
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.throws(
    () => parseAkkCommand("respond @a1b2c3d4"),
    /Usage: \/akk respond <turn-selector>: <answer>/u
  );
  assert.throws(
    () => parseAkkCommand("respond @a1b2c3d4:"),
    /Usage: \/akk respond <turn-selector>: <answer>/u
  );
  assert.throws(
    () => parseAkkCommand("reply @a1b2c3d4: answer"),
    /use \/akk respond/u
  );

  const submitted = formatAkkRespondCommandResult({
    submission_outcome: "submitted",
    session_id: "session-respond",
    turn_id: "turn-respond",
    status: "async_pending"
  });
  assert.equal(submitted.isError, false);
  assert.match(submitted.text, /^AKK response sent\.$/mu);
  assert.match(submitted.text, /^session: session-respond$/mu);
  assert.match(submitted.text, /^turn: turn-respond$/mu);
});

test("/akk respond reports an uncertain submission and forbids automatic retry", () => {
  const formatted = formatAkkRespondCommandResult({
    submission_outcome: "uncertain",
    session_id: "session-uncertain",
    turn_id: "turn-uncertain",
    status: "submission_uncertain"
  });

  assert.equal(formatted.isError, true);
  assert.match(formatted.text, /may have delivered the response/u);
  assert.match(formatted.text, /submission outcome is uncertain/u);
  assert.match(formatted.text, /do not retry automatically/u);
  assert.doesNotMatch(formatted.text, /^AKK response sent\.$/mu);
});

test("/akk respond reports an aborted submission as unsent and safe to retry", () => {
  const formatted = formatAkkRespondCommandResult({
    submission_outcome: "aborted",
    conversation: {
      conversation_id: "legacy-aborted-turn",
      status: "waiting_for_openclaw"
    }
  });

  assert.equal(formatted.isError, true);
  assert.match(formatted.text, /^AKK response was not sent\.$/mu);
  assert.match(formatted.text, /safe to retry this response/u);
  assert.match(formatted.text, /^session: legacy-aborted-turn$/mu);
  assert.match(formatted.text, /^turn: legacy-aborted-turn$/mu);
  assert.doesNotMatch(formatted.text, /^AKK response sent\.$/mu);
});

test("/akk stateful commands consistently use the trusted plugin store", () => {
  const config = {
    workspace: "/legacy/project",
    storeDir: "/private/akk-store",
    idleTimeoutMinutes: 45
  };
  const commands = [
    "list",
    "status conversation-1",
    "@a1b2c3d4: continue",
    "respond conversation-1: use JSON",
    "approve conversation-1 --expected-approval-fingerprint approval-1",
    "cancel conversation-1",
    "renew conversation-1 20",
    "retry-callback conversation-1",
    "close conversation-1 done"
  ];

  for (const input of commands) {
    const args = buildAkkCommandCliArgs(parseAkkCommand(input), config);
    assert.ok(args, input);
    assert.deepEqual(
      args.slice(args.indexOf("--store-dir"), args.indexOf("--store-dir") + 2),
      ["--store-dir", "/private/akk-store"],
      input
    );
    assert.equal(args.includes("--workspace"), false, input);
  }
});

test("/akk terminal send configures a real OpenClaw callback", () => {
  const args = buildAkkCommandCliArgs(
    parseAkkCommand("@a1b2c3d4: continue"),
    {
      workspace: "/work/project",
      storeDir: "/private/akk-store",
      openclawBin: "/opt/openclaw/bin/openclaw",
      agentTimeoutMinutes: 90,
      agentHardTimeoutMinutes: 600
    },
    { sessionKey: "agent:chat:current" }
  );

  assert.ok(args);
  assert.deepEqual(optionValue(args, "--gateway-method"), AKK_CALLBACK_METHOD);
  assert.deepEqual(optionValue(args, "--gateway-session"), "agent:chat:current");
  assert.deepEqual(optionValue(args, "--openclaw-session"), "agent:chat:current");
  assert.deepEqual(optionValue(args, "--openclaw-bin"), "/opt/openclaw/bin/openclaw");
  assert.equal(optionValue(args, "--workspace"), undefined);
  assert.deepEqual(optionValue(args, "--session"), "@a1b2c3d4");
  assert.equal(optionValue(args, "--conversation"), undefined);
  assert.deepEqual(optionValue(args, "--agent-timeout-minutes"), "90");
  assert.deepEqual(optionValue(args, "--agent-hard-timeout-minutes"), "600");
  assert.equal(args.includes("--background"), true);
});

test("/akk approve requires and forwards an exact approval fingerprint", () => {
  assert.throws(
    () => parseAkkCommand("approve conversation-1"),
    /expected-approval-fingerprint/u
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(
        "approve conversation-1 --expected-approval-fingerprint approval-1"
      ),
      {
        workspace: "/work/project",
        storeDir: "/private/akk-store"
      }
    ),
    [
      "approve",
      "--turn",
      "conversation-1",
      "--expected-approval-fingerprint",
      "approval-1",
      "--store-dir",
      "/private/akk-store"
    ]
  );
});

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

test("/akk list renders each live terminal once with its managed-turn context", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      short_ref: "@terminal1",
      agent: "codex",
      process_state: "active",
      activity_state: "idle",
      terminal_control: { target: "work:0.0" },
      managed: {
        session_id: "session-managed-long-id",
        session_short_ref: "@session1",
        current_turn: null,
        recent_turn: {
          conversation_id: "managed-1",
          short_ref: "@managed1",
          agent: "codex",
          lifecycle_state: "idle",
          request: "Review the repository",
          available_actions: {
            status: { arguments: { turn_id: "managed-1" } }
          }
        },
        turn_count: 3,
        hidden_turn_count: 2
      }
    }]
  });

  assert.match(text, /AKK terminals \(1 live, 0 unavailable managed turns\)/u);
  assert.match(text, /@terminal1 \| codex \| active \| idle \| tmux work:0\.0/u);
  assert.match(text, /AKK session: @session1/u);
  assert.match(text, /recent turn: @managed1 \| codex \| idle \| Review the repository/u);
  assert.match(text, /recent turn actions: status/u);
  assert.match(text, /older managed turns: 2/u);
  assert.doesNotMatch(text, /managed-1/u);
  assert.doesNotMatch(text, /delegated|terminal-controlled/u);
});

test("/akk list exposes the exact orphaned terminal dispatch recovery command", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      short_ref: "@terminal1",
      agent: "codex",
      process_state: "active",
      orphaned_terminal_dispatch: {
        message_id: "message-1",
        recovery:
          "/akk close terminal:v2:tmux:codex:work:0.0:1234 " +
          "--expected-message-id message-1"
      }
    }]
  });

  assert.match(
    text,
    /recovery: \/akk close terminal:v2:tmux:codex:work:0\.0:1234 --expected-message-id message-1/u
  );
});

test("/akk list explains a terminal management conflict and its recovery", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      short_ref: "@terminal1",
      agent: "codex",
      process_state: "active",
      activity_state: "idle",
      management_state: "conflict",
      management_conflict: {
        reason: "dispatch owner belongs to another AKK store",
        recovery: "use the AKK store that owns the current dispatch"
      }
    }],
    unavailable_managed_turns: []
  });

  assert.match(
    text,
    /management conflict: dispatch owner belongs to another AKK store/u
  );
  assert.match(
    text,
    /recovery: use the AKK store that owns the current dispatch/u
  );
});

test("/akk list renders current, expanded history, and unavailable managed turns", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: "terminal:v2:tmux:claude:work:0.1:5678",
      short_ref: "@terminal2",
      agent: "claude",
      process_state: "active",
      managed: {
        session_id: "session-current-long-id",
        session_short_ref: "@session2",
        current_turn: {
          conversation_id: "managed-current-long-id",
          short_ref: "@current123",
          agent: "claude",
          lifecycle_state: "working",
          request: "Implement the fix",
          available_actions: {
            follow_up: { arguments: { selector: "managed-current-long-id" } },
            respond: { arguments: { turn_id: "managed-current-long-id" } },
            status: { arguments: { turn_id: "managed-current-long-id" } }
          }
        },
        recent_turn: null,
        history: [{
          conversation_id: "managed-history-long-id",
          short_ref: "@history123",
          agent: "claude",
          lifecycle_state: "idle",
          request: "Plan the fix"
        }],
        turn_count: 2,
        hidden_turn_count: 0
      }
    }],
    unavailable_managed_turns: [{
      conversation_id: "managed-unavailable-long-id",
      short_ref: "@unavail123",
      agent: "codex",
      lifecycle_state: "callback_failed",
      request: "Report the result"
    }]
  });

  assert.match(text, /AKK terminals \(1 live, 1 unavailable managed turns\)/u);
  assert.match(text, /AKK session: @session2/u);
  assert.match(text, /current turn: @current123/u);
  assert.match(text, /current turn actions: respond, status/u);
  assert.match(text, /history: @history123/u);
  assert.match(text, /unavailable managed turns:\n- @unavail123/u);
  assert.doesNotMatch(text, /managed-(?:current|history|unavailable)-long-id/u);
  assert.doesNotMatch(text, /follow_up/u);
});

test("/akk list reports an empty terminal-first view", () => {
  assert.equal(
    formatAkkListCommandResult({ terminals: [], unavailable_managed_turns: [] }),
    "AKK found no live terminals or unavailable managed turns."
  );
});

test("relative plugin storeDir resolves against the Gateway cwd", () => {
  assert.equal(
    resolvePluginStoreDir(
      {
        workspace: "/legacy/project",
        storeDir: ".akk"
      },
      "/gateway"
    ),
    "/gateway/.akk"
  );
  assert.equal(
    optionValue(
      buildAkkCommandCliArgs(
        parseAkkCommand("list"),
        {
          workspace: "/legacy/project",
          storeDir: ".akk"
        }
      )!,
      "--store-dir"
    ),
    path.resolve(process.cwd(), ".akk")
  );
});
