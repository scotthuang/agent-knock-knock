import type {
  TerminalRuntimeCliAdapter
} from "./terminal-runtime-cli-adapter.js";
import type {
  NativeLifecycleCliOptions,
  NativeLifecycleSnapshot,
  NativeThreadOwnershipRequest,
  CreateNativeThreadLifecycleCliAdapterInput
} from "./native-thread-lifecycle-cli-contract.js";

import type {
  TerminalNativeControlCliBoundary
} from "./terminal-native-control-cli-contract.js";

import type {
  ExecutorKind
} from "./executors.js";

import {
  isExactNativeThreadId
} from "./managed-session.js";

import {
  turnIdForConversation
} from "./protocol.js";

import type {
  TerminalAgentAdapter,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  type ResolvedTerminalConversation,
  type TerminalAgentBridge,
  type TerminalBridgeStatus,
  type TerminalModelControlBridgeOptions
} from "./terminal-agent-bridge.js";

import {
  decideModelControlAvailability,
  type ModelControlAvailabilityDecision,
  type ModelControlSafetyFacts
} from "./terminal-model-control-availability.js";

import {
  isCodexModelControlAgentVersion,
  isTerminalModelControlPlanForAgent,
  isTerminalModelReasoningEffort,
  terminalModelControlPlanConforms,
  terminalModelControlProfileForPlan,
  terminalUserExplicitModelControlBindingToken,
  type TerminalModelCatalog,
  type TerminalModelControlPlan,
  type TerminalModelControlResidualObservation,
  type TerminalModelSwitchRequest
} from "./terminal-model-control.js";
import {
  nonBlankString
} from "./value-guards.js";

/** Model operations consume the shared physical/identity boundary without owning Status. */
export interface TerminalModelControlCliPorts {
  runtime: CreateNativeThreadLifecycleCliAdapterInput["runtime"];
  identity: Pick<CreateNativeThreadLifecycleCliAdapterInput["identity"], "physicalProcessIncarnation">;
  state: Pick<CreateNativeThreadLifecycleCliAdapterInput["state"],
    "storeDir" | "inspectStore" | "acquireTerminal" | "terminalBlockingTurns" |
    "hasUnresolvedTransition" | "dispatchOwnership" | "orphanedForRecovery">;
  output: CreateNativeThreadLifecycleCliAdapterInput["output"];
  lifecycle: TerminalNativeControlCliBoundary & {
    currentSnapshot(options: NativeLifecycleCliOptions, terminal: ResolvedTerminalConversation): Promise<NativeLifecycleSnapshot>;
    agentAdapter(options: NativeLifecycleCliOptions, agent: ExecutorKind): TerminalAgentAdapter;
    assertExclusive(input: NativeThreadOwnershipRequest): Promise<void>;
    inspectionRuntime(terminal: ResolvedTerminalConversation, snapshot: NativeLifecycleSnapshot): TerminalRuntimeIdentity;
    assertInspectionAgentIdentity(input: {
      options: NativeLifecycleCliOptions;
      terminal: ResolvedTerminalConversation;
      snapshot: NativeLifecycleSnapshot;
      stage: string;
      expectedClaudeState?: "idle" | "status_dialog";
    }): void;
    observeInitialInspectionReady(options: NativeLifecycleCliOptions,
      terminal: ResolvedTerminalConversation, snapshot: NativeLifecycleSnapshot,
      bridge: TerminalAgentBridge): Promise<{
        runtime: TerminalRuntimeIdentity; status: TerminalBridgeStatus;
      }>;
  };
}

export function createTerminalModelControlCliAdapter(ports: TerminalModelControlCliPorts) {
  const app = new TerminalModelControlCliApplication(ports);
  return Object.freeze({
    runModelOptions: (options: NativeLifecycleCliOptions) => app.runModelOptions(options),
    runSetModel: (options: NativeLifecycleCliOptions) => app.runSetModel(options),
    runRepairModelControl: (options: NativeLifecycleCliOptions) => app.runRepairModelControl(options)
  });
}

