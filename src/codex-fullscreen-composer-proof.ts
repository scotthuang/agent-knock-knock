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
    !hasCodexComposerMarkerStyle(frame.styledLines[frame.composerIndex]!) ||
    !hasCodexSelectedPopupStyle(frame.styledLines[popupStart]!)
  )) return undefined;
  return {
    popup: true,
    // The validated queue hint can disappear as native busy state settles.
    // Retain the menu, Composer, and model/path row as the command proof.
    digest: createHash("sha256")
      .update(frame.styledLines.slice(popupStart, frame.footerIndex + 1)
        // Herdr's detection text trims terminal background padding, whereas
        // its visible ANSI buffer preserves it. Only plain proofs normalize
        // these trailing spaces; leading columns and all content remain exact.
        .map((line) => requireStyled ? line : line.trimEnd()).join("\n"))
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
      !hasCodexComposerMarkerStyle(frame.styledLines[frame.composerIndex]!)) {
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

interface CodexCellStyle {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly reverse: boolean;
  readonly foreground?: string;
  readonly background?: string;
}

interface CodexStyledCharacter {
  readonly character: string;
  readonly style: CodexCellStyle;
}

const RESET_STYLE: CodexCellStyle = { bold: false, dim: false, reverse: false };

function hasCodexComposerMarkerStyle(line: string): boolean {
  const cells = codexStyledCharacters(line);
  const marker = cells?.[0];
  return marker !== undefined && /^[›»]$/u.test(marker.character) &&
    marker.style.bold && !marker.style.dim && !marker.style.reverse &&
    cells![1]?.character === " " &&
    cells!.every(({ style }) => !style.dim && !style.reverse);
}

function hasCodexSelectedPopupStyle(line: string): boolean {
  const cells = codexStyledCharacters(line)?.filter(({ character }) => character.trim());
  const marker = cells?.[0];
  if (!marker || !/^[›»]$/u.test(marker.character) || !marker.style.bold) return false;
  // Codex style/contrast.rs uses reverse when the terminal background is
  // unknown. With truecolor background detection it instead paints one of
  // these two native blue fills and the fixed dark readable foreground.
  return cells!.every(({ style }) => !style.dim && (marker.style.reverse
    ? style.reverse
    : !style.reverse && style.foreground === "rgb:0,0,46" &&
      ["rgb:99,168,248", "rgb:164,205,251"].includes(style.background ?? "") &&
      style.background === marker.style.background));
}

function codexStyledCharacters(line: string): readonly CodexStyledCharacter[] | undefined {
  const cells: CodexStyledCharacter[] = [];
  let style: CodexCellStyle = RESET_STYLE;
  for (let offset = 0; offset < line.length;) {
    if (line[offset] === "\x1b") {
      const escape = /^\x1b\[([0-9;]*)m/u.exec(line.slice(offset));
      if (!escape) return undefined;
      const next = codexSgrStyle(style, escape[1]!);
      if (!next) return undefined;
      style = next;
      offset += escape[0].length;
      continue;
    }
    const character = String.fromCodePoint(line.codePointAt(offset)!);
    if (/[\u0000-\u001F\u007F-\u009F]/u.test(character)) return undefined;
    cells.push({ character, style });
    offset += character.length;
  }
  return cells;
}

function codexSgrStyle(previous: CodexCellStyle, parameters: string): CodexCellStyle | undefined {
  const codes = parameters.split(";").map(Number);
  let style = previous;
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if ([38, 48].includes(code)) {
      const color = codexSgrColor(codes.slice(index + 1));
      if (!color) return undefined;
      style = { ...style, [code === 38 ? "foreground" : "background"]: color.value };
      index += color.length;
    } else {
      const next = codexSimpleSgrStyle(style, code);
      if (!next) return undefined;
      style = next;
    }
  }
  return style;
}

function codexSgrColor(codes: readonly number[]): { value: string; length: number } | undefined {
  const size = codes[0] === 2 ? 3 : codes[0] === 5 ? 1 : 0;
  const components = codes.slice(1, size + 1);
  if (!size || components.length !== size || components.some((value) => value < 0 || value > 255)) {
    return undefined;
  }
  return { value: `${size === 3 ? "rgb" : "indexed"}:${components.join(",")}`, length: size + 1 };
}

function codexSimpleSgrStyle(style: CodexCellStyle, code: number): CodexCellStyle | undefined {
  if (code === 0) return RESET_STYLE;
  if (code === 1) return { ...style, bold: true };
  if (code === 2) return { ...style, dim: true };
  if (code === 7) return { ...style, reverse: true };
  if (code === 22) return { ...style, bold: false, dim: false };
  if (code === 27) return { ...style, reverse: false };
  if (code === 39) return { ...style, foreground: undefined };
  if (code === 49) return { ...style, background: undefined };
  if (code >= 30 && code <= 37 || code >= 90 && code <= 97) {
    return { ...style, foreground: `ansi:${code}` };
  }
  if (code >= 40 && code <= 47 || code >= 100 && code <= 107) {
    return { ...style, background: `ansi:${code}` };
  }
  return undefined;
}
