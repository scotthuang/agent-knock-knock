import type { ExecutorKind } from "./executors.js";

export interface NativeIdentityFacts {
  sessionId: string;
  processUuid?: string; processBirth?: string;
  rollout?: { fd: string; device: string; inode: string; path: string };
  evidence: string;
}

export interface ProcessIncarnationFacts {
  processUuid: string; processBirth: string;
}

export interface CodexCompanionIdentityFacts extends ProcessIncarnationFacts {
  sessionId: string;
  rollout: { fd: string; device: string; inode: string; path: string };
}

export interface CodexCompanionSetFacts {
  primary?: CodexCompanionIdentityFacts; additional: CodexCompanionIdentityFacts[];
}

export function exactLifecycleIdentity(input: {
  agent: ExecutorKind; pid: number; identity: NativeIdentityFacts;
  codexIncarnation?: ProcessIncarnationFacts;
}): NativeIdentityFacts {
  if (input.agent === "claude") {
    if (!input.identity.processUuid) {
      throw new Error(`Claude lifecycle process incarnation is unavailable for pid ${input.pid}`);
    }
    return input.identity;
  }
  const processBirth = input.identity.processBirth ??
    input.codexIncarnation?.processBirth;
  if (processBirth === undefined) {
    throw new Error(`cannot verify Codex process incarnation for pid ${input.pid}`);
  }
  return {
    ...input.identity,
    processBirth,
    processUuid: input.identity.processUuid ?? input.codexIncarnation?.processUuid ??
      `codex-pid:${input.pid}:birth:${processBirth}`
  };
}

export function codexCompanionSet(input: { primary?: CodexCompanionIdentityFacts;
  candidates: readonly CodexCompanionIdentityFacts[] }): CodexCompanionSetFacts {
  const selectedPrimary = input.primary ?? input.candidates[0];
  if (!selectedPrimary) {
    return { additional: [] };
  }
  const primaryKey = JSON.stringify(selectedPrimary);
  const seen = new Set([primaryKey]);
  const additional = [input.primary, ...input.candidates].filter(
    (candidate): candidate is CodexCompanionIdentityFacts => {
      if (!candidate) {
        return false;
      }
      const key = JSON.stringify(candidate);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }
  );
  return { primary: selectedPrimary, additional };
}

export function verifiedEmptySourceSnapshotMatches(input: {
  expectedStatus: "bound" | "detached"; currentStatus: string;
  expectedRevision?: number; currentRevision?: number;
  expectedBindingToken: string; currentBindingToken: string;
}): boolean {
  return input.currentStatus === input.expectedStatus &&
    input.currentRevision === input.expectedRevision &&
    input.currentBindingToken === input.expectedBindingToken;
}
