import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalClaudePermissionFingerprint,
  claudePermissionHookOutput,
  parseClaudeHookInput,
  type ClaudeHookInput,
  type ClaudePermissionBehavior,
  type ClaudePermissionHookOutput,
  type ClaudePermissionRequestHookInput,
  type ClaudeStopFailureHookInput,
  type ClaudeStopHookInput,
  type ClaudeUserPromptSubmitHookInput
} from "./claude-hook-protocol.js";

const STORE_SCHEMA_VERSION = 1;
const DEFAULT_PERMISSION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_MANAGED_LEASE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

export type ClaudeHookStoreErrorCode =
  | "INVALID_INPUT"
  | "SESSION_NOT_FOUND"
  | "SESSION_IDENTITY_MISMATCH"
  | "AMBIGUOUS_SESSION"
  | "PERMISSION_NOT_FOUND"
  | "PERMISSION_EXPIRED"
  | "PERMISSION_CONSUMED"
  | "PERMISSION_ALREADY_DECIDED"
  | "PERMISSION_FINGERPRINT_MISMATCH"
  | "AMBIGUOUS_PERMISSION"
  | "CORRUPT_STORE"
  | "LOCK_TIMEOUT";

export class ClaudeHookStoreError extends Error {
  readonly code: ClaudeHookStoreErrorCode;

  constructor(code: ClaudeHookStoreErrorCode, message: string) {
    super(message);
    this.name = "ClaudeHookStoreError";
    this.code = code;
  }
}

export interface ClaudeStoredHookEvent {
  id: string;
  received_at: string;
  claude_pid?: number;
  turn_id?: string;
  lease_id?: string;
  conversation_id?: string;
  message_id?: string;
  input: ClaudeHookInput;
}

export interface ClaudeStoredPermissionDecision {
  behavior: ClaudePermissionBehavior;
  interrupt?: boolean;
  decided_at: string;
}

export interface ClaudePendingPermission {
  requestId: string;
  nonce: string;
  fingerprint: string;
  eventId: string;
  turnId?: string;
  sessionId: string;
  leaseId: string;
  leaseMatchedBy: "session" | "pid";
  claudePid?: number;
  terminalTarget: string;
  conversationId: string;
  messageId: string;
  cwd: string;
  toolName: string;
  toolInput: ClaudePermissionRequestHookInput["tool_input"];
  createdAt: string;
  expiresAt: string;
  decision?: ClaudeStoredPermissionDecision;
  consumedAt?: string;
}

export interface ClaudeHookSession {
  schema_version: typeof STORE_SCHEMA_VERSION;
  session_id: string;
  cwd: string;
  transcript_path: string;
  claude_pid?: number;
  created_at: string;
  updated_at: string;
  active_turn_id?: string;
  events: ClaudeStoredHookEvent[];
  permissions: ClaudePendingPermission[];
}

export interface ClaudeHookStoreOptions {
  rootDir?: string;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  permissionLeaseMs?: number;
  randomId?: () => string;
}

export interface ClaudeHookRecordOptions {
  claudePid?: number;
  permissionLeaseMs?: number;
}

export interface ClaudeHookRecordResult {
  event: ClaudeStoredHookEvent;
  session: ClaudeHookSession;
  permission?: ClaudePendingPermission;
  managed: boolean;
  lease?: ClaudeManagedLeaseResolution;
}

export interface ClaudeSessionIdentity {
  sessionId?: string;
  pid?: number;
  cwd?: string;
  requireUnique?: boolean;
}

export interface ActivateClaudeManagedLeaseOptions {
  sessionId?: string;
  pid?: number;
  cwd: string;
  conversationId: string;
  messageId: string;
  terminalTarget: string;
  expiresAt?: string | Date;
}

export interface ClaudeManagedLease {
  id: string;
  sessionId?: string;
  pid?: number;
  cwd: string;
  conversationId: string;
  messageId: string;
  terminalTarget: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  releasedAt?: string;
}

export interface ClaudeManagedLeaseResolution {
  lease: ClaudeManagedLease;
  matchedBy: "session" | "pid" | "cwd";
  authorizationEligible: boolean;
}

export interface ReleaseClaudeManagedLeaseOptions {
  leaseId?: string;
  conversationId?: string;
  messageId?: string;
}

export type ClaudePermissionInspection =
  | {
      blocked: false;
      approvable: false;
      reason: string;
    }
  | {
      blocked: true;
      approvable: false;
      reason: string;
      requestId?: string;
      fingerprint?: string;
      expiresAt?: string;
      cwd?: string;
      sessionId?: string;
      conversationId?: string;
      messageId?: string;
    }
  | {
      blocked: true;
      approvable: true;
      reason: string;
      requestId: string;
      fingerprint: string;
      expiresAt: string;
      eventId: string;
      sessionId: string;
      leaseId: string;
      conversationId: string;
      messageId: string;
      cwd: string;
      toolName: string;
      toolInput: ClaudePermissionRequestHookInput["tool_input"];
      kind: "run_command" | "tool_permission";
      promptKind: "run_command" | "tool_permission";
      command?: string;
    };

export interface DecideClaudePermissionOptions {
  sessionId: string;
  requestId: string;
  fingerprint: string;
  conversationId: string;
  messageId: string;
  decision: ClaudePermissionBehavior;
  interrupt?: boolean;
}

export interface ConsumeClaudePermissionOptions {
  sessionId: string;
  requestId: string;
  fingerprint: string;
  conversationId: string;
  messageId: string;
}

export interface WaitForClaudePermissionDecisionOptions extends ConsumeClaudePermissionOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ClaudeConsumedPermissionDecision {
  requestId: string;
  fingerprint: string;
  behavior: ClaudePermissionBehavior;
  interrupt?: boolean;
  decidedAt: string;
  consumedAt: string;
  hookOutput: ClaudePermissionHookOutput;
}

export interface DetectClaudeCompletionOptions extends ClaudeSessionIdentity {
  startedAt: string | Date;
  promptId?: string;
  conversationId?: string;
  messageId?: string;
}

