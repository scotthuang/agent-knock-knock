import {
  isTerminalApprovalDecision,
  type TerminalApprovalDecision
} from "./terminal-agent-adapter.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  buildAkkCommandCliArgs,
  resolvePluginStoreDir
} from "./openclaw-plugin-helpers.js";
import {
  consumeOpenClawPrivateAuthorityOffer,
  invalidateOpenClawInteractionAuthorityOffersForSubject,
  openClawApprovalAuthorityOfferKey,
  openClawInteractionAuthorityOfferKey,
  rememberOpenClawPrivateAuthorityOffer,
  type OpenClawInteractionAuthoritySubjectKind,
  type OpenClawPrivateAuthorityOfferKey,
  type OpenClawPrivateAuthorityOfferPayload,
  type OpenClawPrivateAuthorityTarget
} from "./openclaw-private-authority-offers.js";
import {
  TERMINAL_INTERACTION_SUBJECT_VERSION,
  terminalInteractionSubjectId,
  validateAnyTerminalInteractionProjection,
  validateAnyTerminalInteractionResponse,
  type TerminalInteractionAnyProjection
} from "./terminal-interaction-protocol.js";
import {
  runHostAwareCli
} from "./semantic-tool-relay.js";
import {
  publicTurnIdentity
} from "./semantic-tool-presentation.js";
import {
  numberString,
  pushOptional,
  requiredOpenClawSessionId,
  requiredOpenClawSessionKey,
  requiredString,
  requiredTerminalInteractionIdentifier
} from "./semantic-tool-arguments.js";

const HANDOFF_AUTHORITY_KIND = "handoff";
export const RECONCILE_BINDING_AUTHORITY_KIND = "reconcile_binding";
const MODEL_OPTIONS_AUTHORITY_KIND = "model_options";

interface DisplayedModelOptionsOfferPayload
  extends OpenClawPrivateAuthorityOfferPayload {
  readonly scope?: unknown;
  readonly models?: unknown;
}

async function privateList(
  api,
  options: { reconcile?: boolean } = {}
): Promise<Record<string, unknown>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = ["list"];
  if (options.reconcile !== false) args.push("--reconcile");
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(config.idleTimeoutMinutes)
  );
  return runHostAwareCli(api, args);
}

export async function privateThreadDiscovery(
  api,
  terminalId: string
): Promise<Record<string, unknown>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = [
    "list-resumable-threads",
    "--terminal",
    terminalId
  ];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", stringValue(config.codexHome));
  return runHostAwareCli(api, args);
}

export function rememberDisplayedModelOptionsOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  requestedTerminalIdValue: unknown,
  result: unknown
): void {
  const sessionKey = requiredOpenClawSessionKey(sessionKeyValue);
  const sessionId = requiredOpenClawSessionId(sessionIdValue);
  const requestedTerminalId = requiredString(
    requestedTerminalIdValue,
    "terminal_id"
  );
  if (!isRecord(result)) {
    throw new Error("model-options returned an invalid result");
  }
  const terminalId = requiredString(result.terminal_id, "model-options terminal_id");
  if (terminalId !== requestedTerminalId) {
    throw new Error("model-options returned a different terminal");
  }
  const scope = requiredModelSwitchScope(result.agent, result.scope);
  const models = modelOptionsCatalog(result.models);
  const args = setModelActionArguments(result);
  if (stringValue(args.terminal ?? args.terminal_id) !== terminalId) {
    throw new Error("set-model action belongs to a different terminal");
  }
  const catalogFingerprint = requiredString(
    args.expected_catalog_fingerprint,
    "current internal model catalog authority"
  );
  if (catalogFingerprint !== stringValue(result.catalog_fingerprint)) {
    throw new Error("set-model action does not match the displayed catalog");
  }
  const key = modelOptionsOfferKey(sessionKey, sessionId, terminalId);
  consumeOpenClawPrivateAuthorityOffer(api, key);
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    fingerprint: catalogFingerprint,
    args,
    scope,
    models
  });
}

