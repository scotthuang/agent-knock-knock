import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  formatAkkRespondCommandResult,
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  isAkkNativeSubmissionAccepted,
  parseAkkCommand,
  resolvePluginStoreDir
} from "../src/openclaw-plugin-helpers.js";

const exactTerminalId = "terminal:v2:tmux:codex:work:0.0:1234";
const currentNativeThreadId = "11111111-1111-4111-8111-111111111111";
const resumableNativeThreadId = "22222222-2222-4222-8222-222222222222";

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
  assert.match(usage, /\/akk threads <exact-terminal-id>/);
  assert.match(usage, /\/akk new-thread <exact-terminal-id>/);
  assert.match(usage, /\/akk clear-thread <exact-terminal-id>/);
  assert.match(usage, /\/akk resume-thread <exact-terminal-id>/);
  assert.doesNotMatch(
    usage,
    /\/akk (?:status|respond|approve|cancel)[^\n]*session-selector/u
  );
  assert.doesNotMatch(usage, /\/akk (?:describe|send|renew|retry-callback|close)\b/u);
});

test("/akk native-thread commands require exact identities and keep clear as an alias", () => {
  assert.deepEqual(parseAkkCommand(`threads ${exactTerminalId}`), {
    action: "list-resumable-threads",
    terminalId: exactTerminalId
  });
  assert.deepEqual(parseAkkCommand(`new-thread ${exactTerminalId}`), {
    action: "new-thread",
    terminalId: exactTerminalId
  });
  assert.deepEqual(parseAkkCommand(`clear-thread ${exactTerminalId}`), {
    action: "new-thread",
    terminalId: exactTerminalId
  });
  assert.deepEqual(parseAkkCommand(`resume-thread ${exactTerminalId}`), {
    action: "resume-thread",
    terminalId: exactTerminalId
  });
  assert.deepEqual(
    parseAkkCommand(
      `resume-thread ${exactTerminalId} ${resumableNativeThreadId.toUpperCase()}`
    ),
    {
      action: "resume-thread",
      terminalId: exactTerminalId,
      nativeThreadId: resumableNativeThreadId
    }
  );
  assert.throws(
    () => parseAkkCommand("threads @a1b2c3d4"),
    /exact terminal_id returned by \/akk list/u
  );
  assert.throws(
    () => parseAkkCommand(`resume-thread ${exactTerminalId} 22222222`),
    /complete UUID returned by \/akk threads/u
  );
});

test("/akk lifecycle CLI arguments use a fresh internal binding token", () => {
  const config = { storeDir: "/private/akk-store" };
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(`threads ${exactTerminalId}`),
      config
    ),
    [
      "list-resumable-threads",
      "--terminal",
      exactTerminalId,
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(`resume-thread ${exactTerminalId}`),
      config
    ),
    [
      "list-resumable-threads",
      "--terminal",
      exactTerminalId,
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(`new-thread ${exactTerminalId}`),
      config,
      { expectedBindingToken: "binding-token-1" }
    ),
    [
      "new-thread",
      "--terminal",
      exactTerminalId,
      "--expected-binding-token",
      "binding-token-1",
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(
        `resume-thread ${exactTerminalId} ${resumableNativeThreadId}`
      ),
      config,
      {
        expectedBindingToken: "binding-token-2",
        candidateToken: "candidate-token-2"
      }
    ),
    [
      "resume-thread",
      "--terminal",
      exactTerminalId,
      "--native-thread",
      resumableNativeThreadId,
      "--expected-binding-token",
      "binding-token-2",
      "--candidate-token",
      "candidate-token-2",
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.throws(
    () => buildAkkCommandCliArgs(
      parseAkkCommand(`new-thread ${exactTerminalId}`),
      config
    ),
    /expected binding token is required/u
  );
  assert.throws(
    () => buildAkkCommandCliArgs(
      parseAkkCommand(
        `resume-thread ${exactTerminalId} ${resumableNativeThreadId}`
      ),
      config,
      { expectedBindingToken: "binding-token-without-candidate" }
    ),
    /candidate token is required/u
  );
});

