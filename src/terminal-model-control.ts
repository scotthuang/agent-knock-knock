import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import {
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  isTerminalModelControlPlanForAgent,
  planTerminalModelControlProfile,
  probeTerminalModelControlProfile,
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
  terminalPhysicalBindingToken,
  type TerminalControlRef
} from "./terminal-control-ref.js";

export {
  CLAUDE_MODEL_CONTROL_AGENT_VERSION,
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  TERMINAL_MODEL_CONTROL_PROFILE_IDS,
  isTerminalModelControlPlanForAgent,
  terminalModelControlPlanConforms,
  terminalModelControlProfileFor,
  terminalModelControlProfileForPlan,
  terminalModelControlProfiles,
  terminalModelControlSlashCompletionRows,
  type TerminalModelControlBehaviorProfile,
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

/** Caller-visible reasoning values. Native labels and menu positions stay private. */
export const TERMINAL_MODEL_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra"
] as const;

export type TerminalModelReasoningEffort =
  typeof TERMINAL_MODEL_REASONING_EFFORTS[number];
type TerminalModelNativeEffort = TerminalModelReasoningEffort | "ultracode";

export interface TerminalModelChoice {
  readonly id: string;
  readonly label: string;
  readonly reasoningEfforts: readonly TerminalModelReasoningEffort[];
}

export interface TerminalModelValue {
  readonly model: string;
  readonly reasoningEffort?: TerminalModelReasoningEffort;
}

export interface TerminalModelCatalog {
  readonly agent: ExecutorKind;
  readonly agentVersion: string;
  readonly behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
  readonly scope: TerminalModelControlScope;
  readonly current: TerminalModelValue;
  readonly models: readonly TerminalModelChoice[];
  readonly catalogFingerprint: string;
}

export interface TerminalModelSwitchRequest {
  readonly model: string;
  readonly reasoningEffort: TerminalModelReasoningEffort;
}

export interface TerminalModelSwitchResult {
  readonly outcome: "changed" | "already_effective" | "uncertain";
  readonly scope: TerminalModelControlScope;
  /** null means an irreversible native commit left persistence uncertain. */
  readonly defaultsChanged: boolean | null;
  readonly requested: TerminalModelSwitchRequest;
  readonly effective?: TerminalModelValue;
  readonly newSessionDefaults?: TerminalModelValue;
  readonly doNotRetry: boolean;
  readonly reason?: string;
}

export type TerminalModelControlResidualKind =
  | "profiled_command_popup"
  | "bare_command"
  | "model_surface";

export type TerminalModelControlResidualObservation =
  | {
      readonly state: "recoverable";
      readonly kind: TerminalModelControlResidualKind;
      readonly fingerprint: string;
      readonly terminalControl: unknown;
    }
  | {
      readonly state: "absent" | "unsafe";
      readonly reason: string;
      readonly terminalControl: unknown;
    };

export interface TerminalModelControlRepairResult {
  readonly outcome: "repaired" | "uncertain";
  readonly terminalControl: unknown;
  readonly terminalInputAttempted: boolean;
  readonly composerPostcondition: "empty" | "unproven";
  readonly doNotRetry: boolean;
  readonly reason?: string;
}

/**
 * One action-specific physical authority token for fresh Codex model control.
 * The domain separator and exact profile keep this authority from being reused
 * as Send or native-lifecycle authority even though all bind the same pane.
 */
export function terminalUserExplicitModelControlBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
}): string {
  const subject = requiredModelControlSubject({
    ...value,
    agent: "codex"
  });
  const physicalTerminalToken = terminalPhysicalBindingToken({
    terminalId: subject.terminalId,
    terminalControl: subject.terminalControl,
    agent: "codex",
    pid: subject.pid,
    workspace: subject.workspace,
    processUuid: subject.processUuid,
    processBirth: subject.processBirth
  });
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control",
      physical_terminal_token: physicalTerminalToken,
      agent_version: subject.agentVersion,
      behavior_profile: subject.behaviorProfile
    }))
    .digest("hex");
}

function requiredModelControlSubject(
  input: TerminalModelControlSubjectInput
): NonNullable<ReturnType<typeof canonicalModelControlSubject>> {
  const subject = canonicalModelControlSubject(input);
  if (!subject) {
    throw new Error(
      "model-control authority requires one canonical supported terminal subject"
    );
  }
  return subject;
}

/**
 * Snapshot authority for adopting and cleaning one exact native `/model`
 * residual. The residual kind and normalized surface digest prevent a token
 * for one popup, pane generation, or bare Composer from authorizing another.
 */
export function terminalUserExplicitModelControlRepairBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
  residualKind: TerminalModelControlResidualKind;
  residualFingerprint: string;
}): string {
  const modelControlToken = terminalUserExplicitModelControlBindingToken(value);
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control_repair",
      model_control_token: modelControlToken,
      residual_kind: value.residualKind,
      residual_fingerprint: value.residualFingerprint
    }))
    .digest("hex");
}

/**
 * Snapshot authority for continuing one exact native `/model` residual into
 * the read-only catalog picker. This is deliberately domain-separated from
 * cleanup-only repair: a repair offer never authorizes Enter, while this
 * offer authorizes exactly one profiled slash-command dispatch.
 */
export function terminalUserExplicitModelControlResidualEntryBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  workspace: string;
  processUuid: string;
  processBirth: string;
  agentVersion: string;
  behaviorProfile: TerminalModelControlPlan["behaviorProfile"];
  residualKind: TerminalModelControlResidualKind;
  residualFingerprint: string;
}): string {
  const modelControlToken = terminalUserExplicitModelControlBindingToken(value);
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      authority: "terminal_user_explicit_model_control_residual_entry",
      model_control_token: modelControlToken,
      residual_kind: value.residualKind,
      residual_fingerprint: value.residualFingerprint
    }))
    .digest("hex");
}

/** Read-only catalog returned by the exact running Codex executable. */
export interface CodexNativeModelCatalog {
  readonly models: readonly TerminalModelChoice[];
}

export function parseCodexNativeModelCatalog(
  value: unknown
): CodexNativeModelCatalog {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) {
    throw new Error("the exact running Codex model catalog has an unknown shape");
  }
  const models = value.models.flatMap((candidate): TerminalModelChoice[] => {
    if (!isPlainRecord(candidate) || candidate.visibility !== "list") return [];
    const id = nonBlank(candidate.slug);
    const label = nonBlank(candidate.display_name) ?? id;
    if (!id || !label || !/^[a-z0-9][a-z0-9._:/+\-]{0,127}$/u.test(id) ||
        !Array.isArray(candidate.supported_reasoning_levels)) {
      throw new Error("the exact running Codex model catalog contains an invalid visible row");
    }
    const efforts = candidate.supported_reasoning_levels.flatMap(
      (entry): TerminalModelReasoningEffort[] => {
        const effort = isPlainRecord(entry) ? entry.effort : undefined;
        return isTerminalModelReasoningEffort(effort) ? [effort] : [];
      }
    );
    if (efforts.length === 0 || new Set(efforts).size !== efforts.length) {
      throw new Error(
        `the exact running Codex model catalog has no unique supported efforts for ${id}`
      );
    }
    return [{ id, label, reasoningEfforts: efforts }];
  });
  if (models.length === 0 ||
      new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("the exact running Codex model catalog has no unique visible models");
  }
  return { models };
}

