import { createHash } from "node:crypto";
import { exactCodexAstraSparkleReadyStyledComposerCapture } from
  "./codex-astra-composer-proof.js";
import type { TerminalAgentAdapter, TerminalRuntimeIdentity } from
  "./terminal-agent-adapter.js";

import { CLAUDE_INJECTED_PASTE_FRAME_PROFILE } from
  "./claude-injected-paste-proof.js";
import type { ExecutorKind } from "./executors.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  isTerminalModelControlPlanForAgent,
  type TerminalModelControlPlan
} from "./terminal-model-control.js";
import {
  claudeNativeInspectionTrailingIsFooter,
  CODEX_COMPOSER_FOOTER,
  CODEX_COMPOSER_MARKER,
  exactCodexReadyStyledComposerCapture,
  exactClaudeComposerFrame,
  inferCodexVisibleViewportColumns,
  stripTerminalEscapeSequences
} from "./terminal-native-inspection-bridge.js";

const CODEX_COMPLETE_COMPOSER_FOOTER =
  /^(?:gpt-[\w.-]+(?:\s+\S+)?|[-\w.]+ default)\s+·\s+\S.*$/u;
const CODEX_LARGE_PASTE_CHAR_THRESHOLD = 1_000;

/** Current styled readiness; animated emptiness never overrides input owners. */
export function codexAutomatedInputComposerReady(input: {
  screen: string;
  terminalControl: TerminalControlRef;
  runtime?: TerminalRuntimeIdentity;
  adapter(): TerminalAgentAdapter;
}): boolean {
  const sparkleEmpty = exactCodexAstraSparkleReadyStyledComposerCapture(
    input.screen, input.runtime?.agentVersion
  );
  if (!sparkleEmpty) {
    return exactCodexReadyStyledComposerCapture(input.screen) !== undefined;
  }
  const inspection = input.adapter().inspectScreen({
    screen: stripTerminalEscapeSequences(input.screen),
    runtime: input.runtime
  });
  return inspection.activity.state === "idle" && !inspection.approval.blocked &&
    !codexBlockingModalVisible(input.screen) &&
    !terminalUserExplicitTerminalInputOwnerBlocked(input.terminalControl);
}

function exactClaudeModelControlComposerCapture(
  screen: string,
  plan: TerminalModelControlPlan,
  expectedText: string
): { digest: string } | undefined {
  if (
    !isTerminalModelControlPlanForAgent(plan, "claude") ||
    expectedText !== plan.command ||
    expectedText !== "/model"
  ) return undefined;
  const frame = exactClaudeComposerFrame(screen);
  if (
    !frame ||
    frame.composerRows.length !== 1 ||
    frame.composerRows[0].replace(/^\s*❯\s?/u, "").trimEnd() !== expectedText ||
    frame.trailing.length > 2 ||
    !claudeNativeInspectionTrailingIsFooter(frame.trailing)
  ) return undefined;
  const beforeComposer = frame.lines.slice(0, frame.openIndex);
  while (beforeComposer.length > 0 &&
         beforeComposer.at(-1)?.trim() === "") {
    beforeComposer.pop();
  }
  let popupStart = beforeComposer.length;
  while (popupStart > 0) {
    const line = beforeComposer[popupStart - 1];
    if (
      /^\s*(?:(?:❯|›)\s*)?\/[a-z][a-z0-9-]*(?:\s{2,}|\s*$)/iu.test(line) ||
      /^\s{2,}\S/u.test(line)
    ) {
      popupStart -= 1;
      continue;
    }
    break;
  }
  const popupRows = beforeComposer.slice(popupStart);
  if (popupRows.length === 0 || popupRows.length > 32) return undefined;
  const suggestions: Array<{
    lineIndex: number;
    selected: boolean;
    command: string;
    normalized: string;
  }> = [];
  for (const [lineIndex, line] of popupRows.entries()) {
    const match = /^\s*(?:(❯|›)\s*)?(\/[a-z][a-z0-9-]*)(?:\s{2,}|\s*$)(.*)$/iu
      .exec(line);
    if (match) {
      suggestions.push({
        lineIndex,
        selected: Boolean(match[1]),
        command: match[2],
        normalized: `${match[2]} ${match[3]}`.trim().replace(/\s+/gu, " ")
      });
      continue;
    }
    if (suggestions.length === 0 || !/^\s{2,}\S/u.test(line)) {
      return undefined;
    }
    const previous = suggestions.at(-1)!;
    previous.normalized = `${previous.normalized} ${line.trim()}`
      .replace(/\s+/gu, " ");
  }
  if (suggestions.length === 0 || suggestions[0].lineIndex !== 0) {
    return undefined;
  }
  const selected = suggestions.filter((row) => row.selected);
  if (
    selected.length > 1 ||
    selected.length === 1 && selected[0].lineIndex !== 0 ||
    suggestions.slice(1).some((row) => row.command === "/model")
  ) return undefined;
  const first = suggestions[0].normalized;
  if (!/^\/model Set the AI model for Claude Code \(currently [A-Za-z0-9][A-Za-z0-9._:/+\[\]\- ]{0,127}\)$/u.test(first)) {
    return undefined;
  }
  return {
    digest: createHash("sha256")
      .update(frame.lines.slice(frame.openIndex).join("\n"))
      .digest("hex")
  };
}


