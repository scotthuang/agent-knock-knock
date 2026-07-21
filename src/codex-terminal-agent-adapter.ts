import { createHash } from "node:crypto";
import {
  classifyCodexProcess,
  type CodexProcessKind,
  type ForkContextPackage
} from "./codex-session-provider.js";
import { redactString } from "./runtime-log.js";
import type {
  TerminalAgentAdapter,
  TerminalApprovalInspection,
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest,
  TerminalScreenInspection,
  TerminalScreenInspectionOptions
} from "./terminal-agent-adapter.js";

export type CodexApprovalPromptDetection =
  | {
      approvable: true;
      key: string;
      keys: readonly string[];
      label: string;
      promptKind: string;
      command?: string;
    }
  | {
      approvable: false;
      reason: string;
      promptKind?: string;
      command?: string;
    };

export interface CreateCodexTerminalAgentAdapterOptions {
  detectDurableCompletion?: NonNullable<
    TerminalAgentAdapter<CodexProcessKind>["detectDurableCompletion"]
  >;
}

export function createCodexTerminalAgentAdapter(
  options: CreateCodexTerminalAgentAdapterOptions = {}
): TerminalAgentAdapter<CodexProcessKind> {
  return {
    agent: "codex",
    displayName: "Codex",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: true,
      screenCompletion: true,
      durableCompletion: true,
      cancellation: true
    },
    cancelKeys: ["C-c"],
    classifyProcess(snapshot) {
      const process = classifyCodexProcess(snapshot);
      return process?.kind === "codex_cli" ? process : undefined;
    },
    inspectScreen: inspectCodexScreen,
    detectDurableCompletion: options.detectDurableCompletion ?? (async (request) =>
      detectCodexDurableCompletion(request))
  };
}

export const codexTerminalAgentAdapter = createCodexTerminalAgentAdapter();

export function inspectCodexScreen(options: TerminalScreenInspectionOptions): TerminalScreenInspection {
  const detectedApproval = detectCodexApprovalPrompt(options.screen);
  const blocked = isCodexApprovalPromptVisible(options.screen);
  const approval: TerminalApprovalInspection = detectedApproval.approvable
    ? {
        blocked: true,
        approvable: true,
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command,
        action: {
          keys: detectedApproval.keys,
          label: detectedApproval.label
        }
      }
    : {
        blocked,
        approvable: false,
        reason: detectedApproval.reason,
        promptKind: detectedApproval.promptKind,
        command: detectedApproval.command
      };
  const activity = detectCodexActivityState(options.screen, detectedApproval);
  const screenExcerpt = codexScreenExcerpt(options.screen, options.maxExcerptLength ?? 4000);
  const completion = activity.state === "idle"
    ? detectCodexScreenCompletion({
        screen: screenExcerpt,
        requestText: options.requestText,
        screenChangedSinceSend: options.screenChangedSinceSend
      })
    : undefined;

  return {
    activity,
    approval,
    screenExcerpt,
    completion
  };
}

export function detectCodexApprovalPrompt(screen: string): CodexApprovalPromptDetection {
  const prompt = codexApprovalPromptRegion(screen);
  if (!prompt.visible) {
    return {
      approvable: false,
      reason: prompt.reason
    };
  }

  for (const line of prompt.region.split(/\r?\n/)) {
    const match = /^[\s›]*1\.\s+(Yes,[^(]+)\(([^)]+)\)/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const key = match[2].trim();
    if (key !== "y") {
      return {
        approvable: false,
        reason: `primary approval shortcut is ${key}, not y`,
        ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
      };
    }
    return {
      approvable: true,
      key,
      keys: [key],
      label: match[1].trim(),
      ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
    };
  }

  return {
    approvable: false,
    reason: "no primary approve option with a shortcut was detected",
    ...approvalCandidateFromPrompt(prompt.marker, prompt.region)
  };
}

export function isCodexApprovalPromptVisible(screen: string): boolean {
  return codexApprovalPromptRegion(screen).visible;
}

export function detectCodexActivityState(
  screen: string,
  approval = detectCodexApprovalPrompt(screen)
): { state: "awaiting_approval" | "working" | "idle" | "unknown"; reason: string } {
  if (approval.approvable || isCodexApprovalPromptVisible(screen)) {
    return {
      state: "awaiting_approval",
      reason: "current Codex approval prompt is visible"
    };
  }

  const tailLines = screen.trimEnd().split(/\r?\n/).slice(-30);
  const workingLine = tailLines.find((line) => isCodexWorkingLine(line));
  if (workingLine) {
    return {
      state: "working",
      reason: `Codex working marker detected: ${workingLine.trim()}`
    };
  }

  const idleLine = tailLines
    .slice(-6)
    .map((line) => line.trim())
    .find((line) => isCodexIdlePromptLine(line));
  if (idleLine) {
    return {
      state: "idle",
      reason: `Codex input prompt detected: ${idleLine}`
    };
  }

  return {
    state: "unknown",
    reason: "no current Codex working, idle, or approval marker was detected in the terminal screen"
  };
}

