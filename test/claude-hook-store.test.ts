import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ClaudeHookStore,
  ClaudeHookStoreError,
  type ClaudePendingPermission
} from "../src/claude-hook-store.js";
import {
  canonicalClaudePermissionFingerprint,
  parseClaudeHookInput,
  type ClaudeHookInput,
  type ClaudePermissionRequestHookInput
} from "../src/claude-hook-protocol.js";

test("official Claude hook inputs parse without reading the transcript", (t) => {
  const rootDir = temporaryStore(t);
  const transcriptPath = path.join(rootDir, "must-not-be-read.jsonl");
  const common = {
    session_id: "session-protocol",
    transcript_path: transcriptPath,
    cwd: "/workspace/protocol",
    permission_mode: "default"
  };
  const inputs: unknown[] = [
    { ...common, hook_event_name: "SessionStart", source: "startup", model: "claude-opus-4-6" },
    { ...common, hook_event_name: "UserPromptSubmit", prompt: "Run the tests" },
    {
      ...common,
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      permission_suggestions: []
    },
    {
      ...common,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "All tests pass.",
      background_tasks: [],
      session_crons: []
    },
    {
      ...common,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests",
      last_assistant_message: "API Error: Rate limit reached"
    },
    {
      ...common,
      hook_event_name: "Notification",
      message: "Claude needs permission",
      title: "Permission needed",
      notification_type: "permission_prompt"
    }
  ];

  const store = new ClaudeHookStore({ rootDir });
  store.activateLease({
    sessionId: "session-protocol",
    pid: 1201,
    cwd: "/workspace/protocol",
    conversationId: "conversation-protocol",
    messageId: "message-protocol",
    terminalTarget: "claude-work:0.0"
  });
  const results = inputs.map((input) => store.record(parseClaudeHookInput(input), { claudePid: 1201 }));

  assert.deepEqual(results.map((result) => result.event.input.hook_event_name), [
    "SessionStart",
    "UserPromptSubmit",
    "PermissionRequest",
    "Stop",
    "StopFailure",
    "Notification"
  ]);
  assert.equal(new Set(results.map((result) => result.event.id)).size, results.length);
  assert.ok(results.every((result) => Number.isFinite(Date.parse(result.event.received_at))));
  assert.equal(fs.existsSync(transcriptPath), false);
  const sessionFiles = fs.readdirSync(rootDir).filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry));
  assert.equal(sessionFiles.length, 1);
  assert.equal(fs.statSync(path.join(rootDir, sessionFiles[0])).mode & 0o777, 0o600);
});

test("unmanaged hook payloads stay ephemeral and never persist raw contents", (t) => {
  const rootDir = temporaryStore(t);
  const store = new ClaudeHookStore({ rootDir });
  const sentinel = "UNMANAGED-PRIVATE-PROMPT-DO-NOT-PERSIST";
  const recorded = store.record({
    session_id: "session-unmanaged-private",
    transcript_path: "/workspace/private/transcript.jsonl",
    cwd: "/workspace/private",
    hook_event_name: "UserPromptSubmit",
    prompt_id: "private-turn",
    prompt: sentinel
  }, { claudePid: 1901 });

  assert.equal(recorded.managed, false);
  assert.equal(recorded.event.input.hook_event_name, "UserPromptSubmit");
  assert.equal(store.resolveSession({ sessionId: "session-unmanaged-private" }), undefined);
  const persistedFiles = fs.readdirSync(rootDir)
    .filter((entry) => !entry.endsWith(".lock"))
    .map((entry) => fs.readFileSync(path.join(rootDir, entry), "utf8"));
  assert.equal(persistedFiles.some((source) => source.includes(sentinel)), false);
  assert.equal(
    fs.readdirSync(rootDir).some((entry) => /^[a-f0-9]{64}\.json$/u.test(entry)),
    false
  );
});