function codexBlockingModalVisible(screen: string): boolean {
  const tail = screen.replace(/\r\n?/gu, "\n").split("\n").slice(-80)
    .join("\n");
  return /\b(?:press|use)\s+(?:esc|escape)\s+to\s+(?:cancel|close|dismiss)\b/iu
    .test(tail) ||
    /\besc\s+to\s+cancel\b/iu.test(tail) ||
    codexActiveWriterViewerVisible(tail) ||
    ["expanded", "ambiguous"].includes(
      inspectCodexAsyncQuestionInputMode(tail)
    );
}

/**
 * Detect only a positively identified surface that owns terminal input.
 * Ordinary Composer visibility, emptiness, and draft contents deliberately do
 * not participate: a human-explicit Send replaces those contents. Unknown or
 * clipped captures therefore remain advisory, while a known modal/editor/
 * viewer/history-search surface suppresses the advertised Send action.
 */
function terminalUserExplicitInputOwnerBlocked(
  screen: string | undefined
): boolean {
  if (typeof screen !== "string" || screen.length === 0) return false;
  const tail = stripTerminalEscapeSequences(screen)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .slice(-80)
    .join("\n");
  const lines = tail.split("\n");
  let modalFooterIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /\b(?:press|use)\s+(?:esc|escape)\s+to\s+(?:cancel|close|dismiss|go back)\b/iu
        .test(lines[index]!) ||
      /\besc\s+to\s+cancel\b/iu.test(lines[index]!)
    ) {
      modalFooterIndex = index;
      break;
    }
  }
  const laterMainComposer = modalFooterIndex >= 0 && lines.some(
    (line, index) => index > modalFooterIndex &&
      (CODEX_COMPOSER_MARKER.test(line) || /^\s*❯(?:\s|\u00a0|$)/u.test(line))
  );
  return modalFooterIndex >= 0 && !laterMainComposer ||
    codexActiveWriterViewerVisible(screen) ||
    ["expanded", "ambiguous"].includes(
      inspectCodexAsyncQuestionInputMode(screen)
    ) ||
    /(?:\breverse-i-search\b|\bhistory search\b|\bsearch(?:ing)? (?:prompt )?history\b|^\s*search prompts:\s+)/imu
      .test(tail);
}

const TERMINAL_INPUT_OWNER_COMMANDS = new Set([
  "emacs", "emacsclient", "helix", "hx", "kak", "kakoune", "less",
  "man", "micro", "more", "most", "nano", "nvim", "nvimdiff", "pico",
  "vi", "view", "vim", "vimdiff"
]);