function observeCodexIdleModel(screen: string):
(TerminalModelValue & { readonly planMode: boolean }) | undefined {
  const lines = stripAnsi(screen).replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const footer = lines.at(-1);
  const match = footer
    ? /^\s{2,}([a-z0-9][a-z0-9._:/+\-]{0,127})\s+(low|medium|high|xhigh|max|ultra)(?:\s+fast)?(?:\s+·.*|\s+Plan mode(?:\s+\([^)]*\))?)?\s*$/u
      .exec(footer)
    : undefined;
  if (!match || !isTerminalModelReasoningEffort(match[2])) return undefined;
  return {
    model: match[1],
    reasoningEffort: match[2],
    planMode: /\bPlan mode\b/u.test(footer ?? "")
  };
}

async function inspectClaudeModelEfforts(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
picker: Extract<TerminalModelControlObservation, { state: "claude_model_picker" }>,
model: string): Promise<{
  capture: TerminalModelControlCapture;
  observation: Extract<TerminalModelControlObservation, { state: "claude_model_picker" }>;
  reasoningEfforts: readonly TerminalModelReasoningEffort[];
}> {
  const selected = await transitionModelControl(
    input,
    terminalControl,
    picker,
    modelControlSelectModelKeys(picker, model),
    ["claude_model_picker"]
  );
  if (selected.observation.state !== "claude_model_picker" ||
      selectedClaudeModelId(selected.observation) !== model) {
    throw new Error("Claude highlighted a different model during catalog inspection");
  }
  let control = selected.capture.terminalControl;
  let live = selected.observation;
  const initial = live.displayedEffort;
  if (!initial) {
    return {
      capture: selected.capture,
      observation: live,
      reasoningEfforts: []
    };
  }
  const seen = new Set<TerminalModelNativeEffort>([initial]);
  for (let count = 0; count < 8; count += 1) {
    const next = await transitionModelControl(
      input,
      control,
      live,
      claudeModelControlEffortKey("higher"),
      ["claude_model_picker"]
    );
    if (next.observation.state !== "claude_model_picker" ||
        selectedClaudeModelId(next.observation) !== model) {
      throw new Error("Claude changed the highlighted model while probing its effort ring");
    }
    control = next.capture.terminalControl;
    live = next.observation;
    const effort = live.displayedEffort;
    if (!effort) {
      throw new Error("Claude removed its effort row while it was being inspected");
    }
    if (effort === initial) {
      return {
        capture: next.capture,
        observation: live,
        reasoningEfforts: TERMINAL_MODEL_REASONING_EFFORTS.filter((effort) =>
          seen.has(effort)
        )
      };
    }
    if (seen.has(effort)) {
      throw new Error("Claude's native effort ring did not return to its initial value");
    }
    seen.add(effort);
  }
  throw new Error("Claude's native effort ring exceeded the verified bounded size");
}

interface ModelRow {
  readonly id: string;
  readonly label: string;
  /** Zero-based position in the complete native menu, including excluded rows. */
  readonly nativeIndex: number;
  readonly selected: boolean;
  readonly current: boolean;
  /** Codex catalog visibility marker, not the persisted user default. */
  readonly presetDefault: boolean;
}

interface EffortRow {
  readonly effort?: TerminalModelReasoningEffort;
  readonly kind: "effort" | "advanced" | "unsupported";
  readonly selected: boolean;
  readonly current: boolean;
  /** Model preset default, not the persisted user reasoning setting. */
  readonly presetDefault: boolean;
}

export type TerminalModelControlObservation =
  | {
      /** Exact 0.154 quick-auto menu, or cleanup-only Luna Reserve menu. */
      readonly state: "codex_entry_model_picker";
      readonly fingerprint: string;
      readonly kind: "quick_auto" | "luna_reserve";
      readonly selectedIndex: number;
      readonly currentNativeIndex: number;
      readonly allModelsNativeIndex?: number;
    }
  | {
      readonly state: "codex_model_picker";
      readonly fingerprint: string;
      readonly rows: readonly ModelRow[];
      readonly selectedIndex: number;
      readonly currentNativeIndex: number;
      readonly currentModel: string;
    }
  | {
      readonly state: "codex_reasoning_picker";
      readonly fingerprint: string;
      readonly model: string;
      readonly rows: readonly EffortRow[];
      readonly selectedIndex: number;
      readonly currentEffort?: TerminalModelReasoningEffort;
      readonly presetDefaultEffort?: TerminalModelReasoningEffort;
    }
  | {
      readonly state: "codex_advanced_reasoning_picker";
      readonly fingerprint: string;
      readonly rows: readonly EffortRow[];
      readonly selectedIndex: number;
      readonly currentEffort?: TerminalModelReasoningEffort;
      readonly presetDefaultEffort?: TerminalModelReasoningEffort;
    }
  | {
      readonly state: "codex_plan_scope_picker";
      readonly fingerprint: string;
      readonly rows: readonly string[];
      readonly selectedIndex: number;
    }
  | {
      readonly state: "claude_model_picker";
      readonly fingerprint: string;
      readonly rows: readonly ModelRow[];
      readonly selectedIndex: number;
      readonly currentNativeIndex: number;
      readonly currentModel: string;
      readonly currentEffort?: TerminalModelReasoningEffort;
      readonly displayedEffort?: TerminalModelNativeEffort;
    }
  | {
      readonly state: "none" | "ambiguous";
      readonly fingerprint: string;
      readonly reason: string;
    };

export function isTerminalModelReasoningEffort(
  value: unknown
): value is TerminalModelReasoningEffort {
  return typeof value === "string" &&
    (TERMINAL_MODEL_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function probeTerminalModelControl(
  agent: ExecutorKind,
  agentVersion: string | undefined
): TerminalModelControlCapabilities {
  return probeTerminalModelControlProfile(agent, agentVersion);
}

export function planTerminalModelControl(
  capabilities: TerminalModelControlCapabilities
): TerminalModelControlPlan {
  return planTerminalModelControlProfile(capabilities);
}

/**
 * Observe only complete, current model-control modal frames. Historical or
 * partial picker text is never sufficient to authorize a key dispatch.
 */
export function observeTerminalModelControl(
  plan: TerminalModelControlPlan,
  screen: string
): TerminalModelControlObservation {
  const normalized = stripAnsi(screen).replace(/\r\n?/gu, "\n");
  return isTerminalModelControlPlanForAgent(plan, "codex")
    ? observeCodexModelControl(normalized)
    : observeClaudeModelControl(normalized);
}

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

export function modelControlMoveKeys(
  currentIndex: number,
  targetIndex: number
): readonly string[] {
  if (
    !Number.isSafeInteger(currentIndex) ||
    !Number.isSafeInteger(targetIndex) ||
    currentIndex < 0 ||
    targetIndex < 0
  ) {
    throw new Error("model-control selection index is invalid");
  }
  const key = targetIndex >= currentIndex ? "Down" : "Up";
  return Array.from(
    { length: Math.abs(targetIndex - currentIndex) },
    () => key
  );
}

/** Adapter-owned native navigation; never serialize these keys to a caller. */
export function modelControlSelectModelKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_model_picker" | "claude_model_picker" }
  >,
  model: string
): readonly string[] {
  const row = observation.rows.find((candidate) => candidate.id === model);
  if (!row) throw new Error("the requested model is absent from the current native picker");
  return [
    ...modelControlMoveKeys(observation.selectedIndex, row.nativeIndex),
    ...(observation.state === "codex_model_picker" ? ["C-m"] : [])
  ];
}

function selectedClaudeModelId(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "claude_model_picker" }
  >
): string | undefined {
  return observation.rows.find((row) =>
    row.nativeIndex === observation.selectedIndex
  )?.id;
}

export function codexModelControlSelectEffortKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_reasoning_picker" | "codex_advanced_reasoning_picker" }
  >,
  effort: TerminalModelReasoningEffort
): readonly string[] {
  const direct = observation.rows.find((row) =>
    row.kind === "effort" && row.effort === effort
  );
  const target = direct ?? (
    observation.state === "codex_reasoning_picker" &&
    (effort === "max" || effort === "ultra")
      ? observation.rows.find((row) => row.kind === "advanced")
      : undefined
  );
  if (!target) {
    throw new Error("the requested reasoning effort is absent from the current native picker");
  }
  const targetIndex = observation.rows.indexOf(target);
  return [
    ...modelControlMoveKeys(observation.selectedIndex, targetIndex),
    "C-m"
  ];
}

export function codexModelControlAllModesKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_plan_scope_picker" }
  >
): readonly string[] {
  const targetIndex = observation.rows.indexOf(
    "Apply to global default and Plan mode override"
  );
  if (targetIndex < 0) {
    throw new Error("Codex Plan-mode scope picker has no global-default choice");
  }
  return [
    ...modelControlMoveKeys(observation.selectedIndex, targetIndex),
    "C-m"
  ];
}

export function claudeModelControlEffortKey(
  direction: "lower" | "higher"
): readonly ["Left" | "Right"] {
  return [direction === "lower" ? "Left" : "Right"];
}

export function claudeModelControlCommitKeys(
  plan: TerminalModelControlPlan
): readonly ["s"] {
  if (
    !isTerminalModelControlPlanForAgent(plan, "claude") ||
    plan.scope !== "current_session"
  ) {
    throw new Error("Claude model control cannot commit outside session-only scope");
  }
  return ["s"];
}

export interface TerminalModelControlCapture {
  readonly terminalControl: unknown;
  readonly screen: string;
  readonly activityState: "awaiting_approval" | "working" | "idle" | "unknown";
  readonly approvalBlocked: boolean;
  readonly exactEmptyComposer: boolean;
  /** Exact adapter-profiled slash selection is ready for Enter. */
  readonly exactCommandReady: boolean;
  /** Exact `/model` text, including the post-Escape bare cleanup state. */
  readonly exactCommandComposer: boolean;
  /** Exact command text in the ordinary Composer with its complete footer. */
  readonly exactBareCommand?: boolean;
  /** Digest of only the exact current `/model` Composer and popup region. */
  readonly exactCommandFingerprint?: string;
  /** A questionnaire, editor, viewer, or other non-model input owner exists. */
  readonly inputBlocked?: boolean;
}

/** Runtime ports are implemented only by TerminalAgentBridge. */
export interface TerminalModelControlPorts {
  /** Revalidate current-snapshot and Store authority before each input call. */
  beforeInput(): void | Promise<void>;
  capture(input: {
    terminalControl: unknown;
    expectedComposer?: string;
  }): Promise<TerminalModelControlCapture>;
  sendText(terminalControl: unknown, text: "/model"): Promise<void>;
  sendKeys(terminalControl: unknown, keys: readonly string[]): Promise<void>;
  /** Exact running Codex 0.154.0 `debug models` output, already validated. */
  loadCodexCatalog?(): Promise<CodexNativeModelCatalog>;
  sleep(milliseconds: number): Promise<void>;
}

export interface TerminalModelOptionsExecution {
  readonly terminalControl: unknown;
  readonly catalog: TerminalModelCatalog;
}

const MODEL_CONTROL_SETTLE_TIMEOUT_MS = 5_000;
const MODEL_CONTROL_POLL_MS = 40;

function modelControlCaptureBlocked(
  capture: TerminalModelControlCapture
): boolean {
  return capture.approvalBlocked || capture.inputBlocked === true;
}

