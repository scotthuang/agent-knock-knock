export {
  terminalUserExplicitModelControlBindingToken,
  terminalUserExplicitModelControlRepairBindingToken,
  terminalUserExplicitModelControlResidualEntryBindingToken
} from "./terminal-model-control-subject.js";
export {
  probeTerminalModelControl,
  planTerminalModelControl
} from "./terminal-model-control-profile.js";
import {
  TERMINAL_MODEL_REASONING_EFFORTS,
  isTerminalModelReasoningEffort
} from "./terminal-model-control-contract.js";
import type {
  TerminalModelReasoningEffort,
  TerminalModelChoice,
  TerminalModelValue,
  TerminalModelCatalog,
  TerminalModelSwitchRequest,
  TerminalModelSwitchResult,
  TerminalModelControlResidualKind,
  TerminalModelControlResidualObservation,
  TerminalModelControlRepairResult,
  CodexNativeModelCatalog,
  TerminalModelControlObservation,
  TerminalModelControlCapture,
  TerminalModelControlSurface,
  TerminalModelControlPorts,
  TerminalModelOptionsExecution
} from "./terminal-model-control-contract.js";
import {
  parseCodexNativeModelCatalog,
  observeCodexIdleModel,
  observeTerminalModelControl,
  modelControlMoveKeys,
  modelControlSelectModelKeys,
  codexModelControlSelectEffortKeys,
  codexModelControlAllModesKeys,
  claudeModelControlEffortKey,
  claudeModelControlCommitKeys,
  classifyTerminalModelControlSurface,
  modelControlCaptureBlocked,
  codexPersistencePostcondition
} from "./terminal-model-control-surface.js";
import {
  MODEL_CONTROL_SETTLE_TIMEOUT_MS,
  MODEL_CONTROL_POLL_MS,
  transitionModelControl,
  exactDispatchKeys,
  waitForObservation
} from "./terminal-model-control-input.js";
import {
  inspectClaudeModelEfforts,
  applyCodexModelSelection,
  applyClaudeModelSelection
} from "./terminal-model-selection.js";
export {
  TERMINAL_MODEL_REASONING_EFFORTS,
  TerminalModelReasoningEffort,
  TerminalModelChoice,
  TerminalModelValue,
  TerminalModelCatalog,
  TerminalModelSwitchRequest,
  TerminalModelSwitchResult,
  TerminalModelControlResidualKind,
  TerminalModelControlResidualObservation,
  TerminalModelControlRepairResult,
  CodexNativeModelCatalog,
  TerminalModelControlObservation,
  TerminalModelControlCapture,
  TerminalModelControlSurface,
  TerminalModelControlPorts,
  TerminalModelOptionsExecution,
  isTerminalModelReasoningEffort
} from "./terminal-model-control-contract.js";
export {
  parseCodexNativeModelCatalog,
  observeTerminalModelControl,
  modelControlMoveKeys,
  modelControlSelectModelKeys,
  codexModelControlSelectEffortKeys,
  codexModelControlAllModesKeys,
  claudeModelControlEffortKey,
  claudeModelControlCommitKeys,
  classifyTerminalModelControlSurface
} from "./terminal-model-control-surface.js";

import {
  createHash
} from "node:crypto";

import type {
  ExecutorKind
} from "./executors.js";
import {
  isTerminalModelControlPlanForAgent,
  terminalModelControlProfileForPlan,
  type TerminalModelControlCapabilities,
  type TerminalModelControlPlan,
  type TerminalModelControlScope
} from "./terminal-model-control-profile.js";
import {
  canonicalModelControlSubject,
  type TerminalModelControlSubjectInput
} from "./terminal-model-control-subject.js";
import {
  decideTerminalModelControlFailure,
  reduceTerminalModelControlTransactionPhase,
  type TerminalModelControlFailureDecision,
  type TerminalModelControlTransactionEvent,
  type TerminalModelControlTransactionPhase
} from "./terminal-model-control-transaction.js";

export {
  CLAUDE_MODEL_CONTROL_AGENT_VERSION,
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  CODEX_MODEL_CONTROL_AGENT_VERSIONS,
  TERMINAL_MODEL_CONTROL_PROFILE_IDS,
  isCodexModelControlAgentVersion,
  isTerminalModelControlPlanForAgent,
  terminalModelControlPlanConforms,
  terminalModelControlProfileFor,
  terminalModelControlProfileForPlan,
  terminalModelControlProfiles,
  terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint,
  terminalModelControlSlashCompletionRows,
  type TerminalModelControlBehaviorProfile,
  type CodexModelControlAgentVersion,
  type TerminalModelControlCapabilities,
  type TerminalModelControlPlan,
  type TerminalModelControlProfile,
  type TerminalModelControlScope
} from "./terminal-model-control-profile.js";
export {
  canonicalModelControlSubject,
  type CanonicalTerminalModelControlSubject,
  type TerminalModelControlSubjectInput
} from "./terminal-model-control-subject.js";

