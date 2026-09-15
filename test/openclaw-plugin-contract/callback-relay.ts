import {
  test,
  assert,
  createHash,
  fs,
  http,
  os,
  path,
  plugin,
  createOpenClawPluginForTest,
  isRecord,
  type GatewayMethodHandler
} from "../support/openclaw-plugin-contract-support.js";

test("callback delivery uses the grouped OpenClaw session workflow API", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedInjection: Record<string, unknown> | undefined;
  let response:
    | {
        ok: boolean;
        result?: Record<string, unknown>;
        error?: {
          code?: string;
          message?: string;
        };
      }
    | undefined;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: {
      info() {},
      warn() {}
    },
    session: {
      workflow: {
        async enqueueNextTurnInjection(
          injection: Record<string, unknown>
        ) {
          capturedInjection = injection;
          return {
            enqueued: true,
            id: "injection-1",
            sessionKey: injection.sessionKey
          };
        }
      }
    },
    registerGatewayMethod(
      method: string,
      handler: GatewayMethodHandler
    ) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      conversation: {
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        gateway_session: "agent:main:compat",
        openclaw_session: "agent:main:origin"
      },
      message: {
        id: "message-1",
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        type: "progress",
        requires_response: false,
        round: 1,
        body: "Compatibility callback",
        metadata: {
          conversation_id: "turn-1",
          session_id: "session-1",
          turn_id: "turn-1"
        }
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.error, undefined);
  assert.equal(response?.result?.enqueued, true);
  assert.equal(response?.result?.delivery_required, false);
  assert.equal(response?.result?.session_key, "agent:main:compat");
  assert.equal(response?.result?.session_id, "session-1");
  assert.equal(response?.result?.turn_id, "turn-1");
  assert.deepEqual(capturedInjection, {
    sessionKey: "agent:main:compat",
    text: [
      "[Agent Knock Knock callback]",
      "Session: session-1",
      "Turn: turn-1",
      "Message type: progress",
      "Requires OpenClaw response: no",
      "Round: 1",
      "Compatibility callback"
    ].join("\n"),
    idempotencyKey: "agent-knock-knock:session-1:turn-1:message-1",
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      message_type: "progress"
    }
  });

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2"
      },
      message: {
        id: "message-done",
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2",
        type: "done",
        requires_response: false,
        round: 1,
        body: "All focused tests passed"
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });
  const doneText = String(capturedInjection?.text ?? "");
  const doneResult = (
    response as { result?: Record<string, unknown> } | undefined
  )?.result;
  assert.equal(doneResult?.session_id, "session-1");
  assert.equal(doneResult?.turn_id, "turn-2");
  assert.equal(doneResult?.delivery_required, true);
  assert.match(doneText, /Session: session-1/u);
  assert.match(doneText, /Turn: turn-2/u);
  assert.match(doneText, /agent_knock_knock_send/u);
  assert.match(doneText, /Session "session-1" remains the context label/u);
  assert.match(doneText, /exact `available_actions\.send`/u);
  assert.match(doneText, /Do not assume the returned Session is directly sendable/u);
  assert.match(doneText, /agent_knock_knock_status/u);
  assert.match(doneText, /turn_id: "turn-2"/u);
  assert.doesNotMatch(doneText, /follow_up/u);
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:session-1:turn-2:message-done"
  );
  const chatSend = isRecord(doneResult?.chat_send)
    ? doneResult.chat_send
    : undefined;
  assert.equal(
    chatSend?.idempotencyKey,
    "agent-knock-knock-callback:session-1:turn-2:message-done"
  );

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "legacy-callback-3"
      },
      message: {
        id: "message-legacy",
        conversation_id: "legacy-callback-3",
        type: "done",
        requires_response: false,
        round: 1,
        body: "Legacy callback identity"
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });
  const legacyResponse = response as
    | { ok: boolean; result?: Record<string, unknown> }
    | undefined;
  assert.equal(legacyResponse?.ok, true);
  assert.equal(legacyResponse?.result?.conversation_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.session_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.turn_id, "legacy-callback-3");
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:legacy-callback-3:message-legacy"
  );
  assert.equal(
    (legacyResponse?.result?.chat_send as Record<string, unknown> | undefined)
      ?.idempotencyKey,
    "agent-knock-knock-callback:legacy-callback-3:message-legacy"
  );
});

