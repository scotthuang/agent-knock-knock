import {
  test,
  assert,
  approveParameters,
  closeParameters,
  identifyAndSendParameters,
  identifyForegroundParameters,
  modelOptionsParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  repairModelControlParameters,
  respondInteractionParameters,
  resumeThreadParameters,
  sendParameters,
  setModelParameters,
  unwatchParameters,
  watchParameters,
  registerOpenClawCallbackGateway,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS,
  consumeOpenClawPrivateAuthorityOffer,
  invalidateOpenClawInteractionAuthorityOffersForSubject,
  openClawApprovalAuthorityOfferKey,
  openClawInteractionAuthorityOfferKey,
  openClawManagedTurnInteractionAuthorityOfferKey,
  openClawTerminalWatchInteractionAuthorityOfferKey,
  peekOpenClawPrivateAuthorityOffer,
  rememberOpenClawPrivateAuthorityOffer,
  createConversation,
  createMessage,
  assertNoModelOpaqueAuthority,
  isRecord,
  type GatewayMethodHandler
} from "../support/openclaw-plugin-contract-support.js";

test("OpenClaw model-facing mutation schemas contain only semantic targets", () => {
  const mutationSchemas = {
    send: sendParameters,
    native_inspect: nativeInspectParameters,
    model_options: modelOptionsParameters,
    repair_model_control: repairModelControlParameters,
    set_model: setModelParameters,
    identify_foreground: identifyForegroundParameters,
    identify_and_send: identifyAndSendParameters,
    new_thread: newThreadParameters,
    reconcile_binding: reconcileBindingParameters,
    respond_interaction: respondInteractionParameters,
    resume_thread: resumeThreadParameters,
    approve: approveParameters,
    close: closeParameters,
    watch: watchParameters,
    unwatch: unwatchParameters
  };
  assertNoModelOpaqueAuthority(mutationSchemas, "$.mutationSchemas");
  assert.deepEqual(sendParameters.not, {
    required: ["session_id", "terminal_id"]
  });
  assert.deepEqual(nativeInspectParameters.required, [
    "terminal_id",
    "inspection"
  ]);
  assert.deepEqual(modelOptionsParameters.required, ["terminal_id"]);
  assert.deepEqual(repairModelControlParameters.required, ["terminal_id"]);
  assert.deepEqual(Object.keys(repairModelControlParameters.properties), [
    "terminal_id"
  ]);
  assert.deepEqual(setModelParameters.required, [
    "terminal_id",
    "model",
    "reasoning_effort"
  ]);
  assert.deepEqual(Object.keys(setModelParameters.properties), [
    "terminal_id",
    "model",
    "reasoning_effort"
  ]);
  assert.deepEqual(identifyForegroundParameters.required, ["terminal_id"]);
  assert.deepEqual(identifyAndSendParameters.required, [
    "terminal_id",
    "request"
  ]);
  assert.equal(
    Object.hasOwn(identifyForegroundParameters.properties, "request"),
    false
  );
  assert.match(
    String(nativeInspectParameters.properties.inspection.description),
    /regression-tested[\s\S]*another complete x\.y\.z version remains callable[\s\S]*compatibility warning/u
  );
  assert.deepEqual(newThreadParameters.required, ["terminal_id"]);
  assert.deepEqual(reconcileBindingParameters.required, [
    "terminal_id",
    "conflicting_session_id"
  ]);
  assert.deepEqual(resumeThreadParameters.required, [
    "terminal_id",
    "native_thread_id"
  ]);
  assert.deepEqual(respondInteractionParameters.required, [
    "interaction_id",
    "answers"
  ]);
  assert.deepEqual(respondInteractionParameters.oneOf, [
    {
      required: ["turn_id"],
      not: { required: ["watch_id"] }
    },
    {
      required: ["watch_id"],
      not: { required: ["turn_id"] }
    }
  ]);
  assert.deepEqual(
    Object.keys(respondInteractionParameters.properties),
    ["turn_id", "watch_id", "interaction_id", "answers"]
  );
  assert.equal(respondInteractionParameters.additionalProperties, false);
  assert.deepEqual(
    respondInteractionParameters.properties.answers.items.required,
    ["question_id", "response_kind"]
  );
  assert.deepEqual(
    respondInteractionParameters.properties.answers.items.properties.response_kind.enum,
    ["single_select", "free_text", "confirm"]
  );
  assert.ok(
    respondInteractionParameters.properties.answers.items.properties
      .selected_option_ids
  );
  assert.ok(
    respondInteractionParameters.properties.answers.items.properties.text
  );
  assert.ok(
    respondInteractionParameters.properties.answers.items.properties.confirm
  );
  assert.equal(
    "oneOf" in respondInteractionParameters.properties.answers.items,
    false
  );
  assert.deepEqual(approveParameters.anyOf, [
    { required: ["turn_id"] },
    { required: ["terminal_id"] }
  ]);
  assert.deepEqual(approveParameters.not, {
    required: ["turn_id", "terminal_id"]
  });
  assert.deepEqual(watchParameters.required, ["terminal_id"]);
  assert.deepEqual(unwatchParameters.required, ["watch_id"]);
  assert.ok(closeParameters.properties.expected_message_id);
  assert.ok(closeParameters.properties.expected_transition_id);
});

