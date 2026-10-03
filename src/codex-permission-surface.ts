import { createHash } from "node:crypto";

export type CodexPermissionId = "read_only" | "ask_for_approval" | "approve_for_me" | "full_access";

export interface CodexPermissionRow {
  readonly id: CodexPermissionId;
  readonly label: string;
  readonly description: string;
  readonly current: boolean;
  readonly index: number;
}

export type CodexPermissionSurface =
  | { readonly state: "picker"; readonly rows: readonly CodexPermissionRow[];
      readonly selectedIndex: number; readonly fingerprint: string }
  | { readonly state: "full_access_confirmation"; readonly selectedIndex: number;
      readonly fingerprint: string }
  | { readonly state: "none" | "ambiguous"; readonly reason?: string };

const PICKER_TITLE = "Update Model Permissions";
const CONFIRM_TITLE = "Enable full access?";
const FOOTER = "enter select · esc back";
const MODES: ReadonlyArray<Omit<CodexPermissionRow, "current" | "index">> = [
  { id: "ask_for_approval", label: "Ask for approval", description:
    "Read and edit workspace files and run commands, with approval required for internet access or edits outside the workspace" },
  { id: "approve_for_me", label: "Approve for me", description:
    "Only ask for actions detected as potentially unsafe" },
  { id: "full_access", label: "Full Access", description:
    "Use with caution: Codex can edit files outside this workspace and access the internet without approval" },
  { id: "read_only", label: "Read Only", description:
    "Read workspace files, with approval required for edits or internet access" }
];
const FULL_ACCESS_WARNING = "When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval.";
const WARNINGS = new Set([
  `${FULL_ACCESS_WARNING} Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.`,
  ...["Approve for me", "Ask for approval"].map((reviewer) => `${FULL_ACCESS_WARNING} Cyber models carry a higher risk of dangerous actions. Ensure proper safeguards are in place before granting full access. We strongly recommend selecting "${reviewer}" instead${reviewer === "Approve for me" ? ", and customizing the reviewer policy for your use case" : ""}.`)
]);

interface Style { bold: boolean; dim: boolean; reverse: boolean; fg?: string; bg?: string }
interface Cell { text: string; style: Style }
interface Line { plain: string; cells: Cell[] }
interface ParsedRow { number: number; selected: boolean; text: string; line: Line }
interface ParsedRows { rows: ParsedRow[]; preamble: string }
const RESET: Style = { bold: false, dim: false, reverse: false };