export interface ClaudeStopFailure {
  code: ClaudeStopFailureHookInput["error"];
  details?: ClaudeStopFailureHookInput["error_details"];
  message?: string;
  eventId: string;
  receivedAt: string;
  promptId: string;
}

export type ClaudeCompletionInspection =
  | {
      status: "done";
      reason: string;
      sessionId: string;
      promptId: string;
      eventId: string;
      timestamp: string;
      text: string;
      cwd: string;
    }
  | {
      status: "failed";
      reason: string;
      sessionId: string;
      promptId: string;
      failure: ClaudeStopFailure;
    }
  | {
      status: "pending" | "unknown";
      reason: string;
      sessionId?: string;
      promptId?: string;
    };

export function defaultClaudeHookStoreDir(): string {
  return path.join(os.homedir(), ".agent-knock-knock", "claude-hooks");
}

export class ClaudeHookStore {
  readonly rootDir: string;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly permissionLeaseMs: number;
  private readonly randomId: () => string;

  constructor(options: ClaudeHookStoreOptions = {}) {
    this.rootDir = options.rootDir ?? defaultClaudeHookStoreDir();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.permissionLeaseMs = positiveMilliseconds(
      options.permissionLeaseMs ?? DEFAULT_PERMISSION_LEASE_MS,
      "permissionLeaseMs"
    );
    this.randomId = options.randomId ?? randomUUID;
  }