function modelOptionsCatalog(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("model-options returned no semantic model choices");
  }
  const models = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("model-options returned an invalid model");
    const id = requiredModelSemanticValue(entry.id, "model id", 160);
    if (!Array.isArray(entry.reasoning_efforts)) {
      throw new Error(`model ${id} has no reasoning-effort catalog`);
    }
    const reasoningEfforts = entry.reasoning_efforts.map((effort) =>
      requiredReasoningEffort(effort, `reasoning effort for ${id}`)
    );
    if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
      throw new Error(`model ${id} has duplicate reasoning efforts`);
    }
    return { id, reasoning_efforts: reasoningEfforts };
  });
  const ids = models.map((model) => String(model.id));
  if (new Set(ids).size !== ids.length) {
    throw new Error("model-options returned duplicate model ids");
  }
  return models;
}

function setModelActionArguments(
  result: Record<string, unknown>
): Record<string, unknown> {
  const availableActions = isRecord(result.available_actions)
    ? result.available_actions
    : undefined;
  const action = isRecord(availableActions?.set_model)
    ? availableActions.set_model
    : undefined;
  if (
    action?.tool !== "agent_knock_knock_set_model" ||
    !isRecord(action.arguments)
  ) {
    throw new Error("model-options did not advertise a typed set-model action");
  }
  requiredString(
    action.arguments.expected_binding_token,
    "current internal set-model binding authority"
  );
  return action.arguments;
}

function requiredModelSwitchScope(agentValue: unknown, scopeValue: unknown): string {
  const agent = requiredString(agentValue, "model-options agent");
  const scope = requiredString(scopeValue, "model-options scope");
  const expected = agent === "codex"
    ? "current_and_new_sessions"
    : agent === "claude"
      ? "current_session"
      : undefined;
  if (!expected || scope !== expected) {
    throw new Error("model-options returned an unsupported agent or mutation scope");
  }
  return scope;
}

function modelOptionsOfferKey(
  sessionKey: string,
  sessionId: string,
  terminalId: string
): OpenClawPrivateAuthorityOfferKey {
  return privateAuthorityOfferKey(
    sessionKey,
    sessionId,
    MODEL_OPTIONS_AUTHORITY_KIND,
    { type: "terminal_id", id: terminalId }
  );
}

export function buildPrivateSetModelArgs(
  api,
  params: Record<string, unknown>,
  context: { sessionKey: string; sessionId: string }
): string[] {
  assertOnlyModelControlParameters(
    params,
    ["terminal_id", "model", "reasoning_effort"],
    "set_model"
  );
  const terminalId = requiredString(params.terminal_id, "terminal_id");
  const model = requiredModelSemanticValue(params.model, "model", 160);
  const reasoningEffort = requiredReasoningEffort(
    params.reasoning_effort,
    "reasoning_effort"
  );
  const offered = consumeOpenClawPrivateAuthorityOffer<
    DisplayedModelOptionsOfferPayload
  >(api, modelOptionsOfferKey(context.sessionKey, context.sessionId, terminalId));
  if (!offered || !isRecord(offered.args) || !Array.isArray(offered.models)) {
    throw new Error(
      "set_model requires current choices shown by agent_knock_knock_model_options in this controller conversation; refresh model options and choose one exact semantic tuple"
    );
  }
  assertOfferedModelTuple(offered.models, model, reasoningEffort);
  const offeredTerminalId = stringValue(
    offered.args.terminal ?? offered.args.terminal_id
  );
  if (offeredTerminalId !== terminalId) {
    throw new Error("the displayed set-model action belongs to another terminal");
  }
  const fingerprint = requiredString(
    offered.args.expected_catalog_fingerprint,
    "current internal model catalog authority"
  );
  if (fingerprint !== offered.fingerprint) {
    throw new Error("the displayed model catalog authority changed");
  }
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = buildAkkCommandCliArgs(
    {
      action: "set-model",
      terminalId,
      model,
      reasoningEffort
    },
    config,
    {
      expectedBindingToken: offered.args.expected_binding_token,
      expectedCatalogFingerprint: fingerprint
    }
  );
  if (!args) throw new Error("could not build set-model command");
  return args;
}

