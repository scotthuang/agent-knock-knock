import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ApprovalCandidate {
  agent: string;
  kind: string;
  command?: string;
  cwd?: string;
  fingerprint: string;
  terminalTarget?: string;
}

export interface ApprovalPolicyDecision {
  action: "approve" | "ask";
  reason: string;
  policyFingerprint: string;
  ruleId?: string;
  argv?: string[];
}

export interface SimpleCommandParseResult {
  ok: boolean;
  argv?: string[];
  reason?: string;
}

export interface AutoApprovalAttempt {
  approved: boolean;
  action: "approved" | "ask";
  reason: string;
  rule_id?: string;
  policy_fingerprint: string;
  approval_fingerprint: string;
  monitor_pid?: number | null;
}

export function approvalCandidateFromMessage(message: unknown): ApprovalCandidate | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  if (
    message.type !== "question" ||
    metadata?.source !== "terminal_bridge" ||
    metadata?.reason !== "approval_required"
  ) {
    return undefined;
  }
  const candidate = isRecord(metadata?.approval_candidate) ? metadata.approval_candidate : undefined;
  const agent = stringValue(candidate?.agent);
  const kind = stringValue(candidate?.kind);
  const fingerprint = stringValue(candidate?.fingerprint);
  if (!agent || !kind || !fingerprint) {
    return undefined;
  }

  return {
    agent,
    kind,
    fingerprint,
    command: stringValue(candidate?.command),
    cwd: stringValue(candidate?.cwd),
    terminalTarget: stringValue(candidate?.terminal_target)
  };
}

export function evaluateApprovalPolicy({
  policy,
  candidate
}: {
  policy: unknown;
  candidate: ApprovalCandidate;
}): ApprovalPolicyDecision {
  const policyFingerprint = fingerprintValue(policy);
  if (!isRecord(policy) || policy.enabled !== true) {
    return ask("auto approval is disabled", policyFingerprint);
  }
  if (candidate.kind !== "run_command") {
    return ask(`approval kind is not supported: ${candidate.kind}`, policyFingerprint);
  }
  if (!candidate.command) {
    return ask("approval command is unavailable", policyFingerprint);
  }
  if (!candidate.cwd) {
    return ask("approval cwd is unavailable", policyFingerprint);
  }

  const parsed = parseSimpleShellCommand(candidate.command);
  if (!parsed.ok || !parsed.argv) {
    return ask(parsed.reason ?? "approval command could not be parsed", policyFingerprint);
  }

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  for (const rawRule of rules) {
    const rule = normalizeRule(rawRule);
    if (!rule || !rule.agents.includes(candidate.agent)) {
      continue;
    }
    const workspace = rule.workspaces.find((value) => isPathWithin(candidate.cwd!, value));
    if (!workspace) {
      continue;
    }
    if (!commandPathsStayWithinWorkspace(parsed.argv, candidate.cwd, workspace)) {
      continue;
    }
    if (!rule.commands.some((command) => arraysEqual(command, parsed.argv!))) {
      continue;
    }

    return {
      action: "approve",
      reason: `matched auto-approval rule ${rule.id}`,
      policyFingerprint,
      ruleId: rule.id,
      argv: parsed.argv
    };
  }

  return ask("no explicit auto-approval rule matched", policyFingerprint, parsed.argv);
}

export function autoApprovalCliArgs({
  statePath,
  candidate,
  decision
}: {
  statePath: string;
  candidate: ApprovalCandidate;
  decision: ApprovalPolicyDecision;
}): string[] | undefined {
  if (decision.action !== "approve" || !decision.ruleId || !statePath) {
    return undefined;
  }
  return [
    "approve",
    "--state",
    statePath,
    "--expected-approval-fingerprint",
    candidate.fingerprint,
    "--auto-approved",
    "--policy-rule-id",
    decision.ruleId,
    "--policy-fingerprint",
    decision.policyFingerprint
  ];
}

export function attemptAutoApproval({
  message,
  policy,
  statePath,
  execute
}: {
  message: unknown;
  policy: unknown;
  statePath?: string;
  execute: (args: string[]) => Record<string, any>;
}): AutoApprovalAttempt | undefined {
  const candidate = approvalCandidateFromMessage(message);
  if (!candidate) {
    return undefined;
  }
  const decision = evaluateApprovalPolicy({ policy, candidate });
  const cliArgs = statePath ? autoApprovalCliArgs({ statePath, candidate, decision }) : undefined;
  if (!cliArgs || !decision.ruleId) {
    return {
      approved: false,
      action: "ask",
      reason: decision.reason,
      rule_id: decision.ruleId,
      policy_fingerprint: decision.policyFingerprint,
      approval_fingerprint: candidate.fingerprint
    };
  }

  const result = execute(cliArgs);
  return {
    approved: result.approved === true,
    action: result.approved === true ? "approved" : "ask",
    reason: result.approved === true
      ? decision.reason
      : stringValue(result.reason) ?? "automatic approval was not executed",
    rule_id: decision.ruleId,
    policy_fingerprint: decision.policyFingerprint,
    approval_fingerprint: candidate.fingerprint,
    monitor_pid: typeof result.monitor_pid === "number" ? result.monitor_pid : null
  };
}