  activateLease(options: ActivateClaudeManagedLeaseOptions): ClaudeManagedLease {
    validateActivateLeaseOptions(options);
    return this.withLeaseLock(() => {
      const leases = this.readLeases();
      const now = this.nowIso();
      const expiresAt = options.expiresAt === undefined
        ? new Date(Date.parse(now) + DEFAULT_MANAGED_LEASE_MS).toISOString()
        : new Date(timestampMs(options.expiresAt, "expiresAt")).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(now)) {
        throw new ClaudeHookStoreError("INVALID_INPUT", "managed Claude lease expiresAt must be in the future");
      }

      const existing = leases.find((lease) =>
        !lease.releasedAt &&
        lease.conversationId === options.conversationId &&
        lease.messageId === options.messageId
      );
      const conflicts = leases.filter((lease) =>
        !lease.releasedAt &&
        Date.parse(lease.expiresAt) > Date.parse(now) &&
        lease.id !== existing?.id &&
        ((options.sessionId !== undefined && lease.sessionId === options.sessionId) ||
          (options.pid !== undefined && lease.pid === options.pid))
      );
      if (conflicts.length > 0) {
        throw new ClaudeHookStoreError(
          "AMBIGUOUS_SESSION",
          "an active managed Claude lease already owns the exact session or pid"
        );
      }

      const lease: ClaudeManagedLease = existing
        ? Object.assign(existing, {
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            ...(options.pid === undefined ? {} : { pid: options.pid }),
            cwd: options.cwd,
            terminalTarget: options.terminalTarget,
            updatedAt: now,
            expiresAt
          })
        : {
            id: uniqueManagedLeaseId(leases, this.randomId),
            ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
            ...(options.pid === undefined ? {} : { pid: options.pid }),
            cwd: options.cwd,
            conversationId: options.conversationId,
            messageId: options.messageId,
            terminalTarget: options.terminalTarget,
            createdAt: now,
            updatedAt: now,
            expiresAt
          };
      if (!existing) {
        leases.push(lease);
      }
      this.writeLeases(leases);
      return clone(lease);
    });
  }

  resolveLease(
    inputOrIdentity: ClaudeHookInput | ClaudeSessionIdentity
  ): ClaudeManagedLeaseResolution | undefined {
    const identity = hookInputIdentity(inputOrIdentity);
    validateIdentity(identity);
    return cloneOptional(this.resolveLeaseFrom(this.readLeases(), identity));
  }

  releaseLease(options: ReleaseClaudeManagedLeaseOptions): ClaudeManagedLease | undefined {
    validateReleaseLeaseOptions(options);
    return this.withLeaseLock(() => {
      const leases = this.readLeases();
      const matches = leases.filter((lease) =>
        options.leaseId !== undefined
          ? lease.id === options.leaseId
          : lease.conversationId === options.conversationId && lease.messageId === options.messageId
      );
      const activeMatches = matches.filter((lease) => !lease.releasedAt);
      if (activeMatches.length > 1) {
        throw new ClaudeHookStoreError("AMBIGUOUS_SESSION", "multiple managed Claude leases match release identity");
      }
      const lease = activeMatches[0] ?? (matches.length === 1 ? matches[0] : undefined);
      if (!lease) {
        return undefined;
      }
      if (!lease.releasedAt) {
        const now = this.nowIso();
        lease.releasedAt = now;
        lease.updatedAt = now;
        this.writeLeases(leases);
      }
      return clone(lease);
    });
  }

  record(inputValue: ClaudeHookInput | unknown, options: ClaudeHookRecordOptions = {}): ClaudeHookRecordResult {
    const input = parseClaudeHookInput(inputValue);
    const claudePid = optionalPid(options.claudePid);
    const leaseMs = positiveMilliseconds(
      options.permissionLeaseMs ?? this.permissionLeaseMs,
      "permissionLeaseMs"
    );

    return this.withSessionLock(input.session_id, () => this.withLeaseLock(() => {
      const receivedAt = this.nowIso();
      const lease = this.resolveLeaseFrom(this.readLeases(), {
        sessionId: input.session_id,
        ...(claudePid === undefined ? {} : { pid: claudePid }),
        cwd: input.cwd
      }, { ambiguousCwdAsUnmanaged: true });
      const persist = lease?.authorizationEligible === true;
      // Global Claude hooks observe every local Claude session. Never load an unmanaged
      // event into a persisted session or write its raw prompt/tool/output fields to disk.
      const session = persist
        ? this.readSessionById(input.session_id) ?? newSession(input, receivedAt)
        : newSession(input, receivedAt);
      const eventId = this.uniqueEventId(session);

      if (input.hook_event_name === "SessionStart" &&
          (input.source === "startup" || input.source === "clear" || input.source === "fork")) {
        session.active_turn_id = undefined;
      }

      const turnId = input.hook_event_name === "UserPromptSubmit"
        ? input.prompt_id ?? eventId
        : input.prompt_id ?? session.active_turn_id;
      const event: ClaudeStoredHookEvent = {
        id: eventId,
        received_at: receivedAt,
        ...(claudePid === undefined ? {} : { claude_pid: claudePid }),
        ...(turnId === undefined ? {} : { turn_id: turnId }),
        ...(lease === undefined ? {} : {
          lease_id: lease.lease.id,
          conversation_id: lease.lease.conversationId,
          message_id: lease.lease.messageId
        }),
        input
      };

      session.cwd = input.cwd;
      session.transcript_path = input.transcript_path;
      session.updated_at = receivedAt;
      if (claudePid !== undefined) {
        session.claude_pid = claudePid;
      }
      if (input.hook_event_name === "UserPromptSubmit") {
        session.active_turn_id = turnId;
      }
      session.events.push(event);

      if (!persist) {
        return clone({
          event,
          session,
          managed: false,
          ...(lease ? { lease } : {})
        });
      }

      const permission = input.hook_event_name === "PermissionRequest"
        ? this.createPendingPermission(session, event, input, leaseMs, lease!)
        : undefined;
      if (permission) {
        session.permissions.push(permission);
      }

      this.writeSession(session);
      return clone({
        event,
        session,
        managed: true,
        ...(permission ? { permission } : {}),
        ...(lease ? { lease } : {})
      });
    }));
  }

  resolveSession(identity: ClaudeSessionIdentity): ClaudeHookSession | undefined {
    validateIdentity(identity);
    if (identity.sessionId) {
      const session = this.readSessionById(identity.sessionId);
      if (!session) {
        return undefined;
      }
      if (identity.pid !== undefined && session.claude_pid !== identity.pid) {
        throw new ClaudeHookStoreError(
          "SESSION_IDENTITY_MISMATCH",
          `Claude session ${identity.sessionId} does not belong to pid ${identity.pid}`
        );
      }
      if (identity.cwd !== undefined && session.cwd !== identity.cwd) {
        throw new ClaudeHookStoreError(
          "SESSION_IDENTITY_MISMATCH",
          `Claude session ${identity.sessionId} does not belong to cwd ${identity.cwd}`
        );
      }
      return clone(session);
    }

    const sessions = this.readAllSessions();
    const matches = identity.pid !== undefined
      ? sessions.filter((session) => session.claude_pid === identity.pid)
      : sessions.filter((session) => session.cwd === identity.cwd);
    if (matches.length === 0) {
      return undefined;
    }
    if (matches.length > 1 && identity.requireUnique !== false) {
      const label = identity.pid !== undefined ? `pid ${identity.pid}` : `cwd ${identity.cwd}`;
      throw new ClaudeHookStoreError(
        "AMBIGUOUS_SESSION",
        `multiple Claude sessions match ${label}; use the exact session id`
      );
    }
    matches.sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
    return clone(matches[0]);
  }

  inspectPermission(identity: ClaudeSessionIdentity): ClaudePermissionInspection {
    const session = this.resolveSession(identity);
    if (!session) {
      return { blocked: false, approvable: false, reason: "no matching Claude hook session" };
    }

    const nowMs = this.nowDate().getTime();
    const managedLeases = new Map(this.readLeases()
      .filter((lease) => lease.releasedAt === undefined && Date.parse(lease.expiresAt) > nowMs)
      .map((lease) => [lease.id, lease]));
    const active = session.permissions.filter((permission) =>
      permission.consumedAt === undefined &&
      Date.parse(permission.expiresAt) > nowMs &&
      managedLeases.get(permission.leaseId)?.conversationId === permission.conversationId &&
      managedLeases.get(permission.leaseId)?.messageId === permission.messageId
    );
    if (active.length === 0) {
      return { blocked: false, approvable: false, reason: "no unexpired Claude permission request" };
    }
    if (active.length > 1) {
      return {
        blocked: true,
        approvable: false,
        reason: "multiple Claude permission requests are pending; an exact request id is required"
      };
    }

    const permission = active[0];
    if (permission.decision) {
      return {
        blocked: true,
        approvable: false,
        reason: `Claude permission decision ${permission.decision.behavior} is waiting for hook consumption`,
        requestId: permission.requestId,
        fingerprint: permission.fingerprint,
        expiresAt: permission.expiresAt,
        cwd: permission.cwd,
        sessionId: permission.sessionId,
        conversationId: permission.conversationId,
        messageId: permission.messageId
      };
    }

    const command = permission.toolName === "Bash"
      ? stringProperty(permission.toolInput, "command")
      : undefined;
    const kind = permission.toolName === "Bash" ? "run_command" : "tool_permission";
    return {
      blocked: true,
      approvable: true,
      reason: `Claude requested permission for ${permission.toolName}`,
      requestId: permission.requestId,
      fingerprint: permission.fingerprint,
      expiresAt: permission.expiresAt,
      eventId: permission.eventId,
      sessionId: permission.sessionId,
      leaseId: permission.leaseId,
      conversationId: permission.conversationId,
      messageId: permission.messageId,
      cwd: permission.cwd,
      toolName: permission.toolName,
      toolInput: clone(permission.toolInput),
      kind,
      promptKind: kind,
      ...(command ? { command } : {})
    };
  }

  decidePermission(options: DecideClaudePermissionOptions): ClaudeStoredPermissionDecision {
    validateDecisionOptions(options);
    return this.withSessionLock(options.sessionId, () => this.withLeaseLock(() => {
      const session = this.requireSession(options.sessionId);
      const permission = requirePermission(session, options.requestId);
      this.validatePermissionLease(permission, options, this.readLeases());
      if (permission.decision) {
        throw new ClaudeHookStoreError(
          "PERMISSION_ALREADY_DECIDED",
          `Claude permission request ${options.requestId} already has a decision`
        );
      }

      const decidedAt = this.nowIso();
      const decision: ClaudeStoredPermissionDecision = {
        behavior: options.decision,
        ...(options.decision === "deny" && options.interrupt !== undefined
          ? { interrupt: options.interrupt }
          : {}),
        decided_at: decidedAt
      };
      permission.decision = decision;
      session.updated_at = decidedAt;
      this.writeSession(session);
      return clone(decision);
    }));
  }

  consumePermissionDecision(
    options: ConsumeClaudePermissionOptions
  ): ClaudeConsumedPermissionDecision | undefined {
    validateConsumeOptions(options);
    return this.withSessionLock(options.sessionId, () => this.withLeaseLock(() => {
      const session = this.requireSession(options.sessionId);
      const permission = requirePermission(session, options.requestId);
      this.validatePermissionLease(permission, options, this.readLeases(), {
        allowDecidedAfterRelease: true
      });
      if (!permission.decision) {
        return undefined;
      }

      const consumedAt = this.nowIso();
      permission.consumedAt = consumedAt;
      session.updated_at = consumedAt;
      this.writeSession(session);
      const decision = permission.decision;
      return {
        requestId: permission.requestId,
        fingerprint: permission.fingerprint,
        behavior: decision.behavior,
        ...(decision.interrupt === undefined ? {} : { interrupt: decision.interrupt }),
        decidedAt: decision.decided_at,
        consumedAt,
        hookOutput: claudePermissionHookOutput(decision)
      };
    }));
  }

  async waitForPermissionDecision(
    options: WaitForClaudePermissionDecisionOptions
  ): Promise<ClaudeConsumedPermissionDecision | undefined> {
    const timeoutMs = options.timeoutMs === undefined
      ? this.permissionLeaseRemaining(options)
      : nonNegativeMilliseconds(options.timeoutMs, "timeoutMs");
    const pollIntervalMs = positiveMilliseconds(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs"
    );
    const deadline = this.nowDate().getTime() + timeoutMs;

    while (true) {
      const result = this.consumePermissionDecision(options);
      if (result) {
        return result;
      }
      const remaining = deadline - this.nowDate().getTime();
      if (remaining <= 0) {
        return undefined;
      }
      await this.sleep(Math.min(pollIntervalMs, remaining));
    }
  }

  detectCompletion(options: DetectClaudeCompletionOptions): ClaudeCompletionInspection {
    const startedAtMs = timestampMs(options.startedAt, "startedAt");
    const hasConversationId = options.conversationId !== undefined;
    const hasMessageId = options.messageId !== undefined;
    if (hasConversationId !== hasMessageId ||
        (hasConversationId && (!options.conversationId || !options.messageId))) {
      throw new ClaudeHookStoreError(
        "INVALID_INPUT",
        "conversationId and messageId must be provided together for Claude completion detection"
      );
    }
    const session = this.resolveSession(options);
    if (!session) {
      return { status: "unknown", reason: "no matching Claude hook session" };
    }

    const completionLease = hasConversationId
      ? this.resolveLeaseFrom(this.readLeases(), options)
      : undefined;
    if (hasConversationId && (!completionLease || !completionLease.authorizationEligible)) {
      return {
        status: "unknown",
        reason: "no active strongly-bound managed Claude lease matches the completion identity",
        sessionId: session.session_id
      };
    }
    if (completionLease &&
        (completionLease.lease.conversationId !== options.conversationId ||
          completionLease.lease.messageId !== options.messageId)) {
      return {
        status: "unknown",
        reason: "the active managed Claude lease belongs to a different conversation message",
        sessionId: session.session_id
      };
    }
    const matchesCompletionLease = (event: ClaudeStoredHookEvent): boolean =>
      completionLease === undefined || (
        event.lease_id === completionLease.lease.id &&
        event.conversation_id === completionLease.lease.conversationId &&
        event.message_id === completionLease.lease.messageId
      );

    const prompts = session.events.filter((event): event is ClaudeStoredHookEvent & {
      input: ClaudeUserPromptSubmitHookInput;
      turn_id: string;
    } =>
      event.input.hook_event_name === "UserPromptSubmit" &&
      event.turn_id !== undefined &&
      Date.parse(event.received_at) >= startedAtMs &&
      matchesCompletionLease(event) &&
      (options.promptId === undefined ||
        event.turn_id === options.promptId ||
        event.id === options.promptId ||
        event.input.prompt_id === options.promptId)
    );
    if (prompts.length === 0) {
      return {
        status: "unknown",
        reason: options.promptId
          ? `no UserPromptSubmit hook event matches prompt ${options.promptId} after startedAt`
          : "no UserPromptSubmit hook event was observed after startedAt",
        sessionId: session.session_id
      };
    }
    prompts.sort((left, right) => Date.parse(left.received_at) - Date.parse(right.received_at));
    const prompt = prompts[0];
    const promptId = prompt.turn_id;
    const terminalEvents = session.events.filter((event) =>
      event.turn_id === promptId &&
      Date.parse(event.received_at) >= Date.parse(prompt.received_at) &&
      sameManagedMessageBinding(prompt, event) &&
      matchesCompletionLease(event) &&
      (event.input.hook_event_name === "Stop" || event.input.hook_event_name === "StopFailure")
    );
    if (terminalEvents.length === 0) {
      return {
        status: "pending",
        reason: "the correlated Claude turn has not emitted Stop or StopFailure",
        sessionId: session.session_id,
        promptId
      };
    }
    terminalEvents.sort((left, right) => Date.parse(left.received_at) - Date.parse(right.received_at));
    const terminalEvent = terminalEvents.at(-1)!;

    if (terminalEvent.input.hook_event_name === "StopFailure") {
      const failure: ClaudeStopFailure = {
        code: terminalEvent.input.error,
        ...(terminalEvent.input.error_details === undefined
          ? {}
          : { details: clone(terminalEvent.input.error_details) }),
        ...(terminalEvent.input.last_assistant_message === undefined
          ? {}
          : { message: terminalEvent.input.last_assistant_message }),
        eventId: terminalEvent.id,
        receivedAt: terminalEvent.received_at,
        promptId
      };
      return {
        status: "failed",
        reason: `Claude turn failed with ${failure.code}`,
        sessionId: session.session_id,
        promptId,
        failure
      };
    }

    if (terminalEvent.input.hook_event_name !== "Stop") {
      return {
        status: "unknown",
        reason: "correlated Claude terminal hook event has an unsupported type",
        sessionId: session.session_id,
        promptId
      };
    }
    return completionFromStop(session, promptId, terminalEvent, terminalEvent.input);
  }

  private createPendingPermission(
    session: ClaudeHookSession,
    event: ClaudeStoredHookEvent,
    input: ClaudePermissionRequestHookInput,
    leaseMs: number,
    leaseResolution: ClaudeManagedLeaseResolution
  ): ClaudePendingPermission {
    const lease = leaseResolution.lease;
    if (!leaseResolution.authorizationEligible || leaseResolution.matchedBy === "cwd") {
      throw new ClaudeHookStoreError("INVALID_INPUT", "cwd-only managed leases cannot authorize Claude");
    }
    const fingerprint = canonicalClaudePermissionFingerprint(input);
    const nonce = this.uniqueNonce(session);
    return {
      requestId: `permission:${fingerprint.slice(0, 16)}:${nonce}`,
      nonce,
      fingerprint,
      eventId: event.id,
      ...(event.turn_id === undefined ? {} : { turnId: event.turn_id }),
      sessionId: session.session_id,
      leaseId: lease.id,
      leaseMatchedBy: leaseResolution.matchedBy,
      ...(event.claude_pid === undefined ? {} : { claudePid: event.claude_pid }),
      terminalTarget: lease.terminalTarget,
      conversationId: lease.conversationId,
      messageId: lease.messageId,
      cwd: input.cwd,
      toolName: input.tool_name,
      toolInput: clone(input.tool_input),
      createdAt: event.received_at,
      expiresAt: new Date(Math.min(
        Date.parse(event.received_at) + leaseMs,
        Date.parse(lease.expiresAt)
      )).toISOString()
    };
  }

  private resolveLeaseFrom(
    leases: ClaudeManagedLease[],
    identity: ClaudeSessionIdentity,
    options: { ambiguousCwdAsUnmanaged?: boolean } = {}
  ): ClaudeManagedLeaseResolution | undefined {
    const nowMs = this.nowDate().getTime();
    const active = leases.filter((lease) =>
      lease.releasedAt === undefined && Date.parse(lease.expiresAt) > nowMs
    );
    const isConsistent = (lease: ClaudeManagedLease): boolean =>
      (lease.sessionId === undefined || identity.sessionId === lease.sessionId) &&
      (lease.pid === undefined || identity.pid === lease.pid) &&
      (identity.cwd === undefined || lease.cwd === identity.cwd);

    const exactSession = identity.sessionId === undefined
      ? []
      : active.filter((lease) => lease.sessionId === identity.sessionId);
    const exactPid = identity.pid === undefined
      ? []
      : active.filter((lease) => lease.pid === identity.pid);
    if (exactSession.length > 0 && exactPid.length > 0) {
      const exactPidIds = new Set(exactPid.map((lease) => lease.id));
      return uniqueLeaseResolution(
        exactSession.filter((lease) => exactPidIds.has(lease.id) && isConsistent(lease)),
        "session"
      );
    }
    if (exactSession.length > 0) {
      return uniqueLeaseResolution(exactSession.filter(isConsistent), "session");
    }

    if (exactPid.length > 0) {
      return uniqueLeaseResolution(exactPid.filter(isConsistent), "pid");
    }

    const exactCwd = identity.cwd === undefined
      ? []
      : active.filter((lease) => lease.cwd === identity.cwd && isConsistent(lease));
    if (exactCwd.length > 1 && options.ambiguousCwdAsUnmanaged) {
      return undefined;
    }
    return uniqueLeaseResolution(exactCwd, "cwd");
  }

  private readLeases(): ClaudeManagedLease[] {
    const filePath = path.join(this.rootDir, "leases.json");
    if (!fs.existsSync(filePath)) {
      return [];
    }
    rejectSymlink(filePath);
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      throw corruptStore(filePath, error);
    }
    if (!isObject(value) || value.schema_version !== STORE_SCHEMA_VERSION || !Array.isArray(value.leases)) {
      throw corruptStore(filePath, "invalid managed lease file");
    }
    if (!value.leases.every(isManagedLease)) {
      throw corruptStore(filePath, "invalid managed lease entry");
    }
    return value.leases as ClaudeManagedLease[];
  }

  private writeLeases(leases: ClaudeManagedLease[]): void {
    ensureDirectory(this.rootDir);
    const filePath = path.join(this.rootDir, "leases.json");
    const temporaryPath = `${filePath}.${process.pid}.${this.randomId()}.tmp`;
    atomicWriteJson(filePath, temporaryPath, {
      schema_version: STORE_SCHEMA_VERSION,
      leases
    });
  }

  private withLeaseLock<T>(action: () => T): T {
    return withFileLock(path.join(this.rootDir, "leases.lock"), this.randomId, action);
  }

  private validatePermissionLease(
    permission: ClaudePendingPermission,
    identity: ConsumeClaudePermissionOptions,
    leases: ClaudeManagedLease[],
    options: { allowDecidedAfterRelease?: boolean } = {}
  ): void {
    if (permission.fingerprint !== identity.fingerprint) {
      throw new ClaudeHookStoreError(
        "PERMISSION_FINGERPRINT_MISMATCH",
        `Claude permission fingerprint changed for request ${permission.requestId}`
      );
    }
    if (permission.conversationId !== identity.conversationId || permission.messageId !== identity.messageId) {
      throw new ClaudeHookStoreError(
        "SESSION_IDENTITY_MISMATCH",
        `Claude permission request ${permission.requestId} belongs to a different conversation message`
      );
    }
    const managedLease = leases.find((lease) => lease.id === permission.leaseId);
    const decidedBeforeRelease = Boolean(
      options.allowDecidedAfterRelease &&
      permission.decision &&
      (!managedLease?.releasedAt ||
        Date.parse(permission.decision.decided_at) <= Date.parse(managedLease.releasedAt)) &&
      Date.parse(permission.decision.decided_at) <= Date.parse(permission.expiresAt)
    );
    if (!managedLease || (!decidedBeforeRelease && (
        managedLease.releasedAt !== undefined ||
        Date.parse(managedLease.expiresAt) <= this.nowDate().getTime()
      )) ||
        managedLease.conversationId !== permission.conversationId ||
        managedLease.messageId !== permission.messageId ||
        managedLease.terminalTarget !== permission.terminalTarget ||
        (permission.leaseMatchedBy === "session" && managedLease.sessionId !== permission.sessionId) ||
        (permission.leaseMatchedBy === "pid" &&
          (permission.claudePid === undefined || managedLease.pid !== permission.claudePid))) {
      throw new ClaudeHookStoreError(
        "PERMISSION_EXPIRED",
        `managed Claude lease is no longer active for request ${permission.requestId}`
      );
    }
    if (permission.consumedAt) {
      throw new ClaudeHookStoreError(
        "PERMISSION_CONSUMED",
        `Claude permission request ${permission.requestId} was already consumed`
      );
    }
    if (!decidedBeforeRelease && Date.parse(permission.expiresAt) <= this.nowDate().getTime()) {
      throw new ClaudeHookStoreError(
        "PERMISSION_EXPIRED",
        `Claude permission request ${permission.requestId} expired at ${permission.expiresAt}`
      );
    }
  }

  private permissionLeaseRemaining(options: ConsumeClaudePermissionOptions): number {
    const session = this.requireSession(options.sessionId);
    const permission = requirePermission(session, options.requestId);
    if (permission.fingerprint !== options.fingerprint) {
      throw new ClaudeHookStoreError(
        "PERMISSION_FINGERPRINT_MISMATCH",
        `Claude permission fingerprint changed for request ${permission.requestId}`
      );
    }
    if (permission.conversationId !== options.conversationId || permission.messageId !== options.messageId) {
      throw new ClaudeHookStoreError(
        "SESSION_IDENTITY_MISMATCH",
        `Claude permission request ${permission.requestId} belongs to a different conversation message`
      );
    }
    return Math.max(0, Date.parse(permission.expiresAt) - this.nowDate().getTime());
  }

  private requireSession(sessionId: string): ClaudeHookSession {
    const session = this.readSessionById(sessionId);
    if (!session) {
      throw new ClaudeHookStoreError("SESSION_NOT_FOUND", `Claude hook session not found: ${sessionId}`);
    }
    return session;
  }

  private readSessionById(sessionId: string): ClaudeHookSession | undefined {
    const filePath = this.sessionPath(sessionId);
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    rejectSymlink(filePath);
    return parseStoredSession(fs.readFileSync(filePath, "utf8"), filePath, sessionId);
  }

  private readAllSessions(): ClaudeHookSession[] {
    if (!fs.existsSync(this.rootDir)) {
      return [];
    }
    return fs.readdirSync(this.rootDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
      .map((entry) => {
        const filePath = path.join(this.rootDir, entry.name);
        rejectSymlink(filePath);
        return parseStoredSession(fs.readFileSync(filePath, "utf8"), filePath);
      });
  }

  private writeSession(session: ClaudeHookSession): void {
    ensureDirectory(this.rootDir);
    const filePath = this.sessionPath(session.session_id);
    const temporaryPath = `${filePath}.${process.pid}.${this.randomId()}.tmp`;
    let fileDescriptor: number | undefined;
    try {
      fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(fileDescriptor, `${JSON.stringify(session, null, 2)}\n`, "utf8");
      fs.fsyncSync(fileDescriptor);
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      fs.renameSync(temporaryPath, filePath);
      fs.chmodSync(filePath, 0o600);
      fsyncDirectory(this.rootDir);
    } finally {
      if (fileDescriptor !== undefined) {
        fs.closeSync(fileDescriptor);
      }
      fs.rmSync(temporaryPath, { force: true });
    }
  }

  private withSessionLock<T>(sessionId: string, action: () => T): T {
    ensureDirectory(this.rootDir);
    const lockPath = `${this.sessionPath(sessionId)}.lock`;
    const owner = `${process.pid}:${this.randomId()}`;
    const startedAt = Date.now();
    let descriptor: number | undefined;

    while (descriptor === undefined) {
      try {
        descriptor = fs.openSync(lockPath, "wx", 0o600);
        fs.writeFileSync(descriptor, owner, "utf8");
        fs.fsyncSync(descriptor);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) {
          throw error;
        }
        removeStaleLock(lockPath);
        if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
          throw new ClaudeHookStoreError("LOCK_TIMEOUT", `timed out waiting for Claude hook lock: ${lockPath}`);
        }
        synchronousSleep(20);
      }
    }

    try {
      return action();
    } finally {
      fs.closeSync(descriptor);
      try {
        if (fs.readFileSync(lockPath, "utf8") === owner) {
          fs.rmSync(lockPath, { force: true });
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }

  private sessionPath(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.rootDir, `${digest}.json`);
  }

  private uniqueEventId(session: ClaudeHookSession): string {
    const existing = new Set(session.events.map((event) => event.id));
    return this.uniqueValue("event", existing);
  }

  private uniqueNonce(session: ClaudeHookSession): string {
    const existing = new Set(session.permissions.map((permission) => permission.nonce));
    return this.uniqueValue("nonce", existing);
  }

  private uniqueValue(label: string, existing: Set<string>): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = this.randomId();
      if (candidate && !existing.has(candidate)) {
        return candidate;
      }
    }
    throw new ClaudeHookStoreError("INVALID_INPUT", `could not generate a unique Claude hook ${label}`);
  }

  private nowDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new ClaudeHookStoreError("INVALID_INPUT", "Claude hook store clock returned an invalid date");
    }
    return value;
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }
}