export function codexScreenExcerpt(screen: string, maxLength = 4000): string {
  const lines = screen.trimEnd().split(/\r?\n/);
  const excerpt = lines.slice(Math.max(0, lines.length - 80)).join("\n");
  return redactString(excerpt).slice(-maxLength);
}

export function detectCodexScreenCompletion({
  screen,
  requestText,
  screenChangedSinceSend
}: {
  screen: string;
  requestText?: string;
  screenChangedSinceSend?: boolean;
}): TerminalCompletionEvidence | undefined {
  const request = requestText?.trim() ?? "";
  const promptEnd = request ? whitespaceInsensitiveMatchEnd(screen, request) : undefined;
  const afterPrompt = promptEnd === undefined ? undefined : screen.slice(promptEnd);
  const completionBoundary = afterPrompt === undefined
    ? undefined
    : codexCompletionBoundary(afterPrompt);
  const completionText = afterPrompt === undefined
    ? screenChangedSinceSend
      ? latestCompletedCodexSegment(screen)
      : undefined
    : completionBoundary === undefined
      ? afterPrompt
      : afterPrompt.slice(0, completionBoundary);
  if (completionText === undefined) {
    return undefined;
  }
  const cleaned = cleanCodexTerminalScreenText(completionText);
  const hasCompletionEvidence = promptEnd === undefined || completionBoundary !== undefined || /[•└]/u.test(cleaned ?? "");
  if (!cleaned || cleaned.length < 40 || !hasCompletionEvidence) {
    return undefined;
  }

  return {
    source: "screen",
    text: truncateText(redactString(cleaned), 4000),
    confidence: "screen_only"
  };
}

export function detectCodexDurableCompletion(
  request: TerminalDurableCompletionRequest
): TerminalCompletionEvidence | undefined {
  const context = asForkContextPackage(request.context);
  const threshold = validTimestampMs(request.startedAt);
  const expectedRequestHash = request.requestHash ?? requestFingerprint(request.requestText);
  if (!context || threshold === undefined || !expectedRequestHash) {
    return undefined;
  }

  const turn = [...context.turns]
    .reverse()
    .find((candidate) => {
      const userTimestamp = validTimestampMs(candidate.userTimestamp);
      const completedAt = validTimestampMs(candidate.completedAt);
      return candidate.userTextHash === expectedRequestHash &&
        userTimestamp !== undefined &&
        completedAt !== undefined &&
        userTimestamp >= threshold &&
        completedAt >= userTimestamp &&
        Boolean(candidate.lastAssistantMessage);
    });
  if (!turn?.lastAssistantMessage) {
    return undefined;
  }
  return {
    source: "durable",
    text: turn.lastAssistantMessage,
    timestamp: turn.completedAt,
    id: turn.turnId,
    confidence: "high",
    metadata: {
      match: "rollout_task_complete",
      userTimestamp: turn.userTimestamp,
      session: context.source
    }
  };
}

function codexApprovalPromptRegion(screen: string):
  | { visible: true; region: string; marker: string }
  | { visible: false; reason: string } {
  const approvalMarkers = [
    "Would you like to run the following command?",
    "Would you like to make the following edits?",
    "Would you like to grant these permissions?",
    "needs your approval."
  ];
  const lines = screen.split(/\r?\n/);
  let markerIndex = -1;
  let matchedMarker = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const marker = approvalMarkers.find((candidate) => lines[index].includes(candidate));
    if (marker) {
      markerIndex = index;
      matchedMarker = marker;
      break;
    }
  }

  if (markerIndex < 0) {
    return {
      visible: false,
      reason: "no Codex approval prompt was detected in the terminal screen"
    };
  }

  const regionLines = lines.slice(markerIndex);
  const staleLine = regionLines.slice(1).find((line) => isPostApprovalActivityLine(line));
  if (staleLine) {
    return {
      visible: false,
      reason: `Codex approval prompt appears stale after later terminal activity: ${staleLine.trim()}`
    };
  }

  return {
    visible: true,
    region: regionLines.join("\n"),
    marker: matchedMarker
  };
}

