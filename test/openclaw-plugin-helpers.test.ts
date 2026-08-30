import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  formatAkkRespondCommandResult,
  formatAkkTerminalWatchHint,
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  formatAkkUnwatchCommandResult,
  formatAkkWatchCommandResult,
  formatAkkWatchStatusCommandResult,
  isAkkModelFacingDiagnosticField,
  isAkkModelFacingPrivateAuthorityField,
  isAkkNativeSubmissionAccepted,
  parseAkkCommand,
  resolvePluginStoreDir,
  sanitizeAkkModelFacingDiagnosticText,
  sanitizeAkkModelFacingLegacyAuthorityInstructionText,
  stripAkkLegacyApprovalInstructionTail
} from "../src/openclaw-plugin-helpers.js";
import {
  statusParameters,
  unwatchParameters,
  watchParameters
} from "../src/openclaw-plugin-schemas.js";

const exactTerminalId = "terminal:v2:tmux:codex:work:0.0:1234";
const currentNativeThreadId = "11111111-1111-4111-8111-111111111111";
const resumableNativeThreadId = "22222222-2222-4222-8222-222222222222";

test("model-facing authority policy normalizes fields and preserves ordinary content", () => {
  for (const field of [
    "expected_session_revision",
    "expectedSessionRevision",
    "expected-session-revision",
    "terminalBindingGeneration",
    "terminal-binding-id"
  ]) {
    assert.equal(isAkkModelFacingPrivateAuthorityField(field), true, field);
  }
  for (const field of [
    "bookkeeping_warning",
    "stalledReason",
    "terminal-scan-error",
    "diagnostics"
  ]) {
    assert.equal(isAkkModelFacingDiagnosticField(field), true, field);
  }

  const privateText = [
    "Approval authority",
    '{"expectedSessionRevision":7}',
    '{"expected-binding-token":false}',
    "bindingGeneration: null",
    "--expected-callback-message-id callback-private"
  ].join("\n");
  const sanitized = sanitizeAkkModelFacingLegacyAuthorityInstructionText(
    privateText
  );
  assert.doesNotMatch(
    sanitized,
    /expectedSessionRevision|expected-binding-token|bindingGeneration|callback-private/u
  );
  assert.match(sanitized, /AKK internal authority omitted/u);

  const businessText = [
    `inspect token_fingerprint.ts at commit ${"e".repeat(64)};`,
    "expected_session_revision: 7",
    "--expected-binding-token foo",
    "the request discusses tokens, fingerprints, revisions, and CAS"
  ].join("\n");
  assert.equal(
    sanitizeAkkModelFacingLegacyAuthorityInstructionText(businessText),
    businessText
  );
  const legacyTail = [
    businessText,
    "If the user approves, call `agent_knock_knock_approve` with:",
    `- expected_approval_fingerprint: ${"a".repeat(64)}`,
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ].join("\n");
  assert.equal(stripAkkLegacyApprovalInstructionTail(legacyTail), `${businessText}\n`);
  assert.match(
    sanitizeAkkModelFacingDiagnosticText(
      "bookkeeping conflict: expected revision 7, actual revision 8"
    ),
    /private authority changed/u
  );
});

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
  assert.match(usage, /\/akk watch <exact-terminal-id>/);
  assert.match(usage, /\/akk unwatch <watch-id>/);
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

test("/akk watch and unwatch require authoritative exact identities", () => {
  assert.deepEqual(parseAkkCommand(`watch ${exactTerminalId}`), {
    action: "watch",
    terminalId: exactTerminalId
  });
  assert.deepEqual(parseAkkCommand("unwatch terminal-watch-durable-1"), {
    action: "unwatch",
    watchId: "terminal-watch-durable-1"
  });
  assert.throws(
    () => parseAkkCommand("watch @terminal1"),
    /exact-terminal-id/u
  );
  assert.throws(
    () => parseAkkCommand("unwatch terminal-watch-durable-1 extra"),
    /Usage: \/akk unwatch/u
  );
});