test("private authority offers are isolated, bounded, merged, expiring, and single-use", () => {
  const api = {};
  const otherApi = {};
  const key = openClawApprovalAuthorityOfferKey(
    "agent:main:offers",
    "openclaw-conversation-a",
    {
    type: "turn_id",
    id: "turn-offer"
    }
  );
  const nowMs = 1_000;

  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:one", keep: true }
  }, nowMs);
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two" },
    fingerprint: "a".repeat(64)
  }, nowMs + 1);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 2),
    undefined,
    "changed authority must invalidate rather than replace a displayed offer"
  );
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two" },
    fingerprint: "a".repeat(64)
  }, nowMs + 2);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 3),
    undefined,
    "passive rediscovery must not reactivate changed authority"
  );
  assert.equal(
    consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 3),
    undefined,
    "the first rejected mutation attempt clears the invalidation tombstone"
  );
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two", keep: true },
    fingerprint: "a".repeat(64)
  }, nowMs + 4);

  const merged = peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 5);
  assert.deepEqual(merged, {
    args: { terminal_id: "terminal:two", keep: true },
    fingerprint: "a".repeat(64)
  });
  assert.equal(Object.isFrozen(merged), true);
  assert.equal(Object.isFrozen(merged?.args), true);
  assert.equal(peekOpenClawPrivateAuthorityOffer(otherApi, key, nowMs + 5), undefined);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-b",
        { type: "turn_id", id: "turn-offer" }
      ),
      nowMs + 5
    ),
    undefined,
    "a /new or /reset conversation incarnation cannot consume an old offer"
  );
  assert.deepEqual(
    consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 5),
    merged
  );
  assert.equal(consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 5), undefined);

  rememberOpenClawPrivateAuthorityOffer(api, key, { fingerprint: "b" }, nowMs);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      key,
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS
    ),
    undefined
  );

  for (let index = 0; index <= OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT; index += 1) {
    rememberOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: `turn-${index}`
        }
      ),
      { sequence: index },
      nowMs + index
    );
  }
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: "turn-0"
        }
      ),
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT + 1
    ),
    undefined
  );
  assert.deepEqual(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: `turn-${OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT}`
        }
      ),
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT + 1
    ),
    { sequence: OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT }
  );
});