export function terminalModelCatalogFingerprint(input: {
  agent: ExecutorKind;
  agentVersion: string;
  behaviorProfile: string;
  scope: TerminalModelControlScope;
  current: TerminalModelValue;
  models: readonly TerminalModelChoice[];
}): string {
  const canonical = {
    agent: input.agent,
    agent_version: input.agentVersion,
    behavior_profile: input.behaviorProfile,
    scope: input.scope,
    current: {
      model: input.current.model,
      reasoning_effort: input.current.reasoningEffort ?? null
    },
    models: input.models.map((model) => ({
      id: model.id,
      label: model.label,
      reasoning_efforts: [...model.reasoningEfforts]
    }))
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

interface TerminalModelControlTransaction {
  phase: TerminalModelControlTransactionPhase;
}

type TerminalModelControlOperationInput<T extends {
  ports: TerminalModelControlPorts;
}> = T & {
  readonly transaction: TerminalModelControlTransaction;
};

function advanceTerminalModelControlTransaction(
  transaction: TerminalModelControlTransaction,
  event: TerminalModelControlTransactionEvent
): void {
  transaction.phase = reduceTerminalModelControlTransactionPhase(
    transaction.phase,
    event
  );
}

/** Track every nested native write even when its transport receipt rejects. */
function beginTerminalModelControlTransaction<T extends {
  ports: TerminalModelControlPorts;
}>(input: T): TerminalModelControlOperationInput<T> {
  const transaction: TerminalModelControlTransaction = { phase: "no_input" };
  return {
    ...input,
    transaction,
    ports: {
      ...input.ports,
      sendText: async (terminalControl, text) => {
        advanceTerminalModelControlTransaction(
          transaction,
          "reversible_input_attempted"
        );
        await input.ports.sendText(terminalControl, text);
      },
      sendKeys: async (terminalControl, keys) => {
        advanceTerminalModelControlTransaction(
          transaction,
          "reversible_input_attempted"
        );
        await input.ports.sendKeys(terminalControl, keys);
      }
    }
  };
}

function terminalModelControlInputAttempted(
  transaction: TerminalModelControlTransaction
): boolean {
  return transaction.phase === "reversible_input" ||
    transaction.phase === "commit_attempted";
}

async function settleTerminalModelControlFailure(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
  transaction: TerminalModelControlTransaction;
}, terminalControl: unknown): Promise<{
  readonly decision: TerminalModelControlFailureDecision;
  readonly cleanupError?: string;
}> {
  const pending = decideTerminalModelControlFailure(
    input.transaction.phase,
    "not_attempted"
  );
  if (!pending.unwind) return { decision: pending };
  const cleanupError = await tryUnwindModelControl(input, terminalControl);
  return {
    decision: decideTerminalModelControlFailure(
      input.transaction.phase,
      cleanupError ? "failed" : "proven"
    ),
    ...(cleanupError ? { cleanupError } : {})
  };
}

function residualFromCapture(
  plan: TerminalModelControlPlan,
  capture: TerminalModelControlCapture
): TerminalModelControlResidualObservation {
  const profile = terminalModelControlProfileForPlan(plan);
  if (!profile?.supportsResidualRepair) {
    return {
      state: "unsafe",
      reason:
        "model-control residual repair requires a verified Codex profile",
      terminalControl: capture.terminalControl
    };
  }
  const surface = classifyTerminalModelControlSurface(plan, capture);
  if (surface.state === "blocked") {
    return {
      state: "unsafe",
      reason: "another prompt or active agent state owns terminal input",
      terminalControl: capture.terminalControl
    };
  }
  if (surface.state === "picker") {
    return {
      state: "recoverable",
      kind: "model_surface",
      fingerprint: createHash("sha256")
        .update(JSON.stringify({
          version: 1,
          behavior_profile: plan.behaviorProfile,
          kind: "model_surface",
          surface_state: surface.observation.state,
          surface_fingerprint: surface.observation.fingerprint
        }))
        .digest("hex"),
      terminalControl: capture.terminalControl
    };
  }
  if (surface.state !== "command_popup" &&
      surface.state !== "bare_command") {
    return {
      state: "absent",
      reason: surface.state === "idle_empty"
        ? "the Composer is already empty"
        : "the current Composer is not one exact profiled /model residual",
      terminalControl: capture.terminalControl
    };
  }
  if (!surface.fingerprint) {
    return {
      state: "absent",
      reason: "the current Composer is not one exact profiled /model residual",
      terminalControl: capture.terminalControl
    };
  }
  const kind = surface.state === "command_popup"
    ? "profiled_command_popup"
    : "bare_command";
  return {
    state: "recoverable",
    kind,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({
        version: 1,
        behavior_profile: plan.behaviorProfile,
        kind,
        exact_command_fingerprint: surface.fingerprint
      }))
      .digest("hex"),
    terminalControl: capture.terminalControl
  };
}