test("Terminal Watch tool schemas require exact and mutually exclusive targets", () => {
  assert.deepEqual(watchParameters.required, ["terminal_id"]);
  assert.equal(
    Object.hasOwn(watchParameters.properties, "expected_binding_token"),
    false
  );
  assert.equal(
    watchParameters.properties.terminal_id.pattern,
    "^terminal:v[0-9]+:\\S+$"
  );
  assert.deepEqual(unwatchParameters.required, ["watch_id"]);
  assert.deepEqual(statusParameters.anyOf, [
    { required: ["turn_id"] },
    { required: ["conversation_id"] },
    { required: ["watch_id"] }
  ]);
  assert.deepEqual(statusParameters.not.anyOf, [
    { required: ["turn_id", "conversation_id"] },
    { required: ["turn_id", "watch_id"] },
    { required: ["conversation_id", "watch_id"] }
  ]);
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
      selection: {
        kind: "exact",
        nativeThreadId: resumableNativeThreadId
      }
    }
  );
  assert.deepEqual(
    parseAkkCommand(`resume-thread ${exactTerminalId} previous`),
    {
      action: "resume-thread",
      terminalId: exactTerminalId,
      selection: { kind: "previous" }
    }
  );
  assert.deepEqual(
    parseAkkCommand(`resume-thread ${exactTerminalId} 刚才那个`),
    {
      action: "resume-thread",
      terminalId: exactTerminalId,
      selection: { kind: "previous" }
    }
  );
  assert.deepEqual(
    parseAkkCommand(`resume-thread ${exactTerminalId} 2`),
    {
      action: "resume-thread",
      terminalId: exactTerminalId,
      selection: { kind: "number", selectionNumber: 2 }
    }
  );
  assert.deepEqual(
    parseAkkCommand(`resume-thread ${exactTerminalId} @abcdef12`),
    {
      action: "resume-thread",
      terminalId: exactTerminalId,
      selection: { kind: "short-id", shortId: "@abcdef12" }
    }
  );
  const snapshotHandle = "rs_abcdefghijklmnopqrstuv:2";
  assert.throws(
    () => parseAkkCommand(`resume-thread ${exactTerminalId} ${snapshotHandle}`),
    /selection exactly returned by \/akk threads/u
  );
  assert.throws(
    () => parseAkkCommand("threads @a1b2c3d4"),
    /exact terminal_id returned by \/akk list/u
  );
  assert.throws(
    () => parseAkkCommand(`resume-thread ${exactTerminalId} 0`),
    /selection exactly returned by \/akk threads/u
  );
  assert.throws(
    () => parseAkkCommand(`resume-thread ${exactTerminalId} 2222222a`),
    /selection exactly returned by \/akk threads/u
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
      parseAkkCommand(`resume-thread ${exactTerminalId} 2`),
      config,
      {
        selectionScope: "openclaw:scope",
        selectionSnapshotId: "rs_abcdefghijklmnopqrstuv"
      }
    ),
    [
      "resume-thread",
      "--terminal",
      exactTerminalId,
      "--selection-snapshot",
      "rs_abcdefghijklmnopqrstuv",
      "--selection-number",
      "2",
      "--selection-scope",
      "openclaw:scope",
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

test("/akk Terminal Watch CLI arguments expose only the terminal id", () => {
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(`watch ${exactTerminalId}`),
      {
        storeDir: "/private/akk-store",
        openclawBin: "/opt/openclaw",
        agentHardTimeoutMinutes: 45
      },
      {
        sessionKey: "agent:test:main"
      }
    ),
    [
      "watch-terminal",
      "--terminal",
      exactTerminalId,
      "--store-dir",
      "/private/akk-store",
      "--hard-timeout-minutes",
      "45",
      "--openclaw-session",
      "agent:test:main",
      "--openclaw-bin",
      "/opt/openclaw"
    ]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("unwatch terminal-watch-durable-1"),
      { storeDir: "/private/akk-store" }
    ),
    [
      "unwatch-terminal",
      "--watch",
      "terminal-watch-durable-1",
      "--store-dir",
      "/private/akk-store"
    ]
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("status terminal-watch-durable-1"),
      { storeDir: "/private/akk-store" }
    ),
    [
      "watch-status",
      "--watch",
      "terminal-watch-durable-1",
      "--store-dir",
      "/private/akk-store"
    ]
  );
});

