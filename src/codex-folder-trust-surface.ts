import { normalizeTerminalApprovalPromptRegion } from "./terminal-agent-adapter.js";

const ACCESS_CHOICES = new Map([
  ["Quit", "quit"],
  ["Back to Agent Command Center", "back"],
  ["Keep current directory", "cancel"]
]);

/** A durable folder decision is an input owner, never a one-time tool approval. */
export function codexFolderTrustBlocked(approval: unknown): boolean {
  return typeof approval === "object" && approval !== null && !Array.isArray(approval) &&
    "blocked" in approval && approval.blocked === true &&
    "prompt_kind" in approval && approval.prompt_kind === "folder_trust";
}

/**
 * Read the native folder-access disclosure and ordered picker together. No
 * path, trust value or approval key is inferred. Public 0.164/0.165 snapshots
 * share this surface, including restricted opens and directory changes.
 */
export function codexFolderTrustPromptVisible(screen: string): boolean {
  const region = folderAccessRegion(screen);
  if (!region) return false;
  const choices = folderAccessChoices(region);
  if (!choices) return false;
  const disclosure = region.slice(1, choices.firstIndex).join(" ").replace(/\s+/gu, " ");
  return knownFolderDisclosure(choices.firstLabel, disclosure) &&
    currentFolderAccessFooter(region.slice(choices.optionEnd).filter(Boolean), choices.cancel);
}

function folderAccessRegion(screen: string): string[] | undefined {
  const lines = normalizeTerminalApprovalPromptRegion(screen).split("\n");
  let title = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.trim() === "Folder access") title = index;
  }
  if (title < 0 || lines.length - title > 80 || insideCodeFence(lines, title)) return undefined;
  return lines.slice(title).map((line) => line.trim());
}

function folderAccessChoices(region: readonly string[]): {
  firstLabel: string; firstIndex: number; optionEnd: number; cancel: string;
} | undefined {
  const choices = region.flatMap((line, index) => {
    const match = /^(›\s*)?(\d+)\.\s+(.+)$/u.exec(line);
    return match ? [{ index, selected: Boolean(match[1]), number: match[2], label: match[3] }] : [];
  });
  if (choices.length !== 2 || choices[0]!.number !== "1" || choices[1]!.number !== "2" ||
      choices.filter((row) => row.selected).length !== 1) return undefined;
  const [first, second] = choices as [typeof choices[number], typeof choices[number]];
  const firstLabel = [first.label, ...region.slice(first.index + 1, second.index)]
    .join(" ").replace(/\s+/gu, " ").trim();
  const secondEnd = region.findIndex((line, index) => index > second.index &&
    (line === "" || /^enter\b/iu.test(line)));
  const optionEnd = secondEnd < 0 ? region.length : secondEnd;
  const secondLabel = [second.label, ...region.slice(second.index + 1, optionEnd)]
    .join(" ").replace(/\s+/gu, " ").trim();
  const cancel = ACCESS_CHOICES.get(secondLabel);
  return cancel ? { firstLabel, firstIndex: first.index, optionEnd, cancel } : undefined;
}

function knownFolderDisclosure(firstLabel: string, disclosure: string): boolean {
  return firstLabel === "Trust and continue"
    ? disclosure.includes("Trust this folder?") && disclosure.includes("Your trust decision will be saved.")
    : firstLabel === "Open restricted"
      ? disclosure.includes("Config, hooks, and exec policies from untrusted folders stay disabled.") &&
        disclosure.includes("Opening will not change saved trust.")
      : firstLabel === "Open existing task" &&
        disclosure.includes("This existing task may retain settings and history") &&
        disclosure.includes("The folder's trust setting will not change.");
}

function currentFolderAccessFooter(trailing: readonly string[], cancel: string): boolean {
  // A newer prompt/task makes a historical copy stale. A remaining model/status
  // footer alone does not prove that the folder decision released input.
  if (trailing.some((line) => /^(?:[›»❯](?:\s|$)|•\s|─\s*Worked for\b)/u.test(line))) return false;
  if (trailing.length === 0) return true; // viewport clipped after the choices
  const footer = new RegExp(`^enter continue(?: and create sandbox)? · esc ${cancel}$`, "iu");
  for (let index = 0; index < trailing.length; index += 1) {
    for (let count = 1; count <= 3 && index + count <= trailing.length; count += 1) {
      if (footer.test(trailing.slice(index, index + count).join(" "))) return true;
    }
  }
  return false;
}

function insideCodeFence(lines: readonly string[], before: number): boolean {
  let fence: string | undefined;
  for (const line of lines.slice(0, before)) {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (!marker) continue;
    if (!fence) fence = marker[0];
    else if (marker[0] === fence) fence = undefined;
  }
  return fence !== undefined;
}