function sameManagedMessageBinding(
  prompt: ClaudeStoredHookEvent,
  terminalEvent: ClaudeStoredHookEvent
): boolean {
  const promptIsBound = prompt.lease_id !== undefined ||
    prompt.conversation_id !== undefined ||
    prompt.message_id !== undefined;
  const terminalIsBound = terminalEvent.lease_id !== undefined ||
    terminalEvent.conversation_id !== undefined ||
    terminalEvent.message_id !== undefined;
  if (!promptIsBound && !terminalIsBound) {
    return true;
  }
  return prompt.lease_id !== undefined &&
    prompt.conversation_id !== undefined &&
    prompt.message_id !== undefined &&
    prompt.lease_id === terminalEvent.lease_id &&
    prompt.conversation_id === terminalEvent.conversation_id &&
    prompt.message_id === terminalEvent.message_id;
}

function completionFromStop(
  session: ClaudeHookSession,
  promptId: string,
  event: ClaudeStoredHookEvent,
  input: ClaudeStopHookInput
): ClaudeCompletionInspection {
  if (!Array.isArray(input.background_tasks) || !Array.isArray(input.session_crons)) {
    return {
      status: "unknown",
      reason: "Stop hook did not include both background_tasks and session_crons; completion is unverified",
      sessionId: session.session_id,
      promptId
    };
  }
  if (input.background_tasks.length > 0 || input.session_crons.length > 0) {
    return {
      status: "pending",
      reason: `Claude still reports ${input.background_tasks.length} background task(s) and ${input.session_crons.length} session cron(s)`,
      sessionId: session.session_id,
      promptId
    };
  }
  const text = input.last_assistant_message?.trim();
  if (!text) {
    return {
      status: "unknown",
      reason: "Stop hook did not include a non-empty last_assistant_message",
      sessionId: session.session_id,
      promptId
    };
  }
  return {
    status: "done",
    reason: "correlated Stop hook reported no background tasks or session crons",
    sessionId: session.session_id,
    promptId,
    eventId: event.id,
    timestamp: event.received_at,
    text,
    cwd: event.input.cwd
  };
}