test("interaction authority offers isolate managed Turn and Terminal Watch subjects", () => {
  const api = {};
  const nowMs = 5_000;
  const sessionKey = "agent:main:interaction-subjects";
  const sessionId = "openclaw-conversation-subjects";
  const sharedSubjectId = "subject-shared";
  const interactionId = "ti_shared";
  const legacyManagedKey = openClawInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    sharedSubjectId,
    interactionId
  );
  const managedKey = openClawManagedTurnInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    sharedSubjectId,
    interactionId
  );
  const watchKey = openClawTerminalWatchInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    sharedSubjectId,
    interactionId
  );

  assert.deepEqual(legacyManagedKey, managedKey);
  assert.deepEqual(
    managedKey,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      "managed_turn",
      sharedSubjectId,
      interactionId
    )
  );
  assert.deepEqual(
    watchKey,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      "terminal_watch",
      sharedSubjectId,
      interactionId
    )
  );
  assert.notDeepEqual(managedKey, watchKey);
  rememberOpenClawPrivateAuthorityOffer(
    api,
    managedKey,
    { fingerprint: "a".repeat(64), subject_kind: "managed_turn" },
    nowMs
  );
  rememberOpenClawPrivateAuthorityOffer(
    api,
    watchKey,
    { fingerprint: "b".repeat(64), subject_kind: "terminal_watch" },
    nowMs
  );
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, managedKey, nowMs)?.subject_kind,
    "managed_turn"
  );
  assert.equal(
    consumeOpenClawPrivateAuthorityOffer(api, watchKey, nowMs)?.subject_kind,
    "terminal_watch"
  );
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, managedKey, nowMs)?.subject_kind,
    "managed_turn",
    "consuming a Watch offer must not consume the same-id managed offer"
  );
  assert.throws(
    () => openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      "unsupported" as "managed_turn",
      sharedSubjectId,
      interactionId
    ),
    /interaction subject kind is invalid/u
  );
});

test("interaction authority refresh invalidates every stale id for only one controller subject", () => {
  const api = {};
  const nowMs = 8_000;
  const sessionKey = "agent:main:interaction-refresh";
  const sessionId = "openclaw-conversation-refresh";
  const subjectId = "turn-refresh";
  const staleKeys = ["ti_stale_one", "ti_stale_two"].map((interactionId) =>
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      "managed_turn",
      subjectId,
      interactionId
    )
  );
  const otherSubjectKey = openClawInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    "managed_turn",
    "turn-other",
    "ti_other"
  );
  const otherControllerKey = openClawInteractionAuthorityOfferKey(
    sessionKey,
    "openclaw-conversation-other",
    "managed_turn",
    subjectId,
    "ti_other_controller"
  );
  const sameIdWatchKey = openClawInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    "terminal_watch",
    subjectId,
    "ti_stale_one"
  );
  for (const key of [
    ...staleKeys,
    otherSubjectKey,
    otherControllerKey,
    sameIdWatchKey
  ]) {
    rememberOpenClawPrivateAuthorityOffer(
      api,
      key,
      { fingerprint: "d".repeat(64) },
      nowMs
    );
  }

  assert.equal(
    invalidateOpenClawInteractionAuthorityOffersForSubject(
      api,
      sessionKey,
      sessionId,
      "managed_turn",
      subjectId,
      nowMs + 1
    ),
    2
  );
  for (const key of staleKeys) {
    assert.equal(peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 1), undefined);
  }
  assert.ok(peekOpenClawPrivateAuthorityOffer(api, otherSubjectKey, nowMs + 1));
  assert.ok(peekOpenClawPrivateAuthorityOffer(api, otherControllerKey, nowMs + 1));
  assert.ok(peekOpenClawPrivateAuthorityOffer(api, sameIdWatchKey, nowMs + 1));
  assert.equal(
    invalidateOpenClawInteractionAuthorityOffersForSubject(
      api,
      sessionKey,
      sessionId,
      "managed_turn",
      subjectId,
      nowMs + 2
    ),
    0
  );
});

