import { createHash } from "node:crypto";
import { codexNativeInspectionCompatibilityProfile, isCodexPaginatedReadCandidate } from "./codex-lifecycle-compatibility.js";
import { captureCodexFullscreenComposerFrame } from "./codex-fullscreen-composer-proof.js";
import type { TerminalViewport } from "./terminal-control-provider.js";
import { closedCodex159StatusSuffix, observeCodexNativeInspection } from "./codex-terminal-agent-adapter.js";
import {
  exactCodexReadyStyledComposerCapture,
  stripTerminalEscapeSequences,
  type TerminalCodexStatusProbeResult
} from "./terminal-native-inspection-bridge.js";

/** Only the recognized owned-screen navigation grammar, never a generic pager. */
const PAUSED_FOOTER = /^ {2}(?:New activity · )?enter\/esc latest · \? shortcuts(?: {2,}⚠ [1-9]\d? warnings? · f2 to view)?$/u;
const HISTORY_GAP = /^ +(?:New activity · )?↓ Back to bottom · esc *$/u;
const SESSION = /^ {2}Session: {2,}[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const FIELD = /^ {2}[A-Za-z][^:│]{0,63}: {2,}\S.*$/u;
const INFO = new Set([
  "  Visit https://chatgpt.com/codex/settings/usage for up-to-date",
  "  information on rate limits and credits"
]);

type Tail = { rows: string[]; plain: string[]; liveChrome: string[]; footer: string };
type PausedHistory = { rows: string[]; transcriptBottom: number; screenRows: number };
class MissingStatusOverlap extends Error {}
export interface CodexStatusHistoryPorts {
  /** Every capture and key must freshly revalidate physical terminal identity. */
  capture(): Promise<string>;
  sendKey(key: "PageUp" | "C-End"): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
  inspectViewport?(): Promise<TerminalViewport | undefined>;
  scrollHistoryDown?(expectedViewport: TerminalViewport): Promise<void>;
}

function lines(screen: string): string[] {
  return screen.replace(/\r\n?/gu, "\n").split("\n");
}
function plainRows(rows: readonly string[]): string[] {
  return rows.map((row) => stripTerminalEscapeSequences(row).trimEnd());
}
function trimEmptyEnd(rows: string[]): string[] {
  while (rows.length && !stripTerminalEscapeSequences(rows.at(-1)!).trim()) rows.pop();
  return rows;
}
function completeStatus(screen: string, version: string): boolean {
  return observeCodexNativeInspection({
    operation: { kind: "status" }, expectedAgentVersion: version,
    screen: stripTerminalEscapeSequences(screen)
  }).status === "observed";
}

/** A clipped card tail is navigation eligibility, never independent identity evidence. */
function clippedTail(screen: string, version: string): Tail | undefined {
  if (!exactCodexReadyStyledComposerCapture(screen, version)) return undefined;
  const frame = captureCodexFullscreenComposerFrame(screen, version)!;
  const start = /^[›»](?:\s|$)/u.test(frame.plainLines[0] ?? "") ? 1 : 0;
  let end = frame.composerIndex;
  const session = frame.plainLines.findIndex((row, index) => index >= start && index < end && SESSION.test(row.trimEnd()));
  if (session < 0) return undefined;
  for (let index = start; index < end; index += 1) {
    const row = frame.plainLines[index]!.trimEnd();
    if (!row.trim() || FIELD.test(row) || INFO.has(row) || /^ {4,}\S/u.test(row) ||
        index === start && row === `  >_ OpenAI Codex (v${version})`) continue;
    if (index <= session) return undefined;
    end = index; // Native working/queue chrome is validated by the complete-card parser later.
    break;
  }
  const liveChrome = frame.plainLines.slice(end, frame.composerIndex).filter((row) => row.trim()).map((row) => row.trimEnd());
  if (!closedCodex159StatusSuffix(liveChrome)) return undefined;
  const rows = trimEmptyEnd(frame.styledLines.slice(start, end));
  const plain = plainRows(rows);
  if (!plain.some((row) => /^ {2}Directory: {2,}\S/u.test(row)) ||
      !plain.some((row) => /^ {2}Permissions: {2,}\S/u.test(row)) ||
      !plain.some((row) => /^ {2}Agents\.md: {2,}\S/u.test(row))) return undefined;
  return {
    rows, plain,
    liveChrome,
    footer: frame.plainLines[frame.footerIndex]!.trimEnd()
  };
}

function normalizedChrome(rows: readonly string[]): string {
  return JSON.stringify(rows.map((row) => row
    .replace(/^[•◦] /u, "• ")
    .replace(/\((?:(?:\d+h )?\d+m )?\d+s • esc to interrupt\)/u, "(elapsed • esc to interrupt)")
    .replace(/^( {2}\? [1-9]\d{0,2} questions?) · (?:[1-9]|1\d|20)s$/u, "$1")));
}

function currentChromeBoundary(rows: readonly string[], end: number): number | undefined {
  const tail = plainRows(rows.slice(0, end)).flatMap((row, index) => row.trim() ? [{ row, index }] : []).slice(-8);
  const start = tail.findIndex(({ row }) => row === "• Queued follow-up inputs" ||
    closedCodex159StatusSuffix([row]) || / to interrupt/u.test(row));
  if (start < 0) return end; // The task may have finished and removed its entire live bottom pane.
  return closedCodex159StatusSuffix(tail.slice(start).map(({ row }) => row)) ? tail[start]!.index : undefined;
}

function historyBeforeChrome(rows: string[], end: number, tail: Tail, restoreOnly: boolean): PausedHistory | undefined {
  if (restoreOnly) {
    const boundary = currentChromeBoundary(rows, end);
    return boundary === undefined ? undefined : {
      rows: trimEmptyEnd(rows.slice(0, boundary)), transcriptBottom: boundary, screenRows: rows.length
    };
  }
  const indexed = plainRows(rows.slice(0, end)).flatMap((row, index) => row.trim() ? [{ row, index }] : []);
  if (tail.liveChrome.length > 0) {
    const suffix = indexed.slice(-tail.liveChrome.length);
    const chrome = suffix.map(({ row }) => row);
    if (!closedCodex159StatusSuffix(chrome) || normalizedChrome(chrome) !== normalizedChrome(tail.liveChrome)) return undefined;
    end = suffix[0]!.index;
  }
  return { rows: trimEmptyEnd(rows.slice(0, end)), transcriptBottom: end, screenRows: rows.length };
}

/** Normalize only the exact native paused footer for the existing styled Composer proof. */
function pausedHistory(screen: string, version: string, tail: Tail, restoreOnly = false): PausedHistory | undefined {
  const rows = trimEmptyEnd(lines(screen));
  const plain = plainRows(rows);
  if (!PAUSED_FOOTER.test(plain.at(-1) ?? "")) return undefined;
  const normalized = [...rows.slice(0, -1), "  ← for agents · ? for shortcuts"].join("\n");
  if (!exactCodexReadyStyledComposerCapture(normalized, version)) return undefined;
  const frame = captureCodexFullscreenComposerFrame(normalized, version)!;
  if (frame.plainLines[frame.footerIndex]!.trimEnd() !== tail.footer) return undefined;
  const gaps = plain.flatMap((row, index) => HISTORY_GAP.test(row) ? [index] : []);
  if (gaps.length !== 1 || gaps[0]! >= frame.composerIndex ||
      plain.slice(gaps[0]! + 1, frame.composerIndex).some((row) => row.trim())) return undefined;
  return historyBeforeChrome(rows, gaps[0]!, tail, restoreOnly);
}

function reconstruct(previous: readonly string[], screen: string, tail: Tail, version: string): string {
  const plain = plainRows(previous);
  const command = plain.lastIndexOf("/status");
  if (command < 0) throw new Error("Codex history did not expose the latest /status command");
  const prefix = previous.slice(command);
  const prefixPlain = plain.slice(command);
  const overlaps: number[] = [];
  for (let size = 1; size <= Math.min(prefix.length, tail.rows.length); size += 1) {
    const overlap = tail.plain.slice(0, size);
    if (overlap.some((row) => row.trim().length >= 12) &&
        JSON.stringify(prefixPlain.slice(-size)) === JSON.stringify(overlap)) overlaps.push(size);
  }
  if (overlaps.length === 0) throw new MissingStatusOverlap("Codex status history overlap is missing or ambiguous");
  if (overlaps.length !== 1) throw new Error("Codex status history overlap is ambiguous");
  const size = overlaps[0]!;
  const anchor = tail.plain.slice(0, size).find((row) => row.trim().length >= 12)!;
  if (prefixPlain.filter((row) => row === anchor).length !== 1 ||
      tail.plain.filter((row) => row === anchor).length !== 1) {
    throw new Error("Codex status history overlap is not unique");
  }
  const frame = captureCodexFullscreenComposerFrame(screen, version)!;
  const start = /^[›»](?:\s|$)/u.test(frame.plainLines[0] ?? "") ? 1 : 0;
  // All header/identity characters come from captured frames. The original live
  // suffix and Composer close the reconstructed card; pager chrome never does.
  const result = [...prefix.slice(0, -size), ...frame.styledLines.slice(start)].join("\n");
  if (!completeStatus(result, version)) throw new Error("Codex reconstructed status card is incomplete or ambiguous");
  return result;
}

function sameTail(screen: string, version: string, expected: Tail): boolean {
  const tail = clippedTail(screen, version);
  return tail !== undefined && JSON.stringify(tail.plain) === JSON.stringify(expected.plain) &&
    tail.footer === expected.footer;
}

function compatibleStatusPrefix(paused: PausedHistory, screen: string, version: string): boolean {
  const plain = plainRows(paused.rows);
  const command = plain.lastIndexOf("/status");
  if (command < 0) return false;
  const frame = captureCodexFullscreenComposerFrame(screen, version);
  if (!frame) return false;
  const start = /^[›»](?:\s|$)/u.test(frame.plainLines[0] ?? "") ? 1 : 0;
  // This adjacency is ONLY eligibility for one read-only wheel event, never
  // identity evidence. Reuse the strict card grammar to reject contradictory
  // headers/fields/prose, including a command-only stub whose header is below
  // the paused viewport. Returning identity still requires observed overlap.
  return completeStatus([...paused.rows.slice(command), ...frame.styledLines.slice(start)].join("\n"), version);
}

async function reconstructWithBoundaryBridge(
  paused: PausedHistory, screen: string, tail: Tail, version: string, ports: CodexStatusHistoryPorts
): Promise<string> {
  try { return reconstruct(paused.rows, screen, tail, version); }
  catch (error) {
    if (!(error instanceof MissingStatusOverlap) || !compatibleStatusPrefix(paused, screen, version) ||
        !ports.inspectViewport || !ports.scrollHistoryDown) throw error;
  }
  const viewport = await ports.inspectViewport();
  const fresh = pausedHistory(await ports.capture(), version, tail);
  if (!viewport || viewport.columns < 80 || viewport.rows < 12 || !fresh ||
      fresh.screenRows !== viewport.rows || fresh.transcriptBottom < 3 ||
      JSON.stringify(plainRows(fresh.rows)) !== JSON.stringify(plainRows(paused.rows))) {
    throw new Error("Codex status-boundary history scroll lacks an exact paused transcript viewport");
  }
  // Codex 0.159 transcript_view/input.rs: ScrollDown inside self.area advances
  // exactly three rows. The closed provider event targets (2,2), below the
  // one-row sticky prompt and above proven bottom-pane chrome. Never repeat it.
  await ports.scrollHistoryDown(viewport);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await ports.sleep(50);
    const after = pausedHistory(await ports.capture(), version, tail);
    if (!after || after.screenRows !== viewport.rows) throw new Error("Codex history scroll lost its exact paused viewport");
    if (JSON.stringify(plainRows(after.rows)) !== JSON.stringify(plainRows(paused.rows))) {
      return reconstruct(after.rows, screen, tail, version);
    }
  }
  throw new Error("Codex history scroll did not provide a unique nonblank status overlap");
}

