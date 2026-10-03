import {
  isCodexPaginatedReadCandidate
} from "./codex-lifecycle-compatibility.js";

import type {
  TerminalAgentAdapter,
  TerminalNativeInspectionPlan
} from "./terminal-agent-adapter.js";

import {
  type TerminalControlRef
} from "./terminal-control-ref.js";
import {
  CODEX_PASTE_ENTER_SETTLE_MS
} from "./terminal-text-submission-bridge.js";

// Keep every exact slash-completion shape closed per behavior profile so a
// version adding another matching command cannot silently become an authorized
// native command surface.
export const CODEX_FULLSCREEN_STATUS_POPUP_ROWS: readonly string[] = [
  "› /status      show current session configuration and token usage",
  "  /statusline  configure which items appear in the status line"
];

// Shared grammar has explicit profile membership; no new version is inferred here.
const CODEX_CLASSIC_STATUS_POPUP_ROWS: readonly string[] = [
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ];
const CLAUDE_STATUS_POPUP_ROWS: readonly string[] = [
    "/status Show Claude Code status including version, model, account, API connectivity, and tool statuses",
    "/statusline Set up Claude Code's status line UI",
    "/ide Manage IDE integrations and show status",
    "/usage Show session cost, plan usage, and activity stats"
  ];

export const CODEX_NATIVE_STATUS_POPUP_BY_PROFILE: Readonly<
  Record<string, readonly string[]>
> = {
  "codex-tui-0.146.0": [
    "  /status  show current session configuration and token usage"
  ],
  "codex-tui-0.146.1": [
    "  /status  show current session configuration and token usage"
  ],
  "codex-tui-0.147.0": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.148.0": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.149.1": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.150.1": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.151.0": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.153.0": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.153.4": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.154.0": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.155.1": CODEX_CLASSIC_STATUS_POPUP_ROWS,
  "codex-tui-0.158.0": CODEX_FULLSCREEN_STATUS_POPUP_ROWS,
  "codex-tui-0.159.0": CODEX_FULLSCREEN_STATUS_POPUP_ROWS,
  "codex-tui-0.159.2": CODEX_FULLSCREEN_STATUS_POPUP_ROWS,
  "codex-tui-0.159.3": CODEX_FULLSCREEN_STATUS_POPUP_ROWS,
  "codex-tui-0.160.0": CODEX_FULLSCREEN_STATUS_POPUP_ROWS,
  "codex-tui-generic-v1": CODEX_CLASSIC_STATUS_POPUP_ROWS
};

// Codex's verified `/status` profiles are exercised against its canonical
// 80-column status surface. Narrower layouts can truncate the 36-character
// Session UUID after a dynamically sized label column. Exact provider geometry
// is required before input; ANSI visible-buffer width is only a conservative
// fallback diagnostic and never upgrades unknown geometry to safe.
export const CODEX_NATIVE_STATUS_MIN_VIEWPORT_BY_PROFILE: Readonly<
  Record<string, number>
> = {
  "codex-tui-0.146.0": 80,
  "codex-tui-0.146.1": 80,
  "codex-tui-0.147.0": 80,
  "codex-tui-0.148.0": 80,
  "codex-tui-0.149.1": 80,
  "codex-tui-0.150.1": 80,
  "codex-tui-0.151.0": 80,
  "codex-tui-0.153.0": 80,
  "codex-tui-0.153.4": 80,
  "codex-tui-0.154.0": 80,
  "codex-tui-0.155.1": 80,
  "codex-tui-0.158.0": 80,
  "codex-tui-0.159.0": 80,
  "codex-tui-0.159.2": 80,
  "codex-tui-0.159.3": 80,
  "codex-tui-0.160.0": 80,
  "codex-tui-generic-v1": 80
};

export const CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE: Readonly<
  Record<string, readonly string[]>
> = {
  "claude-code-2.1.218-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.226-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.237-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.251-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.259-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.263-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.266-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.267-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-2.1.285-native-status": CLAUDE_STATUS_POPUP_ROWS,
  "claude-code-unverified-native-status-v1": CLAUDE_STATUS_POPUP_ROWS
};

export const CLAUDE_NATIVE_STATUS_SETTLE_BY_PROFILE: Readonly<
  Record<string, { minimumStableMs: number; maximumSettleMs: number }>
