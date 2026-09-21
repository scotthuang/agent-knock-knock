import { createHash } from "node:crypto";
import { stripTerminalEscapeSequences } from
  "./terminal-native-inspection-bridge.js";

const CODEX_ASTRA_PLACEHOLDER = "Ask Codex to do anything";
const CODEX_ASTRA_SPARKLE = /^[⠁⠂⠄⠈⠐⠠⡀⢀]$/u;

/**
 * Opt-in proof for managed text submission only. In Codex 0.155.1 stars also
 * surround real drafts: their presence is never emptiness evidence. Require
 * the complete dim placeholder and the true-color painted Composer instead.
 * Unstyled/status-only captures and the older reduced ANSI goldens cannot
 * authorize input. Keep native lifecycle/model/list callers on the old proof.
 */
export function exactCodexAstraSparkleReadyStyledComposerCapture(
  screen: string,
  agentVersion: string | undefined
): { digest: string } | undefined {
  if (agentVersion !== "0.154.0" && agentVersion !== "0.155.1") {
    return undefined;
  }
  const frame = codexAstraComposerFrame(screen);
  if (!frame) return undefined;
  const paint = codexAstraEmptyComposerPaint(frame.painted);
  if (!paint) return undefined;
  // Animation changes are equivalent only after every painted cell has passed
  // the proof. A draft, style drift, missing footer, or input owner still fails
  // on each fresh capture before this stable semantic digest is produced.
  return {
    digest: createHash("sha256").update(JSON.stringify({
      profile: `codex-${agentVersion}-astra-empty-v1`,
      marker: paint.marker,
      placeholder: CODEX_ASTRA_PLACEHOLDER,
      background: paint.background,
      footer: frame.footer
    })).digest("hex")
  };
}

function codexAstraComposerFrame(screen: string): {
  painted: CodexAstraStyledCell[][];
  footer: string;
} | undefined {
  const rows = screen.replace(/\r\n?/gu, "\n").split("\n");
  while (rows.length && !stripTerminalEscapeSequences(rows.at(-1)!).trim()) {
    rows.pop();
  }
  const footer = stripTerminalEscapeSequences(rows.at(-1) ?? "").trim();
  if (
    !/^gpt-6-astra\s+(?:low|medium|high|xhigh|max|ultra)\s+·\s+(?:~\/|\/)[^·\r\n]+(?:\s+·\s+[^·\r\n]+)+$/u.test(footer) ||
    footer.includes("…") || footer.endsWith("...")
  ) return undefined;
  let composerIndex = -1;
  for (let index = rows.length - 2; index >= Math.max(0, rows.length - 5); index -= 1) {
    if (/^[›»][ ⠁⠂⠄⠈⠐⠠⡀⢀]/u.test(stripTerminalEscapeSequences(rows[index]!))) {
      composerIndex = index;
      break;
    }
  }
  if (composerIndex < 1 || rows.length - composerIndex > 4) return undefined;
  const painted = codexAstraStyledCells(
    rows.slice(composerIndex - 1, -1).join("\n")
  );
  if (!painted || painted.length < 3 || painted.length > 4) return undefined;
  return { painted, footer };
}

function codexAstraEmptyComposerPaint(
  painted: readonly CodexAstraStyledCell[][]
): { marker: string; background: string } | undefined {
  const composer = painted[1]!;
  const marker = composer[0];
  if (!marker || !/^[›»]$/u.test(marker.character) ||
      !marker.bold || marker.dim || marker.background === undefined) {
    return undefined;
  }
  const background = marker.background;
  const firstPlaceholder = composer.findIndex((cell) => cell.dim);
  if (firstPlaceholder < 2) return undefined;
  const placeholderEnd = firstPlaceholder + CODEX_ASTRA_PLACEHOLDER.length;
  if (!codexAstraPlaceholderPaint(
    composer.slice(firstPlaceholder, placeholderEnd), background
  )) return undefined;
  const decoration = [
    ...painted.filter((_row, index) => index !== 1).flat(),
    ...composer.slice(1, firstPlaceholder),
    ...composer.slice(placeholderEnd)
  ];
  if (
    !decoration.every((cell) => codexAstraDecorationPaint(cell, background)) ||
    !decoration.some((cell) => CODEX_ASTRA_SPARKLE.test(cell.character))
  ) return undefined;
  return { marker: marker.character, background };
}

function codexAstraPlaceholderPaint(
  cells: readonly CodexAstraStyledCell[],
  background: string
): boolean {
  return cells.map((cell) => cell.character).join("") === CODEX_ASTRA_PLACEHOLDER &&
    cells.every((cell) => cell.dim && !cell.bold &&
      cell.background === background);
}

function codexAstraDecorationPaint(
  cell: CodexAstraStyledCell,
  background: string
): boolean {
  if (cell.background !== background || cell.dim || cell.bold) return false;
  if (cell.character === " ") return true;
  return CODEX_ASTRA_SPARKLE.test(cell.character) &&
    cell.foreground !== undefined && cell.foreground !== background;
}

interface CodexAstraStyledCell {
  character: string;
  dim: boolean;
  bold: boolean;
  foreground?: string;
  background?: string;
}

function codexAstraStyledCells(screen: string): CodexAstraStyledCell[][] | undefined {
  const rows: CodexAstraStyledCell[][] = [[]];
  let dim = false;
  let bold = false;
  let foreground: string | undefined;
  let background: string | undefined;
  for (let index = 0; index < screen.length;) {
    if (screen[index] === "\x1b") {
      const escape = /^\x1b\[([\d;]*)m/u.exec(screen.slice(index));
      if (!escape) return undefined;
      const codes = escape[1] === "" ? [0] : escape[1]!.split(";").map(Number);
      for (let part = 0; part < codes.length; part += 1) {
        const code = codes[part]!;
        if (code === 0) {
          dim = bold = false;
          foreground = background = undefined;
        } else if (code === 1) bold = true;
        else if (code === 2) dim = true;
        else if (code === 22) dim = bold = false;
        else if (code === 39) foreground = undefined;
        else if (code === 49) background = undefined;
        else if ((code === 38 || code === 48) && codes[part + 1] === 2) {
          const rgb = codes.slice(part + 2, part + 5);
          if (rgb.length !== 3 || rgb.some((value) => value < 0 || value > 255)) {
            return undefined;
          }
          if (code === 38) foreground = rgb.join(",");
          else background = rgb.join(",");
          part += 4;
        } else return undefined;
      }
      index += escape[0].length;
      continue;
    }
    const character = String.fromCodePoint(screen.codePointAt(index)!);
    index += character.length;
    if (character === "\n") rows.push([]);
    else rows.at(-1)!.push({ character, dim, bold, foreground, background });
  }
  return rows;
}
