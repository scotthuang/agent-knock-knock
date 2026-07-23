import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureClaudeTranscriptAnchor,
  detectClaudeTranscriptCompletion,
  type ClaudeTranscriptAnchor
} from "../src/claude-local-transcript-provider.js";
import type { ClaudeAgentRow } from "../src/claude-terminal-agent-adapter.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PID = 42421;
const AGENT_STARTED_AT_MS = 1784870000000;
const VERSION = "2.1.198";
const STARTED_AT = "2026-07-24T02:00:00.000Z";
const CAPTURED_AT = "2026-07-24T02:00:00.100Z";
const PROMPT_AT = "2026-07-24T02:00:00.200Z";
const COMPLETED_AT = "2026-07-24T02:00:00.400Z";

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
    version: "2.2.0"
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
  changedRecords[1].version = "2.1.199";
  changedMidTurn.write(changedRecords);
  assert.throws(
    () => changedMidTurn.detect(changedMidTurnAnchor, "Schema changed mid-turn"),
    /unsupported schema/u
  );

  const multiple = createFixture(t, 5);
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
    detect
  };
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
  return createHash("sha256")
    .update(value.replace(/\s+/gu, " ").trim())
    .digest("hex");
}
