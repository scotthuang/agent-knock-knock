import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  claudeTerminalAgentAdapter,
  claudePermissionCommandForApproval,
  classifyClaudeProcess,
  createClaudeTerminalAgentAdapter,
  detectClaudeApprovalPrompt,
  extractClaudeSessionId,
  inspectClaudeScreen,
  observeClaudeThreadLifecycle,
  planClaudeThreadLifecycle,
  probeClaudeThreadLifecycle
} from "../src/claude-terminal-agent-adapter.js";
import { terminalControlCapabilitiesForAdapter } from "../src/terminal-agent-adapter.js";

test("classifies only direct interactive Claude CLI processes", () => {
  assert.deepEqual(
    classifyClaudeProcess({ pid: 29466, ppid: 82646, command: "claude", cwd: "/repo" }),
    {
      pid: 29466,
      ppid: 82646,
      command: "claude",
      cwd: "/repo",
      agent: "claude",
      kind: "claude_cli",
      sessionId: undefined,
      confidence: "medium",
      reason: "interactive Claude CLI process without an exact agent metadata row"
    }
  );
  assert.equal(
    classifyClaudeProcess({
      pid: 12,
      command: "/Users/test/.local/bin/claude --permission-mode default"
    })?.kind,
    "claude_cli"
  );
  assert.equal(
    classifyClaudeProcess({
      pid: 13,
      command: "/Users/test/.local/share/claude/versions/2.1.198 --permission-mode default"
    })?.kind,
    "claude_cli"
  );

  for (const command of [
    "claude -p 'summarize this'",
    "claude --print=hello",
    "claude --background",
    "claude agents --json --all",
    "claude mcp serve",
    "claude --debug api doctor",
    "claude plugin list",
    "claude ultrareview",
    "claude update",
    "claude upgrade",
    "claude --help",
    "/opt/bin/claude-wrapper claude",
    ".local/share/claude/versions/2.1.198",
    "/Users/test/.local/share/claude/versions/current",
    "/Users/test/.local/share/not-claude/versions/2.1.198",
    "/opt/claude/versions/2.1.198",
    "sh -lc 'claude --resume session-1'",
    "uvx minimax-coding-plan-mcp -y"
  ]) {
    assert.equal(classifyClaudeProcess({ pid: 99, command }), undefined, command);
  }
});

test("parses explicit Claude session and resume flags", () => {
  assert.equal(extractClaudeSessionId("claude --session-id session-explicit"), "session-explicit");
  assert.equal(extractClaudeSessionId("claude --session-id=session-equals"), "session-equals");
  assert.equal(extractClaudeSessionId("claude --resume session-resume"), "session-resume");
  assert.equal(extractClaudeSessionId("claude --resume=session-equals-resume"), "session-equals-resume");
  assert.equal(extractClaudeSessionId("claude -r session-short"), "session-short");
  assert.equal(extractClaudeSessionId("claude -rsession-attached"), "session-attached");
  assert.equal(extractClaudeSessionId("claude --resume --permission-mode default"), undefined);
  assert.equal(
    extractClaudeSessionId("claude --resume old --session-id authoritative"),
    "authoritative"
  );
});

test("keeps long or secret Claude commands out of automatic approval policy", () => {
  const dangerous = `pwd${" ".repeat(2_100)}; touch /tmp/should-not-run`;
  const longCommand = claudePermissionCommandForApproval(dangerous);
  assert.equal(longCommand.command, undefined);
  assert.match(longCommand.display, /^pwd/u);
  assert.ok(longCommand.display.length < dangerous.length);

  const secretCommand = claudePermissionCommandForApproval(
    "echo ARK_API_KEY=ark-test-secret-value"
  );
  assert.equal(secretCommand.command, undefined);
  assert.doesNotMatch(secretCommand.display, /ark-test-secret-value/u);
});