function newSession(input: ClaudeHookInput, now: string): ClaudeHookSession {
  return {
    schema_version: STORE_SCHEMA_VERSION,
    session_id: input.session_id,
    cwd: input.cwd,
    transcript_path: input.transcript_path,
    created_at: now,
    updated_at: now,
    events: [],
    permissions: []
  };
}

function parseStoredSession(source: string, filePath: string, expectedSessionId?: string): ClaudeHookSession {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw corruptStore(filePath, error);
  }
  if (!isObject(value) || value.schema_version !== STORE_SCHEMA_VERSION) {
    throw corruptStore(filePath, "unsupported or missing schema_version");
  }
  if (typeof value.session_id !== "string" || !value.session_id ||
      typeof value.cwd !== "string" || typeof value.transcript_path !== "string" ||
      typeof value.created_at !== "string" || typeof value.updated_at !== "string" ||
      !Array.isArray(value.events) || !Array.isArray(value.permissions)) {
    throw corruptStore(filePath, "missing required session fields");
  }
  if (expectedSessionId !== undefined && value.session_id !== expectedSessionId) {
    throw corruptStore(filePath, `stored session id does not match ${expectedSessionId}`);
  }

  for (const event of value.events) {
    if (!isObject(event) || typeof event.id !== "string" || typeof event.received_at !== "string") {
      throw corruptStore(filePath, "invalid stored event");
    }
    try {
      parseClaudeHookInput(event.input);
    } catch (error) {
      throw corruptStore(filePath, error);
    }
  }
  for (const permission of value.permissions) {
    if (!isStoredPermission(permission)) {
      throw corruptStore(filePath, "invalid stored permission request");
    }
  }
  return value as unknown as ClaudeHookSession;
}

