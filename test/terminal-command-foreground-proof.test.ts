import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexForegroundProofAuthority,
  type CodexForegroundProofAssertion
} from "../src/terminal-command-foreground-proof.js";
import type { CodexForegroundIdentificationProof } from
  "../src/native-thread-lifecycle-cli-adapter.js";
import type { TerminalAgentAdapterRegistry } from
  "../src/terminal-agent-adapter.js";

const proof: CodexForegroundIdentificationProof = {
  terminalId: "terminal:v2:tmux:codex:demo:0.0:42",
  pid: 42,
  processUuid: "process-42",
  processBirth: "birth-42",
  realCwd: "/private/tmp",
  nativeThreadId: "thread-1",
  agentVersion: "0.154.0",
  behaviorProfile: "codex-0.154.0",
  evidenceFingerprint: "evidence-1",
  postProbeScreenDigest: "screen-1",
  observationScrollbackLines: 240,
  observedAt: "2026-09-15T00:00:00.000Z",
  expiresAt: "2026-09-15T00:01:00.000Z",
  terminalSubmission: {
    command: "/status",
    enterCount: 1,
    materialization: {
      kind: "exact_slash_composer",
      digest: "materialized-1",
      stableForMs: 80,
      stableCaptures: 2
    }
  }
};

function fixture(overrides: {
  nowMs?: number;
  processUuid?: string;
  observationFingerprint?: string;
} = {}) {
  const authority = createCodexForegroundProofAuthority({
    nowMs: () => overrides.nowMs ?? Date.parse("2026-09-15T00:00:30.000Z"),
    processIncarnationForPid: () => ({
      processUuid: overrides.processUuid ?? "process-42",
      processBirth: "birth-42",
      evidence: "process_birth"
    }),
    createRegistry: () => ({
      require: () => ({
        observeNativeInspection: () => ({
          status: "observed",
          nativeThreadId: "thread-1",
          evidenceFingerprint:
            overrides.observationFingerprint ?? "evidence-1"
        })
      })
    }) as unknown as TerminalAgentAdapterRegistry
  });
  const options: Record<string, unknown> = { identifyForeground: true };
  const assertion: CodexForegroundProofAssertion = {
    options,
    executor: { kind: "codex", display_name: "Codex" } as never,
    terminalControl: {
      kind: "tmux",
      target: "demo:0.0",
      session: "demo",
      window: 0,
      pane: 0,
      panePid: 42,
      currentPath: "/private/tmp",
      capabilities: []
    },
    terminalAgentPid: 42,
    status: {
      reachable: true,
      screen: { digest: "screen-1", excerpt: "status fixture" }
    } as CodexForegroundProofAssertion["status"]
  };
  return { authority, options, assertion };
}

test("foreground proof is object-bound, clearable, and never inferred", () => {
  const { authority, options, assertion } = fixture();
  assert.throws(
    () => authority.assertCurrent(assertion),
    /proof is unavailable; no task input was sent/u
  );
  authority.remember(options, proof);
  assert.equal(authority.current(options), proof);
  assert.doesNotThrow(() => authority.assertCurrent(assertion));
  assert.equal(authority.current({ identifyForeground: true }), undefined);
  authority.clear(options);
  assert.equal(authority.current(options), undefined);
});

test("foreground proof rejects expiry, process, screen, and identity drift", () => {
  const expired = fixture({
    nowMs: Date.parse("2026-09-15T00:01:00.000Z")
  });
  expired.authority.remember(expired.options, proof);
  assert.throws(
    () => expired.authority.assertCurrent(expired.assertion),
    /proof expired before task dispatch/u
  );

  const processDrift = fixture({ processUuid: "process-new" });
  processDrift.authority.remember(processDrift.options, proof);
  assert.throws(
    () => processDrift.authority.assertCurrent(processDrift.assertion),
    /process incarnation changed/u
  );

  const screenDrift = fixture();
  screenDrift.authority.remember(screenDrift.options, proof);
  assert.throws(
    () => screenDrift.authority.assertCurrent({
      ...screenDrift.assertion,
      status: {
        ...screenDrift.assertion.status,
        screen: { digest: "screen-new", excerpt: "status fixture" }
      }
    }),
    /screen generation changed/u
  );

  const identityDrift = fixture({ observationFingerprint: "evidence-new" });
  identityDrift.authority.remember(identityDrift.options, proof);
  assert.throws(
    () => identityDrift.authority.assertCurrent(identityDrift.assertion),
    /\/status identity changed/u
  );
});

test("foreground proof is irrelevant unless atomic mode was requested", () => {
  const { authority, assertion } = fixture();
  assert.doesNotThrow(() => authority.assertCurrent({
    ...assertion,
    options: {}
  }));
});
