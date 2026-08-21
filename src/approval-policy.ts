import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ApprovalCandidate {
  agent: string;
  kind: string;
  decisionMode?: "keys";
  command?: string;
  cwd?: string;
  fingerprint: string;
  terminalTarget?: string;
  evidenceSource?: "claude_transcript";
  evidenceFingerprint?: string;
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
  handled: boolean;
  action: "approved" | "already_approved" | "ask";
  reason: string;
  rule_id?: string;
  policy_fingerprint: string;
  approval_fingerprint: string;
  monitor_pid?: number | null;
}

export interface AutoApprovalCallbackAuthority {
  conversationId: string;
  messageId: string;
  openclawSession: string;
  sessionId: string;
  turnId: string;
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
  const policyEvidence = isRecord(candidate?.policy_evidence)
    ? candidate.policy_evidence
    : undefined;
  if (!agent || !kind || !fingerprint) {
    return undefined;
  }

  return {
    agent,
    kind,
    fingerprint,
    ...(candidate?.decision_mode === "keys"
      ? { decisionMode: candidate.decision_mode }
      : {}),
    command: stringValue(candidate?.command),
    cwd: stringValue(candidate?.cwd),
    terminalTarget: stringValue(candidate?.terminal_target),
    ...(policyEvidence?.source === "claude_transcript"
      ? { evidenceSource: "claude_transcript" as const }
      : {}),
    ...(stringValue(policyEvidence?.evidence_fingerprint)
      ? { evidenceFingerprint: stringValue(policyEvidence?.evidence_fingerprint) }
      : {})
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
  if (
    candidate.agent === "claude" &&
    (
      candidate.decisionMode !== "keys" ||
      candidate.evidenceSource !== "claude_transcript" ||
      !isSha256Hex(candidate.evidenceFingerprint)
    )
  ) {
    return ask(
      "Claude auto approval requires verified local transcript evidence for a keys-mode request",
      policyFingerprint
    );
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
  decision,
  policy,
  callbackAuthority
}: {
  statePath: string;
  candidate: ApprovalCandidate;
  decision: ApprovalPolicyDecision;
  policy: unknown;
  callbackAuthority?: AutoApprovalCallbackAuthority;
}): string[] | undefined {
  const serializedPolicy = JSON.stringify(policy);
  if (
    decision.action !== "approve" ||
    !decision.ruleId ||
    !statePath ||
    typeof serializedPolicy !== "string"
  ) {
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
    decision.policyFingerprint,
    "--auto-approval-policy-json",
    serializedPolicy,
    ...autoApprovalCallbackAuthorityCliArgs(callbackAuthority)
  ];
}

export function attemptAutoApproval({
  message,
  policy,
  statePath,
  callbackAuthority,
  execute
}: {
  message: unknown;
  policy: unknown;
  statePath?: string;
  callbackAuthority?: AutoApprovalCallbackAuthority;
  execute: (args: string[]) => Record<string, any>;
}): AutoApprovalAttempt | undefined {
  const candidate = approvalCandidateFromMessage(message);
  if (!candidate) {
    return undefined;
  }
  const decision = evaluateApprovalPolicy({ policy, candidate });
  const deferredDecision = deferredClaudeAutoApprovalDecision({
    policy,
    candidate,
    decision
  });
  const cliArgs = statePath
    ? decision.action === "approve"
      ? autoApprovalCliArgs({
          statePath,
          candidate,
          decision,
          policy,
          callbackAuthority
        })
      : deferredDecision
        ? deferredAutoApprovalCliArgs({
            statePath,
            candidate,
            policy,
            policyFingerprint: deferredDecision.policyFingerprint,
            callbackAuthority
          })
        : undefined
    : undefined;
  if (!cliArgs) {
    return {
      approved: false,
      handled: false,
      action: "ask",
      reason: deferredDecision?.reason ?? decision.reason,
      rule_id: decision.ruleId,
      policy_fingerprint:
        deferredDecision?.policyFingerprint ?? decision.policyFingerprint,
      approval_fingerprint: candidate.fingerprint
    };
  }

  const result = execute(cliArgs);
  const effectiveRuleId = stringValue(result.policy_rule_id) ?? decision.ruleId;
  const effectivePolicyFingerprint =
    stringValue(result.policy_fingerprint) ??
    deferredDecision?.policyFingerprint ??
    decision.policyFingerprint;
  const approved = result.approved === true;
  const alreadyApproved = result.already_approved === true;
  return {
    approved,
    handled: approved || alreadyApproved,
    action: approved
      ? "approved"
      : alreadyApproved
        ? "already_approved"
        : "ask",
    reason: approved
      ? stringValue(result.reason) ??
        (effectiveRuleId
          ? `matched auto-approval rule ${effectiveRuleId}`
          : "executor approved the verified local Claude request")
      : stringValue(result.reason) ?? "automatic approval was not executed",
    rule_id: effectiveRuleId,
    policy_fingerprint: effectivePolicyFingerprint,
    approval_fingerprint: candidate.fingerprint,
    monitor_pid: typeof result.monitor_pid === "number" ? result.monitor_pid : null
  };
}

function deferredClaudeAutoApprovalDecision({
  policy,
  candidate,
  decision
}: {
  policy: unknown;
  candidate: ApprovalCandidate;
  decision: ApprovalPolicyDecision;
}): ApprovalPolicyDecision | undefined {
  if (
    decision.action === "approve" ||
    candidate.agent !== "claude" ||
    candidate.kind !== "run_command" ||
    candidate.decisionMode !== "keys" ||
    candidate.evidenceSource !== "claude_transcript" ||
    !isSha256Hex(candidate.evidenceFingerprint) ||
    !candidate.cwd
  ) {
    return undefined;
  }
  const policyFingerprint = fingerprintValue(policy);
  if (!isRecord(policy) || policy.enabled !== true) {
    return undefined;
  }
  const hasEligibleRule = (Array.isArray(policy.rules) ? policy.rules : [])
    .map(normalizeRule)
    .filter((rule): rule is NonNullable<ReturnType<typeof normalizeRule>> => Boolean(rule))
    .some((rule) =>
      rule.agents.includes("claude") &&
      rule.workspaces.some((workspace) => isPathWithin(candidate.cwd!, workspace))
    );
  if (!hasEligibleRule) {
    return undefined;
  }
  return ask(
    "Claude command policy will be evaluated from fresh local transcript evidence by the executor",
    policyFingerprint
  );
}

function deferredAutoApprovalCliArgs({
  statePath,
  candidate,
  policy,
  policyFingerprint,
  callbackAuthority
}: {
  statePath: string;
  candidate: ApprovalCandidate;
  policy: unknown;
  policyFingerprint: string;
  callbackAuthority?: AutoApprovalCallbackAuthority;
}): string[] | undefined {
  const serializedPolicy = JSON.stringify(policy);
  if (!statePath || typeof serializedPolicy !== "string") {
    return undefined;
  }
  return [
    "approve",
    "--state",
    statePath,
    "--expected-approval-fingerprint",
    candidate.fingerprint,
    "--auto-approved",
    "--policy-fingerprint",
    policyFingerprint,
    "--auto-approval-policy-json",
    serializedPolicy,
    ...autoApprovalCallbackAuthorityCliArgs(callbackAuthority)
  ];
}

function autoApprovalCallbackAuthorityCliArgs(
  authority: AutoApprovalCallbackAuthority | undefined
): string[] {
  if (!authority) {
    return [];
  }
  return [
    "--expected-callback-conversation-id",
    authority.conversationId,
    "--expected-callback-session-id",
    authority.sessionId,
    "--expected-callback-turn-id",
    authority.turnId,
    "--expected-callback-message-id",
    authority.messageId,
    "--expected-callback-openclaw-session",
    authority.openclawSession
  ];
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
  const configuredWorkspaces = stringArray(value.workspaces)
    .map((workspace) => expandHome(workspace));
  if (!configuredWorkspaces.every((workspace) => path.isAbsolute(workspace))) {
    return undefined;
  }
  const workspaces = configuredWorkspaces.map((workspace) =>
    path.resolve(workspace)
  );
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

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
