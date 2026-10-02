import {
  isCodexPaginatedReadCandidate
} from "./codex-lifecycle-compatibility.js";
import {
  createHash
} from "node:crypto";
import {
  captureCodexFullscreenComposerFrame,
  exactCodexFullscreenSlashComposerCapture
} from "./codex-fullscreen-composer-proof.js";
import type {
  ExecutorKind
} from "./executors.js";
import type {
  TerminalNativeInspectionPlan,
  TerminalScreenInspection
} from "./terminal-agent-adapter.js";

import {
  NativeInspectionSubmissionDiagnostic,
  TerminalNativeInspectionMaterializationKind,
  NativeInspectionDiagnosticError
} from "./terminal-native-inspection-contract.js";
import {
  CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE,
  codexFullscreenStatusVersion,
  codexNativeStatusPopupRows
} from "./terminal-native-inspection-profile.js";

/** Pure current-frame proofs. Native input remains owned by the inspection bridge. */
export const CODEX_COMPOSER_MARKER = /^[›»](?:\s|$)/u;

export const CODEX_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s|$)|[-\w.]+ default ·)/u;

export function assertNativeInspectionComposerSafe(
  inspection: TerminalScreenInspection,
  displayName = "terminal agent",
  allowWorkingCodexStatus = false
): void {
  if (
    inspection.approval.blocked ||
    inspection.activity.state === "awaiting_approval" ||
    inspection.activity.state === "working" && !allowWorkingCodexStatus
  ) {
    throw new NativeInspectionDiagnosticError(
      "composer_not_ready",
      `${displayName} became busy or blocked while its /status composer was settling`
    );
  }
  // Codex's generic activity parser deliberately reports a non-empty slash
  // composer as unknown. At this stage the caller has already proved an idle,
  // empty styled composer under the terminal lock; the exact-current composer
  // capture below is the stronger continuation proof after AKK injected only
  // the adapter-owned /status command.
}

export function exactNativeInspectionComposerCapture(
  agent: ExecutorKind,
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  return agent === "codex"
    ? exactCodexNativeInspectionComposerCapture(screen, plan)
    : exactClaudeNativeInspectionComposerCapture(screen, plan);
}

export function exactCodexNativeInspectionComposerCapture(
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  if (codexFullscreenStatusVersion(plan) !== undefined) {
    const captured = exactCodexFullscreenSlashComposerCapture(
      stripTerminalEscapeSequences(screen),
      plan.command,
      codexNativeStatusPopupRows(plan)!,
      false, codexFullscreenStatusVersion(plan)
    );
    return captured && { digest: captured.digest, kind: "exact_slash_popup" };
  }
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  let currentComposerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      currentComposerIndex = index;
      break;
    }
  }
  if (currentComposerIndex < 0) {
    return undefined;
  }
  const composerText = lines[currentComposerIndex]
    .replace(/^[›»]\s?/u, "")
    .trimEnd();
  if (composerText !== plan.command) {
    return undefined;
  }
  const footerIndex = lines.findIndex((line, candidateIndex) =>
    candidateIndex > currentComposerIndex &&
    CODEX_COMPOSER_FOOTER.test(line.trim())
  );
  const region = lines.slice(
    currentComposerIndex,
    footerIndex < 0 ? lines.length : footerIndex
  );
  while (region.length > 1 && region.at(-1)?.trim() === "") {
    region.pop();
  }
  const popupRows = region.slice(1).filter((line) => line.trim().length > 0);
  let kind: TerminalNativeInspectionMaterializationKind;
  if (popupRows.length === 0) {
    kind = "exact_slash_composer";
  } else if (
    JSON.stringify(popupRows.map((line) => line.trimEnd())) ===
      JSON.stringify(codexNativeStatusPopupRows(plan))
  ) {
    kind = "exact_slash_popup";
  } else {
    return undefined;
  }
  return {
    kind,
    digest: createHash("sha256").update(region.join("\n")).digest("hex")
  };
}