/** Ordinary selection, residual continuation, and repair retain separate authority paths. */
class TerminalModelControlCliApplication {
  constructor(readonly ports: TerminalModelControlCliPorts) {}
  /**
   * Model control on Codex is an explicit physical-pane operation. A freshly
   * started TUI may legitimately have no rollout-backed Session yet. Keep the
   * physical token separate from native lifecycle binding while retaining the
   * resolver's fail-closed behavior for genuinely ambiguous live rollouts.
   */
  async modelControlSnapshot(
    options: NativeLifecycleCliOptions,
    terminal: ResolvedTerminalConversation
  ): Promise<NativeLifecycleSnapshot> {
    if (terminal.agent !== "codex") {
      return this.ports.lifecycle.currentSnapshot(options, terminal);
    }
    const snapshot = await this.ports.lifecycle.currentSnapshot(options, terminal);
    const nativeThreadId = snapshot.identity?.sessionId ??
      snapshot.session?.binding?.native_thread_id;
    if (isExactNativeThreadId(nativeThreadId) ||
        snapshot.identity || snapshot.session) {
      return snapshot;
    }
    const adapter = this.ports.lifecycle.agentAdapter(options, terminal.agent);
    const { capability, plan, profile } = modelControlProfileObservation(
      adapter, snapshot.version
    );
    if (!plan || profile?.agent !== "codex" ||
        !profile.supportsZeroRolloutPhysicalAuthority) {
      throw new Error(
        capability?.reason ?? "Codex has no verified physical model-control profile"
      );
    }
    const bindingToken = this.physicalModelControlBindingToken(
      terminal,
      snapshot.version,
      plan.behaviorProfile
    );
    return Object.freeze({
      ...snapshot,
      bindingToken,
      bindingTokens: Object.freeze([bindingToken])
    });
  }

  physicalModelControlBindingToken(
    terminal: ResolvedTerminalConversation,
    agentVersion: string | undefined,
    behaviorProfile: TerminalModelControlPlan["behaviorProfile"]
  ): string {
    const version = required(
      nonBlankString(agentVersion),
      "Codex physical model control requires an exact running version"
    );
    const incarnation = this.ports.identity.physicalProcessIncarnation(
      terminal.pid
    );
    return terminalUserExplicitModelControlBindingToken({
      terminalId: terminal.conversationId,
      terminalControl: terminal.terminalControl,
      pid: terminal.pid,
      workspace: terminal.terminalControl.currentPath ?? this.ports.output.cwd(),
      processUuid: incarnation.processUuid,
      processBirth: incarnation.processBirth,
      agentVersion: version,
      behaviorProfile
    });
  }

  validateModelOptions(options: NativeLifecycleCliOptions): string {
    if (options.command !== undefined || options.message !== undefined ||
        options.model !== undefined || options.reasoningEffort !== undefined ||
        options.expectedCatalogFingerprint !== undefined) {
      throw new Error(
        "model-options accepts only an exact terminal and current binding authority"
      );
    }
    return required(
      nonBlankString(options.expectedBindingToken),
      "--expected-binding-token is required"
    );
  }

  validateSetModel(options: NativeLifecycleCliOptions): {
    expectedBindingToken: string;
    expectedCatalogFingerprint: string;
    request: TerminalModelSwitchRequest;
  } {
    if (options.command !== undefined || options.message !== undefined ||
        options.scope !== undefined || options.keys !== undefined ||
        options.index !== undefined) {
      throw new Error(
        "set-model accepts no command, key, menu index, or caller-selected scope"
      );
    }
    const expectedBindingToken = required(
      nonBlankString(options.expectedBindingToken),
      "--expected-binding-token is required"
    );
    const expectedCatalogFingerprint = required(
      nonBlankString(options.expectedCatalogFingerprint),
      "--expected-catalog-fingerprint is required"
    );
    if (!/^[0-9a-f]{64}$/u.test(expectedCatalogFingerprint)) {
      throw new Error(
        "--expected-catalog-fingerprint must be the exact sha256 from model-options"
      );
    }
    const model = required(
      nonBlankString(options.model), "--model is required"
    );
    const reasoningEffort = options.reasoningEffort;
    if (!isTerminalModelReasoningEffort(reasoningEffort)) {
      throw new Error(
        "--reasoning-effort must be one exact semantic value advertised by model-options"
      );
    }
    return {
      expectedBindingToken,
      expectedCatalogFingerprint,
      request: { model, reasoningEffort }
    };
  }

  validateRepairModelControl(options: NativeLifecycleCliOptions): string {
    if (
      options.command !== undefined ||
      options.message !== undefined ||
      options.model !== undefined ||
      options.reasoningEffort !== undefined ||
      options.expectedCatalogFingerprint !== undefined ||
      options.scope !== undefined ||
      options.keys !== undefined ||
      options.index !== undefined
    ) {
      throw new Error(
        "repair-model-control accepts only an exact terminal and current private repair authority"
      );
    }
    return required(
      nonBlankString(options.expectedBindingToken),
      "--expected-binding-token is required"
    );
  }