test("exact PID agent rows supplement session identity, cwd, and confidence", () => {
  const adapter = createClaudeTerminalAgentAdapter({
    agentRows: [
      {
        pid: 29466,
        cwd: "/workspace/from-agents",
        kind: "interactive",
        sessionId: "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c",
        status: "idle"
      },
      {
        pid: 29467,
        cwd: "/wrong-pid",
        kind: "interactive",
        sessionId: "wrong-session"
      }
    ]
  });
  const process = adapter.classifyProcess({ pid: 29466, command: "claude" });

  assert.equal(process?.sessionId, "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c");
  assert.equal(process?.cwd, "/workspace/from-agents");
  assert.equal(process?.confidence, "high");
  assert.match(process?.reason ?? "", /exact PID/);

  const exactPidRowWins = adapter.classifyProcess({
    pid: 29466,
    command: "claude --session-id command-session",
    cwd: "/workspace/from-ps"
  });
  assert.equal(exactPidRowWins?.sessionId, "bb4b7b5b-4d6c-4fe8-929d-79fde1fec93c");
  assert.equal(exactPidRowWins?.cwd, "/workspace/from-ps");

  assert.equal(
    createClaudeTerminalAgentAdapter({
      agentRows: [{ pid: 51, kind: "background", sessionId: "background-agent" }]
    }).classifyProcess({ pid: 51, command: "claude" }),
    undefined
  );
});

test("detects the Claude 2.1.198 idle and working terminal tails", () => {
  const oldCodexScrollback = [
    "Would you like to run the following command?",
    "› 1. Yes, proceed (y)",
    "• Working (12s • esc to interrupt)",
    ...Array.from({ length: 55 }, (_, index) => `old scrollback ${index}`)
  ];
  const idle = [
    ...oldCodexScrollback,
    "╭─── Claude Code v2.1.198 ─────────╮",
    "│ Welcome back!                    │",
    "╰──────────────────────────────────╯",
    "────────────────────────────────────",
    "❯\u00a0",
    "────────────────────────────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
  ].join("\n");
  const idleInspection = inspectClaudeScreen({ screen: idle });
  assert.equal(idleInspection.activity.state, "idle");
  assert.equal(idleInspection.approval.blocked, false);
  assert.equal(idleInspection.completion, undefined);

  const working = [
    ...oldCodexScrollback,
    "❯ inspect the repository",
    "",
    "✻ Working… (12s · 312 tokens)",
    "  esc to interrupt"
  ].join("\n");
  const workingInspection = inspectClaudeScreen({ screen: working });
  assert.equal(workingInspection.activity.state, "working");
  assert.equal(workingInspection.completion, undefined);

  const codexOnly = inspectClaudeScreen({
    screen: [
      "• Working (12s • esc to interrupt)",
      "› Find and fix a bug"
    ].join("\n")
  });
  assert.equal(codexOnly.activity.state, "unknown");
});

test("approves the strict Claude 2.1.218 Bash dialog in an AKK-managed runtime", () => {
  const screen = [
    " Bash command",
    "",
    "   shasum /etc/hosts",
    "   Compute SHA checksum of /etc/hosts",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don’t ask again for: shasum *",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
  const inspection = inspectClaudeScreen({
    screen,
    runtime: {
      pid: 7200,
      cwd: "/workspace",
      conversationId: "conversation-screen-approval",
      messageId: "message-screen-approval",
      terminalTarget: "claude-work:0.0"
    }
  });

  assert.equal(inspection.activity.state, "awaiting_approval");
  assert.equal(inspection.approval.blocked, true);
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected the selected one-time Yes option to be approvable");
  }
  assert.deepEqual(inspection.approval.action.keys, ["C-m"]);
  assert.equal(inspection.approval.action.mode, "keys");
  assert.equal(inspection.approval.action.label, "Yes");
  assert.equal(inspection.approval.promptKind, "claude_permission");
  assert.equal(inspection.approval.toolName, "Bash");
  assert.equal(inspection.approval.command, undefined);
  assert.match(inspection.approval.requestDetail ?? "", /shasum/u);

  const managedStatusInspection =
    createClaudeTerminalAgentAdapter().inspectScreen({
      screen,
      runtime: {
        pid: 7200,
        cwd: "/workspace",
        conversationId: "conversation-screen-approval",
        messageId: "message-screen-approval",
        terminalTarget: "claude-work:0.0"
      }
    });
  assert.equal(
    managedStatusInspection.approval.requestDetail,
    "Bash request details omitted; inspect the live terminal pane directly"
  );
  assert.doesNotMatch(
    managedStatusInspection.approval.requestDetail ?? "",
    /shasum/u
  );
  assert.doesNotMatch(managedStatusInspection.screenExcerpt, /shasum/u);
  assert.match(
    managedStatusInspection.screenExcerpt,
    /Bash request details omitted/u
  );
});