/** Reject a foreground editor/viewer process even when its TUI is unfamiliar. */
function terminalUserExplicitTerminalInputOwnerBlocked(
  terminalControl: TerminalControlRef
): boolean {
  const executable = terminalControl.currentCommand?.trim().split(/\s+/u)[0]
    ?.replace(/^["']|["']$/gu, "")
    .split("/").at(-1)?.toLowerCase();
  return executable !== undefined &&
    TERMINAL_INPUT_OWNER_COMMANDS.has(executable);
}

function terminalUserExplicitInputSafetyFailure(input: {
  readonly agent: ExecutorKind;
  readonly displayName: string;
  readonly screen: string;
  readonly terminalControl: TerminalControlRef;
  readonly approvalBlocked: boolean;
  readonly awaitingApproval: boolean;
  readonly interactionActive: boolean;
  readonly modelControlSurface: boolean;
  readonly requireExactEmptyClaudeComposer: boolean;
}): string | undefined {
  if (
    input.approvalBlocked || input.awaitingApproval || input.interactionActive ||
    input.modelControlSurface ||
    terminalUserExplicitTerminalInputOwnerBlocked(input.terminalControl) ||
    terminalUserExplicitInputOwnerBlocked(input.screen) ||
    codexBlockingModalVisible(input.screen)
  ) {
    return `the explicit user Send is blocked by a ${input.displayName} approval, interaction, or modal prompt`;
  }
  if (input.agent === "claude" && input.requireExactEmptyClaudeComposer) {
    const frame = exactClaudeComposerFrame(
      stripTerminalEscapeSequences(input.screen)
    );
    if (!frame || frame.composerRows.length !== 1 ||
        !/^\s*❯\s*$/u.test(frame.composerRows[0]!) ||
        !claudeUserExplicitPostClearTrailingIsKnown(frame.trailing)) {
      return "Claude native stash action did not prove an empty main Composer";
    }
  }
  return undefined;
}

function claudeUserExplicitPostClearTrailingIsKnown(
  lines: readonly string[]
): boolean {
  if (lines.length === 0) return true;
  const auxiliary = (line: string) =>
    /^\s*(?:Draft restored\s*·\s*)?› stashed\s*$/u.test(line) ||
    /^\s*[●○◐◉]\s+(?:low|medium|high|xhigh|max|ultracode)\s*·\s*\/effort\s*$/iu
      .test(line);
  if (lines.every(auxiliary)) return true;
  let auxiliaryStart = lines.length;
  while (auxiliaryStart > 0 && auxiliary(lines[auxiliaryStart - 1]!)) {
    auxiliaryStart -= 1;
  }
  const footerRows = lines.slice(0, auxiliaryStart);
  if (footerRows.length === 0 || footerRows.length > 2) return false;
  const footer = footerRows.map((line) => line.trim()).join(" ");
  return /^\s*(?:[⏵⏴⏸]{1,2}|\?)\s+.*(?:manual mode|auto mode|accept edits|bypass permissions|for shortcuts).*(?:←\s+for\s+ag(?:ents|…)|\(shift\+tab\s+to\s+cycle\))(?:\s+(?:Draft restored\s*·\s*)?› stashed)?\s*$/iu
    .test(footer);
}

function codexActiveWriterViewerVisible(styledScreen: string): boolean {
  const lines = stripTerminalEscapeSequences(styledScreen)
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .slice(-80);
  let titleIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /^ {2}🔒(?:\s|$)/u.test(lines[index]!)
    ) {
      titleIndex = index;
      break;
    }
  }
  if (titleIndex < 0) {
    return false;
  }
  const laterMainComposer = lines.findIndex((line, index) =>
    index > titleIndex && CODEX_COMPOSER_MARKER.test(line)
  );
  if (laterMainComposer >= 0) {
    return false;
  }
  const frame = lines.slice(titleIndex, titleIndex + 12)
    .map((line) => line.trim().replace(/\s+/gu, " "))
    .filter((line) => line.length > 0)
    .join(" ");
  return /🔒\s+This conversation is open in another app\s+\S+ to Retry/iu
      .test(frame) &&
    /Close it there and press\s+\S+\s+to continue here\./iu.test(frame) &&
    /\S+ retry\s+\S+ exit(?:\s+\S+ transcript)?/iu.test(frame);
}

export type CodexAsyncQuestionInputMode =
  | "absent"
  | "collapsed"
  | "expanded"
  | "ambiguous";

const CODEX_ASYNC_QUESTION_FOOTER_LABEL =
  /\s(submit|skip|main prompt|prev question|next question|queued messages)(?=\s{2,}|\s*$)/giu;

function codexStructuredAsyncFooterEvidence(
  lines: readonly string[],
  evidenceFloor: number
): { readonly index: number; readonly labelCount: number } {
  let strongest = { index: -1, labelCount: 0 };
  for (let start = evidenceFloor + 1; start < lines.length; start += 1) {
    const labels = new Set<string>();
    for (let end = start; end < Math.min(lines.length, start + 5); end += 1) {
      const line = lines[end]!;
      if (!/^ {2}(?![ ↳?])\S/u.test(line)) {
        break;
      }
      for (const match of line.matchAll(CODEX_ASYNC_QUESTION_FOOTER_LABEL)) {
        labels.add(match[1]!.toLowerCase());
      }
      if (labels.size > strongest.labelCount) {
        strongest = { index: end, labelCount: labels.size };
      }
      if (labels.size >= 2) {
        return strongest;
      }
    }
  }
  return strongest;
}

function codexMainComposerFooterIndex(
  lines: readonly string[],
  composerIndex: number
): number {
  for (let index = lines.length - 1; index > composerIndex; index -= 1) {
    // A real statusline starts at column zero. Draft continuations are inset,
    // even when their text happens to look exactly like a model statusline.
    if (CODEX_COMPLETE_COMPOSER_FOOTER.test(lines[index]!.trimEnd())) {
      return index;
    }
  }
  return -1;
}

/**
 * Classify Codex 0.154's non-blocking inline-question surface by current input
 * ownership. The shared `Queued follow-up inputs` heading is not sufficient:
 * ordinary queued messages use it too. An exact collapsed summary, after any
 * ordinary queue preview is removed, proves Send-safe ownership even when the
 * Composer is outside the viewport. Positive editor evidence without a
 * complete shape remains fail-closed because paste plus Enter would otherwise
 * submit the user's task as an answer.
 */