async function restoreLatest(ports: CodexStatusHistoryPorts, version: string, tail: Tail): Promise<void> {
  // Recapture before restoration: a user draft, modal, selection, or changed
  // model/path footer forbids further input, even a navigation key.
  if (!pausedHistory(await ports.capture(), version, tail, true)) {
    throw new Error("Codex status history changed before restoring latest");
  }
  await ports.sendKey("C-End");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await ports.sleep(50);
    const capture = await ports.capture();
    if (sameTail(capture, version, tail)) return;
    if (!pausedHistory(capture, version, tail, true)) break;
  }
  throw new Error("Codex status history did not restore its exact latest card tail");
}

/** One reversible page, only after our proven closed /status Enter cleared its Composer. */
export async function captureCodexStatusHistory(input: {
  screen: string;
  version: string;
  submission?: TerminalCodexStatusProbeResult;
  ports: CodexStatusHistoryPorts;
}): Promise<string> {
  const { screen, version, submission, ports } = input;
  if (!isCodexPaginatedReadCandidate(version) || completeStatus(screen, version)) return screen;
  const tail = clippedTail(screen, version);
  if (!tail || !submission || submission.stage !== "enter_dispatched" || submission.enterCount !== 1 ||
      submission.agent !== "codex" || submission.command !== "/status" ||
      submission.behaviorProfile !== codexNativeInspectionCompatibilityProfile(version)?.behaviorProfile ||
      !/^[0-9a-f]{64}$/u.test(submission.observationBaselineDigest) ||
      createHash("sha256").update(screen).digest("hex") === submission.observationBaselineDigest) return screen;
  // The original transaction's styled command -> cleared Composer transition
  // provides freshness. Fullscreen clipping cannot preserve occurrence counts
  // in preEnterEvidenceInventory, including repeated identical /status cards.
  if (!sameTail(await ports.capture(), version, tail)) throw new Error("Codex status tail changed before history navigation");
  let paused: PausedHistory | undefined;
  let restoreNeeded = false;
  let candidate: string;
  try {
    await ports.sendKey("PageUp");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await ports.sleep(50);
      const capture = await ports.capture();
      paused = pausedHistory(capture, version, tail);
      restoreNeeded = paused !== undefined || pausedHistory(capture, version, tail, true) !== undefined;
      if (paused) break;
      if (!sameTail(capture, version, tail)) throw new Error("Codex history navigation lost its exact Composer or native footer");
    }
    if (!paused) throw new Error("Codex history navigation did not expose a proven paused viewport");
    candidate = await reconstructWithBoundaryBridge(paused, screen, tail, version, ports);
  } finally {
    if (restoreNeeded) await restoreLatest(ports, version, tail);
  }
  return candidate;
}