test("permission fingerprint is canonical and a cwd-only lease cannot authorize", (t) => {
  const rootDir = temporaryStore(t);
  const store = new ClaudeHookStore({ rootDir });
  const lease = store.activateLease({
    cwd: "/workspace/safe",
    conversationId: "conversation-1",
    messageId: "message-1",
    terminalTarget: "claude-work:0.0"
  });
  const first = permissionInput("session-safe", "/workspace/safe", { command: "npm test", timeout: 30 });
  const reordered = permissionInput("session-safe", "/workspace/safe", { timeout: 30, command: "npm test" });

  assert.equal(
    canonicalClaudePermissionFingerprint(first),
    canonicalClaudePermissionFingerprint(reordered)
  );
  const unmanaged = store.record(first, { claudePid: 2001 });
  assert.equal(unmanaged.managed, false);
  assert.equal(unmanaged.lease?.matchedBy, "cwd");
  assert.equal(unmanaged.lease?.authorizationEligible, false);
  assert.equal(unmanaged.permission, undefined);
  assert.equal(store.resolveSession({ sessionId: "session-safe" }), undefined);

  const bound = store.activateLease({
    pid: 2001,
    cwd: "/workspace/safe",
    conversationId: "conversation-1",
    messageId: "message-1",
    terminalTarget: "claude-work:0.0"
  });
  const managed = store.record(first, { claudePid: 2001 });
  assert.equal(bound.pid, 2001);
  assert.equal(managed.managed, true);
  assert.equal(managed.lease?.matchedBy, "pid");
  assert.match(managed.permission?.requestId ?? "", /^permission:[a-f0-9]{16}:/u);
});

test("ambiguous cwd discovery stays unmanaged while explicit lease resolution rejects it", (t) => {
  const store = new ClaudeHookStore({ rootDir: temporaryStore(t) });
  for (const suffix of ["a", "b"]) {
    store.activateLease({
      cwd: "/workspace/ambiguous-lease",
      conversationId: `conversation-${suffix}`,
      messageId: `message-${suffix}`,
      terminalTarget: `claude-${suffix}:0.0`
    });
  }

  assertStoreError(
    () => store.resolveLease({ cwd: "/workspace/ambiguous-lease" }),
    "AMBIGUOUS_SESSION"
  );
  const recorded = store.record(permissionInput(
    "unmanaged-session",
    "/workspace/ambiguous-lease",
    { command: "npm test" }
  ));
  assert.equal(recorded.managed, false);
  assert.equal(recorded.permission, undefined);
});

test("managed lease resolution rejects stale or malicious session, pid, and cwd combinations", (t) => {
  const store = new ClaudeHookStore({ rootDir: temporaryStore(t) });
  store.activateLease({
    sessionId: "session-trusted",
    pid: 2201,
    cwd: "/workspace/trusted",
    conversationId: "conversation-trusted",
    messageId: "message-trusted",
    terminalTarget: "claude-trusted:0.0"
  });
  store.activateLease({
    sessionId: "session-other",
    pid: 2202,
    cwd: "/workspace/trusted",
    conversationId: "conversation-other",
    messageId: "message-other",
    terminalTarget: "claude-other:0.0"
  });

  assert.equal(store.resolveLease({
    sessionId: "session-trusted",
    pid: 2201,
    cwd: "/workspace/trusted"
  })?.lease.messageId, "message-trusted");
  assert.equal(store.resolveLease({
    sessionId: "session-trusted",
    cwd: "/workspace/trusted"
  }), undefined);
  assert.equal(store.resolveLease({
    sessionId: "session-trusted",
    pid: 2202,
    cwd: "/workspace/trusted"
  }), undefined);
  assert.equal(store.resolveLease({
    sessionId: "session-trusted",
    pid: 2201,
    cwd: "/workspace/attacker"
  }), undefined);
  assert.equal(store.resolveLease({
    sessionId: "session-stale",
    pid: 2201,
    cwd: "/workspace/trusted"
  }), undefined);

  const missingPid = store.record(
    permissionInput("session-trusted", "/workspace/trusted", { command: "npm test" })
  );
  assert.equal(missingPid.managed, false);
  assert.equal(missingPid.permission, undefined);

  const maliciousPid = store.record(
    permissionInput("session-trusted", "/workspace/trusted", { command: "npm publish" }),
    { claudePid: 2202 }
  );
  assert.equal(maliciousPid.managed, false);
  assert.equal(maliciousPid.permission, undefined);

  const staleSession = store.record(
    permissionInput("session-stale", "/workspace/trusted", { command: "git push" }),
    { claudePid: 2201 }
  );
  assert.equal(staleSession.managed, false);
  assert.equal(staleSession.permission, undefined);
});