test("hookless Claude policy evidence requires an exact screen and transcript intersection", () => {
  const command = "rm /workspace/.akk-safe-fixture";
  const managedRequest = {
    sessionId: "claude-session-approval",
    cwd: "/workspace",
    requestText: "Remove the exact fixture",
    requestHash: "request-hash",
    startedAt: "2026-07-25T02:00:00.000Z",
    context: { managed: true }
  };
  const evidence = {
    source: "claude_transcript" as const,
    kind: "run_command" as const,
    command,
    cwd: "/workspace",
    toolName: "Bash" as const,
    toolUseId: "toolu_exact_approval",
    promptUuid: "prompt-exact-approval",
    assistantUuid: "assistant-exact-approval",
    claudeVersion: "2.1.218",
    transcriptFileId: "transcript-exact-approval",
    commandSha256: createHash("sha256").update(command).digest("hex"),
    evidenceFingerprint: "a".repeat(64),
    observedEndOffsetBytes: 4096
  };
  let receivedRequest;
  const inspection = createClaudeTerminalAgentAdapter({
    detectPendingApproval(request) {
      receivedRequest = request;
      return evidence;
    }
  }).inspectScreen({
    screen: [
      "Earlier visible shell echo: rm /workspace/",
      ".akk-safe-fixture",
      currentClaudePermissionScreen(command, "Remove the test fixture")
    ].join("\n"),
    runtime: {
      pid: 7200,
      cwd: "/workspace",
      conversationId: "conversation-screen-approval",
      messageId: "message-screen-approval",
      terminalTarget: "claude-work:0.0"
    },
    managedRequest
  });

  assert.deepEqual(receivedRequest, managedRequest);
  assert.equal(inspection.approval.approvable, true);
  if (!inspection.approval.approvable) {
    assert.fail("expected correlated transcript evidence");
  }
  assert.equal(inspection.approval.command, undefined);
  assert.equal(inspection.approval.cwd, "/workspace");
  assert.equal(inspection.approval.action.requestId, evidence.toolUseId);
  assert.deepEqual(inspection.approval.policyEvidence, {
    source: "claude_transcript",
    kind: "run_command",
    command,
    cwd: "/workspace",
    toolName: "Bash",
    requestId: evidence.toolUseId,
    commandSha256: evidence.commandSha256,
    evidenceFingerprint: evidence.evidenceFingerprint,
    metadata: {
      prompt_uuid: evidence.promptUuid,
      assistant_uuid: evidence.assistantUuid,
      claude_version: evidence.claudeVersion,
      transcript_file_id: evidence.transcriptFileId,
      observed_end_offset_bytes: evidence.observedEndOffsetBytes
    }
  });
  assert.doesNotMatch(inspection.screenExcerpt, new RegExp(command, "u"));
  assert.doesNotMatch(inspection.screenExcerpt, /Earlier visible shell echo/u);
  assert.doesNotMatch(inspection.screenExcerpt, /rm \/workspace\//u);
  assert.doesNotMatch(inspection.screenExcerpt, /\.akk-safe-fixture/u);
  assert.doesNotMatch(inspection.approval.requestDetail ?? "", new RegExp(command, "u"));
  assert.match(inspection.screenExcerpt, /verified Bash request omitted/u);
});

test("hookless Claude excerpt removes a command before the 4000-character boundary slice", () => {
  const command = `rm /workspace/${Array.from(
    { length: 90 },
    (_, index) => `crossboundary${String(index).padStart(3, "0")}`
  ).join("-")}`;
  const commandSha256 = createHash("sha256").update(command).digest("hex");
  const dialog = currentClaudePermissionScreen(
    command,
    "permission-detail-cross-boundary-private"
  );
  const echoPrefix = "Earlier visible shell echo: ";
  const boundaryWithinCommand = Math.floor(command.length / 2);
  const paddingLength =
    4000 - 2 - dialog.length - (command.length - boundaryWithinCommand);
  assert.ok(paddingLength > 0);
  const screen = [
    `${echoPrefix}${command}`,
    "x".repeat(paddingLength),
    dialog
  ].join("\n");
  const sliceStart = screen.length - 4000;
  const commandStart = echoPrefix.length;
  assert.equal(sliceStart, commandStart + boundaryWithinCommand);
  assert.match(screen.slice(sliceStart), /crossboundary\d{3}/u);

  const inspection = createClaudeTerminalAgentAdapter({
    detectPendingApproval() {
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/workspace",
        toolName: "Bash",
        toolUseId: "toolu_boundary_approval",
        promptUuid: "prompt-boundary-approval",
        assistantUuid: "assistant-boundary-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-boundary-approval",
        commandSha256,
        evidenceFingerprint: "c".repeat(64),
        observedEndOffsetBytes: 8192
      };
    }
  }).inspectScreen({
    screen,
    runtime: {
      pid: 7200,
      cwd: "/workspace",
      conversationId: "conversation-boundary-approval",
      messageId: "message-boundary-approval",
      terminalTarget: "claude-work:0.0"
    },
    managedRequest: {
      cwd: "/workspace",
      requestText: "Remove the exact boundary fixture"
    }
  });

  assert.equal(inspection.screenExcerpt.length <= 4000, true);
  assert.match(inspection.screenExcerpt, /verified Bash request omitted/u);
  assert.doesNotMatch(inspection.screenExcerpt, /crossboundary\d{3}/u);
  assert.doesNotMatch(
    inspection.screenExcerpt,
    /permission-detail-cross-boundary-private/u
  );
});

