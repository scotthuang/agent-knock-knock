import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactString } from "../src/runtime-log.js";
import {
  captureClaudeHumanStartedActiveTaskAnchor,
  captureClaudeTranscriptAnchor,
  detectClaudeTranscriptAcceptance,
  detectClaudeTranscriptAcceptanceByHash,
  detectClaudeTranscriptCompletion,
  detectClaudeTranscriptCompletionByHash,
  detectClaudeTranscriptPendingApproval,
  initialClaudeHumanStartedActiveTaskCheckpoint,
  listClaudeHistoricalSessions,
  listClaudeThreadLifecycleCandidates,
  observeClaudeHumanStartedActiveTask,
  observeClaudeDeadProcessTranscriptCompletion,
  observeClaudeUserExplicitFallbackTranscript,
  revalidateClaudeThreadLifecycleCandidate,
  validateClaudeHumanStartedActiveTaskAnchor,
  validateClaudeHumanStartedActiveTaskCheckpoint,
  type ClaudeTranscriptAnchor
} from "../src/claude-local-transcript-provider.js";
import type { ClaudeAgentRow } from "../src/claude-terminal-agent-adapter.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PID = 42421;
const AGENT_STARTED_AT_MS = 1784870000000;
const VERSION = "2.1.218";
const PREVIOUS_VERSION = "2.1.226";
const CURRENT_VERSION = "2.1.259";
const LEGACY_VERSION = "2.1.198";
const STARTED_AT = "2026-07-24T02:00:00.000Z";
const CAPTURED_AT = "2026-07-24T02:00:00.100Z";
const PROMPT_AT = "2026-07-24T02:00:00.200Z";
const COMPLETED_AT = "2026-07-24T02:00:00.400Z";

test("captures and completes one exact human-started Claude task without persisting its prompt", (t) => {
  const fixture = createFixture(t);
  const request = "Human started this exact Claude task";
  const records = fixture.normalizeRecords(turnRecords({
    request,
    assistantText: "Human-started task done",
    ids: 6000
  }));
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(records[0]));

  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    now: new Date(CAPTURED_AT)
  });
  assert.ok(anchor);
  assert.equal(validateClaudeHumanStartedActiveTaskAnchor(anchor), anchor);
  assert.throws(
    () => validateClaudeHumanStartedActiveTaskAnchor({
      ...anchor,
      pid: String(anchor.pid)
    }),
    /identity is invalid/u
  );
  assert.throws(
    () => validateClaudeHumanStartedActiveTaskAnchor({
      ...anchor,
      captured_at: "2026-07-24T02:00:00.1Z"
    }),
    /identity is invalid/u
  );
  assert.equal(anchor.prompt_uuid, uuid(6000));
  assert.equal(anchor.request_hash, fingerprint(request));
  assert.equal(anchor.turn_start_offset_bytes, 0);
  assert.equal(JSON.stringify(anchor).includes(request), false);
  const initialCheckpoint = initialClaudeHumanStartedActiveTaskCheckpoint(anchor);
  assert.equal(
    initialCheckpoint.safe_resume_offset_bytes,
    anchor.turn_start_offset_bytes
  );
  assert.equal(initialCheckpoint.record_count, 0);
  assert.equal(
    validateClaudeHumanStartedActiveTaskCheckpoint(initialCheckpoint, anchor),
    initialCheckpoint
  );
  assert.equal(JSON.stringify(initialCheckpoint).includes(request), false);
  assert.throws(
    () => validateClaudeHumanStartedActiveTaskCheckpoint({
      ...initialCheckpoint,
      assistant_text: "forged raw continuation"
    }, anchor),
    /fingerprint|identity/u
  );
  assert.equal(observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  }).status, "pending");

  const laterPrompt = fixture.normalizeRecords([userRecord({
    uuid: uuid(6010),
    request: "A later task must not erase completion",
    timestamp: "2026-07-24T02:00:00.500Z",
    parentUuid: uuid(6003)
  })]);
  fixture.appendRaw([...records.slice(1), ...laterPrompt].map(jsonLine).join(""));
  fixture.agentRows.splice(0);
  const observed = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(observed.status, "completed");
  if (observed.status === "completed") {
    assert.equal(observed.completion.outcome, "success");
    assert.equal(observed.completion.text, "Human-started task done");
    assert.equal(observed.completion.metadata?.prompt_uuid, uuid(6000));
  }
});

test("human-started Claude observation checkpoints only stable complete JSONL", (t) => {
  const fixture = createFixture(t, 75);
  const prompt = fixture.normalizeRecords([userRecord({
    uuid: uuid(6600),
    request: "Observe a partial Claude transcript tail",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(prompt[0]));
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  const progress = fixture.normalizeRecords([{
    ...baseRecord(
      uuid(6601),
      uuid(6600),
      PROMPT_AT,
      fixture.sessionId,
      VERSION
    ),
    type: "assistant",
    message: {
      role: "assistant",
      id: uuid(7601),
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "toolu_incremental_checkpoint",
        name: "Read",
        input: { file_path: "/tmp/redacted" }
      }]
    }
  }]);
  const progressLine = jsonLine(progress[0]);
  fixture.appendRaw(`${progressLine}{"type":"assistant"`);

  assert.throws(
    () => captureClaudeHumanStartedActiveTaskAnchor({
      sessionId: fixture.sessionId,
      cwd: fixture.workspace,
      pid: PID,
      claudeHome: fixture.claudeHome,
      agentRows: fixture.agentRows
    }),
    /incomplete JSONL tail; retry/u
  );

  const first = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(first.status, "pending");
  if (first.status !== "pending") {
    return;
  }
  assert.equal(
    first.safeResumeOffsetBytes,
    anchor.observed_end_offset_bytes + Buffer.byteLength(progressLine)
  );
  assert.equal(first.observedEndOffsetBytes, fs.statSync(fixture.transcriptPath).size);

  const second = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    checkpoint: first.checkpoint,
    resumeOffsetBytes: first.safeResumeOffsetBytes
  });
  assert.equal(second.status, "pending");
  if (second.status === "pending") {
    assert.equal(second.safeResumeOffsetBytes, first.safeResumeOffsetBytes);
  }
});