export function assertOnlyModelControlParameters(
  params: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} accepts only typed semantic fields; raw commands, keys, menu indexes, scope, labels, tokens, and fingerprints are forbidden`
    );
  }
}

function assertOfferedModelTuple(
  modelEntries: readonly unknown[],
  model: string,
  reasoningEffort: string
): void {
  const entry = modelEntries.find((candidate) =>
    isRecord(candidate) && candidate.id === model
  );
  if (!isRecord(entry) || !Array.isArray(entry.reasoning_efforts)) {
    throw new Error("model was not advertised by the current native catalog");
  }
  if (
    !entry.reasoning_efforts.includes(reasoningEffort)
  ) {
    throw new Error(
      "reasoning_effort was not advertised for this model by the current native catalog"
    );
  }
}

function requiredModelSemanticValue(
  value: unknown,
  label: string,
  maxLength: number
): string {
  const text = requiredString(value, label);
  if (
    text.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/u.test(text)
  ) {
    throw new Error(`${label} must be one exact advertised semantic id`);
  }
  return text;
}

function requiredReasoningEffort(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (text.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(text)) {
    throw new Error(`${label} must be one exact advertised semantic value`);
  }
  return text;
}

export async function privateTerminalActionArguments(
  api,
  terminalId: string,
  tool: string,
  options: { reconcile?: boolean } = {}
): Promise<Record<string, unknown>> {
  return privateActionArguments(api, {
    tool,
    terminalId,
    reconcile: options.reconcile,
    matches: (argumentsValue) =>
      stringValue(argumentsValue.terminal_id) === terminalId
  });
}

export async function privateActionArguments(
  api,
  input: {
    tool: string;
    terminalId?: string;
    reconcile?: boolean;
    matches: (argumentsValue: Record<string, unknown>) => boolean;
  }
): Promise<Record<string, unknown>> {
  const result = await privateList(api, { reconcile: input.reconcile });
  const terminals = input.terminalId
    ? terminalRows(result).filter((terminal) =>
        stringValue(terminal.id) === input.terminalId
      )
    : terminalRows(result);
  if (input.terminalId && terminals.length !== 1) {
    throw new Error(
      `terminal ${input.terminalId} is not uniquely present in the current AKK list`
    );
  }
  const candidates = (
    input.tool === "agent_knock_knock_close"
      ? authoritativeHandoffActionArguments(terminals)
      : terminals.flatMap((terminal) =>
          authoritativeTerminalActionArguments(terminal, input.tool)
        )
  ).filter(input.matches);
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [
    JSON.stringify(candidate),
    candidate
  ])).values()];
  if (uniqueCandidates.length !== 1) {
    throw new Error(
      `the current AKK list does not advertise one exact ${input.tool} action for the requested semantic target`
    );
  }
  return uniqueCandidates[0]!;
}

export function rememberDisplayedPrivateAuthorityOffers(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  rememberDisplayedHandoffActions(api, sessionKey, sessionId, result);
  rememberDisplayedReconcileActions(api, sessionKey, sessionId, result);
}

function rememberDisplayedHandoffActions(
  api: object,
  sessionKey: string,
  sessionId: string,
  result: Record<string, unknown>
): void {
  for (const args of uniqueArgumentObjects(
    authoritativeHandoffActionArguments(terminalRows(result))
  )) {
    const turnId = stringValue(args.turn_id ?? args.conversation_id);
    if (
      !turnId ||
      stringValue(args.reason) !== "superseded_by_human_context_switch" ||
      !stringValue(args.expected_handoff_token)
    ) {
      continue;
    }
    rememberOpenClawPrivateAuthorityOffer(
      api,
      privateAuthorityOfferKey(
        sessionKey,
        sessionId,
        HANDOFF_AUTHORITY_KIND,
        { type: "turn_id", id: turnId }
      ),
      { args }
    );
  }
}

function rememberDisplayedReconcileActions(
  api: object,
  sessionKey: string,
  sessionId: string,
  result: Record<string, unknown>
): void {
  for (const args of uniqueArgumentObjects(
    terminalRows(result).flatMap((terminal) =>
      authoritativeTerminalActionArguments(
        terminal,
        "agent_knock_knock_reconcile_binding"
      )
    )
  )) {
    const terminalId = stringValue(args.terminal_id);
    const conflictingSessionId = stringValue(args.conflicting_session_id);
    if (!terminalId || !conflictingSessionId) continue;
    rememberOpenClawPrivateAuthorityOffer(
      api,
      privateAuthorityOfferKey(
        sessionKey,
        sessionId,
        RECONCILE_BINDING_AUTHORITY_KIND,
        { type: "terminal_id", id: terminalId }
      ),
      { args }
    );
  }
}

export function rememberDisplayedApprovalOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  const decisionFingerprints = currentApprovalDecisionFingerprints(result);
  const fingerprint = decisionFingerprints.approve_once;
  if (!fingerprint) return;
  const target = approvalTargetFromStatus(result);
  if (!target) return;
  rememberOpenClawPrivateAuthorityOffer(
    api,
    openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target),
    {
      fingerprint,
      decision_fingerprints: decisionFingerprints
    }
  );
}

interface DisplayedInteractionOfferPayload
  extends OpenClawPrivateAuthorityOfferPayload {
  readonly interaction_state?: unknown;
}

interface DisplayedInteractionStatus {
  readonly fields: Record<string, unknown>;
  readonly expectedSubjectKind: OpenClawInteractionAuthoritySubjectKind;
  readonly expectedSubjectId?: string;
}

interface OpenClawInteractionSubjectTarget {
  readonly kind: OpenClawInteractionAuthoritySubjectKind;
  readonly id: string;
  readonly cliOption: "--turn" | "--watch";
}

export function rememberDisplayedInteractionOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  const displayed = displayedInteractionStatus(result);
  if (!displayed) return;
  const expectedSubjectId = stringValue(displayed.expectedSubjectId);
  if (!expectedSubjectId || expectedSubjectId === "unknown") return;
  invalidateOpenClawInteractionAuthorityOffersForSubject(
    api,
    sessionKey,
    sessionId,
    displayed.expectedSubjectKind,
    expectedSubjectId
  );
  const fingerprint = stringValue(
    displayed.fields.interaction_prompt_fingerprint
  );
  if (!isExactInteractionFingerprint(fingerprint)) return;
  let interactionState: TerminalInteractionAnyProjection;
  try {
    interactionState = validateAnyTerminalInteractionProjection(
      displayed.fields.interaction_state
    );
  } catch {
    return;
  }
  const subject = interactionProjectionSubject(interactionState);
  if (
    interactionState.state !== "pending" ||
    interactionState.capabilities.respond !== true ||
    subject.kind !== displayed.expectedSubjectKind ||
    subject.id !== expectedSubjectId ||
    (
      interactionState.version === TERMINAL_INTERACTION_SUBJECT_VERSION &&
      (
        interactionState.response_authority !== "executable" ||
        interactionState.prompt_fingerprint !== fingerprint
      )
    )
  ) {
    return;
  }
  rememberOpenClawPrivateAuthorityOffer(
    api,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      subject.kind,
      subject.id,
      interactionState.interaction_id
    ),
    {
      fingerprint,
      interaction_state: interactionState
    }
  );
}

export function invalidateRequestedInteractionOffers(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  params: Record<string, unknown>
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId) return;
  const watchId = stringValue(params.watch_id);
  if (watchId) {
    invalidateOpenClawInteractionAuthorityOffersForSubject(
      api,
      sessionKey,
      sessionId,
      "terminal_watch",
      watchId
    );
    return;
  }
  const turnId = stringValue(params.turn_id);
  if (!turnId) return;
  invalidateOpenClawInteractionAuthorityOffersForSubject(
    api,
    sessionKey,
    sessionId,
    "managed_turn",
    turnId
  );
}

function displayedInteractionStatus(
  result: Record<string, unknown>
): DisplayedInteractionStatus | undefined {
  const watch = isRecord(result.watch) ? result.watch : undefined;
  if (watch) {
    return {
      fields: watch,
      expectedSubjectKind: "terminal_watch",
      expectedSubjectId: stringValue(watch.watch_id)
    };
  }
  const terminalStatus = isRecord(result.terminal_status)
    ? result.terminal_status
    : undefined;
  if (terminalStatus) {
    return {
      fields: terminalStatus,
      expectedSubjectKind: "managed_turn",
      expectedSubjectId: publicTurnIdentity(result).turnId
    };
  }
  if (result.interaction_state === undefined) return undefined;
  const watchId = stringValue(result.watch_id);
  return {
    fields: result,
    expectedSubjectKind: watchId ? "terminal_watch" : "managed_turn",
    expectedSubjectId: watchId ?? publicTurnIdentity(result).turnId
  };
}

function interactionProjectionSubject(
  projection: TerminalInteractionAnyProjection
): Pick<OpenClawInteractionSubjectTarget, "kind" | "id"> {
  if (projection.version === TERMINAL_INTERACTION_SUBJECT_VERSION) {
    return {
      kind: projection.subject.kind,
      id: terminalInteractionSubjectId(projection.subject)
    };
  }
  return { kind: "managed_turn", id: projection.turn_id };
}

function approvalTargetFromStatus(
  result: Record<string, unknown>
): OpenClawPrivateAuthorityTarget | undefined {
  const conversationId = stringValue(result.conversation_id);
  if (
    stringValue(result.source) === "terminal_control" ||
    conversationId?.startsWith("terminal:")
  ) {
    return conversationId
      ? { type: "terminal_id", id: conversationId }
      : undefined;
  }
  const { turnId } = publicTurnIdentity(result);
  return turnId && turnId !== "unknown"
    ? { type: "turn_id", id: turnId }
    : undefined;
}

function uniqueArgumentObjects(
  candidates: Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...new Map(
    candidates.map((args) => [
      JSON.stringify(args),
      args
    ])
  ).values()];
}

function privateAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  kind: string,
  target: OpenClawPrivateAuthorityTarget
): OpenClawPrivateAuthorityOfferKey {
  return { sessionKey, sessionId, kind, target };
}

export async function consumeDisplayedPrivateAction(
  api: object,
  input: {
    sessionKey: string;
    sessionId: string;
    kind: string;
    target: OpenClawPrivateAuthorityTarget;
    tool: string;
    terminalId?: string;
    matches: (argumentsValue: Record<string, unknown>) => boolean;
  }
): Promise<Record<string, unknown>> {
  const offered = consumeOpenClawPrivateAuthorityOffer(api, {
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    kind: input.kind,
    target: input.target
  });
  if (!offered || !isRecord(offered.args)) {
    throw new Error(
      `${input.tool} requires a current action shown by AKK list in this controller session; refresh list, review it, and explicitly confirm again`
    );
  }
  const current = await privateActionArguments(api, input);
  if (JSON.stringify(current) !== JSON.stringify(offered.args)) {
    throw new Error(
      `${input.tool} authority changed after it was shown; refresh AKK list, review the current action, and explicitly confirm again`
    );
  }
  return current;
}

function terminalRows(result: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(result.terminals)
    ? result.terminals.filter(isRecord)
    : [];
}

function authoritativeTerminalActionArguments(
  terminal: Record<string, unknown>,
  tool: string
): Record<string, unknown>[] {
  const availableActions = isRecord(terminal.available_actions)
    ? terminal.available_actions
    : undefined;
  if (!availableActions) return [];
  return Object.values(availableActions).flatMap((action) =>
    isRecord(action) && action.tool === tool && isRecord(action.arguments)
      ? [action.arguments]
      : []
  );
}

function authoritativeHandoffActionArguments(
  terminals: Record<string, unknown>[]
): Record<string, unknown>[] {
  return terminals.flatMap((terminal) => {
    const decision = isRecord(terminal.handoff_decision)
      ? terminal.handoff_decision
      : undefined;
    const choices = isRecord(decision?.choices) ? decision.choices : undefined;
    const takeOver = isRecord(choices?.take_over_current)
      ? choices.take_over_current
      : undefined;
    const action = isRecord(takeOver?.action) ? takeOver.action : undefined;
    return decision?.kind === "active_turn_requires_decision" &&
        action?.tool === "agent_knock_knock_close" &&
        action.requires_explicit_user_confirmation === true &&
        isRecord(action.arguments)
      ? [action.arguments]
      : [];
  });
}

function currentApprovalFingerprint(
  result: unknown,
  decision: TerminalApprovalDecision
): string {
  const fingerprint = isRecord(result)
    ? currentApprovalDecisionFingerprints(result)[decision]
    : undefined;
  if (!fingerprint) {
    throw new Error(
      `the current status does not contain one exact ${decision} choice; refresh status and ask the user to review it again`
    );
  }
  return fingerprint;
}

export async function buildPrivateApprovalArgs(
  api,
  params: Record<string, unknown>,
  { sessionKey, sessionId }: { sessionKey: string; sessionId: string }
): Promise<string[]> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const turnId = stringValue(params.turn_id);
  const terminalId = stringValue(params.terminal_id);
  const decisionValue = params.decision ?? "approve_once";
  if (!isTerminalApprovalDecision(decisionValue)) {
    throw new Error("decision must be one of: approve_once, reject");
  }
  const decision = decisionValue;
  if (Boolean(turnId) === Boolean(terminalId)) {
    throw new Error("approve requires exactly one of turn_id or terminal_id");
  }
  if (terminalId && decision !== "approve_once") {
    throw new Error(
      "terminal-scoped approval supports approve_once only; reject requires an exact managed Turn"
    );
  }
  const target: OpenClawPrivateAuthorityTarget = terminalId
    ? { type: "terminal_id", id: terminalId }
    : { type: "turn_id", id: requiredString(turnId, "turn_id") };
  const offered = consumeOpenClawPrivateAuthorityOffer<
    OpenClawPrivateAuthorityOfferPayload
  >(api, openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target));
  const offeredDecisions = isRecord(offered?.decision_fingerprints)
    ? offered.decision_fingerprints
    : undefined;
  const offeredFingerprint = stringValue(offeredDecisions?.[decision]) ??
    (decision === "approve_once" ? stringValue(offered?.fingerprint) : undefined) ??
    (isRecord(offered?.args)
      ? decision === "approve_once"
        ? stringValue(offered.args.expected_approval_fingerprint)
        : undefined
      : undefined);
  if (!isExactApprovalFingerprint(offeredFingerprint)) {
    throw new Error(
      "approve requires a current approval request shown by agent_knock_knock_status in this controller conversation; refresh status, ask the user to review it, and explicitly confirm again"
    );
  }
  const action = terminalId
    ? await privateActionArguments(api, {
        tool: "agent_knock_knock_approve",
        terminalId,
        matches: (argumentsValue) => stringValue(
          argumentsValue.terminal_id ?? argumentsValue.conversation_id
        ) === terminalId
      })
    : undefined;
  const statusArgs = ["status", "--reconcile"];
  if (terminalId) {
    statusArgs.push("--conversation", terminalId);
  } else {
    statusArgs.push("--turn", requiredString(turnId, "turn_id"));
  }
  pushOptional(statusArgs, "--store-dir", resolvePluginStoreDir(config));
  const args = ["approve"];
  if (terminalId) {
    args.push("--conversation", terminalId);
  } else {
    args.push("--turn", requiredString(turnId, "turn_id"));
  }
  const currentFingerprint = currentApprovalFingerprint(
    await runHostAwareCli(api, statusArgs),
    decision
  );
  if (currentFingerprint !== offeredFingerprint) {
    throw new Error(
      "the approval request changed after it was shown; refresh AKK status, ask the user to review the current request, and explicitly confirm again"
    );
  }
  args.push("--decision", decision);
  args.push("--expected-approval-fingerprint", currentFingerprint);
  if (terminalId) {
    args.push(
      "--expected-terminal-token",
      requiredString(
        action?.expected_terminal_token,
        "current internal terminal approval authority"
      )
    );
  }
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  return args;
}

export function buildPrivateInteractionResponseArgs(
  api,
  params: Record<string, unknown>,
  { sessionKey, sessionId }: { sessionKey: string; sessionId: string }
): string[] {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const requestedSubject = requestedInteractionSubject(params);
  const interactionId = requiredTerminalInteractionIdentifier(
    params.interaction_id,
    "interaction_id"
  );
  const offered = consumeOpenClawPrivateAuthorityOffer<
    DisplayedInteractionOfferPayload
  >(
    api,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      requestedSubject.kind,
      requestedSubject.id,
      interactionId
    )
  );
  const fingerprint = stringValue(offered?.fingerprint);
  if (
    !isExactInteractionFingerprint(fingerprint) ||
    offered?.interaction_state === undefined
  ) {
    throw new Error(
      "respond_interaction requires a current pending interaction shown by agent_knock_knock_status in this controller conversation; refresh status, review the current questions, and respond again"
    );
  }
  const projection = validateAnyTerminalInteractionProjection(
    offered.interaction_state
  );
  assertInteractionSubjectMatchesProjection(requestedSubject, projection);
  const responseInput = interactionResponseForProjection(params, projection);
  const response = validateAnyTerminalInteractionResponse(
    responseInput,
    projection,
    {
      // This consumes a still-live, session/incarnation-bound private offer.
      // The CLI/bridge path always performs exact live terminal recaptures
      // before it can reserve or dispatch input, so projection expiry is a
      // recheck trigger rather than proof that the questionnaire disappeared.
      allowExpiredForLiveRecapture: true
    }
  );
  const args = [
    "respond-interaction",
    requestedSubject.cliOption,
    requestedSubject.id,
    "--interaction",
    response.interaction_id,
    "--response-json",
    JSON.stringify(response),
    "--expected-interaction-fingerprint",
    fingerprint,
    "--expected-interaction-expires-at",
    projection.expires_at,
    "--openclaw-session",
    sessionKey
  ];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  return args;
}

function requestedInteractionSubject(
  params: Record<string, unknown>
): OpenClawInteractionSubjectTarget {
  const hasTurn = Object.hasOwn(params, "turn_id");
  const hasWatch = Object.hasOwn(params, "watch_id");
  if (hasTurn === hasWatch) {
    throw new Error(
      "respond_interaction requires exactly one of turn_id or watch_id"
    );
  }
  return hasTurn
    ? {
        kind: "managed_turn",
        id: requiredTerminalInteractionIdentifier(params.turn_id, "turn_id"),
        cliOption: "--turn"
      }
    : {
        kind: "terminal_watch",
        id: requiredTerminalInteractionIdentifier(params.watch_id, "watch_id"),
        cliOption: "--watch"
      };
}

function assertInteractionSubjectMatchesProjection(
  requested: OpenClawInteractionSubjectTarget,
  projection: TerminalInteractionAnyProjection
): void {
  const projected = interactionProjectionSubject(projection);
  if (requested.kind !== projected.kind || requested.id !== projected.id) {
    throw new Error(
      "respond_interaction target does not match the displayed interaction subject; refresh status and respond to its exact turn_id or watch_id"
    );
  }
}

function interactionResponseForProjection(
  params: Record<string, unknown>,
  projection: TerminalInteractionAnyProjection
): Record<string, unknown> {
  if (projection.version !== TERMINAL_INTERACTION_SUBJECT_VERSION) {
    return params;
  }
  return {
    interaction_id: params.interaction_id,
    subject: projection.subject,
    ...(projection.subject.kind === "managed_turn"
      ? { turn_id: params.turn_id }
      : {}),
    answers: params.answers
  };
}

function isExactApprovalFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isExactInteractionFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function currentApprovalDecisionFingerprints(
  result: Record<string, unknown>
): Partial<Record<TerminalApprovalDecision, string>> {
  const terminalStatus = isRecord(result.terminal_status)
    ? result.terminal_status
    : undefined;
  const states = [
    isRecord(result.approval_state) ? result.approval_state : undefined,
    isRecord(terminalStatus?.approval_state)
      ? terminalStatus.approval_state
      : undefined
  ];
  const found = new Map<TerminalApprovalDecision, Set<string>>();
  const remember = (decision: TerminalApprovalDecision, value: unknown) => {
    if (!isExactApprovalFingerprint(value)) return;
    const fingerprints = found.get(decision) ?? new Set<string>();
    fingerprints.add(value);
    found.set(decision, fingerprints);
  };
  for (const state of states) {
    const fingerprint = state?.approvable === true
      ? stringValue(state.fingerprint)
      : undefined;
    remember("approve_once", fingerprint);
    if (state?.approvable !== true || !Array.isArray(state.choices)) continue;
    for (const choice of state.choices) {
      if (
        isRecord(choice) &&
        isTerminalApprovalDecision(choice.decision)
      ) {
        remember(choice.decision, choice.fingerprint);
      }
    }
  }
  return Object.fromEntries(
    [...found.entries()].flatMap(([decision, fingerprints]) =>
      fingerprints.size === 1
        ? [[decision, [...fingerprints][0]!]]
        : []
    )
  );
}