  async runModelOptions(options: NativeLifecycleCliOptions): Promise<void> {
    const expectedBindingToken = this.validateModelOptions(options);
    const context = await this.withPreparedModelControl(
      options,
      expectedBindingToken,
      async (prepared) => {
        const result = await prepared.bridge.modelOptions(
          prepared.terminal.agent,
          prepared.terminal.terminalControl,
          prepared.agentVersion,
          prepared.plan,
          {
            runtime: prepared.runtime,
            beforeInput: () => prepared.initialResidual
              ? this.assertFreshModelControlResidualBoundary(prepared)
              : this.assertFreshModelControlBoundary(prepared),
            loadCodexCatalog: prepared.loadCodexCatalog,
            initialResidual: prepared.initialResidual
          }
        );
        if (prepared.initialResidual) {
          await this.assertFreshModelControlBoundary({
            ...prepared,
            expectedBindingToken: prepared.ordinaryBindingToken,
            initialResidual: undefined
          });
        }
        return { prepared, catalog: result.catalog };
      },
      { allowResidualEntry: true }
    );
    this.ports.output.print(this.modelOptionsResult(
      context.prepared,
      context.catalog
    ));
  }

  async runSetModel(options: NativeLifecycleCliOptions): Promise<void> {
    const validated = this.validateSetModel(options);
    const output = await this.withPreparedModelControl(
      options,
      validated.expectedBindingToken,
      async (prepared) => {
        const result = await prepared.bridge.setModel(
          prepared.terminal.agent,
          prepared.terminal.terminalControl,
          prepared.agentVersion,
          prepared.plan,
          validated.expectedCatalogFingerprint,
          validated.request,
          {
            runtime: prepared.runtime,
            beforeInput: () => this.assertFreshModelControlBoundary(prepared),
            loadCodexCatalog: prepared.loadCodexCatalog
          }
        );
        return { prepared, result };
      }
    );
    const { result, prepared } = output;
    this.ports.output.print({
      terminal_id: prepared.terminal.conversationId,
      agent: prepared.terminal.agent,
      agent_version: prepared.agentVersion,
      behavior_profile: prepared.plan.behaviorProfile,
      outcome: result.outcome,
      requested: modelValueOutput(result.requested),
      ...(result.effective
        ? { effective: modelValueOutput(result.effective) }
        : {}),
      ...(result.newSessionDefaults
        ? { new_session_defaults: modelValueOutput(result.newSessionDefaults) }
        : {}),
      scope: result.scope,
      defaults_changed: result.defaultsChanged,
      do_not_retry: result.doNotRetry,
      ...(result.reason ? { reason: result.reason } : {})
    });
  }

  async runRepairModelControl(
    options: NativeLifecycleCliOptions
  ): Promise<void> {
    const expectedBindingToken = this.validateRepairModelControl(options);
    const output = await this.withPreparedModelControlRepair(
      options,
      expectedBindingToken,
      async (prepared) => {
        const result = await prepared.bridge.repairModelControlResidual(
          prepared.terminal.agent,
          prepared.terminal.terminalControl,
          prepared.agentVersion,
          prepared.plan,
          prepared.residual.fingerprint,
          {
            runtime: prepared.runtime,
            beforeInput: () =>
              this.assertFreshModelControlResidualBoundary(prepared)
          }
        );
        return { prepared, result };
      }
    );
    this.ports.output.print({
      terminal_id: output.prepared.terminal.conversationId,
      agent: output.prepared.terminal.agent,
      agent_version: output.prepared.agentVersion,
      behavior_profile: output.prepared.plan.behaviorProfile,
      outcome: output.result.outcome,
      terminal_input_attempted: output.result.terminalInputAttempted,
      composer_postcondition: output.result.composerPostcondition,
      do_not_retry: output.result.doNotRetry,
      ...(output.result.reason ? { reason: output.result.reason } : {}),
      ...(output.result.outcome === "repaired"
        ? { next: "refresh_list_then_model_options" }
        : {})
    });
  }

