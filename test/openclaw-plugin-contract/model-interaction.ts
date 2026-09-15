import {
  test,
  assert,
  fs,
  os,
  path,
  bindOpenClawRelayPath,
  registerOpenClawCommands,
  assertModelToolResultHasNoOpaqueAuthority,
  requiredInteractionTool,
  interactionOptionValue,
  requiredInteractionOptionValue,
  interactionRelayFixture,
  interactionRefreshRelayFixture,
  watchInteractionRelayFixture,
  type InteractionToolFactory,
  type ToolDefinition
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw set_model consumes exactly one catalog offer from model_options", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-model-offer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.cjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const terminalId = "terminal:v2:herdr:codex:default:w1:p4:48690";
  const catalogFingerprint = "c".repeat(64);
  fs.writeFileSync(relayPath, `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(argv) + "\\n");
const terminalId = ${JSON.stringify(terminalId)};
const catalogFingerprint = ${JSON.stringify(catalogFingerprint)};
if (argv[0] === "list") {
  process.stdout.write(JSON.stringify({ terminals: [{
    id: terminalId,
    available_actions: { model_options: {
      tool: "agent_knock_knock_model_options",
      arguments: {
        terminal_id: terminalId,
        expected_binding_token: "private-list-authority"
      }
    }}
  }] }));
} else if (argv[0] === "model-options") {
  process.stdout.write(JSON.stringify({
    terminal_id: terminalId,
    agent: "codex",
    scope: "current_and_new_sessions",
    current: { model: "gpt-5.6-terra", reasoning_effort: "high" },
    models: [{
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      reasoning_efforts: ["low", "medium", "high", "xhigh"]
    }],
    catalog_fingerprint: catalogFingerprint,
    available_actions: { set_model: {
      tool: "agent_knock_knock_set_model",
      arguments: {
        terminal_id: terminalId,
        expected_binding_token: "private-set-authority",
        expected_catalog_fingerprint: catalogFingerprint
      }
    }}
  }));
} else if (argv[0] === "set-model") {
  process.stdout.write(JSON.stringify({
    terminal_id: terminalId,
    outcome: "changed",
    scope: "current_and_new_sessions",
    effective: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    new_session_defaults: { model: "gpt-5.6-sol", reasoning_effort: "high" },
    do_not_retry: false
  }));
} else {
  process.stderr.write("unexpected command");
  process.exitCode = 2;
}
`, "utf8");

  const factories = new Map<string, InteractionToolFactory>();
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    registerCommand() {},
    registerTool(
      tool: ToolDefinition | InteractionToolFactory,
      registration?: { readonly name?: unknown }
    ) {
      assert.equal(typeof registration?.name, "string");
      factories.set(
        String(registration?.name),
        typeof tool === "function" ? tool : () => tool
      );
    }
  };
  bindOpenClawRelayPath(api, relayPath);
  registerOpenClawCommands(api, new Map());
  const controller = {
    sessionKey: "agent:test:model-control",
    sessionId: "controller-model-control"
  };
  const options = requiredInteractionTool(
    factories,
    "agent_knock_knock_model_options",
    controller
  );
  const setModel = requiredInteractionTool(
    factories,
    "agent_knock_knock_set_model",
    controller
  );

  const displayed = await options.execute!("models", { terminal_id: terminalId });
  assertModelToolResultHasNoOpaqueAuthority(displayed);
  const changed = await setModel.execute!("set-once", {
    terminal_id: terminalId,
    model: "gpt-5.6-sol",
    reasoning_effort: "high"
  });
  assert.equal(changed.details?.outcome, "changed");
  await assert.rejects(
    () => setModel.execute!("replay", {
      terminal_id: terminalId,
      model: "gpt-5.6-sol",
      reasoning_effort: "high"
    }),
    /requires current choices shown/u
  );

  const calls = fs.readFileSync(callsPath, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.map((argv) => argv[0]), [
    "list", "model-options", "set-model"
  ]);
});