test("callback rejects conflicting identities before injection or dedupe", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let injectionCalls = 0;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection() {
          injectionCalls += 1;
          return { enqueued: true };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  const validParams = () => ({
    sessionKey: "agent:main:identity-check",
    conversation_id: "turn-safe",
    session_id: "session-safe",
    turn_id: "turn-safe",
    conversation: {
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      openclaw_session: "agent:main:identity-check"
    },
    message: {
      id: "message-safe",
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      type: "done",
      requires_response: false,
      round: 1,
      body: "Identity-safe callback",
      metadata: {
        conversation_id: "turn-safe",
        session_id: "session-safe",
        turn_id: "turn-safe",
        openclaw_session: "agent:main:identity-check"
      }
    }
  });
  const cases: Array<{
    name: string;
    mutate(params: ReturnType<typeof validParams>): void;
    error: RegExp;
  }> = [
    {
      name: "conflicting top-level session",
      mutate(params) {
        params.session_id = "session-other";
      },
      error: /session_id mismatch/u
    },
    {
      name: "conflicting metadata turn",
      mutate(params) {
        params.message.metadata.turn_id = "turn-other";
      },
      error: /turn_id mismatch/u
    },
    {
      name: "conflicting message conversation",
      mutate(params) {
        params.message.conversation_id = "turn-other";
      },
      error: /conversation_id mismatch/u
    },
    {
      name: "modern conversation id differs from turn id",
      mutate(params) {
        params.conversation_id = "compat-other";
        params.conversation.conversation_id = "compat-other";
        params.message.conversation_id = "compat-other";
        params.message.metadata.conversation_id = "compat-other";
      },
      error: /conversation_id must equal turn_id/u
    },
    {
      name: "modern identity is missing session id",
      mutate(params) {
        delete (params as any).session_id;
        delete (params.conversation as any).session_id;
        delete (params.message as any).session_id;
        delete (params.message.metadata as any).session_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing turn id",
      mutate(params) {
        delete (params as any).turn_id;
        delete (params.conversation as any).turn_id;
        delete (params.message as any).turn_id;
        delete (params.message.metadata as any).turn_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing the conversation alias",
      mutate(params) {
        delete (params as any).conversation_id;
        delete (params.conversation as any).conversation_id;
        delete (params.message as any).conversation_id;
        delete (params.message.metadata as any).conversation_id;
      },
      error: /require conversation_id/u
    },
    {
      name: "callback has no identity",
      mutate(params) {
        for (const field of ["conversation_id", "session_id", "turn_id"]) {
          delete (params as any)[field];
          delete (params.conversation as any)[field];
          delete (params.message as any)[field];
          delete (params.message.metadata as any)[field];
        }
      },
      error: /callback identity requires/u
    },
    {
      name: "OpenClaw session targets conflict",
      mutate(params) {
        params.conversation.openclaw_session = "agent:other:session";
      },
      error: /session mismatch/u
    },
    {
      name: "OpenClaw identity sources conflict",
      mutate(params) {
        params.message.metadata.openclaw_session = "agent:other:session";
      },
      error: /OpenClaw session mismatch/u
    },
    {
      name: "callback message id is missing",
      mutate(params) {
        delete (params.message as any).id;
      },
      error: /message.id is required/u
    }
  ];

  for (const mismatch of cases) {
    let callbackResponse:
      | {
          ok: boolean;
          error?: { code?: string; message?: string };
        }
      | undefined;
    await callbackHandler?.({
      params: (() => {
        const params = validParams();
        mismatch.mutate(params);
        return params;
      })(),
      respond(ok, _result, error) {
        callbackResponse = { ok, ...(error ? { error } : {}) };
      }
    });
    assert.equal(callbackResponse?.ok, false, mismatch.name);
    assert.equal(
      callbackResponse?.error?.code,
      "AGENT_KNOCK_KNOCK_CALLBACK_FAILED",
      mismatch.name
    );
    assert.match(callbackResponse?.error?.message ?? "", mismatch.error, mismatch.name);
    assert.equal(injectionCalls, 0, mismatch.name);
  }
});

test("callback auto approval keeps its rule workspace boundary without global workspace config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-autoapprove-workspace-"));
  const allowedWorkspace = path.join(tempDir, "allowed");
  const outsideWorkspace = path.join(tempDir, "outside");
  const fakeCli = path.join(tempDir, "approve.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const policy = {
    enabled: true,
    rules: [{
      id: "allowed-status",
      agents: ["codex"],
      workspaces: [allowedWorkspace],
      commands: [["git", "status"]]
    }]
  };
  let callbackHandler: GatewayMethodHandler | undefined;
  const injections: Record<string, unknown>[] = [];

  try {
    fs.mkdirSync(allowedWorkspace, { recursive: true });
    fs.mkdirSync(outsideWorkspace, { recursive: true });
    fs.writeFileSync(
      fakeCli,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write(${JSON.stringify(JSON.stringify({
          approved: true,
          policy_rule_id: "allowed-status",
          monitor_pid: 71
        }))});`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        autoApprove: policy
      },
      logger: {
        info() {},
        warn() {}
      },
      session: {
        workflow: {
          async enqueueNextTurnInjection(
            injection: Record<string, unknown>
          ) {
            injections.push(injection);
            return {
              enqueued: true,
              id: `injection-${injections.length}`,
              sessionKey: injection.sessionKey
            };
          }
        }
      },
      registerGatewayMethod(
        method: string,
        handler: GatewayMethodHandler
      ) {
        if (method === "agent-knock-knock.callback") {
          callbackHandler = handler;
        }
      },
      registerService() {},
      registerCommand() {},
      registerTool() {}
    });

    assert.equal(typeof callbackHandler, "function");
    const invokeApprovalCallback = async (
      messageId: string,
      cwd: string,
      options: {
        legacy?: boolean;
        splitFingerprint?: boolean;
      } = {}
    ) => {
      const turnId = "turn-autoapprove-workspace";
      const sessionId = "session-autoapprove-workspace";
      const approvalFingerprint = createHash("sha256")
        .update(messageId)
        .digest("hex");
      let callbackResponse:
        | {
            ok: boolean;
            result?: Record<string, any>;
            error?: { code?: string; message?: string };
          }
        | undefined;
      const callbackConversation: Record<string, unknown> = {
        conversation_id: turnId,
        session_id: sessionId,
        turn_id: turnId,
        openclaw_session: "agent:test:autoapprove",
        state_path: statePath
      };
      const callbackMessage: Record<string, any> = {
        id: messageId,
        conversation_id: turnId,
        session_id: sessionId,
        turn_id: turnId,
        type: "question",
        requires_response: true,
        body: "Codex needs approval",
        metadata: {
          source: "terminal_bridge",
          reason: "approval_required",
          approval_candidate: {
            agent: "codex",
            kind: "run_command",
            command: "git status",
            cwd,
            fingerprint: approvalFingerprint,
            terminal_target: "codex-work:0.0"
          },
          approval_fingerprint: approvalFingerprint,
          terminal_status: {
            approval_state: {
              fingerprint: options.splitFingerprint
                ? "0".repeat(64)
                : approvalFingerprint
            }
          }
        }
      };
      if (options.legacy) {
        delete callbackConversation.session_id;
        delete callbackConversation.turn_id;
        delete callbackMessage.session_id;
        delete callbackMessage.turn_id;
      }
      await callbackHandler?.({
        params: {
          sessionKey: "agent:test:autoapprove",
          statePath,
          conversation: callbackConversation,
          message: callbackMessage
        },
        respond(ok, result, error) {
          callbackResponse = {
            ok,
            ...(isRecord(result) ? { result } : {}),
            ...(error ? { error } : {})
          };
        }
      });
      assert.notEqual(callbackResponse, undefined);
      return callbackResponse!;
    };

    const approved = await invokeApprovalCallback(
      "approval-allowed",
      allowedWorkspace
    );
    assert.equal(approved.ok, true);
    assert.equal(approved.result?.auto_approved, true);
    assert.equal(approved.result?.enqueued, false);
    assert.equal(injections.length, 0);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "approve");
    assert.equal(calls[0]?.includes("--workspace"), false);
    assert.deepEqual(
      calls[0]?.slice(-10),
      [
        "--expected-callback-conversation-id",
        "turn-autoapprove-workspace",
        "--expected-callback-session-id",
        "session-autoapprove-workspace",
        "--expected-callback-turn-id",
        "turn-autoapprove-workspace",
        "--expected-callback-message-id",
        "approval-allowed",
        "--expected-callback-openclaw-session",
        "agent:test:autoapprove"
      ]
    );
    const policyIndex = calls[0]?.indexOf("--auto-approval-policy-json") ?? -1;
    assert.notEqual(policyIndex, -1);
    assert.deepEqual(
      JSON.parse(calls[0]?.[policyIndex + 1] ?? "{}"),
      policy
    );

    const splitFingerprint = await invokeApprovalCallback(
      "approval-split-fingerprint",
      allowedWorkspace,
      { splitFingerprint: true }
    );
    assert.equal(splitFingerprint.ok, true);
    assert.equal(splitFingerprint.result?.auto_approved, undefined);
    assert.equal(splitFingerprint.result?.enqueued, true);

    const legacy = await invokeApprovalCallback(
      "approval-legacy",
      allowedWorkspace,
      { legacy: true }
    );
    assert.equal(legacy.ok, true);
    assert.equal(legacy.result?.auto_approved, undefined);
    assert.equal(legacy.result?.enqueued, true);

    const outside = await invokeApprovalCallback(
      "approval-outside",
      outsideWorkspace
    );
    assert.equal(outside.ok, true);
    assert.equal(outside.result?.auto_approved, undefined);
    assert.equal(outside.result?.enqueued, true);
    assert.equal(injections.length, 3);
    assert.equal(
      fs.readFileSync(callsPath, "utf8").trim().split("\n").length,
      1,
      "an out-of-rule workspace must not execute the approval CLI"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/akk doctor leaves the Gateway event loop free for its health check", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-doctor-"));
  const fakeCli = path.join(tempDir, "doctor.cjs");
  const codexVersion = "0.153.4";
  const codexNativeProfile = "codex-tui-0.153.4";
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({
      ok: true,
      checks: [{
        command: "codex",
        available: true,
        version: codexVersion,
        native_profile_supported: true,
        native_profile: codexNativeProfile
      }, {
        command: "claude",
        available: true,
        version: "2.1.260",
        native_profile_supported: false,
        native_actions_available: true,
        compatibility_warning:
          "Claude Code 2.1.260 has not been regression-tested by AKK"
      }],
      capabilities: {
        tmux: { checked: true, status: "ready" }
      },
      openclaw: {
        package_ready: true,
        gateway_ready: true,
        checks: []
      }
    }));
  });

  try {
    fs.writeFileSync(
      fakeCli,
      `const http = require("node:http");
const request = http.get(process.env.AKK_TEST_DOCTOR_URL, (response) => {
  response.pipe(process.stdout);
  response.on("end", () => process.exit(0));
});
request.setTimeout(1000, () => {
  request.destroy();
  process.exit(3);
});
request.on("error", () => process.exit(4));
`,
      "utf8"
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const previousUrl = process.env.AKK_TEST_DOCTOR_URL;
    process.env.AKK_TEST_DOCTOR_URL =
      `http://127.0.0.1:${(address as { port: number }).port}/health`;

    try {
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
        registerService() {},
        registerCommand(value: typeof command) {
          command = value;
        },
        registerTool() {}
      });

      assert.equal(typeof command?.handler, "function");
      const result = await command?.handler?.({
        args: "doctor",
        sessionKey: "agent:main:main"
      });
      assert.match(result?.text ?? "", /AKK doctor: ready/u);
      assert.equal(
        (result?.text ?? "").split("\n").includes(
          `Codex: ${codexVersion} (native profile ${codexNativeProfile})`
        ),
        true,
        result?.text
      );
      assert.match(
        result?.text ?? "",
        /Claude Code: 2\.1\.260 \(native lifecycle\/status available with compatibility warning\)/u
      );
      assert.notEqual(result?.isError, true);
    } finally {
      if (previousUrl === undefined) {
        delete process.env.AKK_TEST_DOCTOR_URL;
      } else {
        process.env.AKK_TEST_DOCTOR_URL = previousUrl;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
