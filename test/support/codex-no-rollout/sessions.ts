import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../../../src/managed-session.js";
import {
  saveManagedSession
} from "../../../src/session-store.js";
import {
  ensureStoreWritable
} from "../../../src/store.js";
import {
  LIVE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  type NoRolloutFixture,
  processUuid
} from "./model.js";

export function persistStatusCardSession(
  fixture: NoRolloutFixture,
  processBirth: string,
  nativeThreadId = NATIVE_THREAD_ID,
  sessionId = "session-codex-status-card"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, processBirth),
      processBirth,
      evidence: "codex_status_card",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

export function persistExactEndedRolloutSession(
  fixture: NoRolloutFixture,
  sessionId = "session-codex-ended-rollout"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-11T02:36:56.000Z");
  const stat = fs.statSync(fixture.rolloutPath);
  const openRoot = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === NATIVE_THREAD_ID &&
    fs.realpathSync(candidate.rolloutPath) ===
      fs.realpathSync(fixture.rolloutPath)
  );
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: openRoot?.fd ?? "24",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(fixture.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

export function persistDetachedRolloutCompanion(
  fixture: NoRolloutFixture,
  nativeThreadId: string,
  sessionId: string
): ManagedSessionState {
  const root = fixture.openRootRollouts?.find((candidate) =>
    candidate.nativeThreadId === nativeThreadId
  );
  assert.ok(root, `missing fixture rollout for ${nativeThreadId}`);
  const stat = fs.statSync(root.rolloutPath);
  const now = new Date("2026-08-11T02:37:56.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "detached",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId,
      processUuid: processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
      processBirth: LIVE_PROCESS_BIRTH,
      rollout: {
        fd: root.fd,
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(root.rolloutPath)
      },
      evidence: "codex_open_root_rollout",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    detached_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

export function persistConflictSession(
  fixture: NoRolloutFixture,
  options: {
    sessionId: string;
    nativeThreadId?: string;
    processBirth?: string;
  }
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:30:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: options.sessionId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: options.nativeThreadId,
      processUuid: options.processBirth
        ? processUuid(fixture.codexPid, options.processBirth)
        : undefined,
      processBirth: options.processBirth,
      evidence: options.nativeThreadId
        ? "codex_status_card"
        : "raw_terminal_attach",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}