test("human-started Claude observation separates unavailable I/O from invalidation", (t) => {
  const fixture = createFixture(t, 76);
  const prompt = fixture.normalizeRecords([userRecord({
    uuid: uuid(6700),
    request: "Temporarily unavailable Claude transcript",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(prompt[0]));
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  fs.unlinkSync(fixture.transcriptPath);
  const unavailable = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(unavailable.status, "unavailable");
  if (unavailable.status === "unavailable") {
    assert.equal(unavailable.retryable, true);
    assert.match(unavailable.reason, /disappeared|unavailable/u);
  }
});

test("human-started Claude completion survives cumulative checkpointed data beyond the per-scan limit", (t) => {
  const fixture = createFixture(t, 77);
  const maxTurnBytes = 2 * 1024 * 1024;
  const request = "Complete after many bounded incremental scans";
  const promptUuid = uuid(6800);
  const prompt = fixture.normalizeRecords([userRecord({
    uuid: promptUuid,
    request,
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(prompt[0]));
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  let parentUuid = promptUuid;
  const repeatedPayload = "x".repeat(1024 * 1024);
  for (let index = 1; index <= 65; index += 1) {
    const recordUuid = uuid(6800 + index);
    fixture.append([{
      ...baseRecord(
        recordUuid,
        parentUuid,
        PROMPT_AT,
        fixture.sessionId,
        VERSION
      ),
      type: "attachment",
      compact_progress_hash_input: repeatedPayload
    }]);
    parentUuid = recordUuid;
  }
  const finalAssistantUuid = uuid(6890);
  const finalMessageId = uuid(7890);
  fixture.append([
    assistantRecord({
      uuid: finalAssistantUuid,
      parentUuid,
      messageId: finalMessageId,
      text: "Checkpointed Claude task completed",
      sessionId: fixture.sessionId
    }),
    durationRecord({
      uuid: uuid(6891),
      parentUuid: finalAssistantUuid,
      timestamp: COMPLETED_AT,
      sessionId: fixture.sessionId
    })
  ]);
  assert.ok(
    fs.statSync(fixture.transcriptPath).size - anchor.turn_start_offset_bytes >
      64 * 1024 * 1024
  );

  let checkpoint = initialClaudeHumanStartedActiveTaskCheckpoint(anchor);
  let completedText: string | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const observed = observeClaudeHumanStartedActiveTask({
      anchor,
      checkpoint,
      resumeOffsetBytes: checkpoint.safe_resume_offset_bytes,
      claudeHome: fixture.claudeHome,
      agentRows: fixture.agentRows,
      maxTurnBytes
    });
    if (observed.status === "completed") {
      completedText = observed.completion.text;
      break;
    }
    assert.equal(observed.status, "pending");
    if (observed.status !== "pending") {
      break;
    }
    assert.ok(
      observed.checkpoint.safe_resume_offset_bytes >
        checkpoint.safe_resume_offset_bytes
    );
    checkpoint = validateClaudeHumanStartedActiveTaskCheckpoint(
      JSON.parse(JSON.stringify(observed.checkpoint)),
      anchor
    );
  }
  assert.equal(completedText, "Checkpointed Claude task completed");
});

test("human-started Claude checkpoint carries only privacy-safe unresolved tool state", (t) => {
  const fixture = createFixture(t, 78);
  const request = "Continue across a resolved tool boundary";
  const promptUuid = uuid(6900);
  const toolAssistantUuid = uuid(6901);
  const toolResultUuid = uuid(6902);
  const toolUseId = "toolu_checkpoint_6901";
  const rawCommand = "printf super-secret-command-value";
  const prompt = fixture.normalizeRecords([userRecord({
    uuid: promptUuid,
    request,
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(prompt[0]));
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  fixture.append([{
    ...baseRecord(
      toolAssistantUuid,
      promptUuid,
      PROMPT_AT,
      fixture.sessionId,
      VERSION
    ),
    type: "assistant",
    message: {
      role: "assistant",
      id: uuid(7901),
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: toolUseId,
        name: "Bash",
        input: { command: rawCommand }
      }]
    }
  }]);
  const toolPending = observeClaudeHumanStartedActiveTask({
    anchor,
    checkpoint: initialClaudeHumanStartedActiveTaskCheckpoint(anchor),
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(toolPending.status, "pending");
  assert.ok(toolPending.status === "pending");
  assert.deepEqual(toolPending.checkpoint.unresolved_tool_uses, [{
    tool_use_id: toolUseId,
    owner_uuid: toolAssistantUuid
  }]);
  assert.equal(JSON.stringify(toolPending.checkpoint).includes(rawCommand), false);
  assert.equal(JSON.stringify(toolPending.checkpoint).includes(request), false);
  const restartedToolCheckpoint = validateClaudeHumanStartedActiveTaskCheckpoint(
    JSON.parse(JSON.stringify(toolPending.checkpoint)),
    anchor
  );

  fixture.append([{
    ...baseRecord(
      toolResultUuid,
      toolAssistantUuid,
      PROMPT_AT,
      fixture.sessionId,
      VERSION
    ),
    type: "user",
    sourceToolAssistantUUID: toolAssistantUuid,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }]
    }
  }]);
  const resolved = observeClaudeHumanStartedActiveTask({
    anchor,
    checkpoint: restartedToolCheckpoint,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(resolved.status, "pending");
  assert.ok(resolved.status === "pending");
  assert.deepEqual(resolved.checkpoint.unresolved_tool_uses, []);

  const finalAssistantUuid = uuid(6903);
  const rawOutputSecret = "--token not-a-secret";
  const rawOutput = [
    "Tool-backed checkpoint completed",
    rawOutputSecret,
    "x".repeat(5000)
  ].join(" ");
  fixture.append([assistantRecord({
    uuid: finalAssistantUuid,
    parentUuid: toolResultUuid,
    messageId: uuid(7903),
    text: rawOutput,
    sessionId: fixture.sessionId
  })]);
  const endTurnPending = observeClaudeHumanStartedActiveTask({
    anchor,
    checkpoint: resolved.checkpoint,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(endTurnPending.status, "pending");
  assert.ok(endTurnPending.status === "pending");
  const expectedRedactedOutput = redactString(rawOutput).trim().slice(0, 4000);
  assert.equal(endTurnPending.checkpoint.assistant_text, expectedRedactedOutput);
  assert.ok((endTurnPending.checkpoint.assistant_text?.length ?? 0) <= 4000);
  assert.equal(
    JSON.stringify(endTurnPending.checkpoint).includes(rawOutputSecret),
    false
  );
  fixture.append([durationRecord({
    uuid: uuid(6904),
    parentUuid: finalAssistantUuid,
    timestamp: COMPLETED_AT,
    sessionId: fixture.sessionId
  })]);
  const restartedEndTurnCheckpoint =
    validateClaudeHumanStartedActiveTaskCheckpoint(
      JSON.parse(JSON.stringify(endTurnPending.checkpoint)),
      anchor
    );
  const completed = observeClaudeHumanStartedActiveTask({
    anchor,
    checkpoint: restartedEndTurnCheckpoint,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") {
    assert.equal(completed.completion.text, expectedRedactedOutput);
  }
});

test("human-started Claude watch keeps the end-turn append gap pending", (t) => {
  const fixture = createFixture(t, 73);
  const records = fixture.normalizeRecords(turnRecords({
    request: "Observe the canonical completion append gap",
    assistantText: "The duration record arrived later",
    ids: 6400,
    sessionId: fixture.sessionId
  }));
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(jsonLine(records[0]));
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  fixture.appendRaw(jsonLine(records[1]));
  const capturedDuringGap = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(capturedDuringGap?.prompt_uuid, anchor.prompt_uuid);
  const endTurnPending = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(endTurnPending.status, "pending");
  assert.ok(endTurnPending.status === "pending");
  assert.equal(
    endTurnPending.safeResumeOffsetBytes,
    anchor.observed_end_offset_bytes + Buffer.byteLength(jsonLine(records[1]))
  );
  fixture.appendRaw(records.slice(2, -1).map(jsonLine).join(""));
  const textPending = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    checkpoint: endTurnPending.checkpoint,
    resumeOffsetBytes: endTurnPending.safeResumeOffsetBytes
  });
  assert.equal(textPending.status, "pending");
  assert.ok(textPending.status === "pending");
  assert.ok(
    textPending.safeResumeOffsetBytes > endTurnPending.safeResumeOffsetBytes
  );

  const agent = fixture.agentRows[0];
  assert.ok(agent);
  fixture.agentRows.splice(0);
  assert.equal(observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  }).status, "invalidated");
  fixture.agentRows.push(agent);

  fixture.appendRaw(jsonLine(records[records.length - 1]));
  fixture.agentRows.splice(0);
  const completed = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    checkpoint: textPending.checkpoint,
    resumeOffsetBytes: textPending.safeResumeOffsetBytes
  });
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") {
    assert.equal(completed.completion.text, "The duration record arrived later");
  }
});

test("human-started Claude watch bounds only the anchored turn in a long transcript", (t) => {
  const fixture = createFixture(t, 74);
  const maxTurnBytes = 4 * 1024;
  const historicalLine = jsonLine({
    type: "mode",
    historical_padding: "x".repeat(maxTurnBytes * 2)
  });
  const records = fixture.normalizeRecords(turnRecords({
    request: "Watch only this small tail turn",
    assistantText: "Small tail completed",
    ids: 6500,
    sessionId: fixture.sessionId
  }));
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.writeRaw(`${historicalLine}${jsonLine(records[0])}`);

  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    maxTurnBytes
  });
  assert.ok(anchor);
  assert.equal(
    anchor.turn_start_offset_bytes,
    Buffer.byteLength(historicalLine)
  );
  assert.ok(fs.statSync(fixture.transcriptPath).size > maxTurnBytes);

  fixture.appendRaw(records.slice(1).map(jsonLine).join(""));
  fixture.agentRows.splice(0);
  const completed = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    maxTurnBytes
  });
  assert.equal(completed.status, "completed");
  if (completed.status === "completed") {
    assert.equal(completed.completion.text, "Small tail completed");
  }
});

test("human-started Claude observation returns exact failure and rejects later prompts or process drift", (t) => {
  const failed = createFixture(t, 70);
  const failureRequest = "Human task that reaches a terminal API error";
  const failurePrompt = failed.normalizeRecords([userRecord({
    uuid: uuid(6100),
    request: failureRequest,
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: failed.sessionId
  })]);
  failed.agentRows[0] = { ...failed.agentRows[0], status: "busy" };
  failed.writeRaw(failurePrompt.map(jsonLine).join(""));
  const failureAnchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: failed.sessionId,
    cwd: failed.workspace,
    pid: PID,
    claudeHome: failed.claudeHome,
    agentRows: failed.agentRows
  });
  assert.ok(failureAnchor);
  failed.append([apiErrorRecord({
    uuid: uuid(6101),
    parentUuid: uuid(6100),
    text: "API Error: unavailable",
    error: "server_error"
  })]);
  failed.agentRows[0] = { ...failed.agentRows[0], status: "idle" };
  const failure = observeClaudeHumanStartedActiveTask({
    anchor: failureAnchor,
    claudeHome: failed.claudeHome,
    agentRows: failed.agentRows
  });
  assert.equal(failure.status, "completed");
  if (failure.status === "completed") {
    assert.equal(failure.completion.outcome, "failure");
    assert.equal(failure.completion.metadata?.error, "server_error");
  }

  const superseded = createFixture(t, 71);
  superseded.agentRows[0] = {
    ...superseded.agentRows[0],
    status: "waiting",
    waitingFor: "permission prompt"
  };
  superseded.write([userRecord({
    uuid: uuid(6200),
    request: "Original human task",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: superseded.sessionId
  })]);
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: superseded.sessionId,
    cwd: superseded.workspace,
    pid: PID,
    claudeHome: superseded.claudeHome,
    agentRows: superseded.agentRows
  });
  assert.ok(anchor);
  assert.equal(observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: superseded.claudeHome,
    agentRows: [{
      ...superseded.agentRows[0],
      startedAt: AGENT_STARTED_AT_MS + 1
    }]
  }).status, "invalidated");

  superseded.append([userRecord({
    uuid: uuid(6201),
    request: "Later human task",
    timestamp: COMPLETED_AT,
    parentUuid: uuid(6200),
    sessionId: superseded.sessionId
  })]);
  const later = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: superseded.claudeHome,
    agentRows: superseded.agentRows
  });
  assert.equal(later.status, "invalidated");
  if (later.status === "invalidated") {
    assert.match(later.reason, /later Claude human prompt/u);
  }
});