export function inspectCodexAsyncQuestionInputMode(
  styledScreen: string
): CodexAsyncQuestionInputMode {
  const lines = stripTerminalEscapeSequences(styledScreen)
    .replace(/\r\n?/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .split("\n")
    .slice(-80);
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }
  const normalized = lines.map((line) => line.trim().replace(/\s+/gu, " "));
  let mainComposerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    // The main Composer marker is column zero. Async option and inline-text
    // markers are inset by the menu surface, even after ANSI is removed.
    if (CODEX_COMPOSER_MARKER.test(lines[index]!)) {
      mainComposerIndex = index;
      break;
    }
  }

  let headerIndex = -1;
  let wrappedHeaderRows = 1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (
      /^•\s+Queued follow-up inputs\s*$/u.test(lines[index]!) ||
      /^•\s+Queued follow-up inpu…\s*$/u.test(lines[index]!) ||
      (
        /^•\s+Queued follow-up\s*$/u.test(lines[index]!) &&
        /^ {2}inputs\s*$/u.test(lines[index + 1] ?? "")
      )
    ) {
      headerIndex = index;
      wrappedHeaderRows = /^•\s+Queued follow-up\s*$/u.test(lines[index]!)
        ? 2
        : 1;
      break;
    }
  }
  const headerBodyIndex = headerIndex < 0
    ? -1
    : headerIndex + wrappedHeaderRows;
  let questionEvidenceStart = headerBodyIndex;
  if (headerIndex >= 0) {
    let cursor = headerBodyIndex;
    while (cursor < lines.length && lines[cursor]!.trim().length === 0) {
      cursor += 1;
    }
    let sawQueuedPreview = false;
    while (cursor < lines.length) {
      if (/^ {2}↳\s/u.test(lines[cursor]!)) {
        sawQueuedPreview = true;
        cursor += 1;
        while (cursor < lines.length) {
          if (
            lines[cursor]!.trim().length === 0 ||
            /^ {4,}\S/u.test(lines[cursor]!)
          ) {
            cursor += 1;
            continue;
          }
          break;
        }
        continue;
      }
      break;
    }
    if (sawQueuedPreview) {
      questionEvidenceStart = cursor;
    }
  }

  const mainComposerFooterIndex = mainComposerIndex < 0
    ? -1
    : codexMainComposerFooterIndex(lines, mainComposerIndex);
  const summaryBeforeMainComposer = headerIndex < 0 || mainComposerIndex < 0
    ? -1
    : normalized.findIndex((line, index) =>
      index >= questionEvidenceStart && index < mainComposerIndex &&
      /^\?\s+\d+\s+questions?(?:\s+·\s+\d+s)?$/iu.test(line)
    );
  if (mainComposerIndex >= 0 && mainComposerFooterIndex < 0) {
    // A statusline-disabled Composer is the strongest available ownership
    // anchor. Treat all following wrapped rows as its arbitrary draft instead
    // of letting question-like user text veto a human-priority Send.
    return summaryBeforeMainComposer >= 0 ? "collapsed" : "absent";
  }

  const evidenceFloor = Math.max(
    mainComposerFooterIndex,
    questionEvidenceStart - 1
  );
  const structuredFooter = codexStructuredAsyncFooterEvidence(
    lines,
    evidenceFloor
  );
  if (structuredFooter.labelCount >= 2) {
    return "expanded";
  }

  const clippedFooterIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor && /^ente(?:r)?…$/iu.test(line) &&
    /^ctrl…$/iu.test(normalized[index + 1] ?? "")
  );
  const clippedChoiceIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor &&
    line === "Expand terminal to read the entire option"
  );
  if (clippedFooterIndex >= 0 || clippedChoiceIndex >= 0) {
    return "ambiguous";
  }

  if (headerIndex < 0) {
    const evidence = new Set<string>();
    normalized.forEach((line, index) => {
      if (index <= evidenceFloor) {
        return;
      }
      if (/^\d+\s+of(?:\s+\d+)?$/iu.test(line)) {
        evidence.add("progress");
      }
      if (/^›\s+\S/u.test(line)) {
        evidence.add("selector");
      }
      if (/^Type your answer(?:\s*\(optional\))?$/iu.test(line)) {
        evidence.add("free_text");
      }
    });
    return evidence.size >= 2 ||
        (evidence.size >= 1 && structuredFooter.labelCount >= 1)
      ? "ambiguous"
      : "absent";
  }

  const weakQuestionIndex = normalized.findIndex((line, index) =>
    index > evidenceFloor && index >= questionEvidenceStart && (
      /^\d+\s+of(?:\s+\d+)?$/iu.test(line) ||
      /^›\s+\S/u.test(line) ||
      /^Type your answer(?:\s*\(optional\))?$/iu.test(line)
    )
  );
  if (mainComposerIndex > headerIndex && weakQuestionIndex > evidenceFloor) {
    return "ambiguous";
  }

  const summaryIndex = normalized.findIndex((line, index) =>
    index >= questionEvidenceStart &&
    (mainComposerIndex < 0 || index < mainComposerIndex) &&
    /^\?\s+\d+\s+questions?(?:\s+·\s+\d+s)?$/iu.test(line)
  );
  if (summaryIndex >= 0) {
    return weakQuestionIndex >= 0 ? "ambiguous" : "collapsed";
  }
  if (mainComposerIndex > headerIndex) {
    return "absent";
  }
  const afterHeader = normalized.slice(questionEvidenceStart)
    .filter((line) => line.length > 0);
  const positiveAfterHeader = afterHeader.some((line) =>
      /^\d+\s+of(?:\s+\d+)?$/iu.test(line) ||
      /^›\s+\d+\.(?:\s|$)/u.test(line) ||
      /^Type your answer(?:\s*\(optional\))?$/iu.test(line)
    );
  if (positiveAfterHeader) {
    return "ambiguous";
  }

  // A bare heading (optionally followed by ↳ queued-message previews) is not
  // question authority. Preserve human-explicit Send in that ordinary state.
  if (
    afterHeader.length === 0
  ) {
    return "absent";
  }

  // An expanded editor can temporarily replace its footer with a flash. If
  // there is question-like content under the shared heading and no proven main
  // Composer, do not guess which input surface will receive the next paste.
  return "ambiguous";
}