function isStoredPermission(value: unknown): value is ClaudePendingPermission {
  if (!isObject(value)) {
    return false;
  }
  return typeof value.requestId === "string" &&
    typeof value.nonce === "string" &&
    typeof value.fingerprint === "string" &&
    typeof value.eventId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.leaseId === "string" &&
    (value.leaseMatchedBy === "session" || value.leaseMatchedBy === "pid") &&
    (value.claudePid === undefined || (Number.isSafeInteger(value.claudePid) && value.claudePid > 0)) &&
    typeof value.terminalTarget === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.cwd === "string" &&
    typeof value.toolName === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.decision === undefined || (
      isObject(value.decision) &&
      (value.decision.behavior === "allow" || value.decision.behavior === "deny") &&
      typeof value.decision.decided_at === "string"
    ));
}

function requirePermission(session: ClaudeHookSession, requestId: string): ClaudePendingPermission {
  const matches = session.permissions.filter((permission) => permission.requestId === requestId);
  if (matches.length === 0) {
    throw new ClaudeHookStoreError(
      "PERMISSION_NOT_FOUND",
      `Claude permission request not found: ${requestId}`
    );
  }
  if (matches.length > 1) {
    throw new ClaudeHookStoreError(
      "AMBIGUOUS_PERMISSION",
      `duplicate Claude permission request id: ${requestId}`
    );
  }
  return matches[0];
}