/** Closed, styled Codex 0.159.2/0.159.3/0.160.0 permission picker grammar. */
export function observeCodexPermissionSurface(styledScreen: string): CodexPermissionSurface {
  const rawLines = styledScreen.replace(/\r\n?/gu, "\n").split("\n");
  const plainLines = rawLines.map((line) => line.replace(/\x1b\[[0-9;]*m/gu, ""));
  const titles = plainLines.flatMap((line, index) =>
    [PICKER_TITLE, CONFIRM_TITLE].includes(line.trim()) ? [index] : []);
  if (!titles.length) return { state: "none" };
  if (titles.length !== 1) return ambiguousPermissionSurface("multiple permission surfaces are visible");
  const start = titles[0]!;
  let end = plainLines.length - 1;
  while (end >= 0 && !plainLines[end]!.trim()) end -= 1;
  if (plainLines[end]?.trim() !== FOOTER ||
      plainLines.slice(start, end).some((line) => line.trim() === FOOTER)) {
    return ambiguousPermissionSurface("permission surface has no unique complete closing footer");
  }
  const lines = decodeStyledLines(rawLines.slice(start, end + 1));
  if (!lines) return ambiguousPermissionSurface("permission surface contains unsupported terminal controls");
  if (!visibleCells(lines[0]!).every(({ style }) => style.bold && !style.dim && !style.reverse)) {
    return ambiguousPermissionSurface("permission title lacks native bold styling");
  }
  const body = lines.slice(1, -1);
  const parsed = parseRows(body);
  if (!parsed || parsed.rows.filter((row) => row.selected).length !== 1 ||
      parsed.rows.some((row, index) => row.number !== index + 1)) {
    return ambiguousPermissionSurface("permission choices are incomplete, duplicated or unselected");
  }
  const selectedIndex = parsed.rows.findIndex((row) => row.selected);
  if (!nativeSelectedStyle(parsed.rows[selectedIndex]!.line)) {
    return ambiguousPermissionSurface("selected permission choice lacks native highlight styling");
  }
  if (parsed.rows.some((row) => !row.selected && visibleCells(row.line)
    .some(({ style }) => style.reverse))) {
    return ambiguousPermissionSurface("multiple permission choices have selection styling");
  }
  const fingerprint = `sha256:${createHash("sha256")
    .update(rawLines.slice(start, end + 1).join("\n")).digest("hex")}`;
  return permissionRowsSurface(lines[0]!.plain.trim() === CONFIRM_TITLE,
    parsed, selectedIndex, fingerprint);
}

function permissionRowsSurface(
  confirmation: boolean, parsed: ParsedRows, selectedIndex: number, fingerprint: string
): CodexPermissionSurface {
  if (confirmation) {
    if (!WARNINGS.has(normalize(parsed.preamble)) || parsed.rows.length !== 2 ||
        parsed.rows[0]!.text !== "Yes, continue anyway Apply full access for this session" ||
        parsed.rows[1]!.text !== "Cancel Go back without enabling full access") {
      return ambiguousPermissionSurface("full access confirmation is incomplete or changed");
    }
    return { state: "full_access_confirmation", selectedIndex, fingerprint };
  }
  if (parsed.preamble.trim()) return ambiguousPermissionSurface("permission picker has unexpected introductory content");
  const rows: CodexPermissionRow[] = [];
  for (const row of parsed.rows) {
    const mode = MODES.find((candidate) =>
      row.text === `${candidate.label} ${candidate.description}` ||
      row.text === `${candidate.label} (current) ${candidate.description}`);
    if (!mode) return ambiguousPermissionSurface("permission picker contains an unknown, disabled or clipped choice");
    rows.push({ ...mode, current: row.text.startsWith(`${mode.label} (current) `), index: rows.length });
  }
  const ids = rows.map((row) => row.id).join(",");
  if (!["ask_for_approval,full_access", "ask_for_approval,approve_for_me,full_access",
    "ask_for_approval,full_access,read_only", "ask_for_approval,approve_for_me,full_access,read_only"].includes(ids) ||
    rows.filter((row) => row.current).length > 1) {
    return ambiguousPermissionSurface("permission picker order or current choice is inconsistent");
  }
  return { state: "picker", rows, selectedIndex, fingerprint };
}

function ambiguousPermissionSurface(reason: string): CodexPermissionSurface {
  return { state: "ambiguous", reason };
}

function normalize(value: string): string { return value.replace(/\s+/gu, " ").trim(); }
function visibleCells(line: Line): Cell[] { return line.cells.filter((cell) => cell.text.trim()); }

function parseRows(lines: readonly Line[]): ParsedRows | undefined {
  const rows: ParsedRow[] = [];
  const preamble: string[] = [];
  for (const line of lines) {
    const value = line.plain.trimEnd();
    if (!value.trim()) continue;
    const match = /^(?:(›) |  )([1-4])\. (\S.*)$/u.exec(value);
    if (match) {
      rows.push({ number: Number(match[2]), selected: Boolean(match[1]), text: normalize(match[3]!), line });
    } else if (!rows.length) {
      preamble.push(value);
    } else if (/^ {4,}\S/u.test(value) && !/[›↑↓]|\(disabled\)|\[…/u.test(value)) {
      rows.at(-1)!.text += ` ${normalize(value)}`;
    } else return undefined;
  }
  return { rows, preamble: preamble.join(" ") };
}

function nativeSelectedStyle(line: Line): boolean {
  const prefix = /^› [1-4]\. (?:Ask for approval|Approve for me|Full Access|Read Only|Yes, continue anyway|Cancel)(?: \(current\))? {2,}/u.exec(line.plain);
  if (!prefix) return false;
  const descriptionOffset = prefix[0].length;
  const marker = line.cells[0]!;
  // Native SelectionView makes the marker/name bold, then resets bold for
  // the description while retaining the same highlight. Both are required;
  // accepting a bold transcript line alone would erase this distinction.
  return line.cells.every(({ text, style }, index) => !text.trim() ||
    style.bold === (index < descriptionOffset) && !style.dim && (marker.style.reverse
      ? style.reverse
      : !style.reverse && style.fg === "rgb:0,0,46" &&
        ["rgb:99,168,248", "rgb:164,205,251"].includes(style.bg ?? "") &&
        style.bg === marker.style.bg));
}

function decodeStyledLines(lines: readonly string[]): Line[] | undefined {
  const result: Line[] = [];
  let style = RESET;
  for (const raw of lines) {
    const cells: Cell[] = [];
    for (let offset = 0; offset < raw.length;) {
      if (raw[offset] === "\x1b") {
        const sgr = /^\x1b\[([0-9;]*)m/u.exec(raw.slice(offset));
        if (!sgr) return undefined;
        const next = applySgr(style, sgr[1]!);
        if (!next) return undefined;
        style = next;
        offset += sgr[0].length;
      } else {
        const text = String.fromCodePoint(raw.codePointAt(offset)!);
        if (/[\u0000-\u001f\u007f-\u009f]/u.test(text)) return undefined;
        cells.push({ text, style });
        offset += text.length;
      }
    }
    result.push({ plain: cells.map((cell) => cell.text).join(""), cells });
  }
  return result;
}

function applySgr(previous: Style, value: string): Style | undefined {
  let style = previous;
  const codes = value.split(";").map(Number);
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index]!;
    if (code === 38 || code === 48) {
      const color = extendedSgrColor(codes, index);
      if (!color) return undefined;
      style = { ...style, [code === 38 ? "fg" : "bg"]: color.value };
      index += color.consumed;
    } else {
      const next = applyBasicSgr(style, code);
      if (!next) return undefined;
      style = next;
    }
  }
  return style;
}

function extendedSgrColor(
  codes: readonly number[], index: number
): { value: string; consumed: number } | undefined {
  const kind = codes[index + 1];
  const count = kind === 2 ? 3 : kind === 5 ? 1 : 0;
  const colors = codes.slice(index + 2, index + 2 + count);
  if (!count || colors.length !== count || colors.some((part) => part < 0 || part > 255)) return undefined;
  return {
    value: `${kind === 2 ? "rgb" : "indexed"}:${colors.join(",")}`,
    consumed: count + 1
  };
}

function applyBasicSgr(style: Style, code: number): Style | undefined {
  if (code === 0) return RESET;
  if (code === 1) return { ...style, bold: true };
  if (code === 2) return { ...style, dim: true };
  if (code === 7) return { ...style, reverse: true };
  if (code === 22) return { ...style, bold: false, dim: false };
  if (code === 27) return { ...style, reverse: false };
  if (code === 39) return { ...style, fg: undefined };
  if (code === 49) return { ...style, bg: undefined };
  if (code >= 30 && code <= 37 || code >= 90 && code <= 97) return { ...style, fg: `ansi:${code}` };
  if (code >= 40 && code <= 47 || code >= 100 && code <= 107) return { ...style, bg: `ansi:${code}` };
  return undefined;
}
