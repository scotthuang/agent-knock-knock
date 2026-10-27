import { exactClaudeComposerFrame, stripTerminalEscapeSequences } from "./terminal-native-inspection-proof.js";

export interface ClaudeUserExplicitReadiness {
  readonly ready: boolean;
  readonly reason?: "foreground_running" | "foreground_unproven" | "composer_not_empty" |
    "composer_unrecognized" | "footer_unrecognized" | "stash_not_empty" | "cleanup_marker_present";
  readonly message?: string;
}

const STASH_BADGE_SUFFIX = /›\s+stashed\s*$/u;
const CLEAR_HINT = /^\s*(?:Draft restored\s*·\s*)?new task\? \/clear to save \d+(?:\.\d)?[kmbt]? tokens\s*$/u;
const STASH = /\s+(?:Draft restored\s*·\s*)?› stashed\s*$/u;
const AUXILIARY = /^(?:(?:Draft restored\s*·\s*)?› stashed|[●○◐◉]\s+(?:low|medium|high|xhigh|max|ultracode)\s*·\s*\/effort)$/iu;
const MODE = /^(?:[⏵⏴⏸]{1,2}\s+(?:manual mode|auto mode|accept edits|bypass permissions|plan mode|don't ask) on(?:\s+\(shift\+tab to cycle\))?|\? for shortcuts)$/u;
const HINT = /^(?:\? for shortcuts|[1-9]\d* shells?|esc to interrupt|← for (?:agents|ag…)|(?:↓ to manage|\(↓ to manage\)))$/u;
// Native 2.1.295 spinner frames include the middle dot and reduced-motion dot.
const SPINNER = /^\s*[·✢✳✶✻✽●✣✤✥✦✧]\s+.+(?:…|\.\.\.)(?:\s+\([^)]*\))?\s*$/u;
const COMPLETED = /^\s*[·✢✳✶✻✽●✣✤✥✦✧]\s+(?:Baked|Brewed|Churned|Cogitated|Cooked|Crunched|Sautéed|Worked) for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m|h))*(?: · done \d{1,2}:\d{2}(?:[ \u202f]+[AP]M)?)?(?: · [1-9]\d* shells? still running)?\s*$/u;

/** Closed native vocabulary; joining wrapped rows never licenses unknown text. */
function knownFooter(lines: readonly string[]): boolean {
  const rows = lines.map(line => line.trim()).filter(line => !AUXILIARY.test(line));
  if (rows.length === 0) return true;
  if (rows.length > 4) return false;
  const footer = rows.join(" ").replace(STASH, "").replace(/\s+Debug\s*$/u, "")
    .replace(STASH, "").replace(/\s+/gu, " ").trim();
  const [mode, ...hints] = footer.split(/\s*·\s*/u);
  return MODE.test(mode ?? "") && hints.every(hint => HINT.test(hint));
}

/** Footer esc can outlive foreground work; it is not, by itself, idle evidence. */
function foregroundFailure(lines: readonly string[], interruptHint: boolean): ClaudeUserExplicitReadiness | undefined {
  const tail = lines.filter(line => line.trim()).slice(-12);
  const spinner = tail.reduce((last, line, index) => SPINNER.test(line) ? index : last, -1);
  const completed = tail.reduce((last, line, index) => COMPLETED.test(line) ? index : last, -1);
  const afterSpinner = tail.slice(spinner + 1).map(line => line.trim()).join(" ").replace(/\s+/gu, " ");
  const currentSpinner = spinner > completed && (afterSpinner === "" ||
    /^⎿ Tip: Use \/btw to ask a quick side question without interrupting Claude['’]s current work$/u.test(afterSpinner));
  if (currentSpinner) return {
    ready: false, reason: "foreground_running",
    message: "Claude is still running its foreground turn; wait for it to finish, then refresh and retry. No task text was sent."
  };
  const unresolvedSpinner = spinner > completed && !tail.slice(spinner + 1).some(line => /^\s*[⏺❯]\s+\S/u.test(line));
  if (unresolvedSpinner || interruptHint && (completed < 0 || completed !== tail.length - 1)) return {
    ready: false, reason: "foreground_unproven",
    message: "Claude shows an interrupt hint or an unrecognized working-status layout, but the current foreground turn has no visible completion proof. Background shell counts alone do not prove it idle; wait for the turn to finish and retry."
  };
  return undefined;
}

/** Physical Claude input proof only. Managed input and Codex retain their own policies. */
export function claudeUserExplicitReadiness(
  screen: string | undefined, options: { allowDraft?: boolean } = {}
): ClaudeUserExplicitReadiness {
  const frame = exactClaudeComposerFrame(stripTerminalEscapeSequences(screen ?? ""));
  if (!frame || !/^\s*❯(?:\s|$)/u.test(frame.composerRows[0] ?? "")) return {
    ready: false, reason: "composer_unrecognized",
    message: "Claude main Composer frame is missing or clipped; return to the complete main prompt and retry."
  };
  // The toast describes a past pop; the stash badge describes the current slot.
  // Native hints (including /clear) can precede the badge on the same row.
  // Check the suffix in either current location before validating other footer text.
  // Its absence is not proof: Claude can hide its notification area.
  const currentBody = frame.lines.slice(0, frame.openIndex).filter(line => line.trim());
  const aboveComposer = currentBody.at(-1) ?? "";
  if ([aboveComposer, ...frame.trailing].some(line => STASH_BADGE_SUFFIX.test(line))) return {
    ready: false, reason: "stash_not_empty",
    message: "This window has a stashed draft. Before retrying, restore or clear it yourself in the window. " +
      "Wait until Claude is idle; with an empty input box, press Ctrl+S once to restore it and save any wanted text. " +
      "AKK cannot identify the hidden contents. If you see [AKK replacing current draft ...], it may be an earlier AKK cleanup marker: " +
      "remove only that marker (Ctrl+E then Ctrl+U if it is the entire single-line input), preserve any other text, and do not submit the marker. Empty the input box, refresh List, and retry. No task text was sent."
  };
  if (!knownFooter(frame.trailing)) return {
    ready: false, reason: "footer_unrecognized",
    message: "Claude main Composer is visible, but its footer contains an unknown or unsupported component. Return to the native main prompt; if it persists, report the footer layout. Task text was not sent."
  };
  // A contextual /clear notification is not foreground work or completion proof.
  // Remove only the nearest exact native hint; retain real spinners and unknown text.
  const activity = foregroundFailure(CLEAR_HINT.test(aboveComposer) ? currentBody.slice(0, -1) : currentBody,
    /\besc\s+to\s+interrupt\b/u.test(frame.trailing.join(" ")));
  if (activity) return activity;
  if (frame.composerRows.some(line => /\[AKK replacing current draft(?:\s|\])/u.test(line))) return {
    ready: false, reason: "cleanup_marker_present",
    message: "The input box contains an AKK-style cleanup marker, possibly left by an earlier failed Send. " +
      "Do not press Enter on it. Remove only [AKK replacing current draft ...] (Ctrl+E then Ctrl+U if it is the entire single-line input), save any other text, " +
      "then empty the input box, refresh List, and retry. AKK has not deleted anything or sent task text."
  };
  if (!options.allowDraft && (frame.composerRows.length !== 1 || !/^\s*❯\s*$/u.test(frame.composerRows[0]!))) return {
    ready: false, reason: "composer_not_empty",
    message: "Claude main Composer contains a draft; preserve or clear it yourself before retrying. AKK did not replace the draft or submit task text."
  };
  return { ready: true };
}