  async withPreparedModelControlRepair<T>(
    options: NativeLifecycleCliOptions,
    expectedBindingToken: string,
    operation: (context: TerminalModelControlRepairContext) => Promise<T>
  ): Promise<T> {
    const storeDir = this.ports.state.storeDir(options);
    if (this.ports.state.inspectStore(storeDir).writable !== true) {
      throw new Error(
        "model-control repair requires a compatible AKK Store for current-snapshot authority"
      );
    }
    const initiallyResolved = await this.ports.lifecycle.resolveLifecycleTerminal(options);
    const release = this.ports.state.acquireTerminal(
      storeDir,
      initiallyResolved.terminalControl,
      { timeoutMs: 30_000 }
    );
    try {
      const runtimeFacade = this.ports.runtime.forOptions(options);
      const bridge = runtimeFacade.createBridge();
      const terminal = await bridge.resolveStoredTerminal(
        initiallyResolved.agent,
        initiallyResolved.pid,
        initiallyResolved.terminalControl,
        { pid: initiallyResolved.pid }
      );
      this.ports.lifecycle.assertSameInspectionTerminal(
        initiallyResolved,
        terminal,
        "while waiting for model-control repair ownership"
      );
      if (terminal.agent !== "codex") {
        throw new Error(
          "model-control residual repair currently supports only verified Codex profiles"
        );
      }
      const snapshot = await this.modelControlSnapshot(options, terminal);
      const agentVersion = required(
        nonBlankString(snapshot.version),
        "model-control repair requires an exact running agent version"
      );
      const adapter = runtimeFacade.createAgentRegistry().require(terminal.agent);
      const { capability, plan, profile } = modelControlProfileObservation(
        adapter, agentVersion
      );
      if (!plan || profile?.agent !== "codex" ||
          !profile.supportsResidualRepair) {
        throw new Error(
          capability?.reason ??
          "the running Codex version has no verified model-control repair profile"
        );
      }
      await this.assertModelControlExclusive({ options, terminal, snapshot });
      const runtime = this.ports.lifecycle.inspectionRuntime(terminal, snapshot);
      const status = await this.assertModelControlRepairReady({
        options,
        terminal,
        snapshot,
        bridge,
        runtime
      });
      const residual = await bridge.inspectModelControlResidual(
        terminal.agent,
        terminal.terminalControl,
        agentVersion,
        plan,
        { runtime, beforeInput: () => undefined }
      );
      if (residual.state !== "recoverable") {
        throw new Error(residual.reason);
      }
      const availability = this.modelControlAvailability({
        options,
        terminal,
        snapshot,
        agentVersion,
        plan,
        status,
        surface: {
          kind: "residual",
          residualKind: residual.kind,
          residualFingerprint: residual.fingerprint,
          activityState: status.activity_state
        }
      });
      const repairBindingToken =
        availability.availability === "residual_continuation"
          ? availability.repairBindingToken
          : availability.availability === "repair_only"
            ? availability.expectedBindingToken
            : undefined;
      if (repairBindingToken !== expectedBindingToken) {
        throw new Error(
          "the exact model-control residual changed after it was listed; refresh AKK list"
        );
      }
      return await operation({
        options,
        terminal,
        snapshot,
        bridge,
        runtime,
        adapter,
        agentVersion,
        plan,
        expectedBindingToken,
        residual
      });
    } finally {
      release();
    }
  }

  async assertFreshModelControlResidualBoundary(
    context: TerminalModelControlResidualBoundaryContext
  ): Promise<void> {
    const terminal = await this.resolveModelControlBoundaryTerminal(context);
    this.ports.lifecycle.assertSameInspectionTerminal(
      context.terminal,
      terminal,
      "immediately before model-control repair input"
    );
    const snapshot = await this.modelControlSnapshot(context.options, terminal);
    if (snapshot.version !== context.agentVersion) {
      throw new Error(
        "terminal binding or coding-agent version changed during model-control repair"
      );
    }
    const expectedNativeThreadId = context.snapshot.identity?.sessionId ??
      context.snapshot.session?.binding?.native_thread_id;
    const actualNativeThreadId = snapshot.identity?.sessionId ??
      snapshot.session?.binding?.native_thread_id;
    if (expectedNativeThreadId !== actualNativeThreadId) {
      throw new Error(
        "the current native Session changed during model-control repair"
      );
    }
    const { plan } = modelControlProfileObservation(
      context.adapter, snapshot.version
    );
    if (!plan || JSON.stringify(plan) !== JSON.stringify(context.plan)) {
      throw new Error(
        "the exact model-control repair profile changed during the operation"
      );
    }
    await this.assertModelControlExclusive({
      options: context.options,
      terminal,
      snapshot
    });
    await this.assertModelControlRepairReady({
      options: context.options,
      terminal,
      snapshot,
      bridge: context.bridge,
      runtime: context.runtime
    });
  }