/**
 * Classify only the bottom live Codex composer region. A matching transcript
 * prompt elsewhere in scrollback is deliberately ignored.
 */
function currentCodexComposerCapture(
  styledScreen: string,
  expectedText: string,
  allowOpaqueLargePastePlaceholder = false,
  classifyOpaqueLargePasteAsDifferent = false,
  exactSlashPopupRows?: readonly string[],
  allowStyledSlashPopupWithoutViewportPaint = false,
  agentVersion?: string
): {
  state: "exact_draft" | "exact_empty" | "different_draft";
  digest: string;
  profiledSlashPopup?: true;
  bareCommand?: true;
} | undefined {
  const sparkleEmpty = exactCodexAstraSparkleReadyStyledComposerCapture(
    styledScreen, agentVersion
  );
  if (sparkleEmpty) return { state: "exact_empty", digest: sparkleEmpty.digest };
  const screen = stripTerminalEscapeSequences(styledScreen);
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }
  let composerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(lines[index])) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) {
    return undefined;
  }
  const footerIndex = lines.findIndex((line, index) =>
    index > composerIndex &&
    CODEX_COMPLETE_COMPOSER_FOOTER.test(line.trim())
  );
  if (
    footerIndex >= 0 &&
    lines.slice(footerIndex + 1).some((line) => line.trim().length > 0)
  ) {
    return undefined;
  }
  const regionEnd = footerIndex < 0 ? lines.length : footerIndex;
  const region = lines.slice(composerIndex, regionEnd);
  while (region.length > 1 && region.at(-1)?.trim().length === 0) {
    region.pop();
  }
  if (
    region.length === 0 ||
    region.slice(1).some((line) => line.length > 0 && !line.startsWith("  "))
  ) {
    return undefined;
  }
  const bodyRows = [
    region[0].replace(/^[›»]\s?/u, ""),
    ...region.slice(1).map((line) => line.startsWith("  ") ? line.slice(2) : line)
  ];
  const digest = createHash("sha256").update(region.join("\n")).digest("hex");
  const positivelyEmpty = footerIndex >= 0 &&
    bodyRows.slice(1).every((row) => row.trim().length === 0) &&
    exactCodexReadyStyledComposerCapture(styledScreen) !== undefined;
  if (positivelyEmpty) {
    return { state: "exact_empty", digest };
  }
  const expectedComparable = composerComparableText(expectedText);
  const exactStyledProfiledCommand = exactSlashPopupRows !== undefined &&
    exactCodexStyledCommandComposerCapture(
      styledScreen,
      expectedText
    ) !== undefined;
  const exactFooterlessProfiledCommand = footerIndex < 0 &&
    exactStyledProfiledCommand;
  const exactStyledProfiledPopup =
    allowStyledSlashPopupWithoutViewportPaint &&
    exactSlashPopupRows !== undefined &&
    exactCodexStyledSlashPopupCapture(
      styledScreen,
      expectedText,
      exactSlashPopupRows
    );
  // Profiled Codex releases replace the ordinary model/cwd footer with their slash
  // completion surface. Real terminal renderers may retain one or more blank
  // layout rows between the Composer and that surface. The exact styled
  // command is sufficient only for reversible cleanup; Enter additionally
  // requires the unique, ordered, version-profiled completion rows below.
  const popupRows = region.slice(1).map((row) => row.trimEnd());
  const exactPopupLayout =
    exactSlashPopupRows !== undefined && (
      JSON.stringify(popupRows) === JSON.stringify(exactSlashPopupRows) ||
      popupRows.length === exactSlashPopupRows.length + 1 &&
        popupRows[0] === "" &&
        JSON.stringify(popupRows.slice(1)) ===
          JSON.stringify(exactSlashPopupRows)
    );
  const exactProfiledSlashPopup =
    exactSlashPopupRows !== undefined &&
    (exactStyledProfiledCommand || exactStyledProfiledPopup) &&
    composerComparableText(bodyRows[0] ?? "").trimEnd() ===
      expectedComparable &&
    exactPopupLayout;
  if (
    footerIndex < 0 &&
    !exactFooterlessProfiledCommand &&
    !exactProfiledSlashPopup
  ) {
    return undefined;
  }

  const expectedCharacterCount = Array.from(expectedText).length;
  const comparable = composerComparableText(bodyRows.join("\n"));
  const opaqueLargePastePlaceholder =
    /^\[Pasted Content \d+ chars\]$/u.test(comparable);
  if (opaqueLargePastePlaceholder && !allowOpaqueLargePastePlaceholder) {
    return classifyOpaqueLargePasteAsDifferent
      ? { state: "different_draft", digest }
      : undefined;
  }
  // Herdr's ANSI visible buffer preserves Codex's fixed-width Composer paint:
  // the typed command is followed by layout padding through the viewport edge.
  // Accept that padding only when a closed profile, full-row
  // background paint, exact command text, and complete model/cwd footer all
  // agree. Plain padded text remains untrusted.
  const exactVisibleDraft = footerIndex >= 0 && (
    terminalComposerRowsMatchExpected(bodyRows, expectedComparable) ||
    exactStyledProfiledCommand
  );
  const exactLargePastePlaceholder =
    allowOpaqueLargePastePlaceholder &&
    expectedCharacterCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD &&
    comparable === composerComparableText(
      `[Pasted Content ${expectedCharacterCount} chars]`
    );
  if (
    exactVisibleDraft ||
    exactLargePastePlaceholder ||
    exactProfiledSlashPopup ||
    exactFooterlessProfiledCommand
  ) {
    return {
      state: "exact_draft",
      digest,
      ...(exactProfiledSlashPopup ? { profiledSlashPopup: true as const } : {}),
      ...(exactVisibleDraft && footerIndex >= 0
        ? { bareCommand: true as const }
        : {})
    };
  }
  return comparable.length > 0
    ? { state: "different_draft", digest }
    : undefined;
}