test("approval callbacks preserve review text but require incarnation-bound status", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedInjection: Record<string, unknown> | undefined;
  let response: { ok: boolean; result?: Record<string, any> } | undefined;
  const fingerprint = "c".repeat(64);
  const reviewedCommit = "e".repeat(64);
  const conversation = {
    ...createConversation({
      userRequest: "approval callback",
      sessionId: "session-approval",
      turnId: "turn-approval",
      openclawSession: "agent:main:approval",
      executorKind: "codex",
      executorSession: "codex-approval"
    }),
    native_session_takeover: {
      terminal_bridge_approval: { fingerprint }
    }
  };
  const message = createMessage({
    conversation,
    id: "message-approval",
    from: "codex",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: [
      "Codex is waiting for approval.",
      "Ask the user to review the request.",
      `Command: inspect token_fingerprint.ts at commit ${reviewedCommit}`,
      "expected_session_revision: 7",
      "--expected-binding-token business-approval-example",
      "If the user approves, call `agent_knock_knock_approve` with:",
      `- expected_approval_fingerprint: ${fingerprint}`,
      `Equivalent user command: \`AKK approve turn-approval --expected-approval-fingerprint ${fingerprint}\``
    ].join("\n"),
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_fingerprint: fingerprint,
      approval_candidate: { fingerprint },
      terminal_status: {
        approval_state: { fingerprint }
      }
    }
  });
  const api: Record<string, any> = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(injection: Record<string, unknown>) {
          capturedInjection = injection;
          return {
            enqueued: true,
            id: "approval-injection",
            sessionKey: injection.sessionKey
          };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") callbackHandler = handler;
    }
  };
  registerOpenClawCallbackGateway(api);

  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:approval",
      conversation,
      message
    },
    respond(ok, result) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {})
      };
    }
  });

  assert.equal(response?.ok, true);
  const key = openClawApprovalAuthorityOfferKey(
    "agent:main:approval",
    "openclaw-conversation-a",
    { type: "turn_id", id: "turn-approval" }
  );
  assert.equal(peekOpenClawPrivateAuthorityOffer(api, key), undefined);
  const visible = [
    String(capturedInjection?.text ?? ""),
    String((response?.result?.chat_send as Record<string, unknown>)?.message ?? "")
  ].join("\n");
  assert.match(visible, /agent_knock_knock_status/u);
  assert.match(visible, /Do not call approve/u);
  assert.match(visible, /\{"turn_id":"turn-approval"\}/u);
  assert.match(
    visible,
    new RegExp(`token_fingerprint\\.ts at commit ${reviewedCommit}`, "u")
  );
  assert.match(visible, /expected_session_revision: 7/u);
  assert.match(
    visible,
    /--expected-binding-token business-approval-example/u
  );
  assert.doesNotMatch(visible, /agent_knock_knock_respond/u);
  assert.doesNotMatch(
    visible,
    /expected_approval_fingerprint|--expected-approval-fingerprint/iu
  );
  assert.doesNotMatch(visible, new RegExp(fingerprint, "u"));
});

test("approval callbacks fail closed to status when private authority is incomplete", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedText = "";
  let responseOk = false;
  const conversation = createConversation({
    userRequest: "incomplete approval callback",
    sessionId: "session-incomplete",
    turnId: "turn-incomplete",
    openclawSession: "agent:main:incomplete",
    executorKind: "codex",
    executorSession: "codex-incomplete"
  });
  const message = createMessage({
    conversation,
    id: "message-incomplete",
    from: "codex",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: "Codex is waiting for approval.",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_fingerprint: "d".repeat(64)
    }
  });
  const api: Record<string, any> = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(injection: Record<string, unknown>) {
          capturedText = String(injection.text ?? "");
          return { enqueued: true };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") callbackHandler = handler;
    }
  };
  registerOpenClawCallbackGateway(api);

  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:incomplete",
      conversation,
      message
    },
    respond(ok) {
      responseOk = ok;
    }
  });

  assert.equal(responseOk, true);
  assert.match(capturedText, /agent_knock_knock_status/u);
  assert.match(capturedText, /\{"turn_id":"turn-incomplete"\}/u);
  assert.match(capturedText, /Do not call approve yet/u);
  assert.doesNotMatch(capturedText, /fingerprint|token|--expected-/iu);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:incomplete",
        "openclaw-conversation-a",
        { type: "turn_id", id: "turn-incomplete" }
      )
    ),
    undefined
  );
});