test("human-started Claude observation rejects transcript file replacement", (t) => {
  const fixture = createFixture(t, 72);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.write([userRecord({
    uuid: uuid(6300),
    request: "Task anchored to one private transcript inode",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  const anchor = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.ok(anchor);

  fs.renameSync(fixture.transcriptPath, `${fixture.transcriptPath}.replaced`);
  fixture.write([userRecord({
    uuid: uuid(6300),
    request: "Task anchored to one private transcript inode",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  const observed = observeClaudeHumanStartedActiveTask({
    anchor,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  });
  assert.equal(observed.status, "invalidated");
  if (observed.status === "invalidated") {
    assert.match(observed.reason, /transcript identity changed/u);
  }
});

test("Claude lifecycle candidates are root-interactive and carry a revalidated file token", (t) => {
  const fixture = createFixture(t);
  const historicalRecords = fixture.normalizeRecords(turnRecords({
    request: "Historical request",
    assistantText: "Historical answer",
    ids: 20
  }));
  fixture.writeRaw([
    { type: "mode", sessionId: SESSION_ID, mode: "default" },
    ...historicalRecords
  ].map(jsonLine).join(""));

  const sessions = listClaudeHistoricalSessions({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: VERSION
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, SESSION_ID);
  assert.equal(sessions[0].claudeVersion, VERSION);
  assert.equal(sessions[0].rootInteractive, true);
  assert.equal(sessions[0].fileToken.path, fs.realpathSync(fixture.transcriptPath));
  assert.match(sessions[0].fileToken.device, /^\d+$/u);
  assert.match(sessions[0].fileToken.inode, /^\d+$/u);
  assert.ok(sessions[0].fileToken.size > 0);

  const candidate = listClaudeThreadLifecycleCandidates({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: VERSION
  })[0];
  assert.equal(candidate.source, "claude_transcript");
  assert.equal(
    candidate.candidateToken.schema,
    "agent-knock-knock/thread-candidate-token"
  );
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(candidate.candidateToken, {
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: VERSION
    }).status,
    "valid"
  );

  fixture.append(turnRecords({
    request: "A later request",
    assistantText: "A later answer",
    ids: 40
  }));
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(candidate.candidateToken, {
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: VERSION
    }).status,
    "changed"
  );
  for (const agentVersion of ["2.1.219", "2.1.238", "3.0.0"]) {
    const unverifiedCandidates = listClaudeHistoricalSessions({
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion
    });
    assert.equal(unverifiedCandidates.length, 1);
  }
  for (const agentVersion of ["2.1", "v2.1.238", "02.1.238"]) {
    assert.throws(
      () => listClaudeHistoricalSessions({
        cwd: fixture.workspace,
        claudeHome: fixture.claudeHome,
        agentVersion
      }),
      /complete x\.y\.z Claude Code version/u
    );
  }
});

test("Claude resume candidates use complete versions and structural identity instead of an exact allowlist", (t) => {
  const fixture = createFixture(t);
  fixture.write(turnRecords({
    request: "Historical 2.1.218 request",
    assistantText: "Historical 2.1.218 answer",
    version: VERSION
  }));

  const candidates = listClaudeThreadLifecycleCandidates({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: CURRENT_VERSION
  });
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.agentVersion, CURRENT_VERSION);
  assert.equal(candidate.sourceAgentVersion, VERSION);
  assert.equal(candidate.candidateToken.version, 2);
  if (candidate.candidateToken.version !== 2) {
    return;
  }
  assert.equal(candidate.candidateToken.agentVersion, CURRENT_VERSION);
  assert.equal(candidate.candidateToken.sourceAgentVersion, VERSION);
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(candidate.candidateToken, {
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: CURRENT_VERSION
    }).status,
    "valid"
  );
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate({
      ...candidate.candidateToken,
      sourceAgentVersion: "2.1.217"
    }, {
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: CURRENT_VERSION
    }).status,
    "changed"
  );
  assert.equal(
    listClaudeThreadLifecycleCandidates({
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: VERSION
    })[0].candidateToken.version,
    1
  );
  const previousCompatibilityCandidate = listClaudeThreadLifecycleCandidates({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: PREVIOUS_VERSION
  })[0];
  assert.equal(previousCompatibilityCandidate.sourceAgentVersion, VERSION);
  assert.equal(previousCompatibilityCandidate.candidateToken.version, 2);
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(
      previousCompatibilityCandidate.candidateToken,
      {
        cwd: fixture.workspace,
        claudeHome: fixture.claudeHome,
        agentVersion: PREVIOUS_VERSION
      }
    ).status,
    "valid"
  );

  const previous = createFixture(t, 225);
  previous.write(turnRecords({
    request: "Historical 2.1.226 request",
    assistantText: "Historical 2.1.226 answer",
    sessionId: previous.sessionId,
    version: PREVIOUS_VERSION
  }));
  const previousCandidate = listClaudeThreadLifecycleCandidates({
    cwd: previous.workspace,
    claudeHome: previous.claudeHome,
    agentVersion: CURRENT_VERSION
  })[0];
  assert.equal(previousCandidate.sourceAgentVersion, PREVIOUS_VERSION);
  assert.equal(previousCandidate.candidateToken.version, 2);
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(previousCandidate.candidateToken, {
      cwd: previous.workspace,
      claudeHome: previous.claudeHome,
      agentVersion: CURRENT_VERSION
    }).status,
    "valid"
  );
  assert.equal(
    listClaudeThreadLifecycleCandidates({
      cwd: previous.workspace,
      claudeHome: previous.claudeHome,
      agentVersion: VERSION
    }).length,
    1
  );

  const newer = createFixture(t, 226);
  newer.write(turnRecords({
    request: "Future source request",
    assistantText: "Future source answer",
    sessionId: newer.sessionId,
    version: CURRENT_VERSION
  }));
  assert.equal(
    listClaudeThreadLifecycleCandidates({
      cwd: newer.workspace,
      claudeHome: newer.claudeHome,
      agentVersion: PREVIOUS_VERSION
    }).length,
    1
  );
  assert.equal(
    listClaudeThreadLifecycleCandidates({
      cwd: newer.workspace,
      claudeHome: newer.claudeHome,
      agentVersion: VERSION
    }).length,
    1
  );

  const unverified = createFixture(t, 239);
  unverified.write(turnRecords({
    request: "Unverified future source request",
    assistantText: "Unverified future source answer",
    sessionId: unverified.sessionId,
    version: "2.1.238"
  }));
  const unverifiedCandidate = listClaudeThreadLifecycleCandidates({
    cwd: unverified.workspace,
    claudeHome: unverified.claudeHome,
    agentVersion: "2.1.239"
  })[0];
  assert.equal(unverifiedCandidate.sourceAgentVersion, "2.1.238");
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(
      unverifiedCandidate.candidateToken,
      {
        cwd: unverified.workspace,
        claudeHome: unverified.claudeHome,
        agentVersion: "2.1.239"
      }
    ).status,
    "valid"
  );
});

test("Claude 2.1.259 transcript supports lifecycle, acceptance, completion, and approval evidence", (t) => {
  const fixture = createFixture(t, 259);
  const request = "Verify the exact current Claude transcript profile";
  const anchor = fixture.capture();
  fixture.write(turnRecords({
    request,
    assistantText: "Current Claude transcript accepted",
    sessionId: fixture.sessionId,
    version: CURRENT_VERSION
  }));

  const acceptance = fixture.detectAcceptance(anchor, request);
  assert.equal(acceptance?.metadata?.claude_version, CURRENT_VERSION);
  const completion = fixture.detect(anchor, request);
  assert.equal(completion?.text, "Current Claude transcript accepted");
  assert.equal(completion?.metadata?.claude_version, CURRENT_VERSION);

  const sessions = listClaudeHistoricalSessions({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: CURRENT_VERSION
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].claudeVersion, CURRENT_VERSION);
  const candidate = listClaudeThreadLifecycleCandidates({
    cwd: fixture.workspace,
    claudeHome: fixture.claudeHome,
    agentVersion: CURRENT_VERSION
  })[0];
  assert.equal(candidate.agentVersion, CURRENT_VERSION);
  assert.equal(
    revalidateClaudeThreadLifecycleCandidate(candidate.candidateToken, {
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: CURRENT_VERSION
    }).status,
    "valid"
  );

  const pending = createFixture(t, 238);
  const pendingRequest = "Inspect the current Claude approval schema";
  const pendingAnchor = pending.capture();
  pending.write(pendingBashRecords({
    request: pendingRequest,
    command: "printf current-claude-profile",
    sessionId: pending.sessionId,
    version: CURRENT_VERSION
  }));
  const approval = pending.detectPending(pendingAnchor, pendingRequest);
  assert.equal(approval?.claudeVersion, CURRENT_VERSION);
  assert.equal(approval?.toolName, "Bash");
});

test("Claude 2.1.259 input-ready waiting rows can anchor sends but permission waits cannot", (t) => {
  const fixture = createFixture(t, 259);
  fixture.agentRows[0] = {
    ...fixture.agentRows[0],
    status: "waiting",
    waitingFor: undefined
  };
  assert.ok(fixture.capture());

  fixture.agentRows[0] = {
    ...fixture.agentRows[0],
    status: "waiting",
    waitingFor: "permission prompt"
  };
  assert.equal(captureClaudeTranscriptAnchor({
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows,
    now: new Date(CAPTURED_AT)
  }), undefined);
});

test("fallback Watch identifies one anchored Claude request from its hash only", (t) => {
  const fixture = createFixture(t, 240);
  const request = "Complete this exact user-explicit fallback request";
  const anchor = fixture.capture();
  fixture.write(turnRecords({
    request,
    assistantText: "Hash-only fallback completion",
    sessionId: fixture.sessionId,
    version: CURRENT_VERSION,
    ids: 6240
  }));
  const durableRequest = {
    sessionId: fixture.sessionId,
    cwd: fixture.workspace,
    requestHash: fingerprint(request),
    startedAt: anchor.captured_at,
    context: {
      claudeTranscriptAnchor: anchor,
      pid: PID
    }
  };
  const providerOptions = {
    claudeHome: fixture.claudeHome,
    agentRows: fixture.agentRows
  };

  const acceptance = detectClaudeTranscriptAcceptanceByHash(
    durableRequest,
    providerOptions
  );
  assert.equal(acceptance?.requestHash, fingerprint(request));
  assert.equal(acceptance?.metadata?.prompt_uuid, uuid(6240));
  assert.equal(
    detectClaudeTranscriptCompletionByHash(durableRequest, providerOptions)
      ?.text,
    "Hash-only fallback completion"
  );
  assert.equal(JSON.stringify(durableRequest).includes(request), false);
  const firstDurableSweep = observeClaudeUserExplicitFallbackTranscript(
    durableRequest,
    { claudeHome: fixture.claudeHome }
  );
  assert.equal(firstDurableSweep.status, "completed");
  if (firstDurableSweep.status === "completed") {
    assert.equal(
      firstDurableSweep.completion.text,
      "Hash-only fallback completion"
    );
  }

  fixture.append(turnRecords({
    request,
    assistantText: "Later identical completion must not redirect Watch",
    sessionId: fixture.sessionId,
    version: CURRENT_VERSION,
    ids: 6250
  }));
  const durable = observeClaudeUserExplicitFallbackTranscript(
    durableRequest,
    {
      claudeHome: fixture.claudeHome,
      acceptanceEvidence: acceptance
    }
  );
  assert.equal(durable.status, "completed");
  if (durable.status === "completed") {
    assert.equal(durable.completion.text, "Hash-only fallback completion");
    assert.equal(durable.acceptance.acceptanceId, uuid(6240));
  }

  const wrongRequest = { ...durableRequest, requestHash: "f".repeat(64) };
  assert.equal(
    detectClaudeTranscriptAcceptanceByHash(wrongRequest, providerOptions),
    undefined
  );
  assert.equal(
    detectClaudeTranscriptCompletionByHash(wrongRequest, providerOptions),
    undefined
  );
});

test("Claude lifecycle candidate discovery excludes sidechains, teams, daemons, and loops", (t) => {
  const fixture = createFixture(t);
  const base = () => turnRecords({
    request: "Historical request",
    assistantText: "Historical answer",
    ids: 60
  });
  for (const [label, mutate] of [
    ["sidechain", (record: Record<string, unknown>) => {
      record.isSidechain = true;
    }],
    ["team", (record: Record<string, unknown>) => {
      record.teamName = "team-one";
    }],
    ["daemon", (record: Record<string, unknown>) => {
      record.sessionKind = "daemon";
    }],
    ["loop", (record: Record<string, unknown>) => {
      record.isLoopSession = true;
    }],
    ["subagent", (record: Record<string, unknown>) => {
      record.agentId = "agent-one";
    }]
  ] as const) {
    const records = base();
    mutate(records[0]);
    fixture.write(records);
    assert.equal(
      listClaudeHistoricalSessions({
        cwd: fixture.workspace,
        claudeHome: fixture.claudeHome,
        agentVersion: VERSION
      }).length,
      0,
      label
    );
  }

  fixture.write(base());
  fs.chmodSync(fixture.transcriptPath, 0o644);
  assert.equal(
    listClaudeHistoricalSessions({
      cwd: fixture.workspace,
      claudeHome: fixture.claudeHome,
      agentVersion: VERSION
    }).length,
    0
  );
});

test("detects one anchored foreground Bash tool use waiting for approval", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  assert.equal(anchor.file_existed, false);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };

  const request = "Run the exact approved command";
  const command = "npm test -- --runInBand";
  const ids = 700;
  fixture.write(pendingBashRecords({ request, command, ids }));

  const evidence = fixture.detectPending(anchor, request);
  assert.ok(evidence);
  const stat = fs.statSync(fixture.transcriptPath);
  const commandSha256 = sha256(command);
  const transcriptFileId = sha256(
    `${fixture.sessionId}\0${stat.dev}:${stat.ino}`
  ).slice(0, 24);
  const evidenceFingerprint = sha256(JSON.stringify({
    schema_version: 1,
    source: "claude_transcript",
    kind: "run_command",
    session_id: fixture.sessionId,
    cwd: fixture.workspace,
    pid: PID,
    agent_started_at_ms: AGENT_STARTED_AT_MS,
    anchor_offset_bytes: 0,
    observed_end_offset_bytes: stat.size,
    prompt_uuid: uuid(ids),
    assistant_uuid: uuid(ids + 2),
    tool_use_id: `toolu_pending_${ids}`,
    claude_version: VERSION,
    transcript_file_id: transcriptFileId,
    request_sha256: fingerprint(request),
    command_sha256: commandSha256
  }));
  assert.deepEqual(evidence, {
    source: "claude_transcript",
    kind: "run_command",
    command,
    cwd: fixture.workspace,
    toolName: "Bash",
    toolUseId: `toolu_pending_${ids}`,
    promptUuid: uuid(ids),
    assistantUuid: uuid(ids + 2),
    claudeVersion: VERSION,
    transcriptFileId,
    commandSha256,
    evidenceFingerprint,
    observedEndOffsetBytes: stat.size
  });
  assert.deepEqual(
    fixture.detectPending(anchor, request),
    evidence,
    "an unchanged stable transcript snapshot must produce identical evidence"
  );
  assert.doesNotMatch(evidence.evidenceFingerprint, new RegExp(command, "u"));
  assert.notEqual(evidence.evidenceFingerprint, evidence.commandSha256);
  assert.equal(
    fixture.detect(anchor, request),
    undefined,
    "an unresolved tool use is not durable completion"
  );
});