test("permission decision revalidates binding and is consumed exactly once", async (t) => {
  const rootDir = temporaryStore(t);
  let nowMs = Date.parse("2026-07-23T01:00:00.000Z");
  let pending: ClaudePendingPermission | undefined;
  let store: ClaudeHookStore;
  let decisionWritten = false;
  store = new ClaudeHookStore({
    rootDir,
    now: () => new Date(nowMs),
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      if (!decisionWritten && pending) {
        decisionWritten = true;
        store.decidePermission({
          sessionId: "session-decision",
          requestId: pending.requestId,
          fingerprint: pending.fingerprint,
          conversationId: pending.conversationId,
          messageId: pending.messageId,
          decision: "allow"
        });
      }
    }
  });
  const decisionLease = store.activateLease({
    sessionId: "session-decision",
    pid: 3001,
    cwd: "/workspace/decision",
    conversationId: "conversation-decision",
    messageId: "message-decision",
    terminalTarget: "claude-work:0.0"
  });
  pending = store.record(
    permissionInput("session-decision", "/workspace/decision", { command: "npm test" }),
    { claudePid: 3001 }
  ).permission;
  assert.ok(pending);

  const inspection = store.inspectPermission({ sessionId: "session-decision" });
  assert.equal(inspection.blocked, true);
  assert.equal(inspection.approvable, true);
  if (!inspection.approvable) {
    assert.fail("expected an approvable Claude permission request");
  }
  assert.equal(inspection.kind, "run_command");
  assert.equal(inspection.command, "npm test");
  assert.equal(inspection.cwd, "/workspace/decision");

  assertStoreError(() => store.decidePermission({
    sessionId: "session-decision",
    requestId: pending!.requestId,
    fingerprint: "different-fingerprint",
    conversationId: pending!.conversationId,
    messageId: pending!.messageId,
    decision: "allow"
  }), "PERMISSION_FINGERPRINT_MISMATCH");
  assertStoreError(() => store.decidePermission({
    sessionId: "session-decision",
    requestId: pending!.requestId,
    fingerprint: pending!.fingerprint,
    conversationId: "different-conversation",
    messageId: pending!.messageId,
    decision: "allow"
  }), "SESSION_IDENTITY_MISMATCH");

  const consumed = await store.waitForPermissionDecision({
    sessionId: "session-decision",
    requestId: pending.requestId,
    fingerprint: pending.fingerprint,
    conversationId: pending.conversationId,
    messageId: pending.messageId,
    timeoutMs: 1_000,
    pollIntervalMs: 10
  });
  assert.equal(consumed?.behavior, "allow");
  assert.deepEqual(consumed?.hookOutput, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow" }
    }
  });
  assert.doesNotMatch(JSON.stringify(consumed?.hookOutput), /updatedPermissions/u);
  assertStoreError(() => store.consumePermissionDecision({
    sessionId: "session-decision",
    requestId: pending!.requestId,
    fingerprint: pending!.fingerprint,
    conversationId: pending!.conversationId,
    messageId: pending!.messageId
  }), "PERMISSION_CONSUMED");

  const denied = store.record(
    permissionInput("session-decision", "/workspace/decision", { command: "npm publish" }),
    { claudePid: 3001 }
  ).permission!;
  store.decidePermission({ ...decisionOptions(denied, "deny"), interrupt: true });
  assertStoreError(
    () => store.decidePermission(decisionOptions(denied, "allow")),
    "PERMISSION_ALREADY_DECIDED"
  );
  store.releaseLease({ leaseId: decisionLease.id });
  const consumedDeny = store.consumePermissionDecision({
    sessionId: denied.sessionId,
    requestId: denied.requestId,
    fingerprint: denied.fingerprint,
    conversationId: denied.conversationId,
    messageId: denied.messageId
  });
  assert.deepEqual(consumedDeny?.hookOutput, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: "Denied by Agent Knock Knock.",
        interrupt: true
      }
    }
  });
  assert.doesNotMatch(JSON.stringify(consumedDeny?.hookOutput), /updatedPermissions/u);
});

