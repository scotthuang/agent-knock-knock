import { createHash } from "node:crypto";
import { isCodexPaginatedVersion } from "./codex-lifecycle-compatibility.js";

/** Default retained for existing callers; accepted fullscreen versions remain exact. */
export const CODEX_FULLSCREEN_COMPOSER_VERSION = "0.158.0";
export const CODEX_FULLSCREEN_MODEL_FOOTER =
  /^ {2}(?:GPT-[\w.-]+|gpt-[\w.-]+) (?:low|medium|high|xhigh|max|ultra)(?: fast)? · (?:~\/|\/)[^·\r\n]+(?: · [^·\r\n]+)*$/u;
export const CODEX_FULLSCREEN_SHORTCUT_FOOTER =
  /^ {2}(?:← for agents · )?\? for shortcuts(?: {2,}⚠ [1-9]\d? warnings? · f2 to view)?$/u;
const CODEX_FULLSCREEN_WARNING_FOOTER =
  /^ {2,}⚠ [1-9]\d? warnings? · f2 to view$/u;
const CODEX_FULLSCREEN_QUEUE_FOOTER =
  /^ {2}tab to queue message(?: {2,}⚠ [1-9]\d? warnings? · f2 to view)?$/u;

export interface CodexFullscreenComposerFrame {
  readonly plainLines: readonly string[];
  readonly styledLines: readonly string[];
  readonly composerIndex: number;
  readonly footerIndex: number;
  readonly composerText: string;
  readonly hasShortcutFooter: boolean;
}

function plain(line: string): string {
  return line.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/gu,
    ""
  );
}

/** The footer closes the current main Composer, independently of transcript. */
export function captureCodexFullscreenComposerFrame(
  screen: string,
  version: string | undefined,
  allowMultilineDraft = false
): CodexFullscreenComposerFrame | undefined {
  if (!isCodexPaginatedVersion(version)) return undefined;
  const styledLines = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (styledLines.length && !plain(styledLines.at(-1)!).trim()) {
    styledLines.pop();
  }
  const plainLines = styledLines.map(plain);
  let composerIndex = -1;
  for (let index = plainLines.length - 1; index >= 0; index -= 1) {
    if (/^[›»](?:\s|$)/u.test(plainLines[index]!)) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 0) return undefined;
  const footerIndex = plainLines.findIndex((line, index) =>
    index > composerIndex && CODEX_FULLSCREEN_MODEL_FOOTER.test(line.trimEnd())
  );
  if (footerIndex < 0) return undefined;
  const composerText = plainLines[composerIndex]!.replace(/^[›»]\s?/u, "").trimEnd();
  const footerTail = plainLines.slice(footerIndex + 1).filter((line) => line.trim());
  if (!closedCodexFullscreenFooterTail(footerTail, composerText)) return undefined;
  if (plainLines.slice(composerIndex + 1, footerIndex).some((line) =>
    line.trim() && (!allowMultilineDraft || !line.startsWith("  "))
  )) {
    return undefined;
  }
  return {
    plainLines,
    styledLines,
    composerIndex,
    footerIndex,
    composerText,
    hasShortcutFooter: footerTail.length === 1 &&
      CODEX_FULLSCREEN_SHORTCUT_FOOTER.test(footerTail[0]!.trimEnd())
  };
}

function closedCodexFullscreenFooterTail(
  footerTail: readonly string[],
  composerText: string
): boolean {
  if (footerTail.length === 0) return true;
  if (footerTail.length !== 1) return false;
  const footer = footerTail[0]!.trimEnd();
  return CODEX_FULLSCREEN_SHORTCUT_FOOTER.test(footer) ||
    CODEX_FULLSCREEN_WARNING_FOOTER.test(footer) ||
    !["", "Ask Codex to do anything"].includes(composerText.trim()) &&
      CODEX_FULLSCREEN_QUEUE_FOOTER.test(footer);
}

/** The selected completion list is above the Composer in fullscreen mode. */
export function exactCodexFullscreenSlashComposerCapture(
  screen: string,
  command: string,
  expectedRows: readonly string[],
  requireStyled = false,
  version: string = CODEX_FULLSCREEN_COMPOSER_VERSION
): { readonly digest: string; readonly popup: boolean } | undefined {
  const frame = captureCodexFullscreenComposerFrame(screen, version);
  if (!frame || frame.composerText !== command || frame.hasShortcutFooter) {
    return undefined;
  }
  let popupEnd = frame.composerIndex;
  while (popupEnd > 0 && !frame.plainLines[popupEnd - 1]!.trim()) popupEnd -= 1;
  const popupStart = popupEnd - expectedRows.length;
  if (popupStart < 0 || /^\s*[›»]?\s*\//u.test(frame.plainLines[popupStart - 1] ?? "")) {
    return undefined;
  }
  const rows = frame.plainLines.slice(popupStart, popupEnd).map((line) => line.trimEnd());
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows) || rows.length === 0) {
    return undefined;
  }
  if (requireStyled && (
    !/^\x1b\[1m[›»]\x1b\[0m /u.test(frame.styledLines[frame.composerIndex]!) ||
    ![...frame.styledLines[popupStart]!.matchAll(/\x1b\[([0-9;]*)m/gu)]
      .some((match) => sgrHasReverse(match[1]!))
  )) return undefined;
  return {
    popup: true,
    // The validated queue hint can disappear as native busy state settles.
    // Retain the menu, Composer, and model/path row as the command proof.
    digest: createHash("sha256")
      .update(frame.styledLines.slice(popupStart, frame.footerIndex + 1).join("\n"))
      .digest("hex")
  };
}

/** Reversible cleanup only; a dismissed popup never authorizes command Enter. */
export function exactCodexFullscreenBareCommandCapture(
  screen: string,
  command: string,
  version: string = CODEX_FULLSCREEN_COMPOSER_VERSION
): { readonly digest: string } | undefined {
  const frame = captureCodexFullscreenComposerFrame(screen, version);
  if (!frame || frame.composerText !== command ||
      !/^\x1b\[1m[›»]\x1b\[0m /u.test(frame.styledLines[frame.composerIndex]!)) {
    return undefined;
  }
  let previous = frame.composerIndex - 1;
  while (previous >= 0 && !frame.plainLines[previous]!.trim()) previous -= 1;
  if (/^\s*[›»]?\s*\//u.test(frame.plainLines[previous] ?? "")) {
    return undefined;
  }
  return {
    digest: createHash("sha256")
      .update(frame.styledLines.slice(frame.composerIndex).join("\n"))
      .digest("hex")
  };
}

function sgrHasReverse(parameters: string): boolean {
  const codes = parameters.split(";").map(Number);
  for (let index = 0; index < codes.length; index += 1) {
    if ([38, 48, 58].includes(codes[index]!) && codes[index + 1] === 2) {
      index += 4;
    } else if ([38, 48, 58].includes(codes[index]!) && codes[index + 1] === 5) {
      index += 2;
    } else if (codes[index] === 7) {
      return true;
    }
  }
  return false;
}