/**
 * Prove the Codex 0.155.1 tmux slash popup without requiring the legacy
 * viewport-wide background paint. The active Composer marker and the single
 * native completion row must retain their exact, distinct TUI styles; plain
 * transcript text with the same words remains non-authoritative.
 */
function exactCodexStyledSlashPopupCapture(
  styledScreen: string,
  expectedText: string,
  exactSlashPopupRows: readonly string[]
): boolean {
  const rows = styledScreen.replace(/\r\n?/gu, "\n").split("\n");
  while (
    rows.length > 0 &&
    stripTerminalEscapeSequences(rows.at(-1) ?? "").trim().length === 0
  ) {
    rows.pop();
  }
  let composerIndex = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (CODEX_COMPOSER_MARKER.test(stripTerminalEscapeSequences(rows[index]))) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) return false;
  const composerRow = rows[composerIndex] ?? "";
  const plainComposer = stripTerminalEscapeSequences(composerRow).trimEnd();
  const marker = plainComposer.match(/^([›»])\s/u)?.[1];
  if (
    !marker ||
    plainComposer.replace(/^[›»]\s?/u, "") !== expectedText ||
    composerRow !== `\x1b[1m${marker}\x1b[0m ${expectedText}`
  ) {
    return false;
  }
  const popupRows = rows.slice(composerIndex + 1).filter((row) =>
    stripTerminalEscapeSequences(row).trim().length > 0
  );
  if (
    JSON.stringify(popupRows.map((row) =>
      stripTerminalEscapeSequences(row).trimEnd()
    )) !== JSON.stringify(exactSlashPopupRows)
  ) {
    return false;
  }
  return popupRows.every((row, index) => {
    const expected = exactSlashPopupRows[index] ?? "";
    const leading = expected.match(/^(\s*)/u)?.[1] ?? "";
    const content = expected.slice(leading.length);
    return row ===
      `${leading}\x1b[1m\x1b[38;5;6m${content}\x1b[0m`;
  });
}

/**
 * Prove the live footerless Codex slash Composer without trusting transcript
 * text alone. Profiled Codex TUI builds can paint this row across the current viewport while
 * its completion popup replaces the ordinary model/cwd footer.
 */
function exactCodexStyledCommandComposerCapture(
  styledScreen: string,
  expectedText: string
): { digest: string } | undefined {
  const rows = styledScreen.replace(/\r\n?/gu, "\n").split("\n");
  const viewportColumns = inferCodexVisibleViewportColumns(styledScreen);
  if (!viewportColumns) return undefined;
  let composerLine: string | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const plain = stripTerminalEscapeSequences(rows[index]);
    if (CODEX_COMPOSER_MARKER.test(plain)) {
      composerLine = rows[index];
      break;
    }
  }
  if (!composerLine) return undefined;
  const plain = stripTerminalEscapeSequences(composerLine);
  const exactCommand = plain.trimEnd().replace(/^[›»]\s?/u, "") ===
    expectedText;
  const spansViewport = Array.from(plain).length === viewportColumns &&
    plain.endsWith(" ");
  const hasBackground = [...composerLine.matchAll(/\x1b\[([0-9;]*)m/gu)]
    .some((match) => match[1].split(";").map(Number).includes(48));
  if (!exactCommand || !spansViewport || !hasBackground) {
    return undefined;
  }
  return {
    digest: createHash("sha256").update(composerLine).digest("hex")
  };
}