  async assertModelControlRepairReady(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
    bridge: TerminalAgentBridge;
    runtime: TerminalRuntimeIdentity;
  }): Promise<TerminalBridgeStatus> {
    const status = await input.bridge.status(
      input.terminal.agent,
      input.terminal.terminalControl,
      { runtime: input.runtime }
    );
    if (
      status.reachable !== true ||
      status.approval_state.scanned !== true ||
      status.approval_state.blocked === true ||
      status.interaction_state !== undefined
    ) {
      throw new Error(
        "model-control repair requires a reachable prompt with no approval or questionnaire"
      );
    }
    const storeDir = this.ports.state.storeDir(input.options);
    const blocker = this.ports.state.terminalBlockingTurns(
      storeDir,
      input.terminal.terminalControl
    )[0];
    if (blocker) {
      throw new Error(
        `terminal ${input.terminal.terminalControl.target} still has unresolved Turn ` +
        `${turnIdForConversation(blocker)} (${blocker.status})`
      );
    }
    if (
      input.snapshot.session &&
      this.ports.state.hasUnresolvedTransition(storeDir, input.snapshot.session)
    ) {
      throw new Error(
        `managed Session ${input.snapshot.session.session_id} has an unresolved native-thread transition`
      );
    }
    if (
      this.ports.state.dispatchOwnership(input.terminal.terminalControl).state !==
      "none"
    ) {
      throw new Error(
        "the terminal has unresolved dispatch ownership during model-control repair"
      );
    }
    if (this.ports.state.orphanedForRecovery(input.terminal.terminalControl)) {
      throw new Error(
        "the terminal has unresolved input ownership during model-control repair"
      );
    }
    return status;
  }

  modelControlAvailability(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
    agentVersion: string;
    plan: TerminalModelControlPlan;
    status: TerminalBridgeStatus;
    surface: ModelControlSafetyFacts["surface"];
  }): ModelControlAvailabilityDecision {
    const nativeThreadId = input.snapshot.identity?.sessionId ??
      input.snapshot.session?.binding?.native_thread_id;
    const zeroRolloutVerified = input.terminal.agent === "codex" &&
      !input.snapshot.identity && !input.snapshot.session;
    const incarnation = this.ports.identity.physicalProcessIncarnation(
      input.terminal.pid
    );
    const storeDir = this.ports.state.storeDir(input.options);
    return decideModelControlAvailability({
      exactTerminalRow: true,
      terminalId: input.terminal.conversationId,
      processState: "active",
      terminalControl: input.terminal.terminalControl,
      agent: input.terminal.agent,
      pid: input.terminal.pid,
      processUuid: incarnation.processUuid,
      processBirth: incarnation.processBirth,
      agentVersion: input.agentVersion,
      behaviorProfile: input.plan.behaviorProfile,
      nativeAuthority: isExactNativeThreadId(nativeThreadId)
        ? {
            kind: "exact_session",
            ordinaryBindingToken: input.snapshot.bindingToken
          }
        : zeroRolloutVerified
          ? { kind: "verified_zero_rollout" }
          : { kind: "unavailable" },
      modelControlSupported: true,
      approvalScanned: input.status.approval_state.scanned === true,
      approvalBlocked: input.status.approval_state.blocked === true,
      terminalHasInteraction: input.status.interaction_state !== undefined,
      terminalHasBlockingTurn: this.ports.state.terminalBlockingTurns(
        storeDir, input.terminal.terminalControl
      ).length > 0,
      hasOrphanedDispatch:
        this.ports.state.dispatchOwnership(input.terminal.terminalControl)
          .state !== "none" ||
        this.ports.state.orphanedForRecovery(
          input.terminal.terminalControl
        ) !== undefined,
      surface: input.surface
    });
  }

  async prepareModelControlBinding(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    expectedBindingToken: string;
    allowResidualEntry?: boolean;
    runtimeFacade: TerminalRuntimeCliAdapter;
  }) {
    const { options, terminal, expectedBindingToken, runtimeFacade } = input;
    const behavior = input;
  const snapshot = await this.modelControlSnapshot(options, terminal);
  const ordinaryBindingToken = required(
    nonBlankString(snapshot.bindingToken),
    "terminal model control requires current ordinary binding authority"
  );
  const hasOrdinaryAuthority =
    snapshot.bindingTokens.includes(expectedBindingToken);
  if (!hasOrdinaryAuthority && !behavior.allowResidualEntry) {
    throw new Error(
      "terminal binding changed after it was listed; refresh AKK list and retry"
    );
  }
  const agentVersion = required(
    nonBlankString(snapshot.version),
    "model control requires an exact running agent version"
  );
  const adapter = runtimeFacade.createAgentRegistry().require(terminal.agent);
  const { capability, plan, profile } = modelControlProfileObservation(
    adapter, agentVersion
  );
  if (capability?.status !== "supported" ||
      capability.modelSelection !== true ||
      capability.reasoningEffortSelection !== true) {
    throw new Error(
      capability?.reason ??
      `${adapter.displayName} has no verified model-control profile`
    );
  }
  if (!plan || !profile) {
    throw new Error("the agent adapter did not produce a model-control plan");
  }
  await this.assertModelControlExclusive({ options, terminal, snapshot });
  return { snapshot, ordinaryBindingToken, hasOrdinaryAuthority, agentVersion, adapter, plan, profile };
  }

  async observeOrdinaryModelControlEntry(input: ModelControlEntryContext & {
    ordinaryBindingToken: string;
  }): Promise<TerminalRuntimeIdentity> {
    const { options, terminal, snapshot, bridge, agentVersion, plan,
      ordinaryBindingToken } = input;
    const ready = await this.ports.lifecycle.observeInitialInspectionReady(
      options, terminal, snapshot, bridge
    );

    if (ready.status.approval_state.scanned !== true ||
        ready.status.approval_state.blocked === true ||
        ready.status.interaction_state !== undefined) {
      throw new Error(
        "model control requires a freshly scanned terminal with no approval or questionnaire"
      );
    }
    const availability = this.modelControlAvailability({
      options,
      terminal,
      snapshot,
      agentVersion,
      plan,
      status: ready.status,
      surface: {
        kind: "idle_empty",
        screenState: ready.status.screen_state
      }
    });
    if (availability.availability !== "open_from_empty" ||
        availability.expectedBindingToken !== ordinaryBindingToken) {
      throw new Error(
        "model control requires an exact verified idle pane with an empty composer and no blocking interaction"
      );
    }
    return ready.runtime;
  }

  async observeResidualModelControlEntry(input: ModelControlEntryContext & {
    expectedBindingToken: string;
  }): Promise<{
    runtime: TerminalRuntimeIdentity;
    initialResidual: Extract<TerminalModelControlResidualObservation, { state: "recoverable" }>;
  }> {
    const { options, terminal, snapshot, bridge, agentVersion, plan,
      expectedBindingToken } = input;
    if (
      terminal.agent !== "codex" ||
      terminalModelControlProfileForPlan(plan)
        ?.supportsResidualContinuation !== true
    ) {
      throw new Error(
        "terminal binding changed after it was listed; refresh AKK list and retry"
      );
    }
    const runtime = this.ports.lifecycle.inspectionRuntime(terminal, snapshot);
    const status = await this.assertModelControlRepairReady({
      options,
      terminal,
      snapshot,
      bridge,
      runtime
    });
    const observed = await bridge.inspectModelControlResidual(
      terminal.agent,
      terminal.terminalControl,
      agentVersion,
      plan,
      { runtime, beforeInput: () => undefined }
    );
    if (observed.state !== "recoverable") {
      throw new Error(observed.reason);
    }
    const availability = this.modelControlAvailability({
      options,
      terminal,
      snapshot,
      agentVersion,
      plan,
      status,
      surface: {
        kind: "residual",
        residualKind: observed.kind,
        residualFingerprint: observed.fingerprint,
        activityState: status.activity_state
      }
    });
    if (availability.availability !== "residual_continuation" ||
        availability.expectedBindingToken !== expectedBindingToken) {
      throw new Error(
        "the exact model-control residual changed after it was listed; refresh AKK list"
      );
    }
    return { runtime, initialResidual: observed };
  }

  async withPreparedModelControl<T>(
    options: NativeLifecycleCliOptions,
    expectedBindingToken: string,
    operation: (context: TerminalModelControlContext) => Promise<T>,
    behavior: { readonly allowResidualEntry?: boolean } = {}
  ): Promise<T> {
    const storeDir = this.ports.state.storeDir(options);
    if (this.ports.state.inspectStore(storeDir).writable !== true) {
      throw new Error(
        "terminal model control requires a compatible AKK Store for current-snapshot authority"
      );
    }
    const initiallyResolved = await this.ports.lifecycle.resolveLifecycleTerminal(options);
    const release = this.ports.state.acquireTerminal(
      storeDir, initiallyResolved.terminalControl, { timeoutMs: 30_000 }
    );
    try {
      const runtimeFacade = this.ports.runtime.forOptions(options);
      const bridge = runtimeFacade.createBridge();
      const terminal = await bridge.resolveStoredTerminal(
        initiallyResolved.agent,
        initiallyResolved.pid,
        initiallyResolved.terminalControl,
        { pid: initiallyResolved.pid }
      );
      this.ports.lifecycle.assertSameInspectionTerminal(
        initiallyResolved,
        terminal,
        "while waiting for model-control ownership"
      );
      const { snapshot, ordinaryBindingToken, hasOrdinaryAuthority,
        agentVersion, adapter, plan, profile } = await this.prepareModelControlBinding({
          options, terminal, expectedBindingToken, runtimeFacade,
          allowResidualEntry: behavior.allowResidualEntry
        });
      const entry = { options, terminal, snapshot, bridge, agentVersion, plan };
      const { runtime, initialResidual } = hasOrdinaryAuthority
        ? { runtime: await this.observeOrdinaryModelControlEntry({
            ...entry, ordinaryBindingToken
          }), initialResidual: undefined }
        : await this.observeResidualModelControlEntry({ ...entry, expectedBindingToken });
      const codexCatalogVersion = profile.agent === "codex" &&
          isCodexModelControlAgentVersion(profile.agentVersion)
        ? profile.agentVersion
        : undefined;
      return await operation({
        options,
        terminal,
        snapshot,
        bridge,
        runtime,
        adapter,
        agentVersion,
        plan,
        expectedBindingToken,
        ordinaryBindingToken,
        initialResidual,
        ...(terminal.agent === "codex" &&
            isTerminalModelControlPlanForAgent(plan, "codex") &&
            codexCatalogVersion !== undefined
          ? {
              loadCodexCatalog: async () =>
                runtimeFacade.codexModelCatalogForRunningProcess(
                  terminal.pid,
                  codexCatalogVersion,
                  terminal.terminalControl.currentPath
                )
            }
          : {})
      });
    } finally {
      release();
    }
  }

  async assertFreshModelControlBoundary(
    context: TerminalModelControlContext
  ): Promise<void> {
    const terminal = await this.resolveModelControlBoundaryTerminal(context);
    this.ports.lifecycle.assertSameInspectionTerminal(
      context.terminal,
      terminal,
      "immediately before model-control input"
    );
    const snapshot = await this.modelControlSnapshot(context.options, terminal);
    if (!snapshot.bindingTokens.includes(context.expectedBindingToken) ||
        snapshot.version !== context.agentVersion) {
      throw new Error(
        "terminal binding or coding-agent version changed during model control; refresh AKK list"
      );
    }
    const expectedNativeThreadId = context.snapshot.identity?.sessionId ??
      context.snapshot.session?.binding?.native_thread_id;
    const actualNativeThreadId = snapshot.identity?.sessionId ??
      snapshot.session?.binding?.native_thread_id;
    if (expectedNativeThreadId !== actualNativeThreadId) {
      throw new Error(
        "the current native Session changed during model control; inspect the pane before retrying"
      );
    }
    const { plan } = modelControlProfileObservation(
      context.adapter, snapshot.version
    );
    if (!plan || JSON.stringify(plan) !== JSON.stringify(context.plan)) {
      throw new Error(
        "the exact model-control profile changed during the operation"
      );
    }
    await this.assertModelControlExclusive({
      options: context.options,
      terminal,
      snapshot
    });
    this.ports.lifecycle.assertInspectionReady({
      options: context.options,
      terminal,
      session: snapshot.session
    });
    this.assertModelControlAgentIdentity({
      options: context.options,
      terminal,
      snapshot
    });
  }

  async resolveModelControlBoundaryTerminal(
    context: TerminalModelControlResidualBoundaryContext
  ): Promise<ResolvedTerminalConversation> {
    try {
      return await context.bridge.resolveStoredTerminal(
        context.terminal.agent,
        context.terminal.pid,
        context.terminal.terminalControl,
        context.runtime
      );
    } catch (idleError) {
      if (
        context.terminal.agent !== "claude" ||
        !terminalModelControlPlanConforms({
          agent: context.terminal.agent,
          agentVersion: context.agentVersion,
          plan: context.plan
        }) ||
        context.runtime.requireExactClaudeAgentRow !== true ||
        context.runtime.exactClaudeAgentState !== "idle"
      ) {
        throw idleError;
      }
      try {
        return await context.bridge.resolveStoredTerminal(
          context.terminal.agent,
          context.terminal.pid,
          context.terminal.terminalControl,
          { ...context.runtime, exactClaudeAgentState: "status_dialog" }
        );
      } catch {
        // All immutable process, native Session, cwd, and terminal fences are
        // identical in both attempts. Only the exact Claude agents UI state
        // differs, and the bridge must still prove a fresh profiled model
        // surface after this read-only boundary before any key is dispatched.
        throw idleError;
      }
    }
  }

  assertModelControlAgentIdentity(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
  }): void {
    if (input.terminal.agent !== "claude") return;
    try {
      this.ports.lifecycle.assertInspectionAgentIdentity({
        ...input,
        stage: "during model control",
        expectedClaudeState: "idle"
      });
    } catch (idleError) {
      try {
        this.ports.lifecycle.assertInspectionAgentIdentity({
          ...input,
          stage: "during model control",
          expectedClaudeState: "status_dialog"
        });
      } catch {
        throw idleError;
      }
    }
  }

  async assertModelControlExclusive(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
  }): Promise<void> {
    if (input.terminal.agent === "codex") {
      const nativeThreadId = input.snapshot.identity?.sessionId ??
        input.snapshot.session?.binding?.native_thread_id;
      if (!nativeThreadId && !input.snapshot.identity && !input.snapshot.session) {
        // A fresh, verified-empty Codex process has no durable native Session
        // to own yet. The physical pane/process/cwd fence remains exact.
        this.ports.lifecycle.assertForegroundHasNoLifecycleTransition(
          input.options,
          input.terminal
        );
        return;
      }
      if (!isExactNativeThreadId(nativeThreadId)) {
        throw new Error(
          "Codex model control requires either a fresh zero-rollout pane or one exact current native Session identity"
        );
      }
      await this.ports.lifecycle.assertExclusive({
        options: input.options,
        agent: input.terminal.agent,
        currentPid: input.terminal.pid,
        nativeThreadId,
        storeDir: this.ports.state.storeDir(input.options),
        terminalControl: input.terminal.terminalControl,
        excludedManagedSessionId: input.snapshot.session?.session_id
      });
      return;
    }
    const nativeThreadId = input.snapshot.identity?.sessionId ??
      input.snapshot.session?.binding?.native_thread_id;
    if (!isExactNativeThreadId(nativeThreadId)) {
      throw new Error(
        "model control requires one exact current native Session identity"
      );
    }
    await this.ports.lifecycle.assertExclusive({
      options: input.options,
      agent: input.terminal.agent,
      currentPid: input.terminal.pid,
      nativeThreadId,
      storeDir: this.ports.state.storeDir(input.options),
      terminalControl: input.terminal.terminalControl,
      excludedManagedSessionId: input.snapshot.session?.session_id
    });
  }

  modelOptionsResult(
    context: TerminalModelControlContext,
    catalog: TerminalModelCatalog
  ): unknown {
    return {
      terminal_id: context.terminal.conversationId,
      agent: context.terminal.agent,
      agent_version: context.agentVersion,
      behavior_profile: catalog.behaviorProfile,
      scope: catalog.scope,
      current: modelValueOutput(catalog.current),
      models: catalog.models.map((model) => ({
        id: model.id,
        label: model.label,
        reasoning_efforts: [...model.reasoningEfforts]
      })),
      catalog_fingerprint: catalog.catalogFingerprint,
      available_actions: {
        set_model: {
          tool: "agent_knock_knock_set_model",
          arguments: {
            terminal_id: context.terminal.conversationId,
            expected_binding_token: context.ordinaryBindingToken,
            expected_catalog_fingerprint: catalog.catalogFingerprint
          }
        }
      }
    };
  }
}

