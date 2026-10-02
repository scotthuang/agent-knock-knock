import type {
  ExecutorKind
} from "./executors.js";
import type {
  TerminalModelControlPlan,
  TerminalModelControlScope
} from "./terminal-model-control-profile.js";

/** Value contracts shared by model parsing and execution; no terminal I/O. */
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

export type TerminalModelNativeEffort = TerminalModelReasoningEffort | "ultracode";

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

/** Read-only catalog returned by the exact running Codex executable. */
export interface CodexNativeModelCatalog {
  readonly models: readonly TerminalModelChoice[];
}

export interface ModelRow {
  readonly id: string;
  readonly label: string;
  /** Zero-based position in the complete native menu, including excluded rows. */
  readonly nativeIndex: number;
  readonly selected: boolean;
  readonly current: boolean;
  /** Codex catalog visibility marker, not the persisted user default. */
  readonly presetDefault: boolean;
}

export interface EffortRow {
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

export type ExactTerminalModelControlObservation = Exclude<
  TerminalModelControlObservation,
  { state: "none" | "ambiguous" }
>;

/**
 * One mutually exclusive semantic owner for the current model-control frame.
 * Raw capture facts remain transport-private; policy code consumes this union
 * so an exact profiled picker cannot simultaneously be treated as generic
 * agent activity.
 */
export type TerminalModelControlSurface =
  | {
      readonly state: "idle_empty";
    }
  | {
      readonly state: "command_popup";
      readonly fingerprint?: string;
    }
  | {
      readonly state: "bare_command";
      readonly fingerprint?: string;
    }
  | {
      /** Exact `/model` draft whose popup/bare shape is not profile-authorized. */
      readonly state: "command_draft";
      readonly fingerprint?: string;
    }
  | {
      readonly state: "picker";
      readonly pickerKind: "model" | "effort" | "scope";
      readonly observation: ExactTerminalModelControlObservation;
    }
  | {
      readonly state: "blocked";
      readonly owner: "approval" | "input" | "agent";
    }
  | {
      readonly state: "unknown";
      readonly reason: string;
    };

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
  /** Exact running profiled Codex `debug models` output, already validated. */
  loadCodexCatalog?(): Promise<CodexNativeModelCatalog>;
  sleep(milliseconds: number): Promise<void>;
}

export interface TerminalModelOptionsExecution {
  readonly terminalControl: unknown;
  readonly catalog: TerminalModelCatalog;
}

export function isTerminalModelReasoningEffort(
  value: unknown
): value is TerminalModelReasoningEffort {
  return typeof value === "string" &&
    (TERMINAL_MODEL_REASONING_EFFORTS as readonly string[]).includes(value);
}