function exactCodexComposerCapture(
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  const expectedComparable = composerComparableText(expectedText);
  const expectedCharacterCount = Array.from(expectedText).length;
  const largePasteComparable = composerComparableText(
    `[Pasted Content ${expectedCharacterCount} chars]`
  );
  const matches: { digest: string }[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!CODEX_COMPOSER_MARKER.test(lines[index])) {
      continue;
    }
    const footerIndex = lines.findIndex((line, candidateIndex) =>
      candidateIndex > index && CODEX_COMPOSER_FOOTER.test(line.trim())
    );
    const region = lines.slice(
      index,
      footerIndex < 0 ? lines.length : footerIndex
    );
    while (region.length > 1 && region.at(-1)?.trim() === "") {
      region.pop();
    }
    const bodyRows = [
      region[0].replace(/^[›»]\s?/u, ""),
      ...region.slice(1).map((line) =>
        line.startsWith("  ") ? line.slice(2) : line
      )
    ];
    const comparable = composerComparableText(bodyRows.join("\n"));
    const exactVisibleDraft = terminalComposerRowsMatchExpected(
      bodyRows,
      expectedComparable
    );
    const exactLargePastePlaceholder =
      expectedCharacterCount > CODEX_LARGE_PASTE_CHAR_THRESHOLD &&
      comparable === largePasteComparable;
    if (!exactVisibleDraft && !exactLargePastePlaceholder) {
      continue;
    }
    matches.push({
      digest: createHash("sha256")
        .update(region.join("\n"))
        .digest("hex")
    });
  }

  if (matches.length > 1) {
    throw new Error(
      "multiple Codex composer regions matched the multiline terminal request"
    );
  }
  return matches[0];
}

/**
 * Terminal UIs paint wrapped composer content as independent screen rows, so
 * a provider capture cannot distinguish a visual wrap from an authored
 * newline. Align the rows against the exact text AKK injected instead of
 * joining every row with `\n`.
 *
 * Only row boundaries are ambiguous: they may consume an authored newline, an
 * omitted run of ASCII spaces at a word wrap, or no character at a CJK/token
 * wrap. Every visible character remains character-for-character exact, and an
 * empty row can only advance through an authored newline (plus terminal-trimmed
 * spaces before it), so blank-line structure is preserved.
 */
function terminalComposerRowsMatchExpected(
  rows: readonly string[],
  expectedText: string
): boolean {
  const expected = composerComparableText(expectedText);
  if (rows.length === 0) {
    return expected.length === 0;
  }
  if (!expected.startsWith(rows[0])) {
    return false;
  }

  let offsets = new Set<number>([rows[0].length]);
  for (let index = 1; index < rows.length && offsets.size > 0; index += 1) {
    const row = rows[index];
    const previousRow = rows[index - 1];
    const nextOffsets = new Set<number>();
    for (const offset of offsets) {
      const candidateStarts = new Set<number>();
      if (expected[offset] === "\n") {
        candidateStarts.add(offset + 1);
      }
      let whitespaceEnd = offset;
      while (expected[whitespaceEnd] === " ") {
        whitespaceEnd += 1;
      }
      if (previousRow.length > 0 && row.length > 0) {
        candidateStarts.add(offset);
        if (whitespaceEnd > offset) {
          candidateStarts.add(whitespaceEnd);
        }
      }
      if (
        whitespaceEnd > offset &&
        expected[whitespaceEnd] === "\n"
      ) {
        candidateStarts.add(whitespaceEnd + 1);
      }
      for (const candidateStart of candidateStarts) {
        if (expected.startsWith(row, candidateStart)) {
          nextOffsets.add(candidateStart + row.length);
        }
      }
    }
    offsets = nextOffsets;
  }
  return offsets.has(expected.length);
}

function exactTerminalComposerCapture(
  agent: ExecutorKind,
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  return agent === "codex"
    ? exactCodexComposerCapture(screen, expectedText)
    : exactClaudeComposerCapture(screen, expectedText);
}