test("stale or released managed permission requests fail closed", (t) => {
  const rootDir = temporaryStore(t);
  let nowMs = Date.parse("2026-07-23T02:00:00.000Z");
  const store = new ClaudeHookStore({ rootDir, now: () => new Date(nowMs) });
  const lease = store.activateLease({
    sessionId: "session-stale",
    cwd: "/workspace/stale",
    conversationId: "conversation-stale",
    messageId: "message-stale",
    terminalTarget: "claude-work:0.0"
  });
  const stale = store.record(
    permissionInput("session-stale", "/workspace/stale", { command: "git push" }),
    { permissionLeaseMs: 1_000 }
  ).permission!;
  nowMs += 1_001;
  assertStoreError(() => store.decidePermission(decisionOptions(stale, "allow")), "PERMISSION_EXPIRED");

  nowMs += 1;
  store.activateLease({
    sessionId: "session-stale",
    cwd: "/workspace/stale",
    conversationId: "conversation-stale",
    messageId: "message-stale",
    terminalTarget: "claude-work:0.0"
  });
  const released = store.record(
    permissionInput("session-stale", "/workspace/stale", { command: "npm publish" })
  ).permission!;
  store.releaseLease({ leaseId: lease.id });
  assertStoreError(() => store.decidePermission(decisionOptions(released, "deny")), "PERMISSION_EXPIRED");
});

test("session resolution accepts exact id and pid but rejects an ambiguous cwd", (t) => {
  const store = new ClaudeHookStore({ rootDir: temporaryStore(t) });
  store.activateLease({
    sessionId: "session-a",
    pid: 4101,
    cwd: "/workspace/shared",
    conversationId: "conversation-a",
    messageId: "message-a",
    terminalTarget: "claude-a:0.0"
  });
  store.activateLease({
    sessionId: "session-b",
    pid: 4102,
    cwd: "/workspace/shared",
    conversationId: "conversation-b",
    messageId: "message-b",
    terminalTarget: "claude-b:0.0"
  });
  store.record(sessionStartInput("session-a", "/workspace/shared"), { claudePid: 4101 });
  store.record(sessionStartInput("session-b", "/workspace/shared"), { claudePid: 4102 });

  assert.equal(store.resolveSession({ sessionId: "session-a" })?.claude_pid, 4101);
  assert.equal(store.resolveSession({ pid: 4102 })?.session_id, "session-b");
  assertStoreError(() => store.resolveSession({ cwd: "/workspace/shared" }), "AMBIGUOUS_SESSION");
});