/**
 * Read-only, two-frame proof for one exact Codex `/model` residual or exact
 * native model-control surface. It never treats arbitrary Composer text,
 * transcript text, or an incomplete/unknown picker as recoverable authority.
 */
export async function inspectTerminalModelControlResidual(input: {
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  ports: TerminalModelControlPorts;
}): Promise<TerminalModelControlResidualObservation> {
  const firstCapture = await input.ports.capture({
    terminalControl: input.terminalControl,
    expectedComposer: input.plan.command
  });
  const first = residualFromCapture(input.plan, firstCapture);
  if (first.state !== "recoverable") return first;
  await input.ports.sleep(MODEL_CONTROL_POLL_MS);
  const secondCapture = await input.ports.capture({
    terminalControl: first.terminalControl,
    expectedComposer: input.plan.command
  });
  const second = residualFromCapture(input.plan, secondCapture);
  if (
    second.state !== "recoverable" ||
    second.kind !== first.kind ||
    second.fingerprint !== first.fingerprint
  ) {
    return {
      state: "unsafe",
      reason: "the exact /model residual changed across the stable snapshot",
      terminalControl: second.terminalControl
    };
  }
  return second;
}

/**
 * Consume one current residual offer. Once any cleanup key is attempted, all
 * failures are response-uncertain and callers must not retry automatically.
 */