test("/akk close parses and forwards exactly one recovery identity", () => {
  const transitionCommand = parseAkkCommand(
    `close ${exactTerminalId} ` +
    "--expected-transition-id transition-current"
  );
  assert.deepEqual(transitionCommand, {
    action: "close",
    turnId: exactTerminalId,
    reason:
      "Native-thread lifecycle transition recovered from /akk command",
    expectedTransitionId: "transition-current"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(
      transitionCommand,
      { storeDir: "/private/akk-store" }
    ),
    [
      "close",
      "--turn",
      exactTerminalId,
      "--reason",
      "Native-thread lifecycle transition recovered from /akk command",
      "--expected-transition-id",
      "transition-current",
      "--store-dir",
      "/private/akk-store"
    ]
  );

  const messageCommand = parseAkkCommand(
    `close ${exactTerminalId} --expected-message-id message-current inspected`
  );
  assert.deepEqual(messageCommand, {
    action: "close",
    turnId: exactTerminalId,
    reason: "inspected",
    expectedMessageId: "message-current"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(messageCommand, {}),
    [
      "close",
      "--turn",
      exactTerminalId,
      "--reason",
      "inspected",
      "--expected-message-id",
      "message-current"
    ]
  );

  assert.throws(
    () => parseAkkCommand(
      `close ${exactTerminalId} --expected-message-id message-current ` +
      "--expected-transition-id transition-current"
    ),
    /mutually exclusive/u
  );
  assert.throws(
    () => parseAkkCommand(
      `close ${exactTerminalId} --expected-transition-id transition-current ` +
      "--expected-message-id message-current"
    ),
    /mutually exclusive/u
  );
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
    submission_outcome: "agent_accepted",
    delivery_receipt: "agent_accepted",
    delivered: true,
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

test("/akk respond never upgrades transport-only or pending receipts to accepted", () => {
  for (const result of [
    {
      submission_outcome: "agent_accepted",
      delivery_receipt: "agent_accepted",
      delivered: false,
      status: "submission_pending_acceptance"
    },
    {
      submission_outcome: "submitted",
      delivery_receipt: "submitted",
      status: "submission_pending_acceptance"
    },
    {
      submission_outcome: "pending_acceptance",
      delivery_receipt: "enter_dispatched",
      status: "submission_pending_acceptance"
    },
    {
      submission_outcome: "not_accepted",
      delivery_receipt: "enter_dispatched",
      status: "submission_not_accepted"
    }
  ]) {
    const formatted = formatAkkRespondCommandResult({
      ...result,
      session_id: "session-not-accepted",
      turn_id: "turn-not-accepted"
    });
    assert.equal(formatted.isError, true);
    assert.doesNotMatch(formatted.text, /^AKK response sent\.$/mu);
    assert.match(formatted.text, /do not retry automatically/u);
  }
});

test("native terminal submission acceptance requires the full proof tuple", () => {
  assert.equal(isAkkNativeSubmissionAccepted({
    submission_outcome: "agent_accepted",
    delivery_receipt: "agent_accepted",
    delivered: true
  }), true);
  for (const result of [
    { submission_outcome: "agent_accepted", delivery_receipt: "agent_accepted" },
    { submission_outcome: "agent_accepted", delivery_receipt: "enter_dispatched", delivered: true },
    { submission_outcome: "pending_acceptance", delivery_receipt: "agent_accepted", delivered: true }
  ]) {
    assert.equal(isAkkNativeSubmissionAccepted(result), false);
  }
});

test("/akk respond preserves safe and unsafe aborted retry boundaries", () => {
  const safe = formatAkkRespondCommandResult({
    submission_outcome: "aborted",
    safe_to_retry: true,
    do_not_retry: false,
    conversation: {
      conversation_id: "legacy-aborted-turn",
      status: "waiting_for_openclaw"
    }
  });

  assert.equal(safe.isError, true);
  assert.match(safe.text, /^AKK response was not sent\.$/mu);
  assert.match(safe.text, /safe to retry this response/u);
  assert.match(safe.text, /^session: legacy-aborted-turn$/mu);
  assert.match(safe.text, /^turn: legacy-aborted-turn$/mu);
  assert.doesNotMatch(safe.text, /^AKK response sent\.$/mu);

  for (const unsafeInput of [
    { submission_outcome: "aborted" },
    {
      submission_outcome: "aborted",
      safe_to_retry: false,
      do_not_retry: true
    }
  ]) {
    const unsafe = formatAkkRespondCommandResult({
      ...unsafeInput,
      conversation: {
        conversation_id: "unsafe-aborted-turn",
        status: "waiting_for_openclaw"
      }
    });
    assert.equal(unsafe.isError, true);
    assert.match(unsafe.text, /do not retry automatically/u);
    assert.match(unsafe.text, /inspect/u);
    assert.doesNotMatch(unsafe.text, /safe to retry this response/u);
  }
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
      available_actions: {
        new_thread: { arguments: { terminal_id: exactTerminalId } },
        list_resumable_threads: {
          arguments: { terminal_id: exactTerminalId }
        },
        resume_thread: { arguments: { terminal_id: exactTerminalId } }
      },
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
  assert.match(text, new RegExp(`lifecycle terminal_id: ${exactTerminalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
  assert.match(
    text,
    /terminal actions: list_resumable_threads, new_thread, resume_thread/u
  );
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

test("/akk list exposes the exact native-thread transition recovery command", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      short_ref: "@terminal1",
      agent: "codex",
      process_state: "active",
      orphaned_terminal_dispatch: {
        kind: "lifecycle",
        transition_id: "transition-current",
        recovery:
          "/akk close terminal:v2:tmux:codex:work:0.0:1234 " +
          "--expected-transition-id transition-current"
      }
    }]
  });

  assert.match(
    text,
    /recovery: \/akk close terminal:v2:tmux:codex:work:0\.0:1234 --expected-transition-id transition-current/u
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

test("/akk threads renders exact candidates without exposing the CAS token", () => {
  const text = formatAkkThreadsCommandResult({
    terminal_id: exactTerminalId,
    current_session_id: "session-current",
    current_native_thread_id: currentNativeThreadId,
    expected_binding_token: "binding-token-private-to-handler",
    threads: [
      {
        native_thread_id: currentNativeThreadId,
        resumable: false,
        unavailable_reason: "already_active",
        updated_at: "2026-08-06T08:00:00.000Z"
      },
      {
        native_thread_id: resumableNativeThreadId,
        resumable: true,
        candidate_token: "candidate-token-private-to-handler",
        title: "Implement lifecycle controls",
        preview: "Continue the exact historical context"
      }
    ]
  });

  assert.match(
    text,
    new RegExp(
      exactTerminalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u"
    )
  );
  assert.match(text, new RegExp(resumableNativeThreadId, "u"));
  assert.match(text, /already_active/u);
  assert.match(text, /1 resumable/u);
  assert.match(
    text,
    new RegExp(
      `/akk resume-thread ${exactTerminalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} <native-thread-uuid>`,
      "u"
    )
  );
  assert.match(text, /does not create an AKK Turn/u);
  assert.doesNotMatch(text, /binding-token-private-to-handler/u);
  assert.doesNotMatch(text, /candidate-token-private-to-handler/u);
});

test("/akk thread transition output distinguishes Session switching from Turn creation", () => {
  const text = formatAkkThreadTransitionCommandResult({
    status: "committed",
    operation: "new_thread",
    terminal_id: exactTerminalId,
    previous_session_id: "session-before",
    session_id: "session-after",
    previous_native_thread_id: currentNativeThreadId,
    native_thread_id: resumableNativeThreadId,
    binding_generation: 2,
    turn_created: false
  });

  assert.match(text, /started and verified a new native thread/u);
  assert.match(text, /^session: session-after$/mu);
  assert.match(text, /^binding generation: 2$/mu);
  assert.match(text, /No AKK Turn was created/u);
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