test("pending approval evidence honors the existing transcript byte anchor", (t) => {
  const fixture = createFixture(t);
  fixture.write(turnRecords({
    request: "Earlier completed request",
    assistantText: "Earlier turn done",
    ids: 100
  }));
  const anchor = fixture.capture();
  assert.equal(anchor.file_existed, true);
  assert.ok(anchor.offset_bytes > 0);
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };

  fixture.append(pendingBashRecords({
    request: "Approve the new command",
    command: "git status --short",
    ids: 800
  }));
  const evidence = fixture.detectPending(anchor, "Approve the new command");
  assert.equal(evidence?.command, "git status --short");
  assert.ok((evidence?.observedEndOffsetBytes ?? 0) > anchor.offset_bytes);
  assert.equal(
    fixture.detectPending(anchor, "Earlier completed request"),
    undefined
  );
});

test("pending approval permits earlier sequentially resolved tools in the managed turn", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  const request = "Inspect first, then run the approved command";
  const records = pendingBashRecords({
    request,
    command: "git status --short",
    ids: 850
  });
  const prompt = records[0];
  const pendingThinking = records[1];
  const priorAssistantUuid = uuid(860);
  const priorResultUuid = uuid(861);
  const priorToolId = "toolu_resolved_first";
  const priorAssistant = {
    ...baseRecord(
      priorAssistantUuid,
      prompt.uuid as string,
      PROMPT_AT,
      SESSION_ID,
      VERSION
    ),
    type: "assistant",
    message: {
      role: "assistant",
      id: uuid(1860),
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: priorToolId,
        name: "Read",
        input: { file_path: "README.md" }
      }]
    }
  };
  const priorResult = {
    ...baseRecord(
      priorResultUuid,
      priorAssistantUuid,
      PROMPT_AT,
      SESSION_ID,
      VERSION
    ),
    type: "user",
    sourceToolAssistantUUID: priorAssistantUuid,
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: priorToolId,
        content: "README contents"
      }]
    }
  };
  pendingThinking.parentUuid = priorResultUuid;
  fixture.write([
    prompt,
    priorAssistant,
    priorResult,
    ...records.slice(1)
  ]);

  const evidence = fixture.detectPending(anchor, request);
  assert.equal(evidence?.command, "git status --short");
  assert.equal(evidence?.toolUseId, "toolu_pending_850");
});

test("pending approval requires an unchanged process and a private transcript", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const request = "Approve one private transcript command";
  fixture.write(pendingBashRecords({
    request,
    command: "git status",
    ids: 900
  }));

  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  assert.equal(fixture.detectPending(anchor, request)?.command, "git status");

  fixture.agentRows[0] = {
    ...fixture.agentRows[0],
    startedAt: AGENT_STARTED_AT_MS + 1
  };
  assert.throws(
    () => fixture.detectPending(anchor, request),
    /session identity changed/u
  );

  const broadPermissions = createFixture(t, 2);
  const broadAnchor = broadPermissions.capture();
  broadPermissions.agentRows[0] = {
    ...broadPermissions.agentRows[0],
    status: "working"
  };
  broadPermissions.write(pendingBashRecords({
    request,
    command: "git status",
    ids: 910,
    sessionId: broadPermissions.sessionId
  }));
  fs.chmodSync(broadPermissions.transcriptPath, 0o644);
  assert.throws(
    () => broadPermissions.detectPending(broadAnchor, request),
    /permissions are broader than owner-only/u
  );
});

test("pending approval rejects completed, background, ambiguous, and unsafe tool uses", (t) => {
  const cases: Array<{
    name: string;
    mutate: (
      records: Record<string, unknown>[],
      fixture: ReturnType<typeof createFixture>
    ) => void;
  }> = [
    {
      name: "non-Bash tool",
      mutate: (records) => {
        pendingToolBlock(records).name = "Read";
      }
    },
    {
      name: "background Bash",
      mutate: (records) => {
        const input = pendingToolBlock(records).input as Record<string, unknown>;
        input.run_in_background = true;
      }
    },
    {
      name: "empty command",
      mutate: (records) => {
        const input = pendingToolBlock(records).input as Record<string, unknown>;
        input.command = "   ";
      }
    },
    {
      name: "multiline command",
      mutate: (records) => {
        const input = pendingToolBlock(records).input as Record<string, unknown>;
        input.command = "git status\nrm -rf .";
      }
    },
    {
      name: "parallel tool blocks",
      mutate: (records) => {
        const owner = records[2];
        const message = owner.message as Record<string, unknown>;
        const content = message.content as Record<string, unknown>[];
        content.push({
          type: "tool_use",
          id: "toolu_parallel",
          name: "Bash",
          input: { command: "pwd" }
        });
      }
    },
    {
      name: "resolved tool use",
      mutate: (records) => {
        const ownerUuid = records[2].uuid as string;
        records.push({
          ...baseRecord(
            uuid(9991),
            ownerUuid,
            COMPLETED_AT,
            records[0].sessionId as string,
            VERSION
          ),
          type: "user",
          sourceToolAssistantUUID: ownerUuid,
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: pendingToolBlock(records).id,
              content: "done"
            }]
          }
        });
      }
    },
    {
      name: "UUID-less tool result",
      mutate: (records) => {
        records.push({
          type: "user",
          isSidechain: false,
          entrypoint: "cli",
          timestamp: COMPLETED_AT,
          sessionId: records[0].sessionId,
          version: VERSION,
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: pendingToolBlock(records).id,
              content: "schema is insufficient"
            }]
          }
        });
      }
    },
    {
      name: "completed turn",
      mutate: (records) => {
        records.push(durationRecord({
          uuid: uuid(9992),
          parentUuid: records[2].uuid as string,
          timestamp: COMPLETED_AT,
          sessionId: records[0].sessionId as string
        }));
      }
    },
    {
      name: "later human prompt",
      mutate: (records) => {
        records.push(userRecord({
          uuid: uuid(9993),
          request: "A human superseded the managed prompt",
          timestamp: COMPLETED_AT,
          parentUuid: records[2].uuid as string,
          sessionId: records[0].sessionId as string
        }));
      }
    },
    {
      name: "parallel UUID branch",
      mutate: (records) => {
        records.push({
          ...baseRecord(
            uuid(9994),
            records[0].uuid as string,
            COMPLETED_AT,
            records[0].sessionId as string,
            VERSION
          ),
          type: "attachment",
          attachment: { type: "ide_selection" }
        });
      }
    },
    {
      name: "unverified future transcript schema",
      mutate: (records) => {
        for (const record of records) {
          record.version = "3.0.0";
        }
      }
    }
  ];

  cases.forEach(({ name, mutate }, index) => {
    const fixture = createFixture(t, 20 + index);
    const anchor = fixture.capture();
    fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
    const request = `Reject ${name}`;
    const records = pendingBashRecords({
      request,
      command: "git status",
      ids: 1000 + index * 10,
      sessionId: fixture.sessionId
    });
    mutate(records, fixture);
    fixture.write(records);
    assert.equal(
      fixture.detectPending(anchor, request),
      undefined,
      name
    );
  });
});

test("pending approval throws on sidechains and malformed tool identities", (t) => {
  const sidechain = createFixture(t);
  const sidechainAnchor = sidechain.capture();
  sidechain.agentRows[0] = { ...sidechain.agentRows[0], status: "working" };
  const sidechainRecords = pendingBashRecords({
    request: "Reject sidechain",
    command: "git status",
    ids: 1200
  });
  sidechainRecords[2].isSidechain = true;
  sidechain.write(sidechainRecords);
  assert.throws(
    () => sidechain.detectPending(sidechainAnchor, "Reject sidechain"),
    /unsupported schema or identity/u
  );

  const malformed = createFixture(t, 2);
  const malformedAnchor = malformed.capture();
  malformed.agentRows[0] = { ...malformed.agentRows[0], status: "working" };
  const malformedRecords = pendingBashRecords({
    request: "Reject malformed tool",
    command: "git status",
    ids: 1300,
    sessionId: malformed.sessionId
  });
  delete pendingToolBlock(malformedRecords).id;
  malformed.write(malformedRecords);
  assert.throws(
    () => malformed.detectPending(malformedAnchor, "Reject malformed tool"),
    /malformed tool_use/u
  );
});

test("detects a hookless Claude turn when the transcript is created after send", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  assert.equal(anchor.file_existed, false);
  assert.equal(anchor.offset_bytes, 0);

  fixture.write(turnRecords({
    request: "Implement the focused change",
    assistantText: "Done. Token sk-abcdefghijklmnop was hidden."
  }));
  const completion = fixture.detect(anchor, "Implement the focused change");

  assert.equal(completion?.source, "durable");
  assert.equal(completion?.outcome, "success");
  assert.equal(completion?.text, "Done. Token sk-[REDACTED] was hidden.");
  assert.equal(completion?.timestamp, COMPLETED_AT);
  assert.equal(completion?.metadata?.match, "claude_transcript_turn_duration");
  assert.equal(completion?.metadata?.session_id, SESSION_ID);
  assert.equal(completion?.metadata?.claude_version, VERSION);
  assert.doesNotMatch(
    JSON.stringify(completion),
    /\/projects\/|\.jsonl|Implement the focused/u
  );
});

