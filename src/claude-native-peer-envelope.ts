import type { ClaudeNativeSenderPermissionClass } from "./claude-native-sender-policy.js";

const TAG = "cross-session-message";
const OPEN = new Set("<＜﹤〈⟨〈‹˂ᐸ❬❮❰⧼≮≺⋖");
const CLOSE = new Set(">＞﹥〉⟩〉›˃ᐳ❭❯❱⧽≯≻⋗");
const SLASH = new Set("/／∕⁄");
const WORD = /^[A-Za-z0-9_-]$/iu;
// A conservative superset of the native closing-tag parser's ignorable marks.
// Keeping this property-based avoids copying a version-specific Unicode table.
const GAP = /^[\p{M}\p{Cf}\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u115f\u1160\u1ab0-\u1aff\u1dc0-\u1dff\u2060-\u206f\u20d0-\u20ff\u3164\uffa0\ufff0-\ufffb\u{13430}-\u{1343f}\u{e0000}-\u{e0fff}]$/u;
const DASH = /^[_\p{Pc}\p{Pd}\u2017\u02cd\u07fa\u0640\u2212\u207b\u208b\u02d7\u2796\u2043\u30fc\uff70]$/u;

function isClosingPeerTag(interior: string): boolean {
  if (interior.startsWith("\\")) return false;
  const points = Array.from(interior);
  let cursor = 0, hasSlash = false;
  // The native prefix allows punctuation before/after its closing slash, but
  // stops at a word character or another angle bracket. The caller bounds it
  // at the next angle bracket, so every character is scanned a constant number
  // of times, including adversarial runs of slashes or invisible characters.
  while (cursor < points.length && !WORD.test(points[cursor])) {
    if (SLASH.has(points[cursor])) hasSlash = true;
    cursor++;
  }
  if (!hasSlash) return false;
  for (let index = 0; index < TAG.length; index++) {
    if (index > 0) while (cursor < points.length && GAP.test(points[cursor])) cursor++;
    const point = points[cursor++];
    if (point === undefined) return false;
    if (TAG[index] === "-") {
      if (!DASH.test(point)) return false;
    } else if (point.toUpperCase().toLowerCase() !== TAG[index]) return false;
  }
  return cursor === points.length || !WORD.test(points[cursor]);
}

/** Escape only possible closing peer tags, leaving other XML and code intact. */
function escapePeerBody(text: string): string {
  const pieces: string[] = [];
  let previousOpen = -1, afterOpen = -1, copiedUntil = 0, offset = 0;
  const finishCandidate = (end: number): void => {
    if (previousOpen < 0 || !isClosingPeerTag(text.slice(afterOpen, end))) return;
    pieces.push(text.slice(copiedUntil, previousOpen), "<\\");
    copiedUntil = afterOpen;
  };
  for (const point of text) {
    if (OPEN.has(point) || CLOSE.has(point)) {
      finishCandidate(offset);
      previousOpen = OPEN.has(point) ? offset : -1;
      afterOpen = offset + point.length;
    }
    offset += point.length;
  }
  finishCandidate(text.length);
  pieces.push(text.slice(copiedUntil));
  return pieces.join("");
}

/** Sender attestation belongs to AKK's outer envelope, never to task text. */
export function buildClaudeNativePeerContent(text: string,
  senderPermissionClass?: ClaudeNativeSenderPermissionClass): string {
  if (senderPermissionClass !== undefined && senderPermissionClass !== "prompting" && senderPermissionClass !== "bypass") {
    throw new Error("invalid_claude_sender_permission_class");
  }
  const mode = senderPermissionClass === undefined ? "" : ` from-mode="${senderPermissionClass}"`;
  return `<${TAG}${mode}>\n${escapePeerBody(text)}\n</${TAG}>`;
}
