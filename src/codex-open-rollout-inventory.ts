import {
  createHash
} from "node:crypto";
import fs from "node:fs";

import path from "node:path";

import {
  CodexTransientDuplicateOpenRootDescriptorsError,
  type ActiveAgentSessionIdentity,
  type CodexOpenRootRolloutIdentity,
  type CodexOpenRootRolloutInventory
} from "./agent-session-provider.js";

import {
  codexThreadUsesLegacyRollout
} from "./codex-session-provider.js";

/** Exact open-file inventory. A cwd match alone never establishes process ownership. */
export const MAX_CODEX_OPEN_ROOT_ROLLOUTS = 128;

export interface LsofOpenFileRecord {
  fd?: string;
  type?: string;
  device?: string;
  inode?: string;
  path?: string;
}

export function parseLsofOpenFiles(text: string): LsofOpenFileRecord[] {
  const records: LsofOpenFileRecord[] = [];
  let current: LsofOpenFileRecord | undefined;
  const flush = () => {
    if (current) {
      records.push(current);
    }
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("f")) {
      flush();
      current = { fd: line.slice(1) };
    } else if (current && line.startsWith("t")) {
      current.type = line.slice(1);
    } else if (current && line.startsWith("D")) {
      current.device = line.slice(1);
    } else if (current && line.startsWith("i")) {
      current.inode = line.slice(1);
    } else if (current && line.startsWith("n")) {
      current.path = line.slice(1);
    }
  }
  flush();
  return records;
}

export function resolveCodexOpenRolloutIdentity({
  codexHome,
  pid,
  cwd,
  preferredSessionId,
  allowedCompanionIdentity,
  allowedAdditionalIdentities,
  processBirth,
  lsofOutput
}: {
  codexHome: string;
  pid: number;
  cwd?: string;
  preferredSessionId?: string;
  allowedCompanionIdentity?: ActiveAgentSessionIdentity;
  allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[];
  processBirth: string;
  lsofOutput: string;
}): ActiveAgentSessionIdentity | undefined {
  const inventory = inspectCodexOpenRootRolloutInventory({
    codexHome,
    pid,
    cwd,
    processBirth,
    lsofOutput
  });
  return selectCodexOpenRolloutIdentity({
    inventory,
    preferredSessionId,
    allowedCompanionIdentity,
    allowedAdditionalIdentities
  });
}