test("durable Stop completion requires turn correlation and explicit empty background fields", (t) => {
  const rootDir = temporaryStore(t);
  let nowMs = Date.parse("2026-07-23T03:00:00.000Z");
  const store = new ClaudeHookStore({ rootDir, now: () => new Date(nowMs) });
  const sessionId = "session-completion";
  const cwd = "/workspace/completion";
  store.activateLease({
    sessionId,
    cwd,
    conversationId: "conversation-completion",
    messageId: "message-completion",
    terminalTarget: "claude-completion:0.0"
  });

  store.record(promptInput(sessionId, cwd, "turn-missing"));
  nowMs += 10;
  store.record(stopInput(sessionId, cwd, "turn-missing", {
    last_assistant_message: "This must remain unknown."
  }));
  assert.equal(store.detectCompletion({
    sessionId,
    startedAt: "2026-07-23T03:00:00.000Z",
    promptId: "turn-missing"
  }).status, "unknown");

  nowMs += 10;
  const backgroundStartedAt = new Date(nowMs).toISOString();
  store.record(promptInput(sessionId, cwd, "turn-background"));
  nowMs += 10;
  store.record(stopInput(sessionId, cwd, "turn-background", {
    last_assistant_message: "A background task is still running.",
    background_tasks: [{ id: "task-1", type: "bash", status: "running", description: "tests" }],
    session_crons: []
  }));
  const background = store.detectCompletion({
    sessionId,
    startedAt: backgroundStartedAt,
    promptId: "turn-background"
  });
  assert.equal(background.status, "pending");
  assert.match(background.reason, /1 background task/u);

  nowMs += 10;
  const cronStartedAt = new Date(nowMs).toISOString();
  store.record(promptInput(sessionId, cwd, "turn-cron"));
  nowMs += 10;
  store.record(stopInput(sessionId, cwd, "turn-cron", {
    last_assistant_message: "A scheduled turn is still active.",
    background_tasks: [],
    session_crons: [{ id: "cron-1", schedule: "*/5 * * * *", recurring: true, prompt: "check" }]
  }));
  const cron = store.detectCompletion({
    sessionId,
    startedAt: cronStartedAt,
    promptId: "turn-cron"
  });
  assert.equal(cron.status, "pending");
  assert.match(cron.reason, /1 session cron/u);

  nowMs += 10;
  const completedStartedAt = new Date(nowMs).toISOString();
  store.record(promptInput(sessionId, cwd, "turn-done"));
  nowMs += 10;
  const stop = store.record(stopInput(sessionId, cwd, "turn-done", {
    last_assistant_message: "Implementation complete; all tests pass.",
    background_tasks: [],
    session_crons: []
  }));
  const completed = store.detectCompletion({
    sessionId,
    startedAt: completedStartedAt,
    promptId: "turn-done"
  });
  assert.equal(completed.status, "done");
  if (completed.status !== "done") {
    assert.fail("expected durable Claude completion");
  }
  assert.equal(completed.eventId, stop.event.id);
  assert.equal(completed.text, "Implementation complete; all tests pass.");
});

test("durable completion is bound to the current managed conversation message", (t) => {
  let nowMs = Date.parse("2026-07-23T03:30:00.000Z");
  const store = new ClaudeHookStore({
    rootDir: temporaryStore(t),
    now: () => new Date(nowMs)
  });
  const sessionId = "session-reused";
  const cwd = "/workspace/reused";
  const pid = 4301;
  const startedAt = new Date(nowMs).toISOString();

  const oldLease = store.activateLease({
    sessionId,
    pid,
    cwd,
    conversationId: "conversation-reused",
    messageId: "message-old",
    terminalTarget: "claude-reused:0.0"
  });
  store.record(promptInput(sessionId, cwd, "turn-shared"), { claudePid: pid });
  nowMs += 10;
  store.record({
    ...commonInput(sessionId, cwd),
    hook_event_name: "StopFailure",
    prompt_id: "turn-shared",
    error: "server_error",
    last_assistant_message: "This belongs to the old message."
  }, { claudePid: pid });
  store.releaseLease({ leaseId: oldLease.id });

  nowMs += 10;
  store.activateLease({
    sessionId,
    pid,
    cwd,
    conversationId: "conversation-reused",
    messageId: "message-current",
    terminalTarget: "claude-reused:0.0"
  });
  const currentIdentity = {
    sessionId,
    pid,
    cwd,
    startedAt,
    promptId: "turn-shared",
    conversationId: "conversation-reused",
    messageId: "message-current"
  } as const;

  assert.equal(store.detectCompletion(currentIdentity).status, "unknown");
  store.record(promptInput(sessionId, cwd, "turn-shared"), { claudePid: pid });
  assert.equal(store.detectCompletion(currentIdentity).status, "pending");

  nowMs += 10;
  store.record({
    ...commonInput(sessionId, cwd),
    hook_event_name: "StopFailure",
    prompt_id: "turn-shared",
    error: "rate_limit",
    last_assistant_message: "This event has the wrong process identity."
  }, { claudePid: 9999 });
  store.record(stopInput(sessionId, cwd, "turn-shared", {
    last_assistant_message: "This unbound Stop must not complete the message.",
    background_tasks: [],
    session_crons: []
  }), { claudePid: 9999 });
  assert.equal(
    store.detectCompletion(currentIdentity).status,
    "pending",
    "wrong-pid hook payloads must remain ephemeral and cannot affect managed completion"
  );

  nowMs += 10;
  const legitimateStop = store.record(stopInput(sessionId, cwd, "turn-shared", {
    last_assistant_message: "Only the current managed message may complete.",
    background_tasks: [],
    session_crons: []
  }), { claudePid: pid });
  const completed = store.detectCompletion(currentIdentity);
  assert.equal(completed.status, "done");
  if (completed.status !== "done") {
    assert.fail("expected the current managed Claude message to complete");
  }
  assert.equal(completed.eventId, legitimateStop.event.id);
  assert.equal(completed.text, "Only the current managed message may complete.");

  assert.equal(store.detectCompletion({
    ...currentIdentity,
    messageId: "message-old"
  }).status, "unknown");
  assertStoreError(() => store.detectCompletion({
    sessionId,
    startedAt,
    conversationId: "conversation-reused"
  }), "INVALID_INPUT");
});