export function exactClaudeNativeInspectionComposerCapture(
  screen: string,
  plan: TerminalNativeInspectionPlan
): {
  digest: string;
  kind: TerminalNativeInspectionMaterializationKind;
} | undefined {
  const frame = exactClaudeComposerFrame(screen);
  if (!frame) {
    return undefined;
  }
  const { lines, openIndex, closeIndex, composerRows, trailing } = frame;
  if (
    composerRows.length !== 1 ||
    !/^\s*❯(?:\s|$)/u.test(composerRows[0]) ||
    composerRows[0].replace(/^\s*❯\s?/u, "").trimEnd() !== plan.command
  ) {
    return undefined;
  }
  let kind: TerminalNativeInspectionMaterializationKind;
  if (trailing.length === 0 || claudeNativeInspectionTrailingIsFooter(trailing)) {
    kind = "exact_slash_composer";
  } else {
    const suggestions: string[] = [];
    for (const line of trailing) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/")) {
        suggestions.push(trimmed.replace(/\s+/gu, " "));
      } else if (suggestions.length > 0) {
        suggestions[suggestions.length - 1] +=
          ` ${trimmed.replace(/\s+/gu, " ")}`;
      } else {
        return undefined;
      }
    }
    if (
      !closedClaudeNativeStatusSuggestionsMatch(
        suggestions,
        CLAUDE_NATIVE_STATUS_POPUP_BY_PROFILE[plan.behaviorProfile]
      )
    ) {
      return undefined;
    }
    kind = "exact_slash_popup";
  }
  return {
    kind,
    digest: createHash("sha256")
      .update(lines.slice(openIndex, closeIndex + 1).concat(trailing).join("\n"))
      .digest("hex")
  };
}

/**
 * Claude truncates a suggestion row with a Unicode ellipsis at narrow pane
 * widths. Keep authorization closed by accepting only an exact ordered row or
 * an explicit ellipsis whose preceding text is an exact, non-trivial prefix of
 * that same profiled row. A caller still cannot introduce, omit, or reorder a
 * slash command.
 */
export function closedClaudeNativeStatusSuggestionsMatch(
  observed: readonly string[],
  expected: readonly string[] | undefined
): boolean {
  if (!expected || observed.length !== expected.length) {
    return false;
  }
  return observed.every((row, index) => {
    const exact = expected[index];
    if (row === exact) {
      return true;
    }
    if (!row.endsWith("…")) {
      return false;
    }
    const prefix = row.slice(0, -1);
    const commandEnd = exact.indexOf(" ");
    return (
      commandEnd > 0 &&
      prefix.length >= commandEnd + 12 &&
      exact.startsWith(prefix)
    );
  });
}

/**
 * Prove Claude Code's exact current idle input frame. This is shared by every
 * automated-input path: a loose or historical `❯` prompt is not authority to
 * inject text into the terminal.
 */
export function isExactClaudeIdleComposer(
  screen: string
): boolean {
  const frame = exactClaudeComposerFrame(screen);
  if (!frame) {
    return false;
  }
  return (
    frame.composerRows.length === 1 &&
    /^\s*❯\s*$/u.test(frame.composerRows[0]) &&
    (
      frame.trailing.length === 0 ||
      claudeNativeInspectionTrailingIsFooter(frame.trailing)
    )
  );
}

/**
 * Compatibility export retained for callers that adopted the native-status
 * name before the same exact-frame proof was reused by lifecycle handoff.
 */
export function isExactClaudeNativeInspectionIdleComposer(
  screen: string
): boolean {
  return isExactClaudeIdleComposer(screen);
}