function exactClaudeComposerCapture(
  screen: string,
  expectedText: string
): { digest: string } | undefined {
  const lines = screen.replace(/\r\n?/gu, "\n").split("\n");
  const dividerIndexes = lines
    .map((line, index) => /^\s*[─━]{8,}\s*$/u.test(line) ? index : -1)
    .filter((index) => index >= 0);
  if (dividerIndexes.length < 2) {
    return undefined;
  }
  const closeIndex = dividerIndexes.at(-1)!;
  const openIndex = dividerIndexes.at(-2)!;
  const trailing = lines.slice(closeIndex + 1)
    .filter((line) => line.trim().length > 0);
  if (
    trailing.length > 2 ||
    trailing.some((line) =>
      !/^\s*(?:[⏵⏴⏸]{1,2}|\?)\s*.*(?:manual mode|shift\+tab|accept edits|bypass permissions|for shortcuts|← for agents)/iu
        .test(line)
    )
  ) {
    return undefined;
  }
  const region = lines.slice(openIndex + 1, closeIndex);
  while (region.length > 1 && region.at(-1)?.trim() === "") {
    region.pop();
  }
  if (region.length === 0 || !/^\s*❯(?:\s|$)/u.test(region[0])) {
    return undefined;
  }
  const bodyRows = [
    region[0].replace(/^\s*❯\s?/u, ""),
    ...region.slice(1).map((line) =>
      line.startsWith("  ") ? line.slice(2) : line
    )
  ];
  if (!terminalComposerRowsMatchExpected(bodyRows, expectedText)) {
    return undefined;
  }
  return {
    digest: createHash("sha256")
      .update(lines.slice(openIndex, closeIndex + 1).join("\n"))
      .digest("hex")
  };
}

function exactClaudeInjectedPastePlaceholderCapture(
  screen: string,
  expectedText: string
): {
  state: "exact_injected_paste_placeholder";
  digest: string;
  pasteId: number;
  newlineCount: number;
  frameProfile: string;
} | undefined {
  const expectedNewlineCount = (
    composerComparableText(expectedText).match(/\n/gu) ?? []
  ).length;
  if (expectedNewlineCount === 0) {
    return undefined;
  }
  const frame = exactClaudeComposerFrame(screen);
  if (
    !frame ||
    frame.composerRows.length !== 1 ||
    !claudeInjectedPastePlaceholderTrailingMatches(frame.trailing)
  ) {
    return undefined;
  }
  const placeholder =
    /^\s*❯\s*\[Pasted text #([1-9]\d*) \+([1-9]\d*) lines\]\s*$/u
      .exec(frame.composerRows[0]);
  if (!placeholder) {
    return undefined;
  }
  const pasteId = Number(placeholder[1]);
  const newlineCount = Number(placeholder[2]);
  if (
    !Number.isSafeInteger(pasteId) ||
    !Number.isSafeInteger(newlineCount) ||
    newlineCount !== expectedNewlineCount
  ) {
    return undefined;
  }
  return {
    state: "exact_injected_paste_placeholder",
    digest: createHash("sha256")
      .update(
        frame.lines
          .slice(frame.openIndex, frame.closeIndex + 1)
          .concat(frame.trailing)
          .join("\n")
      )
      .digest("hex"),
    pasteId,
    newlineCount,
    frameProfile: CLAUDE_INJECTED_PASTE_FRAME_PROFILE
  };
}

function claudeInjectedPastePlaceholderTrailingMatches(
  lines: readonly string[]
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const hint = "paste again to expand";
  const first = lines[0].trimStart();
  if (!first.startsWith(hint)) {
    return false;
  }
  const sameRowStatus = first.slice(hint.length);
  if (sameRowStatus.length > 0 && !/^\s{2,}\S/u.test(sameRowStatus)) {
    return false;
  }
  const footerRows = [
    ...(sameRowStatus.trim().length > 0 ? [sameRowStatus.trim()] : []),
    ...lines.slice(1).map((line) => line.trim())
  ];
  return footerRows.length === 0 ||
    claudeNativeInspectionTrailingIsFooter(footerRows) ||
    claudeInjectedPasteAuxiliaryFooterMatches(footerRows);
}

function claudeInjectedPasteAuxiliaryFooterMatches(
  lines: readonly string[]
): boolean {
  if (lines.length === 0 || lines.length > 2) {
    return false;
  }
  const autoUpdate = lines.filter((line) =>
    line === "✘ Auto-update failed · Run claude doctor"
  ).length;
  const effort = lines.filter((line) =>
    /^[●○◐◉] (?:low|medium|high|xhigh|max|ultracode) · \/effort$/u
      .test(line)
  ).length;
  return autoUpdate <= 1 && effort <= 1 &&
    autoUpdate + effort === lines.length;
}

function composerComparableText(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

export {
  codexActiveWriterViewerVisible,
  codexBlockingModalVisible,
  currentCodexComposerCapture,
  exactClaudeComposerCapture,
  exactClaudeInjectedPastePlaceholderCapture,
  exactClaudeModelControlComposerCapture,
  exactTerminalComposerCapture,
  terminalUserExplicitInputSafetyFailure,
  terminalUserExplicitTerminalInputOwnerBlocked,
  terminalUserExplicitInputOwnerBlocked,
  terminalComposerRowsMatchExpected
};