test("OpenClaw interaction response consumes one session-bound private offer after displayed expiry", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-interaction-tool-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.cjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const turnId = "turn_interaction_1";
  const interactionId = "interaction_1";
  const questionId = "question_1";
  const optionId = "option_safe";
  const fingerprint = "a".repeat(64);
  const expiresAt = "2000-09-08T00:00:00.000Z";
  fs.writeFileSync(relayPath, interactionRelayFixture({
    callsPath,
    turnId,
    interactionId,
    questionId,
    optionId,
    fingerprint,
    expiresAt
  }), "utf8");

  const factories = new Map<string, InteractionToolFactory>();
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    registerCommand() {},
    registerTool(
      tool: ToolDefinition | InteractionToolFactory,
      registration?: { readonly name?: unknown }
    ) {
      assert.equal(typeof registration?.name, "string");
      const factory: InteractionToolFactory = typeof tool === "function"
        ? tool
        : () => tool;
      factories.set(String(registration?.name), factory);
    }
  };
  bindOpenClawRelayPath(api, relayPath);
  registerOpenClawCommands(api, new Map());

  const controllerA = {
    sessionKey: "agent:test:main",
    sessionId: "controller-incarnation-a"
  };
  const controllerB = {
    sessionKey: "agent:test:main",
    sessionId: "controller-incarnation-b"
  };
  const statusA = requiredInteractionTool(
    factories,
    "agent_knock_knock_status",
    controllerA
  );
  const respondA = requiredInteractionTool(
    factories,
    "agent_knock_knock_respond_interaction",
    controllerA
  );
  const respondB = requiredInteractionTool(
    factories,
    "agent_knock_knock_respond_interaction",
    controllerB
  );
  const response = {
    turn_id: turnId,
    interaction_id: interactionId,
    answers: [{
      question_id: questionId,
      response_kind: "single_select",
      selected_option_ids: [optionId]
    }]
  };

  const displayed = await statusA.execute!("status-1", { turn_id: turnId });
  const displayedText = JSON.stringify(displayed);
  assert.match(displayedText, /interaction_state/u);
  assert.doesNotMatch(displayedText, /interaction_prompt_fingerprint/u);
  assert.doesNotMatch(displayedText, /interaction_authority|owner_session|process_incarnation/u);
  assert.doesNotMatch(displayedText, new RegExp(fingerprint, "u"));

  await assert.rejects(
    () => respondB.execute!("wrong-controller", response),
    /requires a current pending interaction shown by agent_knock_knock_status in this controller conversation/u
  );

  await assert.rejects(
    () => respondA.execute!("forbidden-authority", {
      ...response,
      expected_interaction_fingerprint: fingerprint
    }),
    /private authority changed or could not be verified/u
  );
  await assert.rejects(
    () => respondA.execute!("consumed-after-invalid", response),
    /requires a current pending interaction shown/u
  );

  await statusA.execute!("status-2", { turn_id: turnId });
  const accepted = await respondA.execute!("response-1", response);
  assert.equal(accepted.details?.responded, true);
  assert.doesNotMatch(JSON.stringify(accepted), /fingerprint/u);
  assert.doesNotMatch(JSON.stringify(accepted), new RegExp(fingerprint, "u"));
  await assert.rejects(
    () => respondA.execute!("replay", response),
    /requires a current pending interaction shown/u
  );
  await statusA.execute!("status-v2", { turn_id: turnId, trace: true });
  const acceptedV2 = await respondA.execute!("response-v2", response);
  assert.equal(acceptedV2.details?.responded, true);

  const calls = fs.readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.map((argv) => argv[0]), [
    "status",
    "status",
    "respond-interaction",
    "status",
    "respond-interaction"
  ]);
  const mutation = calls[2] ?? [];
  assert.equal(interactionOptionValue(mutation, "--turn"), turnId);
  assert.equal(interactionOptionValue(mutation, "--interaction"), interactionId);
  assert.deepEqual(
    JSON.parse(requiredInteractionOptionValue(mutation, "--response-json")),
    response
  );
  assert.equal(
    interactionOptionValue(mutation, "--expected-interaction-fingerprint"),
    fingerprint
  );
  assert.equal(
    interactionOptionValue(mutation, "--expected-interaction-expires-at"),
    expiresAt
  );
  assert.equal(
    interactionOptionValue(mutation, "--openclaw-session"),
    controllerA.sessionKey
  );
  const v2Mutation = calls[4] ?? [];
  assert.equal(interactionOptionValue(v2Mutation, "--turn"), turnId);
  assert.deepEqual(
    JSON.parse(requiredInteractionOptionValue(v2Mutation, "--response-json")),
    {
      interaction_id: interactionId,
      subject: {
        kind: "managed_turn",
        turn_id: turnId,
        message_id: "message_interaction_1"
      },
      turn_id: turnId,
      answers: response.answers
    }
  );
});