export function exactClaudeComposerFrame(screen: string): {
  lines: string[];
  openIndex: number;
  closeIndex: number;
  composerRows: string[];
  trailing: string[];
} | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").replace(/\u00a0/gu, " ")
    .split("\n");
  // Named Claude sessions render the display name inside the upper border.
  // It is only frame decoration, never native session or task identity.
  const plainDivider = /^\s*[─━]{8,}\s*$/u;
  const namedDivider = /^\s*[─━]{8,} [^\x00-\x1f\x7f]{1,128} [─━]+\s*$/u;
  const dividerIndexes = lines
    .map((line, index) => plainDivider.test(line) || namedDivider.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (dividerIndexes.length < 2) {
    return undefined;
  }
  const closeIndex = dividerIndexes.at(-1)!;
  if (!plainDivider.test(lines[closeIndex])) {
    return undefined;
  }
  const openIndex = dividerIndexes.at(-2)!;
  return {
    lines,
    openIndex,
    closeIndex,
    composerRows: lines.slice(openIndex + 1, closeIndex)
      .filter((line) => line.trim().length > 0),
    trailing: lines.slice(closeIndex + 1)
      .filter((line) => line.trim().length > 0)
  };
}

export function claudeNativeInspectionTrailingIsFooter(
  lines: readonly string[]
): boolean {
  return lines.length <= 2 && lines.every(isClaudeNativeComposerFooterLine);
}

export function isClaudeNativeComposerFooterLine(line: string): boolean {
  return /^\s*(?:[⏵⏴⏸]{1,2}|\?)\s*.*(?:manual mode|shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
    .test(line);
}

export function nativeInspectionScreenFingerprint(screen: string): string {
  return `sha256:${createHash("sha256").update(screen).digest("hex")}`;
}

export function bareDigestFromNativeInspectionScreenFingerprint(
  fingerprint: string
): string {
  const match = /^sha256:([0-9a-f]{64})$/u.exec(fingerprint);
  if (!match) {
    throw new Error("native inspection screen fingerprint is malformed");
  }
  return match[1];
}

export function stripTerminalEscapeSequences(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/gu,
    ""
  );
}

export function exactCodexReadyStyledComposerCapture(
  screen: string,
  agentVersion?: string
): { digest: string } | undefined {
  if (isCodexPaginatedReadCandidate(agentVersion)) {
    const frame = captureCodexFullscreenComposerFrame(screen, agentVersion);
    if (!frame || !frame.hasShortcutFooter ||
        !["", "Ask Codex to do anything"].includes(frame.composerText)) {
      return undefined;
    }
  }
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (
    lines.length > 0 &&
    stripTerminalEscapeSequences(lines.at(-1) ?? "").trim().length === 0
  ) {
    lines.pop();
  }
  const composerLine = [...lines.slice(-12)].reverse().find((line) =>
    CODEX_COMPOSER_MARKER.test(
      stripTerminalEscapeSequences(line).trimEnd()
    )
  );
  if (composerLine === undefined) {
    return undefined;
  }

  let dim = false;
  const visible: Array<{ character: string; dim: boolean }> = [];
  for (let index = 0; index < composerLine.length;) {
    if (composerLine[index] === "\x1b") {
      const escape = /^(?:\x1B\[([0-9;]*)m|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\))/u
        .exec(composerLine.slice(index));
      if (escape) {
        if (escape[1] !== undefined) {
          const codes = escape[1] === ""
            ? [0]
            : escape[1].split(";").map((value) => Number(value));
          for (let codeIndex = 0; codeIndex < codes.length; codeIndex += 1) {
            const code = codes[codeIndex];
            if (
              [38, 48, 58].includes(code) &&
              codes[codeIndex + 1] === 2
            ) {
              codeIndex += 4;
              continue;
            }
            if (
              [38, 48, 58].includes(code) &&
              codes[codeIndex + 1] === 5
            ) {
              codeIndex += 2;
              continue;
            }
            if (code === 0 || code === 22) {
              dim = false;
            } else if (code === 2) {
              dim = true;
            }
          }
        }
        index += escape[0].length;
        continue;
      }
    }
    const codePoint = composerLine.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    visible.push({ character, dim });
    index += character.length;
  }
  const promptIndex = visible.findIndex(({ character }) =>
    character === "›" || character === "»"
  );
  if (promptIndex < 0) {
    return undefined;
  }
  const content = visible.slice(promptIndex + 1)
    .filter(({ character }) => !/^\s$/u.test(character));
  if (content.length > 0 && !content.every((entry) => entry.dim)) {
    return undefined;
  }
  return {
    digest: createHash("sha256").update(composerLine).digest("hex")
  };
}