test("proves Claude native acceptance from one anchored user row regardless of idle status", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const request = "请精确接收第一行  两个空格\nThen keep\tthe tab on line two.";
  const prompt = userRecord({
    uuid: uuid(1600),
    request,
    timestamp: PROMPT_AT,
    parentUuid: null
  });
  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  fixture.write([prompt]);

  const evidence = fixture.detectAcceptance(anchor, request);
  assert.ok(evidence);
  const stat = fs.statSync(fixture.transcriptPath);
  const requestSha256 = fingerprint(request);
  const transcriptFileId = sha256(
    `${fixture.sessionId}\0${stat.dev}:${stat.ino}`
  ).slice(0, 24);
  const evidenceBase = {
    source: "claude_transcript",
    kind: "native_user_turn",
    nativeThreadId: fixture.sessionId,
    requestHash: requestSha256,
    acceptanceId: uuid(1600),
    acceptedAt: PROMPT_AT,
    anchorFingerprint: fingerprintClaudeAnchor(anchor),
    metadata: {
      prompt_uuid: uuid(1600),
      claude_version: VERSION,
      transcript_file_id: transcriptFileId,
      anchor_offset_bytes: 0,
      observed_end_offset_bytes: stat.size,
      agent_started_at_ms: AGENT_STARTED_AT_MS
    }
  } as const;
  assert.deepEqual(evidence, {
    ...evidenceBase,
    evidenceFingerprint: sha256(JSON.stringify(evidenceBase))
  });

  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "idle" };
  assert.deepEqual(fixture.detectAcceptance(anchor, request), evidence);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(request), false);
  assert.equal(evidence.requestHash, sha256(request));
  assert.notEqual(
    evidence.requestHash,
    sha256(request.replace(/\s+/gu, " ").trim()),
    "multiline and consecutive whitespace must not be collapsed before hashing"
  );
  assert.equal(serialized.includes(fixture.workspace), false);
  assert.doesNotMatch(serialized, /\.jsonl|\/projects\//u);
});

test("dead-process completion treats UUID-less turn records as unverifiable", (t) => {
  const cases = [
    {
      suffix: 31,
      label: "user",
      record: {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "malformed" }] }
      }
    },
    {
      suffix: 32,
      label: "assistant completion",
      record: {
        type: "assistant",
        message: {
          role: "assistant",
          id: uuid(3200),
          stop_reason: "end_turn",
          content: [{ type: "text", text: "not attributable" }]
        }
      }
    },
    {
      suffix: 33,
      label: "system",
      record: { type: "system", subtype: "progress" }
    }
  ] as const;

  for (const item of cases) {
    const fixture = createFixture(t, item.suffix);
    const request = `Reject UUID-less ${item.label} record`;
    const anchor = fixture.capture();
    const promptUuid = uuid(item.suffix * 100);
    fixture.write([userRecord({
      uuid: promptUuid,
      request,
      timestamp: PROMPT_AT,
      parentUuid: null,
      sessionId: fixture.sessionId
    })]);
    const acceptance = fixture.detectAcceptance(anchor, request);
    assert.ok(acceptance);
    fixture.append([{
      parentUuid: promptUuid,
      isSidechain: false,
      entrypoint: "cli",
      timestamp: COMPLETED_AT,
      version: VERSION,
      ...item.record
    }]);

    assert.equal(
      fixture.detect(anchor, request),
      undefined,
      "the live detector keeps its prior pending semantics"
    );
    const observation = fixture.observeDead(anchor, request, acceptance);
    assert.equal(observation.status, "unverifiable");
    assert.match(
      observation.status === "unverifiable" ? observation.reason : "",
      /without a stable UUID/u
    );
  }
});