function validateIdentity(identity: ClaudeSessionIdentity): void {
  if (!identity || typeof identity !== "object") {
    throw new ClaudeHookStoreError("INVALID_INPUT", "Claude session identity is required");
  }
  if (identity.sessionId !== undefined && (!identity.sessionId || typeof identity.sessionId !== "string")) {
    throw new ClaudeHookStoreError("INVALID_INPUT", "sessionId must be a non-empty string");
  }
  if (identity.pid !== undefined) {
    optionalPid(identity.pid);
  }
  if (identity.cwd !== undefined && (!identity.cwd || typeof identity.cwd !== "string")) {
    throw new ClaudeHookStoreError("INVALID_INPUT", "cwd must be a non-empty string");
  }
  if (!identity.sessionId && identity.pid === undefined && identity.cwd === undefined) {
    throw new ClaudeHookStoreError("INVALID_INPUT", "sessionId, pid, or cwd is required");
  }
}

function validateActivateLeaseOptions(options: ActivateClaudeManagedLeaseOptions): void {
  validateIdentity({
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    cwd: options.cwd
  });
  if (!options.conversationId || !options.messageId || !options.terminalTarget) {
    throw new ClaudeHookStoreError(
      "INVALID_INPUT",
      "conversationId, messageId, and terminalTarget are required for a managed Claude lease"
    );
  }
}