type ModelControlEntryContext = Pick<TerminalModelControlResidualBoundaryContext,
  "options" | "terminal" | "snapshot" | "bridge" | "agentVersion" | "plan">;

interface TerminalModelControlResidualBoundaryContext {
  options: NativeLifecycleCliOptions;
  terminal: ResolvedTerminalConversation;
  snapshot: NativeLifecycleSnapshot;
  bridge: TerminalAgentBridge;
  runtime: TerminalRuntimeIdentity;
  adapter: TerminalAgentAdapter;
  agentVersion: string;
  plan: TerminalModelControlPlan;
}

interface TerminalModelControlContext
  extends TerminalModelControlResidualBoundaryContext {
  expectedBindingToken: string;
  ordinaryBindingToken: string;
  initialResidual?: Extract<
    TerminalModelControlResidualObservation,
    { state: "recoverable" }
  >;
  loadCodexCatalog?: TerminalModelControlBridgeOptions["loadCodexCatalog"];
}

interface TerminalModelControlRepairContext
  extends TerminalModelControlResidualBoundaryContext {
  expectedBindingToken: string;
  residual: Extract<
    TerminalModelControlResidualObservation,
    { state: "recoverable" }
  >;
}

function modelValueOutput(value: {
  model: string;
  reasoningEffort?: string;
}): Record<string, string> {
  return {
    model: value.model,
    ...(value.reasoningEffort
      ? { reasoning_effort: value.reasoningEffort }
      : {})
  };
}

function modelControlProfileObservation(
  adapter: TerminalAgentAdapter,
  agentVersion: string | undefined
) {
  const capability = adapter.probeModelControl?.(agentVersion);
  const plan = capability?.status === "supported"
    ? adapter.planModelControl?.(capability)
    : undefined;
  return {
    capability,
    plan,
    profile: plan ? terminalModelControlProfileForPlan(plan) : undefined
  };
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === "") throw new Error(message);
  return value;
}