test("dead-process completion treats a UUID-less next human prompt as unverifiable", (t) => {
  const fixture = createFixture(t, 35);
  const request = "Do not abandon across an unattributable human boundary";
  const anchor = fixture.capture();
  const promptUuid = uuid(3500);
  fixture.write([userRecord({
    uuid: promptUuid,
    request,
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  const acceptance = fixture.detectAcceptance(anchor, request);
  assert.ok(acceptance);
  fixture.append([{
    parentUuid: promptUuid,
    isSidechain: false,
    entrypoint: "cli",
    timestamp: COMPLETED_AT,
    version: VERSION,
    type: "user",
    promptId: uuid(3501),
    message: {
      role: "user",
      content: "A human submitted a follow-up prompt"
    }
  }]);

  assert.equal(
    fixture.detect(anchor, request),
    undefined,
    "the live detector keeps treating a later human prompt as a turn boundary"
  );
  const observation = fixture.observeDead(anchor, request, acceptance);
  assert.equal(observation.status, "unverifiable");
  assert.match(
    observation.status === "unverifiable" ? observation.reason : "",
    /has no stable UUID/u
  );
});

test("dead-process completion treats an incomplete end-turn chain as unverifiable", (t) => {
  const fixture = createFixture(t, 34);
  const request = "Do not abandon a partially persisted completion";
  const anchor = fixture.capture();
  const promptUuid = uuid(3400);
  fixture.write([userRecord({
    uuid: promptUuid,
    request,
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: fixture.sessionId
  })]);
  const acceptance = fixture.detectAcceptance(anchor, request);
  assert.ok(acceptance);
  fixture.append([{
    ...baseRecord(
      uuid(3401),
      promptUuid,
      COMPLETED_AT,
      fixture.sessionId,
      VERSION
    ),
    type: "assistant",
    message: {
      role: "assistant",
      id: uuid(3499),
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Final text persisted before duration." }]
    }
  }]);

  assert.equal(
    fixture.detect(anchor, request),
    undefined,
    "the live detector must keep waiting for the canonical duration record"
  );
  const observation = fixture.observeDead(anchor, request, acceptance);
  assert.equal(observation.status, "unverifiable");
  assert.match(
    observation.status === "unverifiable" ? observation.reason : "",
    /completion signal without one complete verifiable completion chain/u
  );
});

test("Claude acceptance ignores pre-anchor prompts and waits for a complete matching row", (t) => {
  const fixture = createFixture(t);
  const request = "Repeat this accepted request";
  fixture.write([userRecord({
    uuid: uuid(1700),
    request,
    timestamp: "2026-07-24T01:59:58.000Z",
    parentUuid: null
  })]);
  const anchor = fixture.capture();
  assert.ok(anchor.offset_bytes > 0);
  assert.equal(fixture.detectAcceptance(anchor, request), undefined);

  fixture.append([{ type: "mode", mode: "default" }]);
  assert.equal(fixture.detectAcceptance(anchor, request), undefined);

  const promptLine = JSON.stringify(fixture.normalizeRecords([userRecord({
    uuid: uuid(1701),
    request,
    timestamp: PROMPT_AT,
    parentUuid: uuid(1700)
  })])[0]);
  fixture.appendRaw(promptLine.slice(0, -1));
  assert.equal(fixture.detectAcceptance(anchor, request), undefined);
  fixture.appendRaw(`${promptLine.slice(-1)}\n`);
  assert.equal(
    fixture.detectAcceptance(anchor, request)?.acceptanceId,
    uuid(1701)
  );
});

test("Claude acceptance uses the byte anchor across prompt clock skew", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const request = "Accept despite native clock skew";
  fixture.write([userRecord({
    uuid: uuid(1800),
    request,
    timestamp: "2026-07-24T01:59:59.000Z",
    parentUuid: null
  })]);

  assert.equal(
    fixture.detectAcceptance(anchor, request)?.acceptanceId,
    uuid(1800)
  );
});

test("Claude acceptance fails closed on duplicate prompts, identity drift, and rotation", (t) => {
  const duplicate = createFixture(t);
  const duplicateAnchor = duplicate.capture();
  duplicate.write([
    userRecord({
      uuid: uuid(1900),
      request: "Ambiguous acceptance",
      timestamp: PROMPT_AT,
      parentUuid: null
    }),
    userRecord({
      uuid: uuid(1901),
      request: "Ambiguous acceptance",
      timestamp: "2026-07-24T02:00:00.300Z",
      parentUuid: uuid(1900)
    })
  ]);
  assert.throws(
    () => duplicate.detectAcceptance(duplicateAnchor, "Ambiguous acceptance"),
    /multiple Claude transcript prompts/u
  );

  const drifted = createFixture(t, 2);
  const driftedAnchor = drifted.capture();
  drifted.write([userRecord({
    uuid: uuid(1910),
    request: "Reject identity drift",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: drifted.sessionId
  })]);
  drifted.agentRows[0] = {
    ...drifted.agentRows[0],
    startedAt: AGENT_STARTED_AT_MS + 1
  };
  assert.throws(
    () => drifted.detectAcceptance(driftedAnchor, "Reject identity drift"),
    /session identity changed/u
  );

  const rotated = createFixture(t, 3);
  rotated.write([{ type: "mode", sessionId: rotated.sessionId }]);
  const rotatedAnchor = rotated.capture();
  fs.renameSync(rotated.transcriptPath, `${rotated.transcriptPath}.old`);
  rotated.write([userRecord({
    uuid: uuid(1920),
    request: "Reject transcript rotation",
    timestamp: PROMPT_AT,
    parentUuid: null,
    sessionId: rotated.sessionId
  })]);
  assert.throws(
    () => rotated.detectAcceptance(rotatedAnchor, "Reject transcript rotation"),
    /replaced or rotated/u
  );
});

test("Claude acceptance rejects malformed persisted anchor invariants", (t) => {
  const fresh = createFixture(t);
  const freshAnchor = fresh.capture();
  assert.equal(freshAnchor.file_existed, false);
  assert.throws(
    () => fresh.detectAcceptance({
      ...freshAnchor,
      captured_at: "not-a-timestamp"
    }, "Reject malformed capture time"),
    /transcript anchor is invalid/u
  );
  assert.throws(
    () => fresh.detectAcceptance({
      ...freshAnchor,
      offset_bytes: 1,
      device: "1",
      inode: "2"
    }, "Reject a forged absent-file boundary"),
    /transcript anchor is invalid/u
  );

  const existing = createFixture(t, 2);
  existing.write([{ type: "mode", mode: "default" }]);
  const existingAnchor = existing.capture();
  assert.equal(existingAnchor.file_existed, true);
  assert.throws(
    () => existing.detectAcceptance({
      ...existingAnchor,
      device: undefined
    }, "Reject missing file identity"),
    /transcript anchor is invalid/u
  );
  assert.throws(
    () => existing.detectAcceptance({
      ...existingAnchor,
      inode: "not-numeric"
    }, "Reject malformed file identity"),
    /transcript anchor is invalid/u
  );
});

test("Claude anchor capture rejects a transcript append during boundary capture", (t) => {
  const fixture = createFixture(t);
  fixture.write([{ type: "mode", mode: "default" }]);
  const originalFstatSync = fs.fstatSync.bind(fs);
  let fstatCalls = 0;
  t.mock.method(fs, "fstatSync", (fd: number) => {
    fstatCalls += 1;
    if (fstatCalls === 2) {
      fixture.append([{ type: "mode", mode: "acceptance-race" }]);
    }
    return originalFstatSync(fd);
  });

  assert.throws(
    () => fixture.capture(),
    /changed while its terminal submission anchor was captured/u
  );
  assert.equal(fstatCalls, 2);
});

test("accepts verified and forward-compatible Claude transcript versions", (t) => {
  const current = createFixture(t);
  const currentAnchor = current.capture();
  const [prompt, thinking, text, duration] = turnRecords({
    request: "Validate the current transcript schema",
    assistantText: "Current schema accepted"
  });
  const firstAttachmentUuid = uuid(10);
  const secondAttachmentUuid = uuid(11);
  const firstAttachment = {
    ...baseRecord(
      firstAttachmentUuid,
      prompt.uuid as string,
      PROMPT_AT,
      SESSION_ID,
      VERSION
    ),
    type: "attachment",
    attachment: { type: "ide_selection" }
  };
  const secondAttachment = {
    ...baseRecord(
      secondAttachmentUuid,
      firstAttachmentUuid,
      PROMPT_AT,
      SESSION_ID,
      VERSION
    ),
    type: "attachment",
    attachment: { type: "ide_opened_file" }
  };
  thinking.parentUuid = secondAttachmentUuid;
  thinking.effort = "medium";
  thinking.session_id = SESSION_ID;
  text.effort = "medium";
  text.session_id = SESSION_ID;
  current.write([
    { type: "mode", mode: "manual", sessionId: SESSION_ID },
    { type: "permission-mode", permissionMode: "default", sessionId: SESSION_ID },
    { type: "file-history-snapshot", isSnapshotUpdate: false, snapshot: {} },
    prompt,
    firstAttachment,
    secondAttachment,
    thinking,
    text,
    duration,
    { type: "ai-title", aiTitle: "Schema validation", sessionId: SESSION_ID }
  ]);
  const currentCompletion = current.detect(
    currentAnchor,
    "Validate the current transcript schema"
  );
  assert.equal(currentCompletion?.text, "Current schema accepted");
  assert.equal(currentCompletion?.metadata?.claude_version, VERSION);

  const legacy = createFixture(t, 2);
  const legacyAnchor = legacy.capture();
  legacy.write(turnRecords({
    request: "Validate the legacy transcript schema",
    assistantText: "Legacy schema accepted",
    sessionId: legacy.sessionId,
    version: LEGACY_VERSION
  }));
  const legacyCompletion = legacy.detect(
    legacyAnchor,
    "Validate the legacy transcript schema"
  );
  assert.equal(legacyCompletion?.text, "Legacy schema accepted");
  assert.equal(legacyCompletion?.metadata?.claude_version, LEGACY_VERSION);

  const future = createFixture(t, 3);
  const futureAnchor = future.capture();
  future.write(turnRecords({
    request: "Validate a future compatible transcript schema",
    assistantText: "Future compatible schema accepted",
    sessionId: future.sessionId,
    version: "2.1.219"
  }));
  const futureCompletion = future.detect(
    futureAnchor,
    "Validate a future compatible transcript schema"
  );
  assert.equal(futureCompletion?.text, "Future compatible schema accepted");
  assert.equal(futureCompletion?.metadata?.claude_version, "2.1.219");
});

test("anchors the first Claude turn before the projects directory exists", (t) => {
  const fixture = createFixture(t, 1, false);
  const anchor = fixture.capture();
  assert.equal(anchor.file_existed, false);
  assert.equal(anchor.offset_bytes, 0);

  fs.mkdirSync(fixture.projectDirectory, { recursive: true, mode: 0o700 });
  fixture.write(turnRecords({
    request: "Complete the first local turn",
    assistantText: "First turn complete"
  }));
  assert.equal(
    fixture.detect(anchor, "Complete the first local turn")?.text,
    "First turn complete"
  );
});

test("anchors an existing transcript and ignores identical completed turns before its byte offset", (t) => {
  const fixture = createFixture(t);
  fixture.write(turnRecords({
    request: "Repeat this request",
    assistantText: "Old answer",
    ids: 100
  }));
  const anchor = fixture.capture();
  assert.equal(anchor.file_existed, true);
  assert.ok(anchor.offset_bytes > 0);

  fixture.append(turnRecords({
    request: "Repeat this request",
    assistantText: "New answer",
    ids: 200,
    promptAt: "2026-07-24T02:00:01.200Z",
    completedAt: "2026-07-24T02:00:01.400Z"
  }));
  const completion = fixture.detect(anchor, "Repeat this request");
  assert.equal(completion?.text, "New answer");
});

test("uses the byte boundary across clock skew and permits in-turn cwd changes", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const records = fixture.normalizeRecords(turnRecords({
    request: "Change directory and finish",
    assistantText: "Finished from the new directory",
    promptAt: "2026-07-24T01:59:59.000Z",
    completedAt: "2026-07-24T01:59:59.500Z"
  }));
  const changedCwd = path.join(fixture.workspace, "nested");
  for (const record of records.slice(1)) {
    record.cwd = changedCwd;
  }
  fixture.writeRaw(records.map(jsonLine).join(""));

  assert.equal(
    fixture.detect(anchor, "Change directory and finish")?.text,
    "Finished from the new directory"
  );
});

test("waits for a complete JSONL line and rejects malformed complete records", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const records = turnRecords({
    request: "Finish after the partial write",
    assistantText: "Complete now"
  });
  const normalized = fixture.normalizeRecords(records);
  const completePrefix = normalized.slice(0, -1).map(jsonLine).join("");
  const durationLine = JSON.stringify(normalized.at(-1));
  fixture.writeRaw(`${completePrefix}${durationLine.slice(0, -4)}`);
  assert.equal(fixture.detect(anchor, "Finish after the partial write"), undefined);

  fixture.appendRaw(`${durationLine.slice(-4)}\n`);
  assert.equal(
    fixture.detect(anchor, "Finish after the partial write")?.text,
    "Complete now"
  );

  const malformedFixture = createFixture(t, 2);
  const malformedAnchor = malformedFixture.capture();
  malformedFixture.writeRaw("{broken-json}\n");
  assert.throws(
    () => malformedFixture.detect(malformedAnchor, "Never matches"),
    /invalid complete JSONL record/u
  );
});

test("does not attribute a later human turn to an interrupted managed prompt", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const interruptedPrompt = userRecord({
    uuid: uuid(1),
    request: "Managed request that was interrupted",
    timestamp: PROMPT_AT,
    parentUuid: null
  });
  const laterPrompt = userRecord({
    uuid: uuid(2),
    request: "Human follow-up",
    timestamp: "2026-07-24T02:00:01.000Z",
    parentUuid: uuid(1)
  });
  const laterAssistant = assistantRecord({
    uuid: uuid(3),
    parentUuid: uuid(2),
    messageId: uuid(30),
    text: "Human follow-up completed"
  });
  const laterDuration = durationRecord({
    uuid: uuid(4),
    parentUuid: uuid(3),
    timestamp: "2026-07-24T02:00:01.300Z"
  });
  fixture.write([interruptedPrompt, laterPrompt, laterAssistant, laterDuration]);

  assert.equal(
    fixture.detect(anchor, "Managed request that was interrupted"),
    undefined
  );
});

test("fails closed on duplicate prompts, unsupported schemas, and multiple duration records", (t) => {
  const duplicate = createFixture(t);
  const duplicateAnchor = duplicate.capture();
  const first = turnRecords({
    request: "Same managed request",
    assistantText: "First",
    ids: 10
  });
  const second = turnRecords({
    request: "Same managed request",
    assistantText: "Second",
    ids: 20,
    promptAt: "2026-07-24T02:00:01.000Z",
    completedAt: "2026-07-24T02:00:01.300Z"
  });
  duplicate.write([...first, ...second]);
  assert.throws(
    () => duplicate.detect(duplicateAnchor, "Same managed request"),
    /multiple Claude transcript prompts/u
  );

  const unsupported = createFixture(t, 2);
  const unsupportedAnchor = unsupported.capture();
  unsupported.write(turnRecords({
    request: "Unsupported version",
    assistantText: "Must not complete",
    version: "2.0.999"
  }));
  assert.throws(
    () => unsupported.detect(unsupportedAnchor, "Unsupported version"),
    /unsupported schema/u
  );

  const changedMidTurn = createFixture(t, 4);
  const changedMidTurnAnchor = changedMidTurn.capture();
  const changedRecords = turnRecords({
    request: "Schema changed mid-turn",
    assistantText: "Must not complete",
    sessionId: changedMidTurn.sessionId
  });
  changedRecords[1].version = "2.1.197";
  changedMidTurn.write(changedRecords);
  assert.throws(
    () => changedMidTurn.detect(changedMidTurnAnchor, "Schema changed mid-turn"),
    /unsupported schema/u
  );

  const mixedCompatible = createFixture(t, 5);
  const mixedCompatibleAnchor = mixedCompatible.capture();
  const mixedCompatibleRecords = turnRecords({
    request: "Compatible schema changed mid-turn",
    assistantText: "Must not complete",
    sessionId: mixedCompatible.sessionId
  });
  mixedCompatibleRecords[1].version = "3.0.0";
  mixedCompatible.write(mixedCompatibleRecords);
  assert.throws(
    () => mixedCompatible.detect(
      mixedCompatibleAnchor,
      "Compatible schema changed mid-turn"
    ),
    /changed schema versions/u
  );

  const multiple = createFixture(t, 6);
  const multipleAnchor = multiple.capture();
  const records = turnRecords({
    request: "Ambiguous duration",
    assistantText: "Must not complete",
    ids: 300
  });
  records.push(durationRecord({
    uuid: uuid(399),
    parentUuid: records.at(-1)?.uuid as string,
    timestamp: "2026-07-24T02:00:00.500Z"
  }));
  multiple.write(records);
  assert.throws(
    () => multiple.detect(multipleAnchor, "Ambiguous duration"),
    /multiple turn_duration/u
  );
});