test("OpenClaw Status refresh removes stale interaction ids after absent, manual, and changed snapshots", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-interaction-refresh-tool-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.cjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const turnId = "turn_interaction_refresh";
  const oldInteractionId = "interaction_refresh_old";
  const newInteractionId = "interaction_refresh_new";
  const oldQuestionId = "question_refresh_old";
  const newQuestionId = "question_refresh_new";
  const oldOptionId = "option_refresh_old";
  const newOptionId = "option_refresh_new";
  fs.writeFileSync(relayPath, interactionRefreshRelayFixture({
    callsPath,
    turnId,
    oldInteractionId,
    newInteractionId,
    oldQuestionId,
    newQuestionId,
    oldOptionId,
    newOptionId
  }), "utf8");

  const factories = new Map<string, InteractionToolFactory>();
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    registerCommand() {},
    registerTool(
      tool: ToolDefinition | InteractionToolFactory,
      registration?: { readonly name?: unknown }
    ) {
      assert.equal(typeof registration?.name, "string");
      factories.set(
        String(registration?.name),
        typeof tool === "function" ? tool : () => tool
      );
    }
  };
  bindOpenClawRelayPath(api, relayPath);
  registerOpenClawCommands(api, new Map());
  const controller = {
    sessionKey: "agent:test:interaction-refresh",
    sessionId: "controller-interaction-refresh"
  };
  const status = requiredInteractionTool(
    factories,
    "agent_knock_knock_status",
    controller
  );
  const respond = requiredInteractionTool(
    factories,
    "agent_knock_knock_respond_interaction",
    controller
  );
  const oldResponse = {
    turn_id: turnId,
    interaction_id: oldInteractionId,
    answers: [{
      question_id: oldQuestionId,
      response_kind: "single_select",
      selected_option_ids: [oldOptionId]
    }]
  };
  const newResponse = {
    turn_id: turnId,
    interaction_id: newInteractionId,
    answers: [{
      question_id: newQuestionId,
      response_kind: "single_select",
      selected_option_ids: [newOptionId]
    }]
  };

  await status.execute!("old-before-absent", { turn_id: turnId });
  await status.execute!("absent", { turn_id: turnId });
  await assert.rejects(
    () => respond.execute!("stale-after-absent", oldResponse),
    /requires a current pending interaction shown/u
  );

  await status.execute!("old-before-manual", { turn_id: turnId });
  await status.execute!("manual", { turn_id: turnId });
  await assert.rejects(
    () => respond.execute!("stale-after-manual", oldResponse),
    /requires a current pending interaction shown/u
  );

  await status.execute!("old-before-change", { turn_id: turnId });
  await status.execute!("changed", { turn_id: turnId });
  await assert.rejects(
    () => respond.execute!("stale-after-change", oldResponse),
    /requires a current pending interaction shown/u
  );
  const accepted = await respond.execute!("current-after-change", newResponse);
  assert.equal(accepted.details?.responded, true);

  const calls = fs.readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.map((argv) => argv[0]), [
    "status",
    "status",
    "status",
    "status",
    "status",
    "status",
    "respond-interaction"
  ]);
  assert.equal(
    interactionOptionValue(calls.at(-1) ?? [], "--interaction"),
    newInteractionId
  );
});