test("StopFailure is retained and reported as a structured turn failure", (t) => {
  const rootDir = temporaryStore(t);
  let nowMs = Date.parse("2026-07-23T04:00:00.000Z");
  const store = new ClaudeHookStore({ rootDir, now: () => new Date(nowMs) });
  const sessionId = "session-failure";
  const cwd = "/workspace/failure";
  store.activateLease({
    sessionId,
    cwd,
    conversationId: "conversation-failure",
    messageId: "message-failure",
    terminalTarget: "claude-failure:0.0"
  });
  store.record(promptInput(sessionId, cwd, "turn-failure"));
  nowMs += 25;
  const failedEvent = store.record({
    ...commonInput(sessionId, cwd),
    hook_event_name: "StopFailure",
    prompt_id: "turn-failure",
    error: "server_error",
    error_details: { status: 503, retryable: true },
    last_assistant_message: "API Error: service unavailable"
  });

  const result = store.detectCompletion({
    sessionId,
    startedAt: "2026-07-23T04:00:00.000Z",
    promptId: "turn-failure"
  });
  assert.equal(result.status, "failed");
  if (result.status !== "failed") {
    assert.fail("expected a structured Claude failure");
  }
  assert.deepEqual(result.failure, {
    code: "server_error",
    details: { status: 503, retryable: true },
    message: "API Error: service unavailable",
    eventId: failedEvent.event.id,
    receivedAt: failedEvent.event.received_at,
    promptId: "turn-failure"
  });
});

function temporaryStore(t: test.TestContext): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-hook-store-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function commonInput(sessionId: string, cwd: string) {
  return {
    session_id: sessionId,
    transcript_path: path.join(cwd, ".claude", `${sessionId}.jsonl`),
    cwd,
    permission_mode: "default"
  };
}

function sessionStartInput(sessionId: string, cwd: string): ClaudeHookInput {
  return {
    ...commonInput(sessionId, cwd),
    hook_event_name: "SessionStart",
    source: "startup",
    model: "claude-opus-4-6"
  };
}

function promptInput(sessionId: string, cwd: string, promptId: string): ClaudeHookInput {
  return {
    ...commonInput(sessionId, cwd),
    hook_event_name: "UserPromptSubmit",
    prompt_id: promptId,
    prompt: `prompt for ${promptId}`
  };
}

function permissionInput(
  sessionId: string,
  cwd: string,
  toolInput: Record<string, string | number>
): ClaudePermissionRequestHookInput {
  return {
    ...commonInput(sessionId, cwd),
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: toolInput
  };
}

function stopInput(
  sessionId: string,
  cwd: string,
  promptId: string,
  fields: Record<string, unknown>
): ClaudeHookInput {
  return parseClaudeHookInput({
    ...commonInput(sessionId, cwd),
    hook_event_name: "Stop",
    prompt_id: promptId,
    stop_hook_active: false,
    ...fields
  });
}

function decisionOptions(permission: ClaudePendingPermission, decision: "allow" | "deny") {
  return {
    sessionId: permission.sessionId,
    requestId: permission.requestId,
    fingerprint: permission.fingerprint,
    conversationId: permission.conversationId,
    messageId: permission.messageId,
    decision
  } as const;
}

function assertStoreError(action: () => unknown, code: ClaudeHookStoreError["code"]): void {
  assert.throws(action, (error: unknown) =>
    error instanceof ClaudeHookStoreError && error.code === code
  );
}