test("requires an idle unchanged process and stalls on all known background work", (t) => {
  const fixture = createFixture(t);
  const anchor = fixture.capture();
  const background = turnRecords({
    request: "Start a background task",
    assistantText: "The foreground turn ended",
    includeBackgroundTool: true
  });
  fixture.write(background);
  assert.equal(fixture.detect(anchor, "Start a background task"), undefined);

  fixture.agentRows[0] = { ...fixture.agentRows[0], status: "working" };
  assert.equal(fixture.detect(anchor, "Start a background task"), undefined);

  fixture.agentRows[0] = {
    ...fixture.agentRows[0],
    status: "idle",
    startedAt: AGENT_STARTED_AT_MS + 1
  };
  assert.throws(
    () => fixture.detect(anchor, "Start a background task"),
    /session identity changed/u
  );

  const nativeBackgroundSignals: {
    toolName: string;
    toolUseResult: Record<string, unknown>;
  }[] = [
    { toolName: "Bash", toolUseResult: { backgroundTaskId: "bgtask-123" } },
    { toolName: "Bash", toolUseResult: { backgroundedByUser: true } },
    { toolName: "Bash", toolUseResult: { assistantAutoBackgrounded: true } },
    { toolName: "Agent", toolUseResult: { isAsync: true } },
    { toolName: "Agent", toolUseResult: { status: "async_launched" } },
    { toolName: "Agent", toolUseResult: { status: "remote_launched" } },
    { toolName: "Agent", toolUseResult: { status: "teammate_spawned" } },
    { toolName: "Agent", toolUseResult: { status: "completed" } },
    { toolName: "SendMessage", toolUseResult: { status: "sent" } }
  ];
  nativeBackgroundSignals.forEach(({ toolName, toolUseResult }, index) => {
    const native = createFixture(t, index + 10);
    const nativeAnchor = native.capture();
    const request = `Native background result ${index}`;
    const promptUuid = uuid(100 + index * 10);
    const toolAssistantUuid = uuid(101 + index * 10);
    const toolResultUuid = uuid(102 + index * 10);
    const finalUuid = uuid(103 + index * 10);
    const durationUuid = uuid(104 + index * 10);
    const toolId = `toolu_background_${index}`;
    native.write([
      userRecord({
        uuid: promptUuid,
        request,
        timestamp: PROMPT_AT,
        parentUuid: null,
        sessionId: native.sessionId
      }),
      {
        ...baseRecord(
          toolAssistantUuid,
          promptUuid,
          PROMPT_AT,
          native.sessionId,
          VERSION
        ),
        type: "assistant",
        message: {
          role: "assistant",
          id: uuid(200 + index),
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: toolId,
            name: toolName,
            input: { command: "long-running-test" }
          }]
        }
      },
      {
        ...baseRecord(
          toolResultUuid,
          toolAssistantUuid,
          PROMPT_AT,
          native.sessionId,
          VERSION
        ),
        type: "user",
        sourceToolAssistantUUID: toolAssistantUuid,
        toolUseResult,
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolId,
            content: "Command running in background"
          }]
        }
      },
      assistantRecord({
        uuid: finalUuid,
        parentUuid: toolResultUuid,
        messageId: uuid(300 + index),
        text: "The foreground turn ended",
        sessionId: native.sessionId
      }),
      durationRecord({
        uuid: durationUuid,
        parentUuid: finalUuid,
        timestamp: COMPLETED_AT,
        sessionId: native.sessionId
      })
    ]);
    assert.equal(native.detect(nativeAnchor, request), undefined);
  });
});

test("fails closed on nonzero or malformed Claude pending-work counts", (t) => {
  let suffix = 50;
  for (const key of ["pendingBackgroundAgentCount", "pendingWorkflowCount"]) {
    for (const value of [1, -1, "1", null]) {
      const blocked = createFixture(t, suffix);
      suffix += 1;
      const request = `${key} blocked ${String(value)}`;
      const blockedAnchor = blocked.capture();
      const blockedRecords = turnRecords({
        request,
        assistantText: "Must stay pending",
        sessionId: blocked.sessionId
      });
      blockedRecords.at(-1)![key] = value;
      blocked.write(blockedRecords);
      assert.equal(blocked.detect(blockedAnchor, request), undefined);
    }

    const clear = createFixture(t, suffix);
    suffix += 1;
    const request = `${key} clear`;
    const clearAnchor = clear.capture();
    const clearRecords = turnRecords({
      request,
      assistantText: "No pending work",
      sessionId: clear.sessionId
    });
    clearRecords.at(-1)![key] = 0;
    clear.write(clearRecords);
    assert.equal(clear.detect(clearAnchor, request)?.text, "No pending work");
  }
});

test("accepts a resolved tool branch but not an unresolved tool or whitespace-only prompt collision", (t) => {
  const resolved = createFixture(t);
  const anchor = resolved.capture();
  const promptUuid = uuid(1);
  const toolAssistantUuid = uuid(2);
  const toolResultUuid = uuid(3);
  const finalUuid = uuid(4);
  const summaryUuid = uuid(5);
  const durationUuid = uuid(6);
  const toolId = "toolu_123";
  resolved.write([
    userRecord({
      uuid: promptUuid,
      request: "Inspect  two spaces",
      timestamp: PROMPT_AT,
      parentUuid: null
    }),
    {
      ...baseRecord(toolAssistantUuid, promptUuid, PROMPT_AT, SESSION_ID, VERSION),
      type: "assistant",
      message: {
        role: "assistant",
        id: uuid(200),
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: toolId,
          name: "Read",
          input: { file_path: "README.md" }
        }]
      }
    },
    {
      ...baseRecord(toolResultUuid, toolAssistantUuid, PROMPT_AT, SESSION_ID, VERSION),
      type: "user",
      sourceToolAssistantUUID: toolAssistantUuid,
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: toolId,
          is_error: true,
          content: "A recoverable tool error"
        }]
      }
    },
    assistantRecord({
      uuid: finalUuid,
      parentUuid: toolResultUuid,
      messageId: uuid(201),
      text: "Recovered and finished"
    }),
    {
      ...baseRecord(summaryUuid, finalUuid, COMPLETED_AT, SESSION_ID, VERSION),
      type: "system",
      subtype: "stop_hook_summary",
      preventedContinuation: false,
      hookErrors: []
    },
    durationRecord({
      uuid: durationUuid,
      parentUuid: summaryUuid,
      timestamp: COMPLETED_AT
    })
  ]);
  assert.equal(
    resolved.detect(anchor, "Inspect  two spaces")?.text,
    "Recovered and finished"
  );
  assert.equal(
    resolved.detect(anchor, "Inspect two spaces"),
    undefined,
    "the normalized state hash must not make distinct prompt bytes equivalent"
  );

  const unresolved = createFixture(t, 2);
  const unresolvedAnchor = unresolved.capture();
  const unresolvedRecords = turnRecords({
    request: "Unresolved tool",
    assistantText: "Must stay pending",
    sessionId: unresolved.sessionId
  });
  const prompt = unresolvedRecords[0];
  const assistant = unresolvedRecords[1];
  unresolvedRecords.splice(1, 0, {
    ...baseRecord(
      uuid(50),
      prompt.uuid as string,
      PROMPT_AT,
      unresolved.sessionId,
      VERSION
    ),
    type: "assistant",
    message: {
      role: "assistant",
      id: uuid(51),
      stop_reason: "tool_use",
      content: [{
        type: "tool_use",
        id: "toolu_unresolved",
        name: "Bash",
        input: { command: "npm test" }
      }]
    }
  });
  assistant.parentUuid = uuid(50);
  unresolved.write(unresolvedRecords);
  assert.equal(
    unresolved.detect(unresolvedAnchor, "Unresolved tool"),
    undefined
  );
});

test("returns only terminal API errors and ignores transient retry errors", (t) => {
  const terminalError = createFixture(t);
  const terminalAnchor = terminalError.capture();
  terminalError.write([
    userRecord({
      uuid: uuid(1),
      request: "Call Claude",
      timestamp: PROMPT_AT,
      parentUuid: null
    }),
    apiErrorRecord({
      uuid: uuid(2),
      parentUuid: uuid(1),
      text: "API Error: unavailable",
      error: "server_error"
    })
  ]);
  const failure = terminalError.detect(terminalAnchor, "Call Claude");
  assert.equal(failure?.outcome, "failure");
  assert.equal(failure?.metadata?.match, "claude_transcript_api_error");
  assert.equal(failure?.metadata?.error, "server_error");

  const recovered = createFixture(t, 2);
  const recoveredAnchor = recovered.capture();
  const prompt = userRecord({
    uuid: uuid(10),
    request: "Retry successfully",
    timestamp: PROMPT_AT,
    parentUuid: null
  });
  const transient = apiErrorRecord({
    uuid: uuid(11),
    parentUuid: uuid(10),
    text: "Temporary API error",
    error: "overloaded_error"
  });
  const assistant = assistantRecord({
    uuid: uuid(12),
    parentUuid: uuid(11),
    messageId: uuid(120),
    text: "Recovered"
  });
  const duration = durationRecord({
    uuid: uuid(13),
    parentUuid: uuid(12),
    timestamp: COMPLETED_AT
  });
  recovered.write([prompt, transient, assistant, duration]);
  const success = recovered.detect(recoveredAnchor, "Retry successfully");
  assert.equal(success?.outcome, "success");
  assert.equal(success?.text, "Recovered");
});

test("fails closed when an anchored transcript is truncated, replaced, missing, or redirected", (t) => {
  const truncated = createFixture(t);
  truncated.write([{ type: "last-prompt", sessionId: SESSION_ID }]);
  const truncatedAnchor = truncated.capture();
  fs.truncateSync(truncated.transcriptPath, 0);
  assert.throws(
    () => truncated.detect(truncatedAnchor, "Anything"),
    /truncated/u
  );

  const replaced = createFixture(t, 2);
  replaced.write([{ type: "last-prompt", sessionId: replaced.sessionId }]);
  const replacedAnchor = replaced.capture();
  fs.renameSync(replaced.transcriptPath, `${replaced.transcriptPath}.old`);
  replaced.write(turnRecords({
    request: "Replacement",
    assistantText: "Must not complete",
    sessionId: replaced.sessionId
  }));
  assert.throws(
    () => replaced.detect(replacedAnchor, "Replacement"),
    /replaced or rotated/u
  );

  const missing = createFixture(t, 3);
  missing.write([{ type: "last-prompt", sessionId: missing.sessionId }]);
  const missingAnchor = missing.capture();
  fs.unlinkSync(missing.transcriptPath);
  assert.throws(
    () => missing.detect(missingAnchor, "Anything"),
    /disappeared/u
  );

  const redirected = createFixture(t, 4);
  const redirectedAnchor = redirected.capture();
  redirected.write(turnRecords({
    request: "Symlink",
    assistantText: "Must not complete",
    sessionId: redirected.sessionId
  }));
  const realTranscript = `${redirected.transcriptPath}.real`;
  fs.renameSync(redirected.transcriptPath, realTranscript);
  fs.symlinkSync(realTranscript, redirected.transcriptPath);
  assert.throws(
    () => redirected.detect(redirectedAnchor, "Symlink"),
    /non-symlink/u
  );
});