test("OpenClaw Watch interaction response is subject-bound and dispatches --watch", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-watch-interaction-tool-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relayPath = path.join(directory, "relay.cjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const watchId = "terminal-watch-interaction-1";
  const interactionId = "interaction_watch_1";
  const questionId = "question_watch_1";
  const optionId = "option_watch_safe";
  const fingerprint = "b".repeat(64);
  const anchorFingerprint = "c".repeat(64);
  const expiresAt = "2030-09-08T00:00:00.000Z";
  fs.writeFileSync(relayPath, watchInteractionRelayFixture({
    callsPath,
    watchId,
    interactionId,
    questionId,
    optionId,
    fingerprint,
    anchorFingerprint,
    expiresAt
  }), "utf8");

  const factories = new Map<string, InteractionToolFactory>();
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    registerCommand() {},
    registerTool(
      tool: ToolDefinition | InteractionToolFactory,
      registration?: { readonly name?: unknown }
    ) {
      assert.equal(typeof registration?.name, "string");
      factories.set(
        String(registration?.name),
        typeof tool === "function" ? tool : () => tool
      );
    }
  };
  bindOpenClawRelayPath(api, relayPath);
  registerOpenClawCommands(api, new Map());

  const controller = {
    sessionKey: "agent:test:watch",
    sessionId: "controller-watch-incarnation"
  };
  const status = requiredInteractionTool(
    factories,
    "agent_knock_knock_status",
    controller
  );
  const respond = requiredInteractionTool(
    factories,
    "agent_knock_knock_respond_interaction",
    controller
  );
  const response = {
    watch_id: watchId,
    interaction_id: interactionId,
    answers: [{
      question_id: questionId,
      response_kind: "single_select",
      selected_option_ids: [optionId]
    }]
  };

  const statusWithoutControllerSession = requiredInteractionTool(
    factories,
    "agent_knock_knock_status",
    { sessionId: "controller-watch-without-session-key" }
  );
  await assert.rejects(
    () => statusWithoutControllerSession.execute!("watch-status-no-owner", {
      watch_id: watchId
    }),
    /Controller session identity for this confirmed action is required/u
  );
  assert.equal(
    fs.existsSync(callsPath),
    false,
    "Watch Status without controller ownership must fail before spawning the CLI"
  );

  const displayed = await status.execute!("watch-status", { watch_id: watchId });
  const displayedText = JSON.stringify(displayed);
  assert.match(displayedText, /interaction_state/u);
  assert.match(displayedText, new RegExp(watchId, "u"));
  assert.doesNotMatch(displayedText, /interaction_prompt_fingerprint/u);
  assert.doesNotMatch(displayedText, new RegExp(fingerprint, "u"));
  assert.doesNotMatch(displayedText, new RegExp(anchorFingerprint, "u"));

  await assert.rejects(
    () => respond.execute!("wrong-subject", {
      turn_id: watchId,
      interaction_id: interactionId,
      answers: response.answers
    }),
    /requires a current pending interaction shown/u
  );
  const accepted = await respond.execute!("watch-response", response);
  assert.equal(accepted.details?.responded, true);
  await assert.rejects(
    () => respond.execute!("watch-replay", response),
    /requires a current pending interaction shown/u
  );

  const calls = fs.readFileSync(callsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  assert.deepEqual(calls.map((argv) => argv[0]), [
    "watch-status",
    "respond-interaction"
  ]);
  assert.equal(
    interactionOptionValue(calls[0] ?? [], "--openclaw-session"),
    controller.sessionKey
  );
  const mutation = calls[1] ?? [];
  assert.equal(interactionOptionValue(mutation, "--watch"), watchId);
  assert.equal(interactionOptionValue(mutation, "--turn"), undefined);
  assert.deepEqual(
    JSON.parse(requiredInteractionOptionValue(mutation, "--response-json")),
    {
      interaction_id: interactionId,
      subject: {
        kind: "terminal_watch",
        watch_id: watchId,
        anchor_fingerprint: anchorFingerprint
      },
      answers: response.answers
    }
  );
});
