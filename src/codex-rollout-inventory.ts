// Validation of process-bound rollout candidate inventories.
import {
  type CodexOpenRootRolloutIdentity,
  type CodexOpenRootRolloutInventory,
} from "./agent-session-provider.js";
import {
  isRecord,
} from "./codex-rollout-records.js";
import {
  type CodexCandidateSetRolloutAcceptanceAnchor,
  type CodexRolloutIdentity,
  exactNativeThreadId,
  fingerprint,
  normalizedRolloutIdentity,
  requiredString,
} from "./terminal-submission-facts.js";
import path from "node:path";

export function validateCodexOpenRootInventoryForAcceptance(
  value: CodexOpenRootRolloutInventory
): CodexOpenRootRolloutInventory {
  if (
    !isRecord(value) ||
    value.schema !==
      "agent-knock-knock/codex-open-root-rollout-inventory" ||
    value.version !== 1 ||
    !["verified_absent", "resolved", "unbound"].includes(
      String(value.status)
    ) ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 1 ||
    !Array.isArray(value.roots) ||
    value.roots.length > 128 ||
    !/^[0-9a-f]{64}$/u.test(String(value.inventoryFingerprint))
  ) {
    throw new Error("Codex open-root rollout inventory is invalid");
  }
  requiredString(value.processUuid, "Codex process UUID");
  requiredString(value.processBirth, "Codex process birth");
  if (
    value.processUuid !==
      `codex-pid:${value.pid}:birth:${value.processBirth}`
  ) {
    throw new Error("Codex open-root rollout inventory process UUID is inconsistent");
  }
  if (value.cwd !== undefined && !path.isAbsolute(value.cwd)) {
    throw new Error("Codex open-root rollout inventory cwd is not absolute");
  }
  if (
    (value.status === "verified_absent" && value.roots.length !== 0) ||
    (value.status === "resolved" && value.roots.length !== 1) ||
    (
      value.status === "unbound" &&
      (
        value.roots.length < 2 ||
        value.reason !== "multiple_open_root_rollouts"
      )
    )
  ) {
    throw new Error("Codex open-root rollout inventory status is inconsistent");
  }
  const seenThreads = new Set<string>();
  const seenFiles = new Set<string>();
  for (const identity of value.roots) {
    if (!isRecord(identity)) {
      throw new Error("Codex open-root rollout inventory identity is invalid");
    }
    const nativeThreadId = exactNativeThreadId(identity.sessionId);
    if (
      identity.processUuid !== value.processUuid ||
      identity.processBirth !== value.processBirth ||
      identity.evidence !== "codex_open_root_rollout"
    ) {
      throw new Error(
        "Codex open-root rollout inventory has mixed process authority"
      );
    }
    const rollout = normalizedRolloutIdentity(identity.rollout);
    if (
      seenThreads.has(nativeThreadId) ||
      seenFiles.has(`${rollout.device}:${rollout.inode}`)
    ) {
      throw new Error("Codex open-root rollout inventory is ambiguous");
    }
    seenThreads.add(nativeThreadId);
    seenFiles.add(`${rollout.device}:${rollout.inode}`);
  }
  const { status: _status, inventoryFingerprint, reason: _reason, ...authority } =
    value as CodexOpenRootRolloutInventory & { reason?: string };
  if (fingerprint(authority) !== inventoryFingerprint) {
    throw new Error(
      "Codex open-root rollout inventory fingerprint does not match"
    );
  }
  return value;
}

export function validateCodexRecoveryCandidateForAcceptance(
  value: CodexOpenRootRolloutIdentity,
  anchor: CodexCandidateSetRolloutAcceptanceAnchor
): CodexOpenRootRolloutIdentity {
  if (!isRecord(value)) {
    throw new Error("persisted Codex recovery candidate is invalid");
  }
  const sessionId = exactNativeThreadId(value.sessionId);
  const rollout = normalizedRolloutIdentity(value.rollout);
  if (
    value.processUuid !== anchor.process_uuid ||
    value.processBirth !== anchor.process_birth ||
    value.evidence !== "codex_open_root_rollout"
  ) {
    throw new Error(
      "persisted Codex recovery candidate has different process authority"
    );
  }
  return {
    sessionId,
    processUuid: anchor.process_uuid,
    processBirth: anchor.process_birth,
    rollout,
    evidence: "codex_open_root_rollout"
  };
}

export function codexRolloutInodeKey(rollout: CodexRolloutIdentity): string {
  return `${rollout.device}:${rollout.inode}`;
}