/**
 * Infer a viewport only from fixed-width visible-buffer rows. Trimmed captures
 * deliberately return undefined: a short content row is not proof of a short
 * terminal. This keeps the fallback provider-neutral and fail-closed only on
 * positive geometry evidence.
 */
export function inferCodexVisibleViewportColumns(screen: string): number | undefined {
  const rows = screen.replace(/\r\n?/gu, "\n").split("\n")
    .map(stripTerminalEscapeSequences);
  const widthOneRows = rows.filter((row) =>
    /^[\x20-\x7e›»·─━╭╮╰╯│]*$/u.test(row)
  );
  const maxWidth = widthOneRows.reduce(
    (maximum, row) => Math.max(maximum, Array.from(row).length),
    0
  );
  if (maxWidth < 20) {
    return undefined;
  }
  const paddedAtMax = widthOneRows.filter((row) =>
    row.endsWith(" ") && Array.from(row).length === maxWidth
  );
  const composerAtMax = paddedAtMax.some((row) =>
    CODEX_COMPOSER_MARKER.test(row.trimEnd())
  );
  return paddedAtMax.length >= 3 && composerAtMax
    ? maxWidth
    : undefined;
}

export function hasTruncatedCodexStatusSessionLine(screen: string): boolean {
  return screen.replace(/\r\n?/gu, "\n").split("\n").some((line) => {
    const match = /^\s*│\s*Session:\s*([^│\s]+).*│?\s*$/iu.exec(line);
    if (!match) {
      return false;
    }
    return !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(match[1]);
  });
}

export function codexNativeInspectionComposerMismatchDiagnostic(
  screen: string,
  plan: TerminalNativeInspectionPlan
): NativeInspectionSubmissionDiagnostic {
  const expectedRows = codexNativeStatusPopupRows(plan);
  if (!expectedRows) {
    return "composer_not_exact";
  }
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      composerIndex = index;
      break;
    }
  }
  if (
    composerIndex < 0 ||
    lines[composerIndex].replace(/^[›»]\s?/u, "").trimEnd() !== plan.command
  ) {
    return "composer_not_exact";
  }
  const footerIndex = lines.findIndex((line, index) =>
    index > composerIndex && CODEX_COMPOSER_FOOTER.test(line.trim())
  );
  const popupRows = lines.slice(
    composerIndex + 1,
    footerIndex < 0 ? lines.length : footerIndex
  ).filter((line) => line.trim().length > 0);
  if (popupRows.length === 0) {
    return "composer_not_exact";
  }

  const logicalRows: string[] = [];
  let observedTruncation = false;
  for (const row of popupRows) {
    const trimmed = row.trim().replace(/\s+/gu, " ");
    if (trimmed.startsWith("/")) {
      logicalRows.push(trimmed);
    } else if (logicalRows.length > 0) {
      logicalRows[logicalRows.length - 1] += ` ${trimmed}`;
      observedTruncation = true;
    } else {
      return "composer_not_exact";
    }
    observedTruncation ||= trimmed.endsWith("…");
  }
  const normalizedExpected = expectedRows.map((row) =>
    row.trim().replace(/\s+/gu, " ")
  );
  const everyKnownPrefix = logicalRows.length <= normalizedExpected.length &&
    logicalRows.every((row, index) => {
      const withoutEllipsis = row.endsWith("…")
        ? row.slice(0, -1).trimEnd()
        : row;
      return normalizedExpected[index]?.startsWith(withoutEllipsis) === true;
    });
  return observedTruncation && everyKnownPrefix
    ? "composer_viewport_truncated"
    : "composer_not_exact";
}