> = {
  "claude-code-2.1.218-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 2_000
  },
  "claude-code-2.1.226-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.237-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.251-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.259-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.263-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.266-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.267-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-2.1.285-native-status": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  },
  "claude-code-unverified-native-status-v1": {
    minimumStableMs: 80,
    maximumSettleMs: 5_000
  }
};

export function codexFullscreenStatusVersion(plan: TerminalNativeInspectionPlan): string | undefined {
  const version = /^codex-tui-fullscreen-status-v1@(\d+\.\d+\.\d+)$/u
    .exec(plan.behaviorProfile)?.[1] ??
    (CODEX_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile]
      ? /^codex-tui-(\d+\.\d+\.\d+)$/u.exec(plan.behaviorProfile)?.[1]
      : undefined);
  return isCodexPaginatedReadCandidate(version) ? version : undefined;
}

export function codexNativeStatusPopupRows(plan: TerminalNativeInspectionPlan): readonly string[] | undefined {
  return CODEX_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile] ??
    (codexFullscreenStatusVersion(plan)
      ? CODEX_FULLSCREEN_STATUS_POPUP_ROWS
      : undefined);
}

export function codexNativeStatusMinimumViewport(plan: TerminalNativeInspectionPlan): number | undefined {
  return CODEX_NATIVE_STATUS_MIN_VIEWPORT_BY_PROFILE[plan.behaviorProfile] ??
    (codexFullscreenStatusVersion(plan) ? 80 : undefined);
}

export function assertClosedStatusInspectionPlan(
  adapter: TerminalAgentAdapter,
  terminalControl: TerminalControlRef,
  plan: TerminalNativeInspectionPlan
): void {
  if (!terminalControl.capabilities.includes("send_keys")) {
    throw new Error(`${adapter.displayName} terminal input is not supported`);
  }
  if (!terminalControl.capabilities.includes("screen_status")) {
    throw new Error(`${adapter.displayName} terminal screen inspection is not supported`);
  }
  const codexProfile = adapter.agent === "codex" &&
    codexNativeStatusPopupRows(plan) !== undefined;
  const claudeProfile = adapter.agent === "claude" &&
    CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile] !== undefined;
  const expectedSettle = codexProfile
    ? { minimumStableMs: CODEX_PASTE_ENTER_SETTLE_MS, maximumSettleMs: 2_000 }
    : CLAUDE_NATIVE_STATUS_SETTLE_BY_PROFILE[plan.behaviorProfile];
  const exactPresentation = codexProfile
    ? plan.expectedResult.presentation === "inline" &&
      plan.expectedResult.dismissal === undefined &&
      plan.composer.minimumStableMs === expectedSettle?.minimumStableMs &&
      plan.composer.maximumSettleMs === expectedSettle.maximumSettleMs
    : claudeProfile
      ? plan.expectedResult.presentation === "modal" &&
        plan.composer.minimumStableMs === expectedSettle?.minimumStableMs &&
        plan.composer.maximumSettleMs === expectedSettle.maximumSettleMs &&
        plan.expectedResult.dismissal?.expected === "idle_empty_composer" &&
        JSON.stringify(plan.expectedResult.dismissal.keys) ===
          JSON.stringify(["Escape"])
      : false;
  if (
    plan.operation.kind !== "status" ||
    plan.command !== "/status" ||
    plan.effect !== "read_only" ||
    plan.requiresIdle !== true ||
    plan.composer.kind !== "exact" ||
    !Number.isFinite(plan.composer.minimumStableMs) ||
    plan.composer.minimumStableMs < 0 ||
    !Number.isFinite(plan.composer.maximumSettleMs) ||
    plan.composer.maximumSettleMs < plan.composer.minimumStableMs ||
    plan.expectedResult.kind !== "native_status" ||
    !exactPresentation
  ) {
    throw new Error("refusing a non-closed native inspection plan");
  }
}

export function assertClosedNativeInspectionDismissal(
  plan: TerminalNativeInspectionPlan
): void {
  if (
    plan.expectedResult.presentation !== "modal" ||
    plan.expectedResult.dismissal?.expected !== "idle_empty_composer" ||
    JSON.stringify(plan.expectedResult.dismissal.keys) !==
      JSON.stringify(["Escape"])
  ) {
    throw new Error("native inspection has no closed modal dismissal plan");
  }
}