test("/akk forwards configured codexHome through every lifecycle discovery and mutation", () => {
  const config = {
    storeDir: "/private/akk-store",
    codexHome: "/private/custom-codex"
  };
  const commands = [
    {
      input: `threads ${exactTerminalId}`,
      context: {}
    },
    {
      input: `new-thread ${exactTerminalId}`,
      context: { expectedBindingToken: "binding-token-new" }
    },
    {
      input: `clear-thread ${exactTerminalId}`,
      context: { expectedBindingToken: "binding-token-clear" }
    },
    {
      input: `resume-thread ${exactTerminalId}`,
      context: {}
    },
    {
      input: `resume-thread ${exactTerminalId} previous`,
      context: {}
    },
    {
      input: `resume-thread ${exactTerminalId} 2`,
      context: {
        selectionScope: "openclaw:scope",
        selectionSnapshotId: "rs_abcdefghijklmnopqrstuv"
      }
    },
    {
      input: `resume-thread ${exactTerminalId} @22222222`,
      context: {
        selectionScope: "openclaw:scope",
        selectionSnapshotId: "rs_abcdefghijklmnopqrstuv"
      }
    },
    {
      input: `resume-thread ${exactTerminalId} ${resumableNativeThreadId}`,
      context: {
        expectedBindingToken: "binding-token-resume",
        candidateToken: "candidate-token-resume"
      }
    }
  ];

  for (const { input, context } of commands) {
    const args = buildAkkCommandCliArgs(
      parseAkkCommand(input),
      config,
      context
    );
    assert.ok(args, input);
    assert.equal(
      args.filter((argument) => argument === "--codex-home").length,
      1,
      input
    );
    assert.equal(
      args[args.indexOf("--codex-home") + 1],
      "/private/custom-codex",
      input
    );
  }
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
    buildAkkCommandCliArgs(
      parseAkkCommand("codex: review the diff"),
      {},
      {
        sessionKey: "agent:test:selector-send",
        messageId: "openclaw-command-fixed"
      }
    ),
    [
      "send",
      "--session",
      "codex",
      "--message",
      "review the diff",
      "--background",
      "--message-id",
      "openclaw-command-fixed",
      "--openclaw-session",
      "agent:test:selector-send",
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:selector-send"
    ]
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

test("/akk approve accepts only a semantic Turn and delegates private fencing", () => {
  const command = parseAkkCommand("approve conversation-1");
  assert.deepEqual(command, {
    action: "approve",
    turnId: "conversation-1"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(
      command,
      {
        workspace: "/work/project",
        storeDir: "/private/akk-store"
      }
    ),
    undefined,
    "the command adapter privately derives the approval fingerprint immediately before dispatch"
  );
  assert.throws(
    () => parseAkkCommand(
      "approve conversation-1 --expected-approval-fingerprint approval-1"
    ),
    /Usage: \/akk approve <turn-selector>/u
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
  assert.doesNotMatch(text, /AKK Watch available:/u);
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

test("/akk list renders watchable terminals and durable watch rows", () => {
  const text = formatAkkListCommandResult({
    terminals: [{
      id: exactTerminalId,
      short_ref: "@terminal1",
      agent: "codex",
      process_state: "active",
      activity_state: "working",
      compatibility_warnings: [
        "Codex 0.150.0 has not been regression-tested by AKK"
      ],
      terminal_control: { target: "work:0.0" },
      available_actions: {
        watch: {
          arguments: {
            terminal_id: exactTerminalId
          }
        }
      }
    }],
    terminal_watches: [{
      watch_id: "terminal-watch-durable-1",
      agent: "codex",
      status: "watching",
      terminal_id: exactTerminalId,
      compatibility_warning:
        "Codex 0.150.0 has not been regression-tested by AKK",
      available_actions: {
        status: { arguments: { watch_id: "terminal-watch-durable-1" } },
        unwatch: { arguments: { watch_id: "terminal-watch-durable-1" } }
      }
    }],
    unavailable_managed_turns: []
  });

  assert.match(text, /1 live, 1 terminal watches/u);
  assert.match(
    text,
    new RegExp(
      `AKK Watch available: /akk watch ${exactTerminalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
      "u"
    )
  );
  assert.match(text, /terminal actions: watch/u);
  assert.match(
    text,
    /observe this exact terminal without input; exact task evidence is preferred and terminal-activity fallback is best-effort/u
  );
  assert.match(text, /terminal watches:/u);
  assert.match(text, /terminal-watch-durable-1 \| codex \| watching/u);
  assert.match(text, /actions: status, unwatch/u);
  assert.equal(
    text.match(/compatibility warning: Codex 0\.150\.0 has not been regression-tested by AKK/gu)?.length,
    2
  );
});

test("Terminal Watch command summaries preserve external-work attribution", () => {
  const started = formatAkkWatchCommandResult({
    watch_id: "terminal-watch-durable-1",
    terminal_id: exactTerminalId,
    agent: "claude",
    status: "watching",
    compatibility_warning:
      "Claude Code 2.1.238 has not been regression-tested by AKK"
  });
  assert.match(started, /Terminal Watch started/u);
  assert.match(started, /compatibility warning: Claude Code 2\.1\.238/u);
  assert.match(started, /without sending input, adopting the task/u);

  const activityStarted = formatAkkWatchCommandResult({
    watch: {
      watch_id: "terminal-watch-activity-1",
      terminal_id: exactTerminalId,
      agent: "codex",
      status: "active",
      watch_mode: "terminal_activity",
      confidence: "best_effort",
      warnings: ["exact task anchor unavailable"]
    }
  });
  assert.match(activityStarted, /^mode: terminal_activity$/mu);
  assert.match(activityStarted, /^confidence: best_effort$/mu);
  assert.match(activityStarted, /^warning: exact task anchor unavailable$/mu);
  assert.match(activityStarted, /Stable idle is best-effort/u);
  assert.match(activityStarted, /not proof that one exact task completed/u);

  const status = formatAkkWatchStatusCommandResult({
    watch: {
      watch_id: "terminal-watch-durable-1",
      terminal_id: exactTerminalId,
      agent: "claude",
      status: "awaiting_approval",
      compatibility_warning:
        "Claude Code 2.1.238 has not been regression-tested by AKK"
    }
  });
  assert.match(status, /Terminal Watch status/u);
  assert.match(status, /compatibility warning: Claude Code 2\.1\.238/u);
  assert.match(status, /user-selected read-only exact-task observation/u);

  const fallbackStatus = formatAkkWatchStatusCommandResult({
    watch: {
      watch_id: "terminal-watch-user-send-1",
      source: "terminal_user_explicit_fallback_watch",
      terminal_id: exactTerminalId,
      agent: "codex",
      status: "completed",
      callback: {
        pending: 0,
        delivered: 1,
        failed: 0,
        superseded: 0
      }
    }
  });
  assert.match(fallbackStatus, /AKK sent this exact request/u);
  assert.match(fallbackStatus, /no managed Turn was created/u);
  assert.match(fallbackStatus, /^callback: delivered \(1\)$/mu);
  assert.doesNotMatch(fallbackStatus, /AKK did not send/u);

  const failedCallbackStatus = formatAkkWatchStatusCommandResult({
    watch: {
      watch_id: "terminal-watch-user-send-failed",
      source: "terminal_user_explicit_fallback_watch",
      terminal_id: exactTerminalId,
      agent: "codex",
      status: "completed",
      callback: {
        pending: 1,
        delivered: 0,
        failed: 1,
        superseded: 0,
        last_error_code:
          "callback_permanent_openclaw_callback_profile_changed"
      }
    }
  });
  assert.match(failedCallbackStatus, /^callback: failed \(1\)$/mu);
  assert.match(
    failedCallbackStatus,
    /^callback error: callback_permanent_openclaw_callback_profile_changed$/mu
  );
  assert.match(
    failedCallbackStatus,
    /terminal task status and callback delivery status are separate/u
  );

  const pendingCallbackStatus = formatAkkWatchStatusCommandResult({
    watch: {
      watch_id: "terminal-watch-user-send-pending",
      source: "terminal_user_explicit_fallback_watch",
      terminal_id: exactTerminalId,
      agent: "codex",
      status: "active",
      callback: {
        pending: 1,
        delivered: 0,
        failed: 0,
        superseded: 0
      }
    }
  });
  assert.match(pendingCallbackStatus, /^callback: pending \(1\)$/mu);
  assert.doesNotMatch(pendingCallbackStatus, /^callback: failed/mu);

  const stopped = formatAkkUnwatchCommandResult({
    terminal_watch: {
      watch_id: "terminal-watch-durable-1",
      status: "cancelled"
    }
  });
  assert.match(stopped, /Terminal Watch stopped/u);
  assert.match(stopped, /not interrupted/u);
});

test("status Watch guidance requires an explicit non-authoritative hint", () => {
  assert.deepEqual(formatAkkTerminalWatchHint({
    source: "terminal_control",
    terminal_status: { activity_state: "working" }
  }), []);
  assert.deepEqual(formatAkkTerminalWatchHint({
    terminal_watch_hint: {
      kind: "terminal_watch_discovery",
      terminal_id: exactTerminalId,
      command: `/akk watch ${exactTerminalId}`,
      available_action_required: false,
      instruction:
        "Refresh list to copy the exact terminal; the action is discovery help."
    }
  }), [
    `AKK Watch available: /akk watch ${exactTerminalId}`,
    "next: Refresh list to copy the exact terminal; the action is discovery help."
  ]);
  assert.deepEqual(formatAkkTerminalWatchHint({
    terminal_watch_hint: {
      kind: "terminal_watch_discovery",
      command: `/akk watch ${exactTerminalId}`,
      available_action_required: true,
      instruction: "Do not trust this malformed hint."
    },
    terminal_status: { activity_state: "working" }
  }), []);
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
    capability: {
      compatibilityWarning:
        "Codex 0.150.0 has not been regression-tested by AKK"
    },
    expected_binding_token: "binding-token-private-to-handler",
    selection_snapshot: {
      snapshot_id: "rs_abcdefghijklmnopqrstuv",
      expires_at: "2026-08-06T08:05:00.000Z"
    },
    previous: {
      native_thread_id: resumableNativeThreadId
    },
    threads: [
      {
        native_thread_id: currentNativeThreadId,
        selection_number: 1,
        short_id: "@11111111",
        selection_handle: "rs_abcdefghijklmnopqrstuv:1",
        resumable: false,
        unavailable_reason: "already_active",
        updated_at: "2026-08-06T08:00:00.000Z"
      },
      {
        native_thread_id: resumableNativeThreadId,
        selection_number: 2,
        short_id: "@22222222",
        selection_handle: "rs_abcdefghijklmnopqrstuv:2",
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
  assert.match(text, /1\. @11111111/u);
  assert.match(text, /2\. @22222222/u);
  assert.doesNotMatch(text, /rs_abcdefghijklmnopqrstuv/u);
  assert.match(text, /previous \/ 刚才那个/u);
  assert.match(text, /resume-thread[^\n]+ previous/u);
  assert.match(text, /refer only to this displayed snapshot/u);
  assert.match(
    text,
    new RegExp(
      `/akk resume-thread ${exactTerminalId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} <native-thread-uuid>`,
      "u"
    )
  );
  assert.match(text, /does not create an AKK Turn/u);
  assert.match(text, /compatibility warning: Codex 0\.150\.0/u);
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
    compatibility_warning:
      "Codex 0.150.0 has not been regression-tested by AKK",
    binding_generation: 2,
    turn_created: false
  });

  assert.match(text, /started and verified a new native thread/u);
  assert.match(text, /^session: session-after$/mu);
  assert.doesNotMatch(text, /binding generation/iu);
  assert.match(text, /No AKK Turn was created/u);
  assert.match(text, /compatibility warning: Codex 0\.150\.0/u);
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