function validateReleaseLeaseOptions(options: ReleaseClaudeManagedLeaseOptions): void {
  if (!options.leaseId && (!options.conversationId || !options.messageId)) {
    throw new ClaudeHookStoreError(
      "INVALID_INPUT",
      "leaseId or conversationId plus messageId is required to release a managed Claude lease"
    );
  }
}

function validateDecisionOptions(options: DecideClaudePermissionOptions): void {
  validateConsumeOptions(options);
  if (options.decision !== "allow" && options.decision !== "deny") {
    throw new ClaudeHookStoreError("INVALID_INPUT", "decision must be allow or deny");
  }
  if (options.decision === "allow" && options.interrupt !== undefined) {
    throw new ClaudeHookStoreError("INVALID_INPUT", "interrupt is only valid for a deny decision");
  }
}

function validateConsumeOptions(options: ConsumeClaudePermissionOptions): void {
  if (!options.sessionId || !options.requestId || !options.fingerprint ||
      !options.conversationId || !options.messageId) {
    throw new ClaudeHookStoreError(
      "INVALID_INPUT",
      "sessionId, requestId, fingerprint, conversationId, and messageId are required for a Claude permission decision"
    );
  }
}

function hookInputIdentity(inputOrIdentity: ClaudeHookInput | ClaudeSessionIdentity): ClaudeSessionIdentity {
  if ("hook_event_name" in inputOrIdentity) {
    return {
      sessionId: inputOrIdentity.session_id,
      cwd: inputOrIdentity.cwd
    };
  }
  return inputOrIdentity;
}

function uniqueLeaseResolution(
  leases: ClaudeManagedLease[],
  matchedBy: ClaudeManagedLeaseResolution["matchedBy"]
): ClaudeManagedLeaseResolution | undefined {
  if (leases.length === 0) {
    return undefined;
  }
  if (leases.length > 1) {
    throw new ClaudeHookStoreError(
      "AMBIGUOUS_SESSION",
      `multiple active managed Claude leases match exact ${matchedBy}`
    );
  }
  return {
    lease: leases[0],
    matchedBy,
    authorizationEligible: matchedBy === "session" || matchedBy === "pid"
  };
}

function uniqueManagedLeaseId(
  leases: ClaudeManagedLease[],
  randomId: () => string
): string {
  const existing = new Set(leases.map((lease) => lease.id));
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `lease:${randomId()}`;
    if (candidate !== "lease:" && !existing.has(candidate)) {
      return candidate;
    }
  }
  throw new ClaudeHookStoreError("INVALID_INPUT", "could not generate a unique managed Claude lease id");
}

function isManagedLease(value: unknown): value is ClaudeManagedLease {
  return isObject(value) &&
    typeof value.id === "string" &&
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.pid === undefined || (Number.isSafeInteger(value.pid) && value.pid > 0)) &&
    typeof value.cwd === "string" &&
    typeof value.conversationId === "string" &&
    typeof value.messageId === "string" &&
    typeof value.terminalTarget === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.expiresAt === "string" &&
    (value.releasedAt === undefined || typeof value.releasedAt === "string");
}

function optionalPid(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClaudeHookStoreError("INVALID_INPUT", "claudePid must be a positive integer");
  }
  return value;
}

function positiveMilliseconds(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ClaudeHookStoreError("INVALID_INPUT", `${field} must be greater than zero`);
  }
  return value;
}

function nonNegativeMilliseconds(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ClaudeHookStoreError("INVALID_INPUT", `${field} must not be negative`);
  }
  return value;
}

function timestampMs(value: string | Date, field: string): number {
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new ClaudeHookStoreError("INVALID_INPUT", `${field} must be a valid timestamp`);
  }
  return result;
}

function stringProperty(value: ClaudePermissionRequestHookInput["tool_input"], key: string): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  return typeof value[key] === "string" && value[key].trim() ? value[key] : undefined;
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function atomicWriteJson(filePath: string, temporaryPath: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function withFileLock<T>(lockPath: string, randomId: () => string, action: () => T): T {
  ensureDirectory(path.dirname(lockPath));
  const owner = `${process.pid}:${randomId()}`;
  const startedAt = Date.now();
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, owner, "utf8");
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      removeStaleLock(lockPath);
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new ClaudeHookStoreError("LOCK_TIMEOUT", `timed out waiting for Claude hook lock: ${lockPath}`);
      }
      synchronousSleep(20);
    }
  }
  const acquiredDescriptor = descriptor;
  try {
    return action();
  } finally {
    fs.closeSync(acquiredDescriptor);
    try {
      if (fs.readFileSync(lockPath, "utf8") === owner) {
        fs.rmSync(lockPath, { force: true });
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
    }
  }
}

function rejectSymlink(filePath: string): void {
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new ClaudeHookStoreError("CORRUPT_STORE", `refusing Claude hook store symlink: ${filePath}`);
  }
}

function removeStaleLock(lockPath: string): void {
  try {
    if (Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function synchronousSleep(milliseconds: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some platforms do not support fsync on directories; the file rename is still atomic.
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function corruptStore(filePath: string, cause: unknown): ClaudeHookStoreError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new ClaudeHookStoreError("CORRUPT_STORE", `invalid Claude hook store ${filePath}: ${detail}`);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneOptional<T>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : clone(value);
}
