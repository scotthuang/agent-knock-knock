import fs from "node:fs";
import path from "node:path";
import {
  NATIVE_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  codexTestComposerScreen,
  type NoRolloutFixture
} from "./model.js";

export function readTmuxCalls(
  filePath: string
): Array<{ args: string[]; at?: number }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function appendNativeAcceptance(
  rolloutPath: string,
  request: string,
  turnId: string,
  metadata: {
    nativeThreadId: string;
    workspace: string;
    codexVersion: string;
    timestamp: string;
  }
): void {
  if (!request) {
    return;
  }
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: metadata.timestamp,
      type: "session_meta",
      payload: {
        id: metadata.nativeThreadId,
        cwd: metadata.workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: metadata.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  const records = [
    {
      timestamp: "2026-08-06T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId }
    },
    {
      timestamp: "2026-08-06T00:00:01.010Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    }
  ];
  fs.appendFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
  );
}

export function enableFixtureCandidateInventory(
  fixture: NoRolloutFixture,
  nativeThreadIds: string[]
): void {
  fixture.openRootRollouts = [];
  for (const nativeThreadId of nativeThreadIds) {
    ensureFixtureCandidateRollout(fixture, nativeThreadId);
  }
}

export function ensureFixtureCandidateRollout(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  materializedAt = new Date().toISOString()
): string {
  const existing = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  if (existing) {
    return existing.rolloutPath;
  }
  const rolloutPath = nativeThreadId === NATIVE_THREAD_ID
    ? fixture.rolloutPath
    : path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-12T00-00-00-${nativeThreadId}.jsonl`
      );
  if (!fs.existsSync(rolloutPath)) {
    fs.mkdirSync(path.dirname(rolloutPath), {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: materializedAt,
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: fixture.terminalControl.currentPath,
        originator: "codex-tui",
        source: "cli",
        cli_version: fixture.codexVersion
      }
    })}\n`, { mode: 0o600 });
  }
  fixture.openRootRollouts?.push({
    nativeThreadId,
    rolloutPath,
    fd: `${12 + (fixture.openRootRollouts?.length ?? 0)}u`
  });
  return rolloutPath;
}

export function appendFixtureCompletion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  text = "Candidate rollout completed exactly once."
): void {
  const rolloutPath = ensureFixtureCandidateRollout(
    fixture,
    nativeThreadId
  );
  fs.appendFileSync(rolloutPath, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: FIRST_NATIVE_TURN_ID,
      last_agent_message: text
    }
  })}\n`);
  fs.writeFileSync(
    fixture.screenPath,
    `${text}\n${codexTestComposerScreen()}`
  );
}
