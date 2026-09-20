import {
  test,
  assert,
  createHash,
  fs,
  os,
  path,
  plugin,
  createOpenClawPluginForTest,
  readSupervisorCalls,
  optionAfter,
  isRecord,
  type ToolDefinition,
  type ToolFactory
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw routing and reconciliation omit a global workspace argument", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-send-paths-"));
  const fakeCli = path.join(tempDir, "delegate.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const eventLogPath = path.join(tempDir, "events.ndjson");
  const followCurrentTerminalId =
    "terminal:v2:tmux:codex:work:0.0:1234";
  let sendTool: ToolDefinition | undefined;
  let sendToolFactory: ToolFactory | undefined;
  let respondTool: ToolDefinition | undefined;
  let reconciliationService: {
    start?(): void;
    stop?(): void | Promise<void>;
  } | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const args = process.argv.slice(2);`,
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";`,
        `const sendResult = ${JSON.stringify({
          conversation: {
            conversation_id: "turn-1",
            session_id: "session-1",
            turn_id: "turn-1",
            status: "waiting_for_agent",
            state_path: statePath,
            event_log_path: eventLogPath,
            executor: {
              kind: "codex",
              session: "terminal:v2:tmux:codex:work:0.0:123"
            }
          },
          terminal_control: {
            target: "work:0.0",
            panePid: 123
          },
          delivered: true,
          background: true
        })};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: { send: {`,
        `    tool: "agent_knock_knock_send",`,
        `    arguments: { selector: terminalId, expected_terminal_token: "terminal-token-current", expected_managed_terminal_token: "managed-terminal-token-current", request: "continue" }`,
        `  } }`,
        `}] } : sendResult;`,
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n")
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService(service: {
        start?(): void;
        stop?(): void | Promise<void>;
      }) {
        reconciliationService = service;
      },
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:main",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name === "agent_knock_knock_send") {
          sendTool = definition;
          sendToolFactory = typeof tool === "function" ? tool : undefined;
        }
        if (options?.name === "agent_knock_knock_respond") {
          respondTool = definition;
        }
      }
    });

    assert.equal(typeof sendTool?.execute, "function");
    assert.equal(sendTool?.parameters?.additionalProperties, false);
    assert.equal(sendTool?.parameters?.required, undefined);
    assert.deepEqual(sendTool?.parameters?.oneOf, [
      {
        required: ["request"],
        not: { required: ["turn_id"] }
      },
      {
        required: ["turn_id"],
        not: {
          anyOf: [
            { required: ["request"] },
            { required: ["session_id"] },
            { required: ["terminal_id"] },
            { required: ["type"] },
            { required: ["idleTimeoutMinutes"] },
            { required: ["agentTimeoutMinutes"] },
            { required: ["agentHardTimeoutMinutes"] }
          ]
        }
      }
    ]);
    assert.deepEqual(sendTool?.parameters?.not, {
      required: ["session_id", "terminal_id"]
    });
    assert.equal(
      "timeoutSeconds" in (sendTool?.parameters?.properties ?? {}),
      false
    );
    const sendTypeSchema = sendTool?.parameters?.properties?.type;
    assert.deepEqual(
      isRecord(sendTypeSchema) ? sendTypeSchema.enum : undefined,
      ["task"]
    );
    for (const field of [
      "session_id",
      "terminal_id",
      "request",
      "turn_id"
    ]) {
      const schema = sendTool?.parameters?.properties?.[field];
      assert.equal(
        isRecord(schema) ? schema.minLength : undefined,
        1,
        `${field} must reject empty strings at the schema boundary`
      );
    }
    const idleTimeoutSchema = sendTool?.parameters?.properties?.idleTimeoutMinutes;
    assert.match(
      isRecord(idleTimeoutSchema)
        ? String(idleTimeoutSchema.description ?? "")
        : "",
      /idle or completed AKK Turn record is retained/u
    );
    assert.match(sendTool?.description ?? "", /session_id/u);
    assert.match(sendTool?.description ?? "", /terminal_id/u);
    assert.match(sendTool?.description ?? "", /exact \{turn_id\} form/u);
    assert.match(
      sendTool?.description ?? "",
      /opaque freshness authority stay private/u
    );
    assert.match(
      sendTool?.description ?? "",
      /terminal_user_explicit[\s\S]*exact live physical terminal\/process[\s\S]*scanned non-blocked approval state[\s\S]*no input-owning native questionnaire\/editor(?:, menu,)? or read-only viewer[\s\S]*parsed working activity[\s\S]*Codex rollout ambiguity[\s\S]*Composer visibility, stability,(?: or)? exactness[\s\S]*existing draft contents[\s\S]*do not veto[\s\S]*C-u[\s\S]*Claude Code[\s\S]*whole-draft clear[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*without a post-text Composer veto[\s\S]*source-less Codex terminal[\s\S]*provisional Session\/Turn[\s\S]*managed preparation fails[\s\S]*unmanaged work[\s\S]*Terminal Watch callback[\s\S]*exact request acceptance[\s\S]*owner-bound response authority[\s\S]*watch_id[\s\S]*manual_required interactions remain notification-only/u
    );
    const terminalIdSchema = sendTool?.parameters?.properties?.terminal_id;
    assert.match(
      isRecord(terminalIdSchema)
        ? String(terminalIdSchema.description ?? "")
        : "",
      /Codex and Claude Code terminal_user_explicit[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state[\s\S]*Composer visibility, stability, exactness[\s\S]*not eligibility vetoes[\s\S]*C-u[\s\S]*Claude Code[\s\S]*whole-draft clear[\s\S]*paste window[\s\S]*Enter exactly once[\s\S]*without a post-text Composer veto[\s\S]*Broken AKK state cannot veto[\s\S]*no managed callback Turn[\s\S]*Terminal Watch callback/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-answer", {
        request: "Do not route this as an ordinary send",
        type: "answer"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-control", {
        session_id: "session-1",
        request: "Do not route this control message",
        type: "control"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-ambiguous-target", {
        session_id: "session-1",
        terminal_id: followCurrentTerminalId,
        request: "Do not choose one target silently"
      }),
      /only one of session_id or terminal_id/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-short-terminal", {
        terminal_id: "@a1b2c3d4",
        request: "Do not expand a short selector under a terminal fence"
      }),
      /terminal_id must be the exact full terminal identifier/u
    );
    for (const [field, value] of [
      ["session_id", ""],
      ["session_id", "   "],
      ["terminal_id", ""],
      ["terminal_id", "   "]
    ] as const) {
      await assert.rejects(
        () => sendTool!.execute!(`tool-call-empty-${field}`, {
          [field]: value,
          request: "Never fall back to automatic terminal selection"
        }),
        new RegExp(`${field} is required`, "u")
      );
    }
    const result = await sendTool?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    assert.equal(result?.details?.state_path, statePath);
    assert.equal(result?.details?.event_log_path, eventLogPath);
    assert.equal(result?.details?.session_id, "session-1");
    assert.equal(result?.details?.turn_id, "turn-1");
    await sendTool?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    await sendTool?.execute?.("tool-call-2", {
      session_id: "session-1",
      request: "Start a distinct turn"
    });
    await sendTool?.execute?.("tool-call-3", {
      terminal_id: followCurrentTerminalId,
      request: "Discover the initial terminal"
    });
    assert.deepEqual(respondTool?.parameters?.required, ["turn_id", "request"]);
    const respondResult = await respondTool?.execute?.("tool-call-4", {
      turn_id: "turn-1",
      request: "Use the safer implementation"
    });
    assert.equal(respondResult?.details?.session_id, "session-1");
    assert.equal(respondResult?.details?.turn_id, "turn-1");
    await respondTool?.execute?.("tool-call-4", {
      turn_id: "turn-1",
      request: "Use the safer implementation"
    });
    assert.equal(typeof reconciliationService?.start, "function");
    reconciliationService?.start?.();
    const otherSessionSend = sendToolFactory?.({
      sessionKey: "agent:test:other",
      sessionId: "openclaw-conversation-a"
    } as never);
    await otherSessionSend?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    await respondTool?.execute?.("tool-call-1", {
      turn_id: "turn-1",
      request: "Keep send and respond idempotency domains separate"
    });
    const nextConversationSend = sendToolFactory?.({
      sessionKey: "agent:test:main",
      sessionId: "openclaw-conversation-b"
    } as never);
    await nextConversationSend?.execute?.("tool-call-1", {
      request: "Verify a reset OpenClaw conversation is isolated"
    });
    await sendTool?.execute?.("tool-call-follow-current", {
      terminal_id: followCurrentTerminalId,
      request: "Continue in the human-selected terminal context"
    });
    await reconciliationService?.stop?.();
    const allCalls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const reconciliationCalls = allCalls.filter(
      ([command]) => command === "reconcile-monitors" ||
        command === "reconcile-watches"
    );
    const privateListCalls = allCalls.filter(([command]) => command === "list");
    const calls = allCalls.filter(
      ([command]) => command !== "reconcile-monitors" &&
        command !== "reconcile-watches" &&
        command !== "list"
    );
    assert.equal(privateListCalls.length, 2);
    assert.equal(calls[0]?.[0], "delegate");
    assert.equal(calls[0]?.includes("--agent"), false);
    assert.equal(calls[0]?.includes("--workspace"), false);
    const expectedToolCall1MessageId =
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-1"
      ])).digest("hex")}`;
    const optionValue = (args: string[], name: string): string | undefined => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    assert.equal(
      optionValue(calls[0] ?? [], "--message-id"),
      expectedToolCall1MessageId
    );
    assert.equal(
      optionValue(calls[1] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "the same OpenClaw tool call must reuse one redacted idempotency key"
    );
    assert.deepEqual(calls[2]?.slice(0, 5), [
      "send",
      "--session",
      "session-1",
      "--message",
      "Start a distinct turn"
    ]);
    assert.equal(calls[2]?.includes("--workspace"), false);
    assert.equal(
      optionValue(calls[2] ?? [], "--message-id"),
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-2"
      ])).digest("hex")}`
    );
    assert.deepEqual(calls[3]?.slice(0, 5), [
      "send",
      "--conversation",
      followCurrentTerminalId,
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    assert.equal(
      optionValue(calls[3] ?? [], "--message"),
      "Discover the initial terminal"
    );
    assert.equal(
      optionValue(calls[3] ?? [], "--expected-managed-terminal-token"),
      "managed-terminal-token-current"
    );
    assert.equal(
      optionValue(calls[3] ?? [], "--message-id"),
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-3"
      ])).digest("hex")}`
    );
    assert.deepEqual(calls[4]?.slice(0, 5), [
      "respond",
      "--turn",
      "turn-1",
      "--message",
      "Use the safer implementation"
    ]);
    const expectedRespondMessageId =
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_respond",
        "tool-call-4"
      ])).digest("hex")}`;
    assert.equal(
      optionValue(calls[4] ?? [], "--message-id"),
      expectedRespondMessageId
    );
    assert.equal(
      optionValue(calls[5] ?? [], "--message-id"),
      expectedRespondMessageId,
      "the same OpenClaw respond call must reuse one redacted idempotency key"
    );
    assert.equal(
      optionValue(calls[4] ?? [], "--openclaw-session"),
      "agent:test:main"
    );
    assert.deepEqual(
      reconciliationCalls.map(([command]) => command),
      ["reconcile-monitors", "reconcile-watches"]
    );
    assert.equal(reconciliationCalls[0]?.includes("--workspace"), false);
    assert.equal(reconciliationCalls[1]?.includes("--workspace"), false);
    assert.notEqual(
      optionValue(calls[6] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "the same tool call id in another OpenClaw Session must be isolated"
    );
    assert.notEqual(
      optionValue(calls[7] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "send and respond must have separate idempotency domains"
    );
    assert.notEqual(
      optionValue(calls[8] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "a new OpenClaw conversation incarnation must not replay an old receipt"
    );
    assert.deepEqual(calls[9]?.slice(0, 5), [
      "send",
      "--conversation",
      followCurrentTerminalId,
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    assert.equal(
      optionValue(calls[9] ?? [], "--message"),
      "Continue in the human-selected terminal context"
    );
    assert.equal(
      optionValue(calls[9] ?? [], "--expected-managed-terminal-token"),
      "managed-terminal-token-current"
    );
  } finally {
    await reconciliationService?.stop?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw send retry uses only the currently advertised exact Turn form", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-send-retry-")
  );
  const fakeCli = path.join(tempDir, "send-retry.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const turnId = "turn-submission-uncertain";
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const turnId = ${JSON.stringify(turnId)};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: "terminal:v2:tmux:codex:retry:0.0:1234",`,
        `  available_actions: { retry_submission: {`,
        `    tool: "agent_knock_knock_send",`,
        `    arguments: { turn_id: turnId },`,
        `    requires_explicit_user_confirmation: true`,
        `  } }`,
        `}] } : {`,
        `  conversation_id: turnId, session_id: "session-retry",`,
        `  turn_id: turnId, status: "stalled",`,
        `  submission_outcome: "pending_acceptance"`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({
                sessionKey: "agent:test:retry",
                sessionId: "openclaw-retry"
              } as never)
            : tool;
        }
      }
    });

    for (const extra of [
      { request: "never inject replacement text" },
      { session_id: "session-retry" },
      { terminal_id: "terminal:v2:tmux:codex:retry:0.0:1234" },
      { agentTimeoutMinutes: 1 },
      { openclawSession: "caller-selected-route" }
    ]) {
      await assert.rejects(
        () => sendTool!.execute!("invalid-retry-form", {
          turn_id: turnId,
          ...extra
        }),
        /retry_submission accepts exactly turn_id/u
      );
    }
    await assert.rejects(
      () => sendTool!.execute!("invalid-retry-selector", {
        turn_id: "@deadbeef"
      }),
      /turn_id must be an authoritative managed id/u
    );

    const result = await sendTool?.execute?.("retry-once", {
      turn_id: turnId
    });
    assert.equal(result?.details?.turn_id, turnId);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0], ["list", "--reconcile"]);
    assert.deepEqual(calls[1], ["send", "--turn", turnId]);
    for (const forbidden of [
      "--message",
      "--session",
      "--conversation",
      "--agent-timeout-minutes",
      "--openclaw-session",
      "--gateway-session",
      "--gateway-method"
    ]) {
      assert.equal(calls[1]?.includes(forbidden), false, forbidden);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw monitor supervisor reconciles repeatedly without overlap and stops cleanly", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-monitor-supervisor-")
  );
  const fakeCli = path.join(tempDir, "supervisor.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const activePath = path.join(tempDir, "active");
  const startupReadyPath = path.join(tempDir, "startup-ready");
  const startupGatePath = path.join(tempDir, "startup-gate");
  let service: {
    start?(): void;
    stop?(): void | Promise<void>;
  } | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        'const fs = require("node:fs");',
        `const callsPath = ${JSON.stringify(callsPath)};`,
        `const activePath = ${JSON.stringify(activePath)};`,
        "const args = process.argv.slice(2);",
        "if (fs.existsSync(activePath)) { fs.appendFileSync(callsPath, JSON.stringify({ phase: 'overlap', args }) + '\\n'); }",
        "fs.writeFileSync(activePath, String(process.pid));",
        "fs.appendFileSync(callsPath, JSON.stringify({ phase: 'start', args }) + '\\n');",
        `if (args[0] === "reconcile-monitors" && args.includes("startup_reconciliation")) {`,
        `  fs.writeFileSync(${JSON.stringify(startupReadyPath)}, "ready");`,
        "  const deadline = Date.now() + 1000;",
        `  while (!fs.existsSync(${JSON.stringify(startupGatePath)}) && Date.now() < deadline) {`,
        "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
        "  }",
        `  if (!fs.existsSync(${JSON.stringify(startupGatePath)})) process.exit(88);`,
        "}",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);",
        "fs.rmSync(activePath, { force: true });",
        "fs.appendFileSync(callsPath, JSON.stringify({ phase: 'end', args }) + '\\n');",
        "process.stdout.write(JSON.stringify({ checked: 1, launched: 0, already_running: 1, skipped: 0, errors: 0 }));"
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli, {
        monitorSupervisorIntervalMs: 20
      }) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService(value: typeof service) {
        service = value;
      },
      registerCommand() {},
      registerTool() {}
    });

    assert.equal(typeof service?.start, "function");
    assert.equal(typeof service?.stop, "function");
    const startupBeganAt = Date.now();
    service?.start?.();
    assert.equal(
      Date.now() - startupBeganAt < 500,
      true,
      "Terminal Watch startup reconciliation must not block the Gateway event loop"
    );
    const readyDeadline = Date.now() + 1_000;
    while (!fs.existsSync(startupReadyPath) && Date.now() < readyDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(startupReadyPath), true);
    fs.writeFileSync(startupGatePath, "continue");
    const deadline = Date.now() + 2_000;
    while (
      (!fs.existsSync(callsPath) ||
        readSupervisorCalls(callsPath).filter((entry) => entry.phase === "start")
          .length < 4) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await service?.stop?.();
    const stoppedCalls = readSupervisorCalls(callsPath);
    assert.equal(
      stoppedCalls.filter((entry) => entry.phase === "start").length >= 4,
      true
    );
    assert.equal(
      stoppedCalls.some((entry) => entry.phase === "overlap"),
      false
    );
    const starts = stoppedCalls.filter((entry) => entry.phase === "start");
    assert.equal(starts[0]?.args[0], "reconcile-monitors");
    assert.equal(starts[1]?.args[0], "reconcile-watches");
    assert.equal(starts[2]?.args[0], "reconcile-monitors");
    assert.equal(starts[3]?.args[0], "reconcile-watches");
    assert.equal(optionAfter(starts[0]?.args ?? [], "--reason"), "startup_reconciliation");
    assert.equal(optionAfter(starts[2]?.args ?? [], "--reason"), "monitor_supervision");
    assert.equal(starts[1]?.args.includes("--reason"), false);
    assert.equal(starts[3]?.args.includes("--reason"), false);
    assert.equal(starts[0]?.args.includes("--terminal-monitors-only"), false);
    assert.equal(starts[1]?.args.includes("--terminal-monitors-only"), false);
    assert.equal(starts[2]?.args.includes("--terminal-monitors-only"), true);
    assert.equal(starts[3]?.args.includes("--terminal-monitors-only"), false);
    const countAfterStop = stoppedCalls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(readSupervisorCalls(callsPath).length, countAfterStop);
  } finally {
    await service?.stop?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw supervisor isolates managed monitor and Terminal Watch failures", async () => {
  const runFailureCase = async (
    failingCommand: "reconcile-monitors" | "reconcile-watches"
  ): Promise<void> => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `akk-plugin-supervisor-${failingCommand}-`)
    );
    const fakeCli = path.join(tempDir, "supervisor-failure.cjs");
    const callsPath = path.join(tempDir, "calls.ndjson");
    const warnings: string[] = [];
    let service: {
      start?(): void;
      stop?(): void | Promise<void>;
    } | undefined;

    try {
      fs.writeFileSync(
        fakeCli,
        [
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
          `if (args[0] === ${JSON.stringify(failingCommand)}) { process.stderr.write("injected failure"); process.exit(9); }`,
          "process.stdout.write(JSON.stringify({ checked: 1, launched: 0, already_running: 1, skipped: 0, changed: 0, callbacks_delivered: 0, errors: 0 }));"
        ].join("\n"),
        "utf8"
      );

      (
        createOpenClawPluginForTest(fakeCli, {
          monitorSupervisorIntervalMs: 20
        }) as unknown as {
          register(api: Record<string, any>): void;
        }
      ).register({
        pluginConfig: {},
        logger: {
          info() {},
          warn(message: string) {
            warnings.push(message);
          }
        },
        registerGatewayMethod() {},
        registerService(value: typeof service) {
          service = value;
        },
        registerCommand() {},
        registerTool() {}
      });

      service?.start?.();
      const deadline = Date.now() + 2_000;
      while (
        (!fs.existsSync(callsPath) ||
          fs.readFileSync(callsPath, "utf8").trim().split("\n").length < 4) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      await service?.stop?.();
      const calls = fs.readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls.slice(0, 4).map((args) => args[0]), [
        "reconcile-monitors",
        "reconcile-watches",
        "reconcile-monitors",
        "reconcile-watches"
      ]);
      assert.equal(
        warnings.some((message) =>
          failingCommand === "reconcile-monitors"
            ? message.includes("monitor supervision deferred") ||
              message.includes("monitor reconciliation skipped")
            : message.includes("Terminal Watch supervision deferred") ||
              message.includes("Terminal Watch reconciliation skipped")
        ),
        true
      );
    } finally {
      await service?.stop?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  await runFailureCase("reconcile-monitors");
  await runFailureCase("reconcile-watches");
});