export function parseSimpleShellCommand(command: string): SimpleCommandParseResult {
  const text = String(command ?? "").trim();
  if (!text) {
    return { ok: false, reason: "command is empty" };
  }

  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const pushToken = () => {
    if (tokenStarted) {
      argv.push(token);
      token = "";
      tokenStarted = false;
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") {
      return { ok: false, reason: "multiline commands are not allowed" };
    }
    if (quote === "single") {
      if (char === "'") {
        quote = undefined;
      } else {
        token += char;
      }
      continue;
    }
    if (quote === "double") {
      if (char === "\"") {
        quote = undefined;
        continue;
      }
      if (char === "$" || char === "`" || char === "!") {
        return { ok: false, reason: "command expansion is not allowed" };
      }
      if (char === "\\") {
        const next = text[index + 1];
        if (next === undefined || next === "\n" || next === "\r") {
          return { ok: false, reason: "invalid command escape" };
        }
        token += next;
        index += 1;
        continue;
      }
      token += char;
      continue;
    }

    if (/\s/u.test(char)) {
      pushToken();
      continue;
    }
    if (char === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (char === "\"") {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined || next === "\n" || next === "\r") {
        return { ok: false, reason: "invalid command escape" };
      }
      token += next;
      tokenStarted = true;
      index += 1;
      continue;
    }
    if ("|&;<>()`{}!".includes(char)) {
      return { ok: false, reason: `shell composition is not allowed: ${char}` };
    }
    if (char === "$" || char === "#") {
      return { ok: false, reason: "command expansion or comments are not allowed" };
    }
    if (char === "*" || char === "?" || char === "[" || char === "]") {
      return { ok: false, reason: "shell glob expansion is not allowed" };
    }
    token += char;
    tokenStarted = true;
  }

  if (quote) {
    return { ok: false, reason: "command contains an unterminated quote" };
  }
  pushToken();
  if (argv.length === 0) {
    return { ok: false, reason: "command is empty" };
  }
  if (!/^[A-Za-z0-9._+-]+$/u.test(argv[0]) || argv[0].includes("/")) {
    return { ok: false, reason: "command executable must be a simple PATH name" };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[0])) {
    return { ok: false, reason: "environment assignments are not allowed" };
  }

  return { ok: true, argv };
}

function normalizeRule(value: unknown): {
  id: string;
  agents: string[];
  workspaces: string[];
  commands: string[][];
} | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = stringValue(value.id);
  const agents = stringArray(value.agents);
  const workspaces = stringArray(value.workspaces).map((workspace) => path.resolve(expandHome(workspace)));
  const commands = Array.isArray(value.commands)
    ? value.commands.filter((command): command is string[] => (
      Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string")
    ))
    : [];
  if (!id || agents.length === 0 || workspaces.length === 0 || commands.length === 0) {
    return undefined;
  }
  return { id, agents, workspaces, commands };
}

function commandPathsStayWithinWorkspace(argv: string[], cwd: string, workspace: string): boolean {
  for (const argument of argv.slice(1)) {
    const value = argument.startsWith("-") && argument.includes("=")
      ? argument.slice(argument.indexOf("=") + 1)
      : argument;
    if (!looksLikePath(value)) {
      continue;
    }
    if (value.startsWith("~")) {
      return false;
    }
    const resolved = path.resolve(cwd, value);
    if (!isPathWithin(resolved, workspace)) {
      return false;
    }
  }
  return true;
}

function looksLikePath(value: string): boolean {
  return value === "." || value === ".." || value.startsWith("./") || value.startsWith("../") ||
    value.startsWith("/") || value.startsWith("~") || value.includes("/");
}

function isPathWithin(candidate: string, workspace: string): boolean {
  const relative = path.relative(canonicalPath(workspace), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  const suffix: string[] = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      return resolved;
    }
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync(existing), ...suffix);
  } catch {
    return resolved;
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ask(reason: string, policyFingerprint: string, argv?: string[]): ApprovalPolicyDecision {
  return {
    action: "ask",
    reason,
    policyFingerprint,
    argv
  };
}

function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(sortValue(value))).digest("hex").slice(0, 16);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