export function inspectCodexOpenRootRolloutInventory({
  codexHome,
  pid,
  cwd,
  processBirth,
  lsofOutput
}: {
  codexHome: string;
  pid: number;
  cwd?: string;
  processBirth: string;
  lsofOutput: string;
}): CodexOpenRootRolloutInventory {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processBirth.trim()) {
    throw new Error("Codex rollout inventory requires an exact process incarnation");
  }
  const rolloutFiles = parseLsofOpenFiles(lsofOutput).filter((openFile) => {
    if (!openFile.path) {
      return false;
    }
    const openPath = openFile.path.replace(/\s+\(deleted\)$/u, "");
    return /^rollout-.*\.jsonl$/u.test(path.basename(openPath));
  });
  if (rolloutFiles.length > MAX_CODEX_OPEN_ROOT_ROLLOUTS) {
    throw new Error(
      `Codex process ${pid} has too many open rollout files to inspect safely`
    );
  }
  const processUuid = `codex-pid:${pid}:birth:${processBirth}`;
  const expectedCwd = cwd ? path.resolve(cwd) : undefined;
  // An absent sessions directory is only evidence of a virgin process when
  // lsof also reported no rollout descriptor at all. Once a rollout FD exists,
  // every descriptor and every root/subagent classification must be verified.
  if (rolloutFiles.length === 0) {
    return codexOpenRootRolloutInventoryResult({
      pid,
      processUuid,
      processBirth,
      cwd: expectedCwd,
      roots: []
    });
  }

  const configuredSessionsRoot = path.join(codexHome, "sessions");
  let sessionsRoot: string;
  try {
    sessionsRoot = fs.realpathSync(configuredSessionsRoot);
  } catch {
    throw new Error(
      `Codex process ${pid} has open rollout files but CODEX_HOME/sessions is unavailable`
    );
  }
  const identities: CodexOpenRootRolloutIdentity[] = [];
  for (const openFile of rolloutFiles) {
    const openPath = openFile.path!;
    const descriptorPath = openPath.replace(/\s+\(deleted\)$/u, "");
    const lexicalRelative = path.relative(
      path.resolve(configuredSessionsRoot),
      path.resolve(descriptorPath)
    );
    if (
      !lexicalRelative ||
      lexicalRelative.startsWith("..") ||
      path.isAbsolute(lexicalRelative)
    ) {
      throw new Error(
        `Codex process ${pid} has an open rollout outside CODEX_HOME/sessions`
      );
    }
    if (
      openFile.type !== "REG" ||
      !openFile.fd ||
      !openFile.device ||
      !openFile.inode ||
      /\s+\(deleted\)$/u.test(openPath)
    ) {
      throw new Error(
        `Codex process ${pid} has an unverifiable open rollout descriptor`
      );
    }
    let realPath: string;
    try {
      realPath = fs.realpathSync(descriptorPath);
    } catch {
      throw new Error(
        `Codex process ${pid} has an unreadable open rollout descriptor`
      );
    }
    const relative = path.relative(sessionsRoot, realPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Codex process ${pid} has an open rollout outside CODEX_HOME/sessions`
      );
    }
    const expectedDevice = parseLsofInteger(openFile.device);
    const expectedInode = parseLsofInteger(openFile.inode);
    const metadata = readCodexSessionMetadata(
      descriptorPath,
      expectedDevice,
      expectedInode,
      pid
    );
    let confirmedRealPath: string;
    try {
      confirmedRealPath = fs.realpathSync(descriptorPath);
    } catch {
      throw new Error(
        `Codex process ${pid} has an unreadable open rollout descriptor`
      );
    }
    if (confirmedRealPath !== realPath) {
      throw new Error(
        `Codex process ${pid} rollout path changed while it was being verified`
      );
    }
    const filenameSessionId = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu
      .exec(path.basename(descriptorPath))?.[1];
    if (!metadata || metadata.id !== filenameSessionId) {
      throw new Error(
        `Codex process ${pid} has invalid rollout session metadata`
      );
    }
    if (
      typeof metadata.source === "object" &&
      metadata.source !== null &&
      "subagent" in metadata.source
    ) {
      continue;
    }
    if (
      metadata.originator !== "codex-tui" ||
      metadata.source !== "cli" ||
      (expectedCwd && path.resolve(metadata.cwd) !== expectedCwd)
    ) {
      throw new Error(
        `Codex process ${pid} has an indeterminate open root rollout`
      );
    }
    identities.push({
      sessionId: metadata.id,
      processUuid,
      processBirth,
      rollout: {
        fd: openFile.fd,
        device: openFile.device,
        inode: openFile.inode,
        path: confirmedRealPath
      },
      evidence: "codex_open_root_rollout"
    });
  }
  if (identities.length === 0) {
    throw new Error(
      `Codex process ${pid} has open rollout files but no exact TUI root identity`
    );
  }
  identities.sort((left, right) =>
    left.sessionId.localeCompare(right.sessionId) ||
    left.rollout.path.localeCompare(right.rollout.path) ||
    left.rollout.fd.localeCompare(right.rollout.fd)
  );
  const duplicateDisposition = classifyCodexOpenRootDuplicates(identities);
  if (duplicateDisposition === "transient_exact_descriptor_duplicate") {
    throw new CodexTransientDuplicateOpenRootDescriptorsError(pid);
  }
  if (duplicateDisposition === "conflicting_identity") {
    throw new Error(
      `Codex process ${pid} has duplicate open root rollout identities`
    );
  }
  return codexOpenRootRolloutInventoryResult({
    pid,
    processUuid,
    processBirth,
    cwd: expectedCwd,
    roots: identities
  });
}

export type CodexOpenRootDuplicateDisposition =
  | "none"
  | "transient_exact_descriptor_duplicate"
  | "conflicting_identity";

export function classifyCodexOpenRootDuplicates(
  identities: readonly CodexOpenRootRolloutIdentity[]
): CodexOpenRootDuplicateDisposition {
  let exactDescriptorDuplicate = false;
  for (let leftIndex = 0; leftIndex < identities.length; leftIndex += 1) {
    const left = identities[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < identities.length;
      rightIndex += 1
    ) {
      const right = identities[rightIndex];
      const sameSession = left.sessionId === right.sessionId;
      const sameFile =
        left.rollout.device === right.rollout.device &&
        left.rollout.inode === right.rollout.inode;
      if (!sameSession && !sameFile) {
        continue;
      }
      const exactRolloutWithDistinctDescriptors =
        sameSession &&
        sameFile &&
        left.processUuid === right.processUuid &&
        left.processBirth === right.processBirth &&
        left.rollout.path === right.rollout.path &&
        left.rollout.fd !== right.rollout.fd;
      if (!exactRolloutWithDistinctDescriptors) {
        return "conflicting_identity";
      }
      exactDescriptorDuplicate = true;
    }
  }
  return exactDescriptorDuplicate
    ? "transient_exact_descriptor_duplicate"
    : "none";
}

export function codexOpenRootRolloutInventoryResult({
  pid,
  processUuid,
  processBirth,
  cwd,
  roots
}: {
  pid: number;
  processUuid: string;
  processBirth: string;
  cwd?: string;
  roots: CodexOpenRootRolloutIdentity[];
}): CodexOpenRootRolloutInventory {
  const authority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid,
    processUuid,
    processBirth,
    ...(cwd ? { cwd } : {}),
    roots
  };
  const inventoryFingerprint = createHash("sha256")
    .update(JSON.stringify(authority))
    .digest("hex");
  if (roots.length === 0) {
    return {
      ...authority,
      status: "verified_absent",
      roots: [],
      inventoryFingerprint
    };
  }
  if (roots.length === 1) {
    return {
      ...authority,
      status: "resolved",
      roots: [roots[0]],
      inventoryFingerprint
    };
  }
  return {
    ...authority,
    status: "unbound",
    reason: "multiple_open_root_rollouts",
    inventoryFingerprint
  };
}

export function selectCodexOpenRolloutIdentity({
  inventory,
  preferredSessionId,
  allowedCompanionIdentity,
  allowedAdditionalIdentities
}: {
  inventory: CodexOpenRootRolloutInventory;
  preferredSessionId?: string;
  allowedCompanionIdentity?: ActiveAgentSessionIdentity;
  allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[];
}): ActiveAgentSessionIdentity | undefined {
  const pid = inventory.pid;
  const identities: ActiveAgentSessionIdentity[] = inventory.roots;
  if (identities.length === 0) {
    return undefined;
  }
  if (preferredSessionId) {
    const preferred = identities.filter((identity) =>
      identity.sessionId === preferredSessionId
    );
    if (preferred.length > 1) {
      throw new Error(
        `Codex process ${pid} has multiple open root rollouts for preferred ` +
        `session ${preferredSessionId}`
      );
    }
    if (allowedCompanionIdentity) {
      const allowedConstraints = [
        allowedCompanionIdentity,
        ...(allowedAdditionalIdentities ?? [])
      ];
      const allowedMatches: ActiveAgentSessionIdentity[] = [];
      for (const constraint of allowedConstraints) {
        const matches = identities.filter((identity) =>
          sameActiveCodexIdentity(identity, constraint)
        );
        if (matches.length > 1) {
          throw new Error(
            `Codex process ${pid} has multiple open root rollouts for an ` +
            "allowed companion session"
          );
        }
        if (matches[0] && !allowedMatches.includes(matches[0])) {
          allowedMatches.push(matches[0]);
        }
      }
      const unexpected = identities.filter((identity) =>
        identity !== preferred[0] && !allowedMatches.includes(identity)
      );
      if (unexpected.length > 0) {
        throw new Error(
          `Codex process ${pid} has an unexpected open root rollout outside ` +
          "the preferred and exact companion identities"
        );
      }
      if (preferred.length === 1) {
        return preferred[0];
      }
      const primaryCompanion = identities.find((identity) =>
        sameActiveCodexIdentity(identity, allowedCompanionIdentity)
      );
      if (primaryCompanion) {
        return primaryCompanion;
      }
      if (allowedMatches.length > 0) {
        // The immediately preceding rollout can close while an older,
        // independently verified managed ancestor remains open. Constraint
        // order is authoritative and deterministic; unknown roots were
        // rejected above, so the first surviving exact companion is safe
        // process-incarnation evidence for a fresh status-card proof.
        return allowedMatches[0];
      }
      throw new Error(
        `Codex process ${pid} has neither the preferred session nor an ` +
        "exact managed companion rollout open"
      );
    } else if (preferred.length === 1 && identities.length === 1) {
      return preferred[0];
    } else {
      throw new Error(
        `Codex process ${pid} does not have the preferred session as its ` +
        "sole open root rollout"
      );
    }
  }
  if (identities.length !== 1) {
    throw new Error(
      `Codex process ${pid} has ${identities.length} open root rollout files; ` +
      "the foreground native session is ambiguous"
    );
  }
  return identities[0];
}

export function sameActiveCodexIdentity(
  left: ActiveAgentSessionIdentity,
  right: ActiveAgentSessionIdentity
): boolean {
  return Boolean(
    left.sessionId === right.sessionId &&
    left.processUuid === right.processUuid &&
    left.processBirth === right.processBirth &&
    left.rollout?.fd === right.rollout?.fd &&
    left.rollout?.device === right.rollout?.device &&
    left.rollout?.inode === right.rollout?.inode &&
    left.rollout?.path === right.rollout?.path
  );
}

export function parseLsofInteger(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return -1n;
  }
}

export function readCodexSessionMetadata(
  filePath: string,
  expectedDevice: bigint,
  expectedInode: bigint,
  pid: number
): {
  id: string;
  cwd: string;
  originator: string;
  source: unknown;
} | undefined {
  let fd: number;
  try {
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
  } catch {
    throw new Error(
      `Codex process ${pid} has an unreadable open rollout descriptor`
    );
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.dev !== expectedDevice ||
      stat.ino !== expectedInode
    ) {
      throw new Error(
        `Codex process ${pid} rollout descriptor no longer matches its file`
      );
    }
    const buffer = Buffer.alloc(1024 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0 && bytesRead === buffer.length) {
      throw new Error(`Codex session metadata line is too large: ${filePath}`);
    }
    const parsed = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    const payload = parsed?.type === "session_meta" ? parsed.payload : undefined;
    if (
      typeof payload?.id !== "string" ||
      typeof payload?.cwd !== "string" ||
      typeof payload?.originator !== "string" ||
      !codexThreadUsesLegacyRollout(payload)
    ) {
      return undefined;
    }
    return {
      id: payload.id,
      cwd: payload.cwd,
      originator: payload.originator,
      source: payload.source
    };
  } finally {
    fs.closeSync(fd);
  }
}