export async function repairTerminalModelControlResidual(input: {
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  expectedResidualFingerprint: string;
  ports: TerminalModelControlPorts;
}): Promise<TerminalModelControlRepairResult> {
  const observed = await inspectTerminalModelControlResidual(input);
  if (observed.state !== "recoverable") {
    throw new Error(observed.reason);
  }
  if (observed.fingerprint !== input.expectedResidualFingerprint) {
    throw new Error(
      "the exact /model residual changed after authorization; refresh AKK list"
    );
  }
  const operation = beginTerminalModelControlTransaction(input);
  try {
    const cleared = await unwindModelControl(
      operation,
      observed.terminalControl
    );
    if (classifyTerminalModelControlSurface(input.plan, cleared).state !==
        "idle_empty") {
      throw new Error("cleanup did not prove an exact idle empty Composer");
    }
    const terminalInputAttempted = terminalModelControlInputAttempted(
      operation.transaction
    );
    advanceTerminalModelControlTransaction(
      operation.transaction,
      "postcondition_proven"
    );
    return {
      outcome: "repaired",
      terminalControl: cleared.terminalControl,
      terminalInputAttempted,
      composerPostcondition: "empty",
      doNotRetry: false
    };
  } catch (error) {
    const decision = decideTerminalModelControlFailure(
      operation.transaction.phase,
      "failed"
    );
    if (decision.outcome === "throw") throw error;
    return {
      outcome: "uncertain",
      terminalControl: observed.terminalControl,
      terminalInputAttempted: true,
      composerPostcondition: "unproven",
      doNotRetry: decision.doNotRetry,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
/**
 * Run one bounded, reversible native catalog inspection. It enters only the
 * adapter-owned `/model` surface and always returns through exact Escape paths.
 */
export async function discoverTerminalModelOptions(input: {
  agent: ExecutorKind;
  agentVersion: string;
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  ports: TerminalModelControlPorts;
  initialResidual?: Extract<
    TerminalModelControlResidualObservation,
    { state: "recoverable" }
  >;
}): Promise<TerminalModelOptionsExecution> {
  const operation = beginTerminalModelControlTransaction(input);
  const codexNativeCatalog = operation.agent === "codex"
    ? await operation.ports.loadCodexCatalog?.()
    : undefined;
  if (operation.agent === "codex" && !codexNativeCatalog) {
    throw new Error(
      "Codex model discovery requires the exact running executable's validated model catalog"
    );
  }
  let control = operation.terminalControl;
  const opened = await openModelPicker(operation, control);
  control = opened.capture.terminalControl;
  const picker = opened.observation;
  try {
  if (
    picker.state !== "codex_model_picker" &&
    picker.state !== "claude_model_picker"
  ) {
    throw new Error("the native model picker did not expose an exact catalog");
  }

  let currentEffort: TerminalModelReasoningEffort | undefined;
  let models: TerminalModelChoice[];
  if (picker.state === "codex_model_picker") {
    const nativeById = new Map(
      codexNativeCatalog?.models.map((model) => [model.id, model]) ?? []
    );
    const currentChoice = nativeById.get(picker.currentModel);
    let idleCurrent = observeCodexIdleModel(opened.idleCapture.screen, input.plan);
    models = picker.rows.flatMap((row) => {
      const native = nativeById.get(row.id);
      // A single-effort row commits on Enter instead of opening the profiled
      // reasoning picker, so it is deliberately absent from this typed API.
      return native && native.reasoningEfforts.length >= 2
        ? [{
            id: row.id,
            label: native.label || row.label,
            reasoningEfforts: native.reasoningEfforts
          }]
        : [];
    });
    const dismissed = await exactDismiss(
      operation,
      control,
      picker
    );
    control = dismissed.terminalControl;
    // An adopted profiled slash popup temporarily replaces the ordinary
    // footer. Once the read-only picker is dismissed, the exact idle footer
    // is visible again and can complete the same catalog cross-check.
    idleCurrent ??= observeCodexIdleModel(dismissed.screen, input.plan);
    if (!currentChoice || !idleCurrent ||
        idleCurrent.model !== picker.currentModel ||
        !idleCurrent.reasoningEffort ||
        !currentChoice.reasoningEfforts.includes(idleCurrent.reasoningEffort)) {
      throw new Error(
        "the current Codex model and effort are not exact across its idle footer and live catalog"
      );
    }
    currentEffort = idleCurrent.reasoningEffort;
  } else {
    currentEffort = picker.currentEffort;
    let livePicker = picker;
    models = [];
    for (const row of picker.rows) {
      const inspected = await inspectClaudeModelEfforts(
        operation, control, livePicker, row.id
      );
      control = inspected.capture.terminalControl;
      livePicker = inspected.observation;
      if (inspected.reasoningEfforts.length > 0) {
        models.push({
          id: row.id,
          label: row.label,
          reasoningEfforts: inspected.reasoningEfforts
        });
      }
    }
    control = (await exactDismiss(
      operation,
      control,
      livePicker
    )).terminalControl;
  }
  if (models.length === 0) {
    throw new Error("the live native model picker had no verified model choices");
  }
  const current = {
    model: picker.currentModel,
    reasoningEffort: currentEffort
  } satisfies TerminalModelValue;
  const fingerprintInput = {
    agent: operation.agent,
    agentVersion: operation.agentVersion,
    behaviorProfile: operation.plan.behaviorProfile,
    scope: operation.plan.scope,
    current,
    models
  };
  const result = {
    terminalControl: control,
    catalog: {
      ...fingerprintInput,
      catalogFingerprint: terminalModelCatalogFingerprint(fingerprintInput)
    }
  };
  advanceTerminalModelControlTransaction(
    operation.transaction,
    "postcondition_proven"
  );
  return result;
  } catch (error) {
    const { cleanupError } = await settleTerminalModelControlFailure(
      operation,
      control
    );
    const detail = error instanceof Error ? error.message : String(error);
    if (cleanupError) {
      throw new Error(
        `${detail}; exact native model-control cleanup failed: ${cleanupError}`
      );
    }
    throw error;
  }
}

/**
 * Re-discover the exact catalog, consume one adapter-owned model path, then
 * reopen the picker to prove the effective postcondition. No automatic retry
 * is possible after the native commit key is attempted.
 */
export async function switchTerminalModel(input: {
  agent: ExecutorKind;
  agentVersion: string;
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  expectedCatalogFingerprint: string;
  request: TerminalModelSwitchRequest;
  ports: TerminalModelControlPorts;
}): Promise<TerminalModelSwitchResult & { readonly terminalControl: unknown }> {
  const requestedEffort = input.request.reasoningEffort;
  if (!requestedEffort || !isTerminalModelReasoningEffort(requestedEffort)) {
    throw new Error("--reasoning-effort must be one current advertised semantic value");
  }
  const discovery = await discoverTerminalModelOptions(input);
  if (discovery.catalog.catalogFingerprint !== input.expectedCatalogFingerprint) {
    throw new Error(
      "the native model catalog changed after discovery; run model-options again"
    );
  }
  const offered = discovery.catalog.models.find((model) =>
    model.id === input.request.model
  );
  if (!offered || !offered.reasoningEfforts.includes(requestedEffort)) {
    throw new Error(
      "the requested model and reasoning effort are not in the current native catalog"
    );
  }
  if (
    input.agent !== "codex" &&
    discovery.catalog.current.model === input.request.model &&
    discovery.catalog.current.reasoningEffort === requestedEffort
  ) {
    return {
      terminalControl: discovery.terminalControl,
      outcome: "already_effective",
      scope: input.plan.scope,
      defaultsChanged: false,
      requested: input.request,
      effective: discovery.catalog.current,
      doNotRetry: false
    };
  }

  const operation = beginTerminalModelControlTransaction(input);
  let control = discovery.terminalControl;
  let codexPersistenceBaseline: string | undefined;
  let codexPersistenceScreen: string | undefined;
  try {
    const opened = await openModelPicker(operation, control);
    control = opened.capture.terminalControl;
    const picker = opened.observation;
    if (picker.state === "codex_model_picker") {
      codexPersistenceBaseline = opened.idleCapture.screen;
      const committed = await applyCodexModelSelection(
        operation,
        control,
        picker,
        input.request,
        () => advanceTerminalModelControlTransaction(
          operation.transaction,
          "commit_attempted"
        )
      );
      control = committed.capture.terminalControl;
      codexPersistenceScreen = committed.capture.screen;
    } else if (picker.state === "claude_model_picker") {
      const committed = await applyClaudeModelSelection(
        operation, control, picker, input.request,
        () => advanceTerminalModelControlTransaction(
          operation.transaction, "commit_attempted"
        ),
        (observedControl) => { control = observedControl; }
      );
      control = committed.capture.terminalControl;
    } else {
      throw new Error("the native model picker changed before selection");
    }

    let persistence = input.agent === "codex"
      ? await waitForCodexPersistencePostcondition(
          operation,
          control,
          codexPersistenceBaseline ?? "",
          input.request,
          codexPersistenceScreen
        )
      : { proven: true } as const;
    let post = await discoverTerminalModelOptions({
      ...input, terminalControl: control
    });
    control = post.terminalControl;
    let effective = post.catalog.current;
    if (
      input.agent === "codex" &&
      persistence.proven &&
      observeCodexIdleModel(codexPersistenceBaseline ?? "", input.plan)?.planMode === true &&
      discovery.catalog.current.model !== input.request.model &&
      effective.model === input.request.model &&
      effective.reasoningEffort === discovery.catalog.current.reasoningEffort &&
      effective.reasoningEffort !== requestedEffort
    ) {
      const reopened = await openModelPicker(operation, control);
      if (reopened.observation.state !== "codex_model_picker") {
        throw new Error("Codex Plan-mode reconciliation did not open its model picker");
      }
      const secondBaseline = reopened.idleCapture.screen;
      const reconciled = await applyCodexModelSelection(
        operation,
        reopened.capture.terminalControl,
        reopened.observation,
        input.request,
        () => advanceTerminalModelControlTransaction(
          operation.transaction,
          "commit_attempted"
        )
      );
      control = reconciled.capture.terminalControl;
      persistence = await waitForCodexPersistencePostcondition(
        operation,
        control,
        secondBaseline,
        input.request,
        reconciled.capture.screen
      );
      post = await discoverTerminalModelOptions({
        ...input, terminalControl: control
      });
      control = post.terminalControl;
      effective = post.catalog.current;
    }
    if (
      effective.model !== input.request.model ||
      effective.reasoningEffort !== requestedEffort
    ) {
      return {
        terminalControl: control,
        outcome: "uncertain",
        scope: input.plan.scope,
        defaultsChanged: null,
        requested: input.request,
        effective,
        doNotRetry: true,
        reason: "the native postcondition did not match the requested model and effort"
      };
    }
    if (!persistence.proven) {
      return {
        terminalControl: control,
        outcome: "uncertain",
        scope: input.plan.scope,
        defaultsChanged: null,
        requested: input.request,
        effective,
        doNotRetry: true,
        reason: persistence.reason
      };
    }
    const newSessionDefaults = input.agent === "codex"
      ? {
          model: input.request.model,
          ...(requestedEffort === "ultra"
            ? {}
            : { reasoningEffort: requestedEffort })
        }
      : undefined;
    advanceTerminalModelControlTransaction(
      operation.transaction,
      "postcondition_proven"
    );
    return {
      terminalControl: control,
      outcome: "changed",
      scope: input.plan.scope,
      defaultsChanged: input.agent === "codex",
      requested: input.request,
      effective,
      ...(newSessionDefaults ? { newSessionDefaults } : {}),
      doNotRetry: false
    };
  } catch (error) {
    const { decision, cleanupError } =
      await settleTerminalModelControlFailure(operation, control);
    if (decision.outcome === "throw") throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      terminalControl: control,
      outcome: "uncertain",
      scope: input.plan.scope,
      defaultsChanged: null,
      requested: input.request,
      doNotRetry: decision.doNotRetry,
      reason: cleanupError
        ? `${detail}; exact native model-control cleanup failed: ${cleanupError}`
        : detail
    };
  }
}

async function openModelPicker(input: {
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  ports: TerminalModelControlPorts;
  transaction: TerminalModelControlTransaction;
  initialResidual?: Extract<
    TerminalModelControlResidualObservation,
    { state: "recoverable" }
  >;
}, terminalControl: unknown): Promise<{
  idleCapture: TerminalModelControlCapture;
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  let cleanupControl = terminalControl;
  try {
  let idleCapture: TerminalModelControlCapture;
  let revalidatedCommand: TerminalModelControlCapture;
  if (input.initialResidual) {
    const profile = terminalModelControlProfileForPlan(input.plan);
    if (!profile?.supportsResidualContinuation) {
      throw new Error(
        "native model-control continuation requires a verified Codex profile"
      );
    }
    const observed = await inspectTerminalModelControlResidual({
      plan: input.plan,
      terminalControl,
      ports: input.ports
    });
    if (
      observed.state !== "recoverable" ||
      observed.kind !== input.initialResidual.kind ||
      observed.fingerprint !== input.initialResidual.fingerprint
    ) {
      throw new Error(
        "the exact /model residual changed before native catalog discovery"
      );
    }
    cleanupControl = observed.terminalControl;
    await input.ports.beforeInput();
    revalidatedCommand = await input.ports.capture({
      terminalControl: observed.terminalControl,
      expectedComposer: input.plan.command
    });
    const revalidatedResidual = residualFromCapture(
      input.plan,
      revalidatedCommand
    );
    if (
      revalidatedResidual.state !== "recoverable" ||
      revalidatedResidual.kind !== input.initialResidual.kind ||
      revalidatedResidual.fingerprint !== input.initialResidual.fingerprint
    ) {
      throw new Error(
        "the exact /model residual changed immediately before Enter"
      );
    }
    idleCapture = revalidatedCommand;
  } else {
    const before = await input.ports.capture({ terminalControl });
    cleanupControl = before.terminalControl;
    if (classifyTerminalModelControlSurface(input.plan, before).state !==
        "idle_empty") {
      throw new Error(
        "model control requires an exact verified idle pane with an empty composer and no blocking interaction"
      );
    }
    await input.ports.beforeInput();
    const finalEmpty = await input.ports.capture({
      terminalControl: before.terminalControl
    });
    if (classifyTerminalModelControlSurface(input.plan, finalEmpty).state !==
        "idle_empty") {
      throw new Error("the exact idle composer changed before /model input");
    }
    await input.ports.sendText(finalEmpty.terminalControl, input.plan.command);
    let commandCapture: TerminalModelControlCapture | undefined;
    const startedAt = Date.now();
    while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
      const captured = await input.ports.capture({
        terminalControl: before.terminalControl,
        expectedComposer: input.plan.command
      });
      const surface = classifyTerminalModelControlSurface(input.plan, captured);
      if (surface.state === "command_popup" ||
          isTerminalModelControlPlanForAgent(input.plan, "codex") &&
            surface.state === "bare_command") {
        commandCapture = captured;
        break;
      }
      await input.ports.sleep(MODEL_CONTROL_POLL_MS);
    }
    if (!commandCapture) {
      throw new Error("the exact /model composer did not materialize before Enter");
    }
    await input.ports.beforeInput();
    revalidatedCommand = await input.ports.capture({
      terminalControl: commandCapture.terminalControl,
      expectedComposer: input.plan.command
    });
    const revalidatedSurface = classifyTerminalModelControlSurface(
      input.plan,
      revalidatedCommand
    );
    if (revalidatedSurface.state !== "command_popup" &&
        !(isTerminalModelControlPlanForAgent(input.plan, "codex") &&
          revalidatedSurface.state === "bare_command")) {
      throw new Error("the exact /model composer changed before Enter");
    }
    idleCapture = finalEmpty;
  }
  cleanupControl = revalidatedCommand.terminalControl;
  await input.ports.sendKeys(revalidatedCommand.terminalControl, ["C-m"]);
  let opened = await waitForObservation(
    input,
    revalidatedCommand.terminalControl,
    ["codex_entry_model_picker", "codex_model_picker", "claude_model_picker"]
  );
  if (opened.observation.state === "codex_entry_model_picker") {
    const entry = opened.observation;
    if (
      entry.kind !== "quick_auto" ||
      entry.allModelsNativeIndex === undefined ||
      entry.selectedIndex !== entry.currentNativeIndex ||
      entry.selectedIndex !== entry.allModelsNativeIndex
    ) {
      throw new Error(
        entry.kind === "luna_reserve"
          ? "Codex Luna Reserve model control cannot safely change persisted defaults"
          : "Codex quick-auto model control is supported only when All models is the exact current selection"
      );
    }
    opened = await transitionModelControl(
      input,
      opened.capture.terminalControl,
      entry,
      ["C-m"],
      ["codex_model_picker"]
    );
  }
  if ((opened.observation.state !== "codex_model_picker" &&
       opened.observation.state !== "claude_model_picker") ||
      opened.observation.selectedIndex !==
        opened.observation.currentNativeIndex) {
    throw new Error(
      "the native model picker did not open on the exact current selection"
    );
  }
  // This is the exact idle frame revalidated after current-snapshot authority
  // and immediately before `/model` input. Earlier idle captures cannot prove
  // the catalog tuple, Plan mode, or a persistence-message baseline.
  return { ...opened, idleCapture };
  } catch (error) {
    const { cleanupError } = await settleTerminalModelControlFailure(
      input,
      cleanupControl
    );
    if (!cleanupError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${detail}; exact native model-control cleanup failed: ${cleanupError}`
    );
  }
}

async function tryUnwindModelControl(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown): Promise<string | undefined> {
  try {
    await unwindModelControl(input, terminalControl);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function unwindModelControl(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown): Promise<TerminalModelControlCapture> {
  let control = terminalControl;
  for (let count = 0; count < 7; count += 1) {
    const captured = await input.ports.capture({
      terminalControl: control,
      expectedComposer: input.plan.command
    });
    control = captured.terminalControl;
    const surface = classifyTerminalModelControlSurface(input.plan, captured);
    if (surface.state === "blocked") {
      throw new Error("the terminal became busy or blocked during cleanup");
    }
    if (surface.state === "idle_empty") {
      return captured;
    }
    if (surface.state === "command_popup" ||
        surface.state === "bare_command" ||
        surface.state === "command_draft") {
      await input.ports.beforeInput();
      const finalCommand = await input.ports.capture({
        terminalControl: control,
        expectedComposer: input.plan.command
      });
      const finalCommandSurface = classifyTerminalModelControlSurface(
        input.plan,
        finalCommand
      );
      if (finalCommandSurface.state !== "command_popup" &&
          finalCommandSurface.state !== "bare_command" &&
          finalCommandSurface.state !== "command_draft") {
        throw new Error("the exact /model composer changed during cleanup");
      }
      control = finalCommand.terminalControl;
      if (
        finalCommandSurface.state !== "bare_command" ||
        isTerminalModelControlPlanForAgent(input.plan, "claude")
      ) {
        await input.ports.sendKeys(control, ["Escape"]);
        const afterEscape = await waitForModelCommandCleanupState(
          input, control
        );
        control = afterEscape.terminalControl;
        if (classifyTerminalModelControlSurface(
          input.plan,
          afterEscape
        ).state === "idle_empty") return afterEscape;
      }
      await input.ports.beforeInput();
      const finalBareCommand = await input.ports.capture({
        terminalControl: control,
        expectedComposer: input.plan.command
      });
      if (classifyTerminalModelControlSurface(
        input.plan,
        finalBareCommand
      ).state !== "bare_command") {
        throw new Error(
          `the exact bare ${input.plan.behaviorProfile.startsWith("codex-")
            ? "Codex"
            : "Claude"} /model composer changed during cleanup`
        );
      }
      control = finalBareCommand.terminalControl;
      await input.ports.sendKeys(control, ["C-u"]);
      const cleared = await waitForObservation(input, control, ["none"], {
        allowImmediateNone: true
      });
      control = cleared.capture.terminalControl;
      continue;
    }
    if (surface.state !== "picker") {
      throw new Error(
        "no exact current model-control frame was available for Escape"
      );
    }
    const observation = surface.observation;
    control = await exactDispatchKeys(
      input, control, observation, ["Escape"]
    );
    const next = await waitForObservation(
      input,
      control,
      [
        "none",
        "codex_entry_model_picker",
        "codex_model_picker",
        "codex_reasoning_picker",
        "codex_advanced_reasoning_picker",
        "claude_model_picker"
      ],
      {
        allowImmediateNone: true,
        allowExactCommandComposer: true,
        excludeFingerprint: observation.fingerprint
      }
    );
    control = next.capture.terminalControl;
  }
  throw new Error("the native model-control surface exceeded its cleanup depth");
}

async function waitForModelCommandCleanupState(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown): Promise<TerminalModelControlCapture> {
  const startedAt = Date.now();
  let stableState: string | undefined;
  let stableCaptures = 0;
  while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
    const captured = await input.ports.capture({
      terminalControl,
      expectedComposer: input.plan.command
    });
    const surface = classifyTerminalModelControlSurface(input.plan, captured);
    if (surface.state === "idle_empty" || surface.state === "bare_command") {
      const semanticState = surface.state === "idle_empty"
        ? "empty"
        : surface.fingerprint
          ? `bare:${surface.fingerprint}`
          : isTerminalModelControlPlanForAgent(input.plan, "claude")
            ? "bare:claude-profiled-composer"
            : undefined;
      if (!semanticState) {
        stableState = undefined;
        stableCaptures = 0;
        await input.ports.sleep(MODEL_CONTROL_POLL_MS);
        continue;
      }
      if (semanticState === stableState) stableCaptures += 1;
      else {
        stableState = semanticState;
        stableCaptures = 1;
      }
      if (stableCaptures >= 2) return captured;
    } else {
      stableState = undefined;
      stableCaptures = 0;
    }
    await input.ports.sleep(MODEL_CONTROL_POLL_MS);
  }
  throw new Error(
    "/model suggestions did not close to an exact bare or empty composer"
  );
}

async function exactDismiss(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown, observation: TerminalModelControlObservation):
Promise<TerminalModelControlCapture> {
  const control = await exactDispatchKeys(
    input,
    terminalControl,
    observation,
    ["Escape"]
  );
  const closed = await waitForObservation(input, control, ["none"], {
    allowImmediateNone: true,
    allowExactCommandComposer: true,
    excludeFingerprint: observation.fingerprint
  });
  const closedSurface = classifyTerminalModelControlSurface(
    input.plan,
    closed.capture
  );
  if (closedSurface.state === "idle_empty") {
    return closed.capture;
  }
  if (closedSurface.state === "command_popup" ||
      closedSurface.state === "bare_command" ||
      closedSurface.state === "command_draft") {
    return unwindModelControl(input, closed.capture.terminalControl);
  }
  throw new Error("native model-control dismissal did not return to exact idle");
}

async function waitForCodexPersistencePostcondition(input: {
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
baselineScreen: string,
request: TerminalModelSwitchRequest,
initialScreen?: string): Promise<
  { proven: true } | { proven: false; final: boolean; reason: string }
> {
  const startedAt = Date.now();
  let screen = initialScreen;
  while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
    if (screen !== undefined) {
      const evidence = codexPersistencePostcondition(
        baselineScreen, screen, request
      );
      if (evidence.proven || evidence.final) return evidence;
    }
    const captured = await input.ports.capture({ terminalControl });
    if (modelControlCaptureBlocked(captured) ||
        captured.activityState !== "idle" ||
        !captured.exactEmptyComposer) {
      return {
        proven: false,
        final: true,
        reason:
          "Codex left the exact idle frame while persistence evidence was pending"
      };
    }
    terminalControl = captured.terminalControl;
    screen = captured.screen;
    await input.ports.sleep(MODEL_CONTROL_POLL_MS);
  }
  return {
    proven: false,
    final: true,
    reason: "Codex model-default persistence evidence did not materialize in time"
  };
}