function approvalCandidateFromPrompt(marker: string, region: string): { promptKind: string; command?: string } {
  const promptKind = marker === "Would you like to run the following command?"
    ? "run_command"
    : marker === "Would you like to make the following edits?"
      ? "file_edit"
      : marker === "Would you like to grant these permissions?"
        ? "grant_permissions"
        : "unknown";
  return {
    promptKind,
    command: promptKind === "run_command" ? commandFromApprovalRegion(region) : undefined
  };
}

function commandFromApprovalRegion(region: string): string | undefined {
  const lines = region.split(/\r?\n/);
  const commandStart = lines.findIndex((line) => /^\s*\$\s+/u.test(line));
  if (commandStart < 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (let index = commandStart; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > commandStart && (!line.trim() || /^[\s›]*\d+\.\s+/u.test(line) || /Press enter to confirm/u.test(line))) {
      break;
    }
    parts.push(index === commandStart ? line.replace(/^\s*\$\s+/u, "").trim() : line.trim());
  }
  const command = parts.filter(Boolean).join(" ").trim();
  return command ? redactString(command) : undefined;
}

function isPostApprovalActivityLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^✔\s+You approved\b/u.test(trimmed)) {
    return true;
  }
  if (/^›\s+(?!1\.)\S/u.test(trimmed)) {
    return true;
  }
  if (/^•\s+(Working|Ran|Explored|Edited|Read|Called|Searching|Planning|Updated|Added|Deleted|Modified|Running|Thinking)\b/u.test(trimmed)) {
    return true;
  }
  return /^─\s*Worked for\b/u.test(trimmed);
}

function isCodexWorkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^•\s+Working\b/u.test(trimmed) && (/\besc to interrupt\b/u.test(trimmed) || trimmed === "• Working")) {
    return true;
  }
  if (/^•\s+Waiting for background terminals?\b(?:\s*·|$)/u.test(trimmed)) {
    return true;
  }
  return /^\d+\s+background terminals? running\b/u.test(trimmed) && /\/(?:ps|stop)\b/u.test(trimmed);
}

function isCodexIdlePromptLine(line: string): boolean {
  const trimmed = line.trim();
  return /^›(?:\s|$)/u.test(trimmed) && !/^›\s*1\./u.test(trimmed);
}

function whitespaceInsensitiveMatchEnd(text: string, expected: string): number | undefined {
  const normalizedExpected = expected.replace(/\s/gu, "");
  if (!normalizedExpected) {
    return undefined;
  }

  let normalizedText = "";
  const sourceEnds: number[] = [];
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    if (!/\s/u.test(character)) {
      normalizedText += character;
      for (let codeUnit = 0; codeUnit < character.length; codeUnit += 1) {
        sourceEnds.push(index + character.length);
      }
    }
    index += character.length;
  }

  const matchIndex = normalizedText.lastIndexOf(normalizedExpected);
  if (matchIndex < 0) {
    return undefined;
  }
  return sourceEnds[matchIndex + normalizedExpected.length - 1];
}

function latestCompletedCodexSegment(text: string): string | undefined {
  const matches = [...text.matchAll(/^[ \t]*[─━-]+\s+Worked for\b.*$/gmu)];
  const completion = matches.at(-1);
  if (completion?.index === undefined) {
    return undefined;
  }

  const previousCompletion = matches.at(-2);
  let start = previousCompletion?.index === undefined
    ? 0
    : previousCompletion.index + previousCompletion[0].length;
  const beforeCompletion = text.slice(0, completion.index);
  const prompts = [...beforeCompletion.matchAll(/^[ \t]*›(?:\s|$).*$/gmu)];
  const latestPrompt = prompts.at(-1);
  if (latestPrompt?.index !== undefined && latestPrompt.index >= start) {
    start = latestPrompt.index + latestPrompt[0].length;
  }
  return text.slice(start, completion.index);
}

function codexCompletionBoundary(text: string): number | undefined {
  const matches = [...text.matchAll(/^[ \t]*[─━-]+\s+Worked for\b.*$/gmu)];
  return matches.at(-1)?.index;
}

function cleanCodexTerminalScreenText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed &&
        !trimmed.startsWith("› Use /skills") &&
        !/^gpt-[\w.-]+/u.test(trimmed) &&
        !/^[-\w.]+ default ·/u.test(trimmed);
    });
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
}

function asForkContextPackage(value: unknown): ForkContextPackage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const context = value as Partial<ForkContextPackage>;
  return context.source && Array.isArray(context.turns)
    ? context as ForkContextPackage
    : undefined;
}

function validTimestampMs(value: string | undefined): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requestFingerprint(value: string | undefined): string | undefined {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}... [truncated]`;
}