function modelCommandReadyForEnter(
  plan: TerminalModelControlPlan,
  capture: TerminalModelControlCapture
): boolean {
  return capture.exactCommandReady ||
    isTerminalModelControlPlanForAgent(plan, "codex") &&
      capture.exactBareCommand === true;
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
        "model-control residual repair is profiled only for Codex " +
        CODEX_MODEL_CONTROL_AGENT_VERSION,
      terminalControl: capture.terminalControl
    };
  }
  const modelObservation = observeTerminalModelControl(plan, capture.screen);
  const exactModelSurface = modelObservation.state !== "none" &&
    modelObservation.state !== "ambiguous";
  if (
    capture.approvalBlocked ||
    capture.inputBlocked === true && !exactModelSurface ||
    (capture.activityState === "working" ||
      capture.activityState === "awaiting_approval") && !exactModelSurface
  ) {
    return {
      state: "unsafe",
      reason: "another prompt or active agent state owns terminal input",
      terminalControl: capture.terminalControl
    };
  }
  if (exactModelSurface) {
    return {
      state: "recoverable",
      kind: "model_surface",
      fingerprint: createHash("sha256")
        .update(JSON.stringify({
          version: 1,
          behavior_profile: plan.behaviorProfile,
          kind: "model_surface",
          surface_state: modelObservation.state,
          surface_fingerprint: modelObservation.fingerprint
        }))
        .digest("hex"),
      terminalControl: capture.terminalControl
    };
  }
  if (
    !capture.exactCommandComposer ||
    !capture.exactCommandFingerprint ||
    (!capture.exactCommandReady && capture.exactBareCommand !== true)
  ) {
    return {
      state: "absent",
      reason: capture.exactEmptyComposer
        ? "the Composer is already empty"
        : "the current Composer is not one exact profiled /model residual",
      terminalControl: capture.terminalControl
    };
  }
  const kind = capture.exactCommandReady
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
        exact_command_fingerprint: capture.exactCommandFingerprint
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
  let terminalInputAttempted = false;
  const ports: TerminalModelControlPorts = {
    ...input.ports,
    sendKeys: async (terminalControl, keys) => {
      terminalInputAttempted = true;
      await input.ports.sendKeys(terminalControl, keys);
    }
  };
  try {
    const cleared = await unwindModelControl(
      { plan: input.plan, ports },
      observed.terminalControl
    );
    if (
      modelControlCaptureBlocked(cleared) ||
      cleared.activityState !== "idle" ||
      !cleared.exactEmptyComposer
    ) {
      throw new Error("cleanup did not prove an exact idle empty Composer");
    }
    return {
      outcome: "repaired",
      terminalControl: cleared.terminalControl,
      terminalInputAttempted,
      composerPostcondition: "empty",
      doNotRetry: false
    };
  } catch (error) {
    if (!terminalInputAttempted) throw error;
    return {
      outcome: "uncertain",
      terminalControl: observed.terminalControl,
      terminalInputAttempted: true,
      composerPostcondition: "unproven",
      doNotRetry: true,
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
  const codexNativeCatalog = input.agent === "codex"
    ? await input.ports.loadCodexCatalog?.()
    : undefined;
  if (input.agent === "codex" && !codexNativeCatalog) {
    throw new Error(
      "Codex model discovery requires the exact running executable's validated model catalog"
    );
  }
  let control = input.terminalControl;
  const opened = await openModelPicker(input, control);
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
    let idleCurrent = observeCodexIdleModel(opened.idleCapture.screen);
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
      input,
      control,
      picker
    );
    control = dismissed.terminalControl;
    // An adopted profiled slash popup temporarily replaces the ordinary
    // footer. Once the read-only picker is dismissed, the exact idle footer
    // is visible again and can complete the same catalog cross-check.
    idleCurrent ??= observeCodexIdleModel(dismissed.screen);
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
        input, control, livePicker, row.id
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
      input,
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
    agent: input.agent,
    agentVersion: input.agentVersion,
    behaviorProfile: input.plan.behaviorProfile,
    scope: input.plan.scope,
    current,
    models
  };
  return {
    terminalControl: control,
    catalog: {
      ...fingerprintInput,
      catalogFingerprint: terminalModelCatalogFingerprint(fingerprintInput)
    }
  };
  } catch (error) {
    const cleanupError = await tryUnwindModelControl(input, control);
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

  let irreversible = false;
  let control = discovery.terminalControl;
  let codexPersistenceBaseline: string | undefined;
  let codexPersistenceScreen: string | undefined;
  try {
    const opened = await openModelPicker(input, control);
    control = opened.capture.terminalControl;
    const picker = opened.observation;
    if (picker.state === "codex_model_picker") {
      codexPersistenceBaseline = opened.idleCapture.screen;
      const committed = await applyCodexModelSelection(
        input,
        control,
        picker,
        input.request,
        () => { irreversible = true; }
      );
      control = committed.capture.terminalControl;
      codexPersistenceScreen = committed.capture.screen;
    } else if (picker.state === "claude_model_picker") {
      const selected = await transitionModelControl(
        input,
        control,
        picker,
        modelControlSelectModelKeys(picker, input.request.model),
        ["claude_model_picker"]
      );
      control = selected.capture.terminalControl;
      if (selected.observation.state !== "claude_model_picker") {
        throw new Error("Claude model selection did not remain in its picker");
      }
      if (selectedClaudeModelId(selected.observation) !== input.request.model) {
        throw new Error("Claude highlighted a different model before effort selection");
      }
      let effortPicker = selected.observation;
      const seen = new Set<TerminalModelNativeEffort>();
      for (let count = 0; count < 7; count += 1) {
        const displayed = effortPicker.displayedEffort;
        if (!displayed) throw new Error("Claude model picker has no exact effort value");
        if (displayed === requestedEffort) break;
        if (seen.has(displayed)) {
          throw new Error("the requested effort is absent from Claude's live effort ring");
        }
        seen.add(displayed);
        const next = await transitionModelControl(
          input,
          control,
          effortPicker,
          claudeModelControlEffortKey("higher"),
          ["claude_model_picker"]
        );
        control = next.capture.terminalControl;
        if (next.observation.state !== "claude_model_picker") {
          throw new Error("Claude effort adjustment left the model picker");
        }
        if (selectedClaudeModelId(next.observation) !== input.request.model) {
          throw new Error("Claude changed the highlighted model during effort selection");
        }
        effortPicker = next.observation;
      }
      if (effortPicker.displayedEffort !== requestedEffort) {
        throw new Error("the requested effort is absent from Claude's live effort ring");
      }
      if (selectedClaudeModelId(effortPicker) !== input.request.model) {
        throw new Error("Claude changed the highlighted model before session-only commit");
      }
      irreversible = true;
      await exactDispatchKeys(
        input,
        control,
        effortPicker,
        claudeModelControlCommitKeys(input.plan)
      );
      const closed = await waitForObservation(input, control, ["none"], {
        allowImmediateNone: true
      });
      control = closed.capture.terminalControl;
    } else {
      throw new Error("the native model picker changed before selection");
    }

    let persistence = input.agent === "codex"
      ? await waitForCodexPersistencePostcondition(
          input,
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
      observeCodexIdleModel(codexPersistenceBaseline ?? "")?.planMode === true &&
      discovery.catalog.current.model !== input.request.model &&
      effective.model === input.request.model &&
      effective.reasoningEffort === discovery.catalog.current.reasoningEffort &&
      effective.reasoningEffort !== requestedEffort
    ) {
      const reopened = await openModelPicker(input, control);
      if (reopened.observation.state !== "codex_model_picker") {
        throw new Error("Codex Plan-mode reconciliation did not open its model picker");
      }
      const secondBaseline = reopened.idleCapture.screen;
      const reconciled = await applyCodexModelSelection(
        input,
        reopened.capture.terminalControl,
        reopened.observation,
        input.request,
        () => { irreversible = true; }
      );
      control = reconciled.capture.terminalControl;
      persistence = await waitForCodexPersistencePostcondition(
        input,
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
    const cleanupError = await tryUnwindModelControl(input, control);
    if (!irreversible && !cleanupError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    return {
      terminalControl: control,
      outcome: "uncertain",
      scope: input.plan.scope,
      defaultsChanged: null,
      requested: input.request,
      doNotRetry: true,
      reason: cleanupError
        ? `${detail}; exact native model-control cleanup failed: ${cleanupError}`
        : detail
    };
  }
}

async function applyCodexModelSelection(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
picker: Extract<TerminalModelControlObservation, { state: "codex_model_picker" }>,
request: TerminalModelSwitchRequest,
beforeIrreversible: () => void): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  const target = picker.rows.find((row) => row.id === request.model);
  if (!target) {
    throw new Error("the requested Codex model left the current native picker");
  }
  const moved = await transitionModelControl(
    input,
    terminalControl,
    picker,
    modelControlMoveKeys(picker.selectedIndex, target.nativeIndex),
    ["codex_model_picker"]
  );
  if (moved.observation.state !== "codex_model_picker") {
    throw new Error("Codex model navigation left its native picker");
  }
  const movedSelection = moved.observation.selectedIndex;
  if (moved.observation.rows.find((row) =>
    row.nativeIndex === movedSelection
  )?.id !== request.model) {
    throw new Error("Codex highlighted a different model before selection");
  }
  // A remotely refreshed model can become single-effort after discovery; in
  // that case Enter may commit immediately instead of opening a submenu.
  beforeIrreversible();
  const reasoning = await transitionModelControl(
    input,
    moved.capture.terminalControl,
    moved.observation,
    ["C-m"],
    ["codex_reasoning_picker"]
  );
  if (reasoning.observation.state !== "codex_reasoning_picker" ||
      reasoning.observation.model !== request.model) {
    throw new Error("Codex opened a different reasoning picker");
  }
  let selection: Extract<
    TerminalModelControlObservation,
    { state: "codex_reasoning_picker" | "codex_advanced_reasoning_picker" }
  > = reasoning.observation;
  let keys = codexModelControlSelectEffortKeys(
    selection, request.reasoningEffort
  );
  const advanced = request.reasoningEffort === "max" ||
    request.reasoningEffort === "ultra";
  if (!advanced) beforeIrreversible();
  let selected = await transitionModelControl(
    input,
    reasoning.capture.terminalControl,
    selection,
    keys,
    advanced
      ? ["codex_advanced_reasoning_picker"]
      : ["none", "codex_plan_scope_picker"],
    advanced ? {} : { allowImmediateNone: true }
  );
  if (advanced) {
    if (selected.observation.state !== "codex_advanced_reasoning_picker") {
      throw new Error("Codex advanced-reasoning picker did not materialize");
    }
    selection = selected.observation;
    keys = codexModelControlSelectEffortKeys(
      selection, request.reasoningEffort
    );
    beforeIrreversible();
    selected = await transitionModelControl(
      input,
      selected.capture.terminalControl,
      selection,
      keys,
      ["none", "codex_plan_scope_picker"],
      { allowImmediateNone: true }
    );
  }
  if (selected.observation.state !== "codex_plan_scope_picker") {
    return selected;
  }
  beforeIrreversible();
  return transitionModelControl(
    input,
    selected.capture.terminalControl,
    selected.observation,
    codexModelControlAllModesKeys(selected.observation),
    ["none"],
    { allowImmediateNone: true }
  );
}

async function openModelPicker(input: {
  plan: TerminalModelControlPlan;
  terminalControl: unknown;
  ports: TerminalModelControlPorts;
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
  let terminalInputAttempted = false;
  try {
  let idleCapture: TerminalModelControlCapture;
  let revalidatedCommand: TerminalModelControlCapture;
  if (input.initialResidual) {
    const profile = terminalModelControlProfileForPlan(input.plan);
    if (!profile?.supportsResidualContinuation) {
      throw new Error(
        "native model-control continuation is profiled only for Codex " +
        CODEX_MODEL_CONTROL_AGENT_VERSION
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
    if (
      before.activityState !== "idle" ||
      modelControlCaptureBlocked(before) ||
      !before.exactEmptyComposer
    ) {
      throw new Error(
        "model control requires an exact verified idle pane with an empty composer and no blocking interaction"
      );
    }
    await input.ports.beforeInput();
    const finalEmpty = await input.ports.capture({
      terminalControl: before.terminalControl
    });
    if (
      finalEmpty.activityState !== "idle" ||
      modelControlCaptureBlocked(finalEmpty) ||
      !finalEmpty.exactEmptyComposer
    ) {
      throw new Error("the exact idle composer changed before /model input");
    }
    terminalInputAttempted = true;
    await input.ports.sendText(finalEmpty.terminalControl, input.plan.command);
    let commandCapture: TerminalModelControlCapture | undefined;
    const startedAt = Date.now();
    while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
      const captured = await input.ports.capture({
        terminalControl: before.terminalControl,
        expectedComposer: input.plan.command
      });
      if (
        !modelControlCaptureBlocked(captured) &&
        captured.activityState !== "working" &&
        modelCommandReadyForEnter(input.plan, captured)
      ) {
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
    if (
      modelControlCaptureBlocked(revalidatedCommand) ||
      revalidatedCommand.activityState === "working" ||
      !modelCommandReadyForEnter(input.plan, revalidatedCommand)
    ) {
      throw new Error("the exact /model composer changed before Enter");
    }
    idleCapture = finalEmpty;
  }
  cleanupControl = revalidatedCommand.terminalControl;
  terminalInputAttempted = true;
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
    if (!terminalInputAttempted) throw error;
    const cleanupError = await tryUnwindModelControl(
      input, cleanupControl
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
    if (modelControlCaptureBlocked(captured) ||
        captured.activityState === "working") {
      throw new Error("the terminal became busy or blocked during cleanup");
    }
    if (captured.exactEmptyComposer && captured.activityState === "idle") {
      return captured;
    }
    if (captured.exactCommandComposer) {
      await input.ports.beforeInput();
      const finalCommand = await input.ports.capture({
        terminalControl: control,
        expectedComposer: input.plan.command
      });
      if (modelControlCaptureBlocked(finalCommand) ||
          finalCommand.activityState === "working" ||
          !finalCommand.exactCommandComposer) {
        throw new Error("the exact /model composer changed during cleanup");
      }
      control = finalCommand.terminalControl;
      if (
        finalCommand.exactCommandReady ||
        isTerminalModelControlPlanForAgent(input.plan, "claude") ||
        finalCommand.exactBareCommand !== true
      ) {
        await input.ports.sendKeys(control, ["Escape"]);
        const afterEscape = await waitForModelCommandCleanupState(
          input, control
        );
        control = afterEscape.terminalControl;
        if (afterEscape.exactEmptyComposer) return afterEscape;
      }
      await input.ports.beforeInput();
      const finalBareCommand = await input.ports.capture({
        terminalControl: control,
        expectedComposer: input.plan.command
      });
      if (
        modelControlCaptureBlocked(finalBareCommand) ||
        finalBareCommand.activityState === "working" ||
        !finalBareCommand.exactCommandComposer ||
        finalBareCommand.exactCommandReady
      ) {
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
    const observation = observeTerminalModelControl(input.plan, captured.screen);
    if (observation.state === "none" || observation.state === "ambiguous") {
      throw new Error(
        "no exact current model-control frame was available for Escape"
      );
    }
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
    const exactState = captured.exactEmptyComposer ||
      captured.exactCommandComposer && !captured.exactCommandReady &&
        (isTerminalModelControlPlanForAgent(input.plan, "claude") ||
          captured.exactBareCommand === true);
    if (!modelControlCaptureBlocked(captured) &&
        captured.activityState !== "working" && exactState) {
      const semanticState = captured.exactEmptyComposer
        ? "empty"
        : captured.exactCommandFingerprint
          ? `bare:${captured.exactCommandFingerprint}`
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

async function transitionModelControl(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown, observation: TerminalModelControlObservation,
keys: readonly string[], expectedStates: readonly TerminalModelControlObservation["state"][],
options: { allowImmediateNone?: boolean } = {}): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  if (keys.length === 0) {
    return waitForObservation(input, terminalControl, expectedStates, options);
  }
  let control = terminalControl;
  let current = observation;
  for (const [index, key] of keys.entries()) {
    control = await exactDispatchKeys(input, control, current, [key]);
    const isLast = index === keys.length - 1;
    const next = await waitForObservation(
      input,
      control,
      isLast ? expectedStates : [current.state],
      {
        ...(isLast ? options : {}),
        ...(key === "Up" || key === "Down" || key === "Left" || key === "Right"
          ? { excludeFingerprint: current.fingerprint }
          : {})
      }
    );
    current = next.observation;
    control = next.capture.terminalControl;
    if (isLast) return next;
  }
  throw new Error("model-control transition dispatched no key");
}

async function exactDispatchKeys(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown, observation: TerminalModelControlObservation,
  keys: readonly string[]): Promise<unknown> {
  if (keys.length === 0) return terminalControl;
  if (keys.length !== 1) {
    throw new Error("model-control transport accepts exactly one native key per proof");
  }
  await input.ports.beforeInput();
  const captured = await input.ports.capture({ terminalControl });
  const current = observeTerminalModelControl(input.plan, captured.screen);
  if (
    modelControlCaptureBlocked(captured) ||
    captured.activityState === "working" ||
    current.state !== observation.state ||
    current.fingerprint !== observation.fingerprint
  ) {
    throw new Error("the native model-control frame changed before key dispatch");
  }
  await input.ports.sendKeys(captured.terminalControl, keys);
  return captured.terminalControl;
}

async function waitForObservation(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
expectedStates: readonly TerminalModelControlObservation["state"][],
options: {
  allowImmediateNone?: boolean;
  allowExactCommandComposer?: boolean;
  excludeFingerprint?: string;
} = {}): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  const startedAt = Date.now();
  let stableFingerprint: string | undefined;
  let stableCaptures = 0;
  while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
    const captured = await input.ports.capture({ terminalControl });
    if (modelControlCaptureBlocked(captured) ||
        captured.activityState === "working") {
      throw new Error("the terminal became busy or blocked during model control");
    }
    const observation = observeTerminalModelControl(input.plan, captured.screen);
    const expectedNone = observation.state === "none" && (
      options.allowImmediateNone === true && captured.exactEmptyComposer ||
      options.allowExactCommandComposer === true &&
        captured.exactCommandComposer
    );
    const expected = observation.fingerprint !== options.excludeFingerprint &&
      expectedStates.includes(observation.state) &&
      (observation.state !== "none" || expectedNone);
    if (expected) {
      if (observation.fingerprint === stableFingerprint) stableCaptures += 1;
      else {
        stableFingerprint = observation.fingerprint;
        stableCaptures = 1;
      }
      if (stableCaptures >= 2) return { capture: captured, observation };
    } else {
      stableFingerprint = undefined;
      stableCaptures = 0;
    }
    await input.ports.sleep(MODEL_CONTROL_POLL_MS);
  }
  throw new Error("the expected native model-control frame did not become stable");
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
  if (closed.capture.exactEmptyComposer &&
      closed.capture.activityState === "idle") {
    return closed.capture;
  }
  if (closed.capture.exactCommandComposer) {
    return unwindModelControl(input, closed.capture.terminalControl);
  }
  throw new Error("native model-control dismissal did not return to exact idle");
}

function observeCodexModelControl(
  screen: string
): TerminalModelControlObservation {
  const lines = terminalTailLines(screen);
  const fingerprint = screenFingerprint(lines);
  const entryHeader = lastIndex(lines, (line) =>
    line.trim() === "Select Model"
  );
  const modelHeader = lastIndex(lines, (line) =>
    line.trim() === "Select Model and Effort"
  );
  const reasoningHeader = lastIndex(lines, (line) =>
    /^\s*Select Reasoning Level for \S+\s*$/u.test(line)
  );
  const advancedHeader = lastIndex(lines, (line) =>
    line.trim() === "Advanced Reasoning"
  );
  const scopeHeader = lastIndex(lines, (line) =>
    line.trim() === "Apply reasoning change"
  );
  const latest = Math.max(
    entryHeader, modelHeader, reasoningHeader, advancedHeader, scopeHeader
  );
  if (latest < 0) {
    return { state: "none", fingerprint, reason: "no current Codex model picker is visible" };
  }
  const region = currentPickerRegion(lines, latest);
  if (!region) {
    return {
      state: "ambiguous",
      fingerprint,
      reason: "the current Codex model picker is incomplete or has trailing content"
    };
  }
  if (region.some((line) => line.includes("OpenAI base URL is overridden"))) {
    return {
      state: "ambiguous",
      fingerprint,
      reason: "Codex model control is unavailable with an overridden OpenAI base URL"
    };
  }
  if (latest === entryHeader) {
    const parsedEntry = parseCodexEntryModelPicker(region);
    if (!parsedEntry) {
      return {
        state: "ambiguous",
        fingerprint,
        reason: "the Codex entry model picker is not exact"
      };
    }
    return { state: "codex_entry_model_picker", fingerprint, ...parsedEntry };
  }
  if (latest === modelHeader) {
    const parsedRows = parseCodexModelRows(region);
    if (!parsedRows) {
      return { state: "ambiguous", fingerprint, reason: "the Codex model catalog frame is not exact" };
    }
    return { state: "codex_model_picker", fingerprint, ...parsedRows };
  }
  if (latest === reasoningHeader) {
    const model = /^\s*Select Reasoning Level for (\S+)\s*$/u.exec(
      region[0] ?? ""
    )?.[1];
    const parsedRows = parseCodexEffortRows(region, false);
    if (!model || !parsedRows) {
      return { state: "ambiguous", fingerprint, reason: "the Codex reasoning frame is not exact" };
    }
    return {
      state: "codex_reasoning_picker",
      fingerprint,
      model,
      ...parsedRows
    };
  }
  if (latest === advancedHeader) {
    const parsedRows = parseCodexEffortRows(region, true);
    if (!parsedRows) {
      return { state: "ambiguous", fingerprint, reason: "the Codex advanced-reasoning frame is not exact" };
    }
    return {
      state: "codex_advanced_reasoning_picker",
      fingerprint,
      ...parsedRows
    };
  }
  const rows = region.flatMap((line) => {
    const match = /^\s*(?:›\s*)?\d+\.\s+(Apply to (?:Plan mode override|global default and Plan mode override))\s*$/u
      .exec(line);
    return match ? [match[1]] : [];
  });
  const numberedLines = region.filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedLines = numberedLines.filter((line) => /^\s*›\s*\d+\./u.test(line));
  if (
    rows.length !== 2 ||
    numberedLines.length !== rows.length ||
    selectedLines.length !== 1 ||
    rows[0] !== "Apply to Plan mode override" ||
    rows[1] !== "Apply to global default and Plan mode override" ||
    !numberedLines.every((line, index) =>
      new RegExp(`^\\s*(?:›\\s*)?${index + 1}\\.`).test(line)
    )
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Codex Plan-mode scope frame is not exact" };
  }
  const selectedRow = numberedLines.findIndex((line) => /^\s*›/u.test(line));
  return {
    state: "codex_plan_scope_picker",
    fingerprint,
    rows,
    selectedIndex: selectedRow
  };
}

function observeClaudeModelControl(
  screen: string
): TerminalModelControlObservation {
  const lines = terminalTailLines(screen);
  const fingerprint = screenFingerprint(lines);
  const headerIndex = lastIndex(lines, (line) =>
    line.trim() === "Select model"
  );
  if (headerIndex < 0) {
    return { state: "none", fingerprint, reason: "no current Claude model picker is visible" };
  }
  if (
    headerIndex === 0 ||
    !/^\s*[▔¯─━]{8,}\s*$/u.test(lines[headerIndex - 1])
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model picker is not anchored to its top border" };
  }
  const region = lines.slice(headerIndex);
  const footerIndex = region.findIndex((line) =>
    /^\s*Enter to set as default\s+·\s+s to use this session only\s+·\s+Esc to cancel\s*$/u
      .test(line)
  );
  if (footerIndex < 0 || region.slice(footerIndex + 1).some((line) => line.trim())) {
    return { state: "ambiguous", fingerprint, reason: "the current Claude model picker footer is incomplete" };
  }
  const picker = region.slice(0, footerIndex + 1);
  const rows: ModelRow[] = [];
  const nativeRows: Array<{
    nativeIndex: number;
    selected: boolean;
    label: string;
    description: string;
    current: boolean;
  }> = [];
  for (const line of picker) {
    const match = /^\s*(❯\s*)?(\d+)\.\s+(.+?)(?:\s{2,})(\S.*)$/u.exec(line);
    if (!match) continue;
    const rawLabel = match[3].trim();
    const label = rawLabel.replace(/\s+✔\s*$/u, "").trim();
    const description = match[4].trim();
    nativeRows.push({
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      label,
      description,
      current: rawLabel.endsWith("✔")
    });
  }
  const numberedClaudeLines = picker.filter((line) =>
    /^\s*(?:❯\s*)?\d+\./u.test(line)
  );
  if (numberedClaudeLines.length !== nativeRows.length ||
      nativeRows.some((row, index) => row.nativeIndex !== index)) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model numbering is not exact" };
  }
  for (const row of nativeRows) {
    if (
      /^Default(?:\s+\(recommended\))?$/iu.test(row.label) ||
      /Opus Plan Mode/iu.test(row.label) ||
      /Opus Plan Mode/iu.test(row.description) ||
      /\bFable\b/iu.test(row.label) ||
      /\bFable\b/iu.test(row.description)
    ) continue;
    const id = claudeSemanticModelId(`${row.label} ${row.description}`);
    if (!id) continue;
    rows.push({
      id,
      label: row.label,
      nativeIndex: row.nativeIndex,
      selected: row.selected,
      current: row.current,
      presetDefault: false
    });
  }
  const selectedRows = nativeRows.filter((row) => row.selected);
  const selectedNativeIndex = selectedRows[0]?.nativeIndex ?? -1;
  const currentNativeRows = nativeRows.filter((row) => row.current);
  const currentModel = currentNativeRows.length === 1
    ? claudeSemanticModelId(
        `${currentNativeRows[0].label} ${currentNativeRows[0].description}`
      )
    : undefined;
  if (
    rows.length === 0 ||
    selectedRows.length !== 1 ||
    !currentModel ||
    !rows.some((row) => row.id === currentModel) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model rows are not profiled" };
  }
  const displayedEfforts = picker.flatMap((line) => {
    const match = /^\s*[●○◐◉◈✦]\s+(Low|Medium|High|Extra high|Xhigh|Max|Ultracode)\s+effort\b/iu
      .exec(line);
    const value = match ? claudeEffortFromNativeLabel(match[1]) : undefined;
    return value ? [value] : [];
  });
  if (displayedEfforts.length > 1) {
    return { state: "ambiguous", fingerprint, reason: "the Claude effort row is not exact" };
  }
  const displayedEffort = displayedEfforts[0];
  return {
    state: "claude_model_picker",
    fingerprint,
    rows,
    selectedIndex: selectedNativeIndex,
    currentNativeIndex: currentNativeRows[0].nativeIndex,
    currentModel,
    ...(displayedEffort && displayedEffort !== "ultracode"
      ? { currentEffort: displayedEffort }
      : {}),
    ...(displayedEffort ? { displayedEffort } : {})
  };
}

function parseCodexModelRows(region: readonly string[]): {
  rows: readonly ModelRow[];
  selectedIndex: number;
  currentNativeIndex: number;
  currentModel: string;
} | undefined {
  const rows: ModelRow[] = [];
  for (const line of region.slice(1, -1)) {
    const match = /^\s*(›\s*)?(\d+)\.\s+([a-z0-9][a-z0-9._:/+\-]*)(?:\s+((?:\((?:current|default)\)\s*){1,2}))?(?:\s{2,}.*)?$/u
      .exec(line);
    if (!match) continue;
    const flags = match[4] ?? "";
    rows.push({
      id: match[3],
      label: match[3],
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      current: flags.includes("(current)"),
      presetDefault: flags.includes("(default)")
    });
  }
  const numberedLines = region.slice(1, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedRows = rows.filter((row) => row.selected);
  const selectedIndex = selectedRows[0]?.nativeIndex ?? -1;
  const currentRows = rows.filter((row) => row.current);
  if (
    rows.length === 0 ||
    numberedLines.length !== rows.length ||
    rows.some((row, index) => row.nativeIndex !== index) ||
    selectedRows.length !== 1 ||
    currentRows.length !== 1 ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    return undefined;
  }
  return {
    rows,
    selectedIndex,
    currentNativeIndex: currentRows[0].nativeIndex,
    currentModel: currentRows[0].id
  };
}

function parseCodexEntryModelPicker(region: readonly string[]): {
  kind: "quick_auto" | "luna_reserve";
  selectedIndex: number;
  currentNativeIndex: number;
  allModelsNativeIndex?: number;
} | undefined {
  const subtitle = region[1]?.trim();
  const kind = subtitle === "Pick a quick auto mode or browse all models."
    ? "quick_auto"
    : subtitle === "Other models return when ordinary usage is available again."
      ? "luna_reserve"
      : undefined;
  if (!kind) return undefined;
  const numbered = region.slice(2, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const rows = numbered.map((line) => {
    const match = /^\s*(›\s*)?(\d+)\.\s+(.+)$/u.exec(line);
    if (!match) return undefined;
    const current = /(?:^|\s)\(current\)(?:\s{2,}|\s*$)/u.test(match[3]);
    const label = match[3]
      .replace(/\s+\(current\)(?=\s{2,}|\s*$)/u, "")
      .split(/\s{2,}/u, 1)[0]
      ?.trim();
    return {
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      current,
      label
    };
  });
  if (
    rows.some((row) => !row) ||
    rows.length === 0 ||
    rows.some((row, index) => row?.nativeIndex !== index)
  ) return undefined;
  const exactRows = rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  const selected = exactRows.filter((row) => row.selected);
  const current = exactRows.filter((row) => row.current);
  if (selected.length !== 1 || current.length !== 1) return undefined;
  if (kind === "quick_auto") {
    const allModels = exactRows.filter((row) => row.label === "All models");
    if (
      allModels.length !== 1 ||
      exactRows.at(-1)?.label !== "All models" ||
      exactRows.slice(0, -1).some((row) =>
        !/^codex-auto-[a-z0-9][a-z0-9._:/+\-]*$/u.test(row.label ?? "")
      )
    ) return undefined;
    return {
      kind,
      selectedIndex: selected[0].nativeIndex,
      currentNativeIndex: current[0].nativeIndex,
      allModelsNativeIndex: allModels[0].nativeIndex
    };
  }
  if (exactRows.length !== 1 || !exactRows[0].label) return undefined;
  return {
    kind,
    selectedIndex: selected[0].nativeIndex,
    currentNativeIndex: current[0].nativeIndex
  };
}

function parseCodexEffortRows(
  region: readonly string[],
  advanced: boolean
): {
  rows: readonly EffortRow[];
  selectedIndex: number;
  currentEffort?: TerminalModelReasoningEffort;
  presetDefaultEffort?: TerminalModelReasoningEffort;
} | undefined {
  const rows: EffortRow[] = [];
  for (const line of region.slice(1, -1)) {
    const match = /^\s*(›\s*)?\d+\.\s+(Low|Medium|High|Extra high|Max|Ultra|Persistent|More reasoning…)(?:\s+((?:\((?:current|default)\)\s*){1,2}))?(?:\s{2,}.*)?$/u
      .exec(line);
    if (!match) continue;
    const effort = effortFromNativeLabel(match[2]);
    const flags = match[3] ?? "";
    rows.push({
      ...(effort ? { effort } : {}),
      kind: match[2] === "More reasoning…"
        ? "advanced"
        : match[2] === "Persistent"
          ? "unsupported"
          : "effort",
      selected: Boolean(match[1]),
      current: flags.includes("(current)"),
      presetDefault: flags.includes("(default)")
    });
  }
  const numberedLines = region.slice(1, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedRows = rows.filter((row) => row.selected);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const current = rows.filter((row) => row.current && row.effort);
  const defaults = rows.filter((row) => row.presetDefault && row.effort);
  const allowed = advanced
    ? rows.every((row) => row.kind === "effort" && ["max", "ultra"].includes(row.effort ?? ""))
    : rows.every((row) => row.kind === "advanced" || row.kind === "unsupported" ||
        !["max", "ultra"].includes(row.effort ?? ""));
  if (
    rows.length === 0 ||
    numberedLines.length !== rows.length ||
    !numberedLines.every((line, index) =>
      new RegExp(`^\\s*(?:›\\s*)?${index + 1}\\.`).test(line)
    ) ||
    selectedRows.length !== 1 ||
    selectedIndex < 0 ||
    current.length > 1 ||
    defaults.length > 1 ||
    !allowed
  ) return undefined;
  return {
    rows,
    selectedIndex,
    ...(current[0]?.effort ? { currentEffort: current[0].effort } : {}),
    ...(defaults[0]?.effort
      ? { presetDefaultEffort: defaults[0].effort }
      : {})
  };
}

function currentPickerRegion(
  lines: readonly string[],
  headerIndex: number
): readonly string[] | undefined {
  const after = lines.slice(headerIndex);
  const footerIndex = after.findIndex((line) =>
    line.trim() === "Press enter to confirm or esc to go back"
  );
  if (footerIndex < 0 || after.slice(footerIndex + 1).some((line) => line.trim())) {
    return undefined;
  }
  return after.slice(0, footerIndex + 1);
}

function effortFromNativeLabel(
  label: string
): TerminalModelReasoningEffort | undefined {
  return ({
    Low: "low",
    Medium: "medium",
    High: "high",
    "Extra high": "xhigh",
    Max: "max",
    Ultra: "ultra"
  } as const)[label as "Low" | "Medium" | "High" | "Extra high" | "Max" | "Ultra"];
}

function claudeEffortFromNativeLabel(
  label: string
): TerminalModelNativeEffort | undefined {
  const normalized = label.trim().toLowerCase();
  return ({
    low: "low",
    medium: "medium",
    high: "high",
    "extra high": "xhigh",
    xhigh: "xhigh",
    max: "max",
    ultracode: "ultracode"
  } as const)[normalized as
    "low" | "medium" | "high" | "extra high" | "xhigh" | "max" | "ultracode"];
}

function claudeSemanticModelId(label: string): string | undefined {
  const family = /\b(opus|sonnet|haiku)\b/iu.exec(label)?.[1].toLowerCase();
  if (!family || !/^(?:opus|sonnet|haiku)$/u.test(family)) return undefined;
  const version = new RegExp(
    `\\b${family}[-\\s]+(\\d+(?:\\.\\d+)?)\\b`, "iu"
  ).exec(label)?.[1] ?? /\b(\d+\.\d+)\b/u.exec(label)?.[1];
  const longContext = /(?:\[?1m\]?|1\s*million)(?:\s+context)?\b/iu.test(label);
  return [family, version, longContext ? "1m" : undefined]
    .filter((part): part is string => Boolean(part))
    .join("-");
}

function terminalTailLines(screen: string): readonly string[] {
  const lines = screen.split("\n").slice(-160);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

function lastIndex(
  lines: readonly string[],
  predicate: (line: string) => boolean
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return index;
  }
  return -1;
}

function screenFingerprint(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

function stripAnsi(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu,
    ""
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function codexPersistencePostcondition(
  beforeScreen: string,
  afterScreen: string,
  request: TerminalModelSwitchRequest
): { proven: true } | {
  proven: false;
  final: boolean;
  reason: string;
} {
  const errorPatterns = [
    /Failed to save default model:/giu,
    /Failed to save Plan mode reasoning effort:/giu,
    /Saved default model and reasoning effort, but a higher-priority configuration\s+layer overrides the saved value\./giu,
    /Saved Plan mode reasoning effort, but a higher-priority configuration\s+layer overrides the saved value\./giu
  ];
  if (errorPatterns.some((pattern) =>
    matchCount(afterScreen, pattern) > matchCount(beforeScreen, pattern)
  )) {
    return {
      proven: false,
      final: true,
      reason:
        "Codex reported that its persisted model default failed or is overridden by a higher-priority configuration layer"
    };
  }
  const model = escapeRegExp(request.model);
  const effort = request.reasoningEffort === "xhigh"
    ? "(?:xhigh|extra high)"
    : escapeRegExp(request.reasoningEffort);
  const suffix = request.reasoningEffort === "ultra"
    ? "\\s+for this conversation"
    : "";
  const success = new RegExp(
    `Model changed to\\s+${model}\\s+${effort}${suffix}(?:\\s|$)`,
    "giu"
  );
  if (matchCount(afterScreen, success) <= matchCount(beforeScreen, success)) {
    return {
      proven: false,
      final: false,
      reason:
        "Codex did not expose a fresh exact model-default persistence success frame"
    };
  }
  return { proven: true };
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

function matchCount(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