function createFixture(
  t: test.TestContext,
  suffix = 1,
  createProjectsRoot = true
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-transcript-"));
  const claudeHome = path.join(root, ".claude");
  const workspace = path.join(root, `workspace-${suffix}`);
  const sessionId = suffix === 1
    ? SESSION_ID
    : `${String(suffix).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const projectDirectory = path.join(
    claudeHome,
    "projects",
    workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
  fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  if (createProjectsRoot) {
    fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  }
  fs.mkdirSync(workspace, { recursive: true });
  const agentRows: ClaudeAgentRow[] = [{
    pid: PID,
    cwd: workspace,
    kind: "interactive",
    sessionId,
    startedAt: AGENT_STARTED_AT_MS,
    status: "idle"
  }];
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const capture = () => {
    const anchor = captureClaudeTranscriptAnchor({
      sessionId,
      cwd: workspace,
      pid: PID,
      claudeHome,
      agentRows,
      now: new Date(CAPTURED_AT)
    });
    assert.ok(anchor);
    return anchor;
  };
  const writeRaw = (text: string) => {
    fs.writeFileSync(transcriptPath, text, { mode: 0o600 });
    fs.chmodSync(transcriptPath, 0o600);
  };
  const appendRaw = (text: string) => {
    fs.appendFileSync(transcriptPath, text, { mode: 0o600 });
    fs.chmodSync(transcriptPath, 0o600);
  };
  const normalizeRecords = (records: readonly Record<string, unknown>[]) =>
    records.map((record) => ({
      ...record,
      cwd: workspace,
      sessionId
    }));
  const write = (records: readonly Record<string, unknown>[]) =>
    writeRaw(normalizeRecords(records).map(jsonLine).join(""));
  const append = (records: readonly Record<string, unknown>[]) =>
    appendRaw(normalizeRecords(records).map(jsonLine).join(""));
  const detect = (anchor: ClaudeTranscriptAnchor, request: string) =>
    detectClaudeTranscriptCompletion({
      sessionId,
      cwd: workspace,
      requestText: request,
      requestHash: fingerprint(request),
      startedAt: STARTED_AT,
      context: {
        pid: PID,
        sessionId,
        nativeTakeover: {
          claude_transcript_anchor: anchor
        }
      }
    }, {
      claudeHome,
      agentRows
    });
  const detectAcceptance = (anchor: ClaudeTranscriptAnchor, request: string) =>
    detectClaudeTranscriptAcceptance({
      sessionId,
      cwd: workspace,
      requestText: request,
      requestHash: fingerprint(request),
      startedAt: STARTED_AT,
      context: {
        pid: PID,
        sessionId,
        nativeTakeover: {
          claude_transcript_anchor: anchor
        }
      }
    }, {
      claudeHome,
      agentRows
    });
  const observeDead = (
    anchor: ClaudeTranscriptAnchor,
    request: string,
    acceptanceEvidence: unknown
  ) => observeClaudeDeadProcessTranscriptCompletion({
    sessionId,
    cwd: workspace,
    requestText: request,
    requestHash: fingerprint(request),
    startedAt: STARTED_AT,
    context: {
      pid: PID,
      sessionId,
      nativeTakeover: {
        claude_transcript_anchor: anchor
      }
    }
  }, {
    claudeHome,
    agentRows,
    acceptanceEvidence
  });
  const detectPending = (anchor: ClaudeTranscriptAnchor, request: string) =>
    detectClaudeTranscriptPendingApproval({
      sessionId,
      cwd: workspace,
      requestText: request,
      requestHash: fingerprint(request),
      startedAt: STARTED_AT,
      context: {
        pid: PID,
        sessionId,
        nativeTakeover: {
          claude_transcript_anchor: anchor
        }
      }
    }, {
      claudeHome,
      agentRows
    });

  return {
    root,
    claudeHome,
    workspace,
    sessionId,
    projectDirectory,
    transcriptPath,
    agentRows,
    capture,
    write,
    append,
    writeRaw,
    appendRaw,
    normalizeRecords,
    detect,
    detectAcceptance,
    observeDead,
    detectPending
  };
}

function pendingBashRecords({
  request,
  command,
  ids = 700,
  sessionId = SESSION_ID,
  version = VERSION
}: {
  request: string;
  command: string;
  ids?: number;
  sessionId?: string;
  version?: string;
}): Record<string, unknown>[] {
  const promptUuid = uuid(ids);
  const thinkingUuid = uuid(ids + 1);
  const toolUuid = uuid(ids + 2);
  const messageId = uuid(ids + 1000);
  return [
    userRecord({
      uuid: promptUuid,
      request,
      timestamp: PROMPT_AT,
      parentUuid: null,
      sessionId,
      version
    }),
    {
      ...baseRecord(thinkingUuid, promptUuid, PROMPT_AT, sessionId, version),
      type: "assistant",
      message: {
        role: "assistant",
        id: messageId,
        stop_reason: "tool_use",
        content: [{ type: "thinking", thinking: "not returned" }]
      }
    },
    {
      ...baseRecord(toolUuid, thinkingUuid, PROMPT_AT, sessionId, version),
      type: "assistant",
      message: {
        role: "assistant",
        id: messageId,
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: `toolu_pending_${ids}`,
          name: "Bash",
          input: { command }
        }]
      }
    }
  ];
}

function pendingToolBlock(
  records: readonly Record<string, unknown>[]
): Record<string, unknown> {
  const owner = records[2];
  const message = isTestRecord(owner.message) ? owner.message : undefined;
  const content = Array.isArray(message?.content) ? message.content : [];
  const block = content.find((value) =>
    isTestRecord(value) && value.type === "tool_use"
  );
  assert.ok(isTestRecord(block));
  return block;
}

function turnRecords({
  request,
  assistantText,
  ids = 1,
  sessionId = SESSION_ID,
  version = VERSION,
  promptAt = PROMPT_AT,
  completedAt = COMPLETED_AT,
  includeBackgroundTool = false
}: {
  request: string;
  assistantText: string;
  ids?: number;
  sessionId?: string;
  version?: string;
  promptAt?: string;
  completedAt?: string;
  includeBackgroundTool?: boolean;
}): Record<string, unknown>[] {
  const promptUuid = uuid(ids);
  const thinkingUuid = uuid(ids + 1);
  const textUuid = uuid(ids + 2);
  const durationUuid = uuid(ids + 3);
  const messageId = uuid(ids + 1000);
  const records: Record<string, unknown>[] = [
    userRecord({
      uuid: promptUuid,
      request,
      timestamp: promptAt,
      parentUuid: null,
      sessionId,
      version
    })
  ];
  let parentUuid = promptUuid;
  if (includeBackgroundTool) {
    const toolUuid = uuid(ids + 10);
    records.push({
      ...baseRecord(toolUuid, parentUuid, promptAt, sessionId, version),
      type: "assistant",
      message: {
        role: "assistant",
        id: uuid(ids + 1010),
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          name: "Bash",
          input: {
            command: "long-running-test",
            run_in_background: true
          }
        }]
      }
    });
    parentUuid = toolUuid;
  }
  records.push(
    {
      ...baseRecord(thinkingUuid, parentUuid, promptAt, sessionId, version),
      type: "assistant",
      message: {
        role: "assistant",
        id: messageId,
        stop_reason: "end_turn",
        content: [{ type: "thinking", thinking: "not returned" }]
      }
    },
    assistantRecord({
      uuid: textUuid,
      parentUuid: thinkingUuid,
      messageId,
      text: assistantText,
      sessionId,
      version
    }),
    durationRecord({
      uuid: durationUuid,
      parentUuid: textUuid,
      timestamp: completedAt,
      sessionId,
      version
    })
  );
  return records;
}

function userRecord({
  uuid: recordUuid,
  request,
  timestamp,
  parentUuid,
  sessionId = SESSION_ID,
  version = VERSION
}: {
  uuid: string;
  request: string;
  timestamp: string;
  parentUuid: string | null;
  sessionId?: string;
  version?: string;
}): Record<string, unknown> {
  return {
    ...baseRecord(recordUuid, parentUuid, timestamp, sessionId, version),
    type: "user",
    promptId: uuid(Number(recordUuid.slice(-4)) + 5000),
    message: {
      role: "user",
      content: request
    }
  };
}

function assistantRecord({
  uuid: recordUuid,
  parentUuid,
  messageId,
  text,
  sessionId = SESSION_ID,
  version = VERSION
}: {
  uuid: string;
  parentUuid: string;
  messageId: string;
  text: string;
  sessionId?: string;
  version?: string;
}): Record<string, unknown> {
  return {
    ...baseRecord(recordUuid, parentUuid, COMPLETED_AT, sessionId, version),
    type: "assistant",
    message: {
      role: "assistant",
      id: messageId,
      stop_reason: "end_turn",
      content: [{ type: "text", text }]
    }
  };
}

function apiErrorRecord({
  uuid: recordUuid,
  parentUuid,
  text,
  error
}: {
  uuid: string;
  parentUuid: string;
  text: string;
  error: string;
}): Record<string, unknown> {
  return {
    ...baseRecord(recordUuid, parentUuid, COMPLETED_AT, SESSION_ID, VERSION),
    type: "assistant",
    isApiErrorMessage: true,
    error,
    message: {
      role: "assistant",
      id: uuid(9000),
      stop_reason: "stop_sequence",
      content: [{ type: "text", text }]
    }
  };
}

function durationRecord({
  uuid: recordUuid,
  parentUuid,
  timestamp,
  sessionId = SESSION_ID,
  version = VERSION
}: {
  uuid: string;
  parentUuid: string;
  timestamp: string;
  sessionId?: string;
  version?: string;
}): Record<string, unknown> {
  return {
    ...baseRecord(recordUuid, parentUuid, timestamp, sessionId, version),
    type: "system",
    subtype: "turn_duration",
    durationMs: 200
  };
}

function baseRecord(
  recordUuid: string,
  parentUuid: string | null,
  timestamp: string,
  sessionId: string,
  version: string
): Record<string, unknown> {
  return {
    uuid: recordUuid,
    parentUuid,
    isSidechain: false,
    entrypoint: "cli",
    timestamp,
    sessionId,
    version
  };
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fingerprintClaudeAnchor(anchor: ClaudeTranscriptAnchor): string {
  return sha256(JSON.stringify({
    schema: "agent-knock-knock/claude-transcript-acceptance-anchor",
    version: 1,
    session_id: anchor.session_id,
    cwd: anchor.cwd,
    pid: anchor.pid,
    agent_started_at_ms: anchor.agent_started_at_ms,
    captured_at: anchor.captured_at,
    relative_path: anchor.relative_path,
    offset_bytes: anchor.offset_bytes,
    file_existed: anchor.file_existed,
    device: anchor.device ?? null,
    inode: anchor.inode ?? null
  }));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isTestRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