test("hookless Claude transcript uncertainty preserves manual approval but grants no policy authority", () => {
  const command = "rm /workspace/.akk-safe-fixture";
  const baseEvidence = {
    source: "claude_transcript" as const,
    kind: "run_command" as const,
    command,
    cwd: "/workspace",
    toolName: "Bash" as const,
    toolUseId: "toolu_uncertain",
    promptUuid: "prompt-uncertain",
    assistantUuid: "assistant-uncertain",
    claudeVersion: "2.1.218",
    transcriptFileId: "transcript-uncertain",
    commandSha256: createHash("sha256").update(command).digest("hex"),
    evidenceFingerprint: "b".repeat(64),
    observedEndOffsetBytes: 4096
  };
  const managedRequest = {
    cwd: "/workspace",
    requestText: "Remove the exact fixture"
  };
  const runtime = {
    pid: 7200,
    cwd: "/workspace",
    conversationId: "conversation-screen-approval",
    messageId: "message-screen-approval",
    terminalTarget: "claude-work:0.0"
  };
  const cases = [
    {
      label: "screen command mismatch",
      screen: currentClaudePermissionScreen("pwd"),
      detect: () => baseEvidence
    },
    {
      label: "visually wrapped screen command",
      screen: currentClaudePermissionScreen(
        command,
        undefined,
        ["rm /workspace/", ".akk-safe-fixture"]
      ),
      detect: () => baseEvidence
    },
    {
      label: "redacted transcript command",
      screen: currentClaudePermissionScreen("echo ARK_API_KEY=ark-test-secret-value"),
      detect: () => {
        const secretCommand = "echo ARK_API_KEY=ark-test-secret-value";
        return {
          ...baseEvidence,
          command: secretCommand,
          commandSha256: createHash("sha256").update(secretCommand).digest("hex")
        };
      }
    },
    {
      label: "transcript workspace mismatch",
      screen: currentClaudePermissionScreen(command),
      detect: () => ({
        ...baseEvidence,
        cwd: "/different-workspace"
      })
    },
    {
      label: "detector failure",
      screen: currentClaudePermissionScreen(command),
      detect: () => {
        throw new Error("unstable transcript");
      }
    }
  ];

  for (const candidate of cases) {
    const inspection = createClaudeTerminalAgentAdapter({
      detectPendingApproval: candidate.detect
    }).inspectScreen({
      screen: candidate.screen,
      runtime,
      managedRequest
    });
    assert.equal(inspection.approval.approvable, true, candidate.label);
    if (!inspection.approval.approvable) {
      assert.fail(candidate.label);
    }
    assert.equal(inspection.approval.policyEvidence, undefined, candidate.label);
    assert.equal(inspection.approval.action.requestId, undefined, candidate.label);
    assert.equal(
      inspection.approval.requestDetail,
      "Bash request details omitted; inspect the live terminal pane directly",
      candidate.label
    );
    for (const rawFragment of [
      "rm /workspace/",
      ".akk-safe-fixture",
      "pwd",
      "ARK_API_KEY",
      "ark-test-secret-value"
    ]) {
      assert.doesNotMatch(
        inspection.screenExcerpt,
        new RegExp(rawFragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        `${candidate.label}: ${rawFragment}`
      );
      assert.doesNotMatch(
        inspection.approval.requestDetail ?? "",
        new RegExp(rawFragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
        `${candidate.label}: ${rawFragment}`
      );
    }
    assert.match(
      inspection.screenExcerpt,
      /Bash request details omitted/u,
      candidate.label
    );
  }
});

test("screen approval rejects prose lookalikes and incomplete or ambiguous Bash dialogs", () => {
  const validLines = [
    " Bash command",
    "",
    "   npm test",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend"
  ];
  const markerIndex = validLines.indexOf(" Do you want to proceed?");
  const yesIndex = validLines.indexOf(" ❯ 1. Yes");
  const persistentIndex = validLines.indexOf(
    "   2. Yes, and don't ask again for this command"
  );
  const noIndex = validLines.indexOf("   3. No");
  const footerIndex = validLines.indexOf(" Esc to cancel · Tab to amend");

  const cases: Array<[string, string]> = [
    [
      "minimal prose",
      "The assistant asked “Do you want to proceed?” in ordinary explanatory prose."
    ],
    [
      "complete dialog quoted as prose",
      [
        "The following is documentation, not a live permission dialog:",
        "```text",
        ...validLines,
        "```"
      ].join("\n")
    ],
    [
      "missing Bash header",
      validLines.filter((_, index) => index !== 0).join("\n")
    ],
    [
      "missing footer",
      validLines.filter((_, index) => index !== footerIndex).join("\n")
    ],
    [
      "missing No choice",
      validLines.filter((_, index) => index !== noIndex).join("\n")
    ],
    [
      "duplicate permission marker",
      [
        ...validLines.slice(0, markerIndex + 1),
        " Do you want to proceed?",
        ...validLines.slice(markerIndex + 1)
      ].join("\n")
    ],
    [
      "duplicate highlighted choice",
      validLines.map((line, index) =>
        index === persistentIndex
          ? " ❯ 2. Yes, and don't ask again for this command"
          : line
      ).join("\n")
    ],
    [
      "unexpected text between marker and choices",
      [
        ...validLines.slice(0, yesIndex),
        "This line is not part of the permission dialog.",
        ...validLines.slice(yesIndex)
      ].join("\n")
    ],
    [
      "unexpected text between choices",
      [
        ...validLines.slice(0, persistentIndex),
        "This line must not be accepted as option continuation.",
        ...validLines.slice(persistentIndex)
      ].join("\n")
    ],
    [
      "choices in the wrong order",
      [
        ...validLines.slice(0, yesIndex),
        " ❯ 1. Yes",
        "   3. No",
        "   2. Yes, and don't ask again for this command",
        ...validLines.slice(yesIndex + 3)
      ].join("\n")
    ],
    [
      "extra choice",
      [
        ...validLines.slice(0, noIndex + 1),
        "   4. Open settings",
        ...validLines.slice(noIndex + 1)
      ].join("\n")
    ],
    [
      "unknown footer control",
      validLines.map((line, index) =>
        index === footerIndex
          ? " Esc to cancel · Tab to amend · ctrl+x to trust"
          : line
      ).join("\n")
    ],
    [
      "explain control without amend",
      validLines.map((line, index) =>
        index === footerIndex
          ? " Esc to cancel · ctrl+e to explain"
          : line
      ).join("\n")
    ],
    [
      "reordered footer controls",
      validLines.map((line, index) =>
        index === footerIndex
          ? " Esc to cancel · ctrl+e to explain · Tab to amend"
          : line
      ).join("\n")
    ]
  ];

  for (const [label, screen] of cases) {
    const approval = detectClaudeApprovalPrompt(screen);
    assert.equal(approval.approvable, false, label);
    assert.equal(approval.action, undefined, label);
  }
});

test("a strict Bash dialog is non-approvable without an AKK-managed runtime", () => {
  const inspection = inspectClaudeScreen({
    screen: [
      " Bash command",
      "",
      "   npm test",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and don't ask again for this command",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend"
    ].join("\n")
  });

  assert.equal(inspection.activity.state, "awaiting_approval");
  assert.equal(inspection.approval.blocked, true);
  assert.equal(inspection.approval.approvable, false);
  assert.equal(inspection.approval.action, undefined);
  assert.match(inspection.approval.reason, /AKK-managed turn/u);
});

test("permission fallback fails closed for persistent, negative, unknown, and stale choices", () => {
  for (const [label, selected] of [
    ["persistent", "❯ 2. Yes, and don’t ask again for: shasum *"],
    ["negative", "❯ 3. No"],
    ["unknown", "❯ 1. Allow once"]
  ]) {
    const approval = detectClaudeApprovalPrompt([
      "Do you want to proceed?",
      "  1. Yes",
      selected,
      "  3. No",
      "Esc to cancel"
    ].join("\n"));
    assert.equal(approval.blocked, true, label);
    assert.equal(approval.approvable, false, label);
    assert.equal(approval.action, undefined, label);
  }

  const stale = detectClaudeApprovalPrompt([
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "Bash command completed",
    "────────────────────────",
    "❯",
    "────────────────────────",
    "accept edits on"
  ].join("\n"));
  assert.equal(stale.blocked, false);
  assert.equal(stale.approvable, false);
  assert.match(stale.reason, /stale/);

  const staleWithoutIdle = detectClaudeApprovalPrompt([
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. No",
    "Bash command completed after the old dialog"
  ].join("\n"));
  assert.equal(staleWithoutIdle.blocked, true);
  assert.equal(staleWithoutIdle.approvable, false);
  assert.match(staleWithoutIdle.reason, /does not match/);

  const prose = detectClaudeApprovalPrompt([
    "The README asks: Do you want to proceed?",
    "This is ordinary assistant prose, not a dialog.",
    "❯"
  ].join("\n"));
  assert.equal(prose.blocked, false);
  assert.equal(prose.approvable, false);
});

test("screen excerpts redact secrets and idle never becomes completion evidence", () => {
  const screen = [
    "ANTHROPIC_API_KEY=sk-ant-api03-super-secret-value",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "❯",
    "accept edits on"
  ].join("\n");
  const inspection = inspectClaudeScreen({
    screen,
    requestText: "finish the task",
    screenChangedSinceSend: true
  });

  assert.equal(inspection.activity.state, "idle");
  assert.equal(inspection.completion, undefined);
  assert.doesNotMatch(inspection.screenExcerpt, /super-secret-value/);
  assert.doesNotMatch(inspection.screenExcerpt, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(inspection.screenExcerpt, /\[REDACTED\]/);
});

test("Claude terminal capabilities expose durable completion only with a configured provider", async () => {
  assert.deepEqual(terminalControlCapabilitiesForAdapter(claudeTerminalAgentAdapter), [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "terminal_cancel"
  ]);
  assert.deepEqual(claudeTerminalAgentAdapter.cancelKeys, ["Escape"]);
  assert.equal(claudeTerminalAgentAdapter.capabilities.screenCompletion, false);
  assert.equal(claudeTerminalAgentAdapter.capabilities.durableCompletion, false);
  assert.equal(claudeTerminalAgentAdapter.detectDurableCompletion, undefined);

  const transcriptAdapter = createClaudeTerminalAgentAdapter({
    async detectDurableCompletion() {
      return {
        source: "durable",
        text: "Transcript-complete"
      };
    }
  });
  assert.equal(transcriptAdapter.capabilities.durableCompletion, true);
  assert.equal(
    (await transcriptAdapter.detectDurableCompletion?.({}))?.text,
    "Transcript-complete"
  );
});

test("Claude 2.1.218 lifecycle plan is exact-version and UUID scoped", () => {
  const capabilities = probeClaudeThreadLifecycle("2.1.218");
  assert.equal(capabilities.status, "supported");
  assert.equal(capabilities.behaviorProfile, "claude-code-2.1.218");
  assert.equal(probeClaudeThreadLifecycle("2.1.219").status, "unsupported");
  assert.equal(probeClaudeThreadLifecycle(undefined).status, "unknown");
  assert.deepEqual(
    planClaudeThreadLifecycle({ kind: "new_thread" }, capabilities).steps,
    [{
      kind: "transition",
      command: "/clear",
      effect: "thread_transition",
      requiresIdle: true
    }]
  );

  const target = "22222222-2222-4222-8222-222222222222";
  assert.equal(
    planClaudeThreadLifecycle(
      { kind: "resume_thread", nativeThreadId: target },
      capabilities
    ).steps[0].command,
    `/resume ${target}`
  );
  assert.throws(
    () => planClaudeThreadLifecycle(
      { kind: "resume_thread", nativeThreadId: "partial" },
      capabilities
    ),
    /complete native thread UUID/u
  );
});

test("Claude lifecycle observer requires one idle exact-PID agents row", () => {
  const before = "11111111-1111-4111-8111-111111111111";
  const after = "22222222-2222-4222-8222-222222222222";
  const baseRequest = {
    operation: { kind: "new_thread" as const },
    phase: "after" as const,
    beforeNativeThreadId: before,
    pid: 29466,
    processStartedAt: 1784870000000,
    cwd: "/repo",
    agentRows: [{
      pid: 29466,
      cwd: "/repo",
      kind: "interactive",
      sessionId: after,
      startedAt: 1784870000000,
      status: "idle"
    }]
  };
  assert.deepEqual(observeClaudeThreadLifecycle(baseRequest), {
    status: "verified",
    nativeThreadId: after,
    evidence: "claude_agents_exact_pid",
    idle: true
  });
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      operation: { kind: "resume_thread", nativeThreadId: after }
    }).status,
    "verified"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      agentRows: [{ ...baseRequest.agentRows[0], status: "working" }]
    }).status,
    "mismatch"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      agentRows: [baseRequest.agentRows[0], baseRequest.agentRows[0]]
    }).status,
    "ambiguous"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      processStartedAt: 1784870000001
    }).status,
    "mismatch"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      processStartedAt: -1,
      agentRows: [{ ...baseRequest.agentRows[0], startedAt: -1 }]
    }).status,
    "missing"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      agentRows: [{ ...baseRequest.agentRows[0], kind: "background" }]
    }).status,
    "mismatch"
  );
  assert.equal(
    observeClaudeThreadLifecycle({
      ...baseRequest,
      agentRows: [{ ...baseRequest.agentRows[0], cwd: "/another-repo" }]
    }).status,
    "mismatch"
  );
  assert.equal(
    observeClaudeThreadLifecycle(
      "Session: untrusted-screen-text",
      { kind: "new_thread" }
    ).status,
    "missing"
  );
});

function currentClaudePermissionScreen(
  command: string,
  description?: string,
  visibleCommandLines: readonly string[] = [command]
): string {
  return [
    "Bash command",
    "",
    ...visibleCommandLines.map((line) => `  ${line}`),
    ...(description ? [`  ${description}`] : []),
    "",
    "This command requires approval",
    "",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, and don't ask again for this command",
    "  3. No",
    "",
    "Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}
