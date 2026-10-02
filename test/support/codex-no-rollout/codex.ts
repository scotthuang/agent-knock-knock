import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  CodexLocalSessionAdapter
} from "../../../src/codex-local-session-provider.js";
import type {
  CodexOpenRootRolloutInventory
} from "../../../src/agent-session-provider.js";
import {
  inspectCodexOpenRootRolloutInventory
} from "../../../src/codex-store-adapter.js";
import type {
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateRequest,
  TerminalThreadLifecycleCandidateToken
} from "../../../src/terminal-agent-adapter.js";
import {
  NATIVE_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  codexTestComposerScreen,
  type NoRolloutFixture,
  processUuid
} from "./model.js";
import {
  test
} from "./test-registration.js";
import {
  appendNativeAcceptance
} from "./rollouts.js";

export function fixtureProcessSnapshots(fixture: NoRolloutFixture) {
  const panePid = fixture.terminalControl.panePid;
  const workspace = fixture.terminalControl.currentPath;
  return [
    {
      pid: panePid,
      ppid: 1,
      command: "zsh",
      cwd: workspace,
      elapsed: "00:10"
    },
    {
      pid: fixture.codexPid,
      ppid: panePid,
      command:
        `/opt/akk-test/releases/${fixture.codexVersion}-aarch64-apple-darwin/bin/codex`,
      cwd: workspace,
      elapsed: "00:09"
    }
  ];
}

export function createFixtureCodexAdapter(
  fixture: NoRolloutFixture
): CodexLocalSessionAdapter {
  return {
    async listThreadRows() {
      if (!fixture.persistedCandidate) {
        return [];
      }
      return [{
        id: NATIVE_THREAD_ID,
        cwd: fixture.terminalControl.currentPath,
        rollout_path: fixture.rolloutPath,
        updated_at_ms: 1_786_000_000_000,
        archived: 0
      }];
    },
    async readRollout(rolloutPath) {
      return fs.existsSync(rolloutPath)
        ? fs.readFileSync(rolloutPath, "utf8")
        : undefined;
    },
    async listProcessSnapshots() {
      return fixtureProcessSnapshots(fixture);
    },
    ...(fixture.openRootRollouts !== undefined
      ? {
          async inspectOpenRootRolloutInventoryForPid(pid: number, cwd?: string) {
            assert.equal(pid, fixture.codexPid);
            return fixtureCodexOpenRootInventory(fixture, cwd);
          }
        }
      : {}),
    async resolveActiveSessionIdentityForPid(
      pid,
      cwd,
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    ) {
      assert.equal(pid, fixture.codexPid);
      if (fixture.identityObservationError) {
        throw new Error(fixture.identityObservationError);
      }
      if (fixture.openRootRollouts !== undefined) {
        const inventory = fixtureCodexOpenRootInventory(fixture, cwd);
        const roots = inventory.roots;
        if (roots.length === 0) {
          return undefined;
        }
        if (!preferredSessionId) {
          if (roots.length !== 1) {
            throw new Error(
              `fixture Codex process has ${roots.length} ambiguous open roots`
            );
          }
          return roots[0];
        }
        const preferred = roots.find((root) =>
          root.sessionId === preferredSessionId
        );
        const allowed = [
          allowedCompanionIdentity,
          ...(allowedAdditionalIdentities ?? [])
        ].flatMap((candidate) => candidate ? [candidate] : []);
        const exactAllowed = roots.filter((root) => allowed.some((candidate) =>
          candidate.sessionId === root.sessionId &&
          candidate.processUuid === root.processUuid &&
          candidate.processBirth === root.processBirth &&
          candidate.rollout?.fd === root.rollout.fd &&
          candidate.rollout?.device === root.rollout.device &&
          candidate.rollout?.inode === root.rollout.inode &&
          candidate.rollout?.path === root.rollout.path
        ));
        if (roots.some((root) => root !== preferred && !exactAllowed.includes(root))) {
          throw new Error("fixture Codex process has an unexpected open root");
        }
        if (preferred) {
          return preferred;
        }
        if (exactAllowed[0]) {
          return exactAllowed[0];
        }
        throw new Error("fixture Codex preferred open root is unavailable");
      }
      const probeCount = fs.existsSync(fixture.rolloutProbeCountPath)
        ? Number(fs.readFileSync(fixture.rolloutProbeCountPath, "utf8"))
        : 0;
      const nextProbeCount = probeCount + 1;
      fs.writeFileSync(fixture.rolloutProbeCountPath, String(nextProbeCount));
      if (fixture.materializeRolloutOnProbe === nextProbeCount) {
        fs.writeFileSync(fixture.materializedPath, "ready");
      }
      if (!fs.existsSync(fixture.materializedPath)) {
        return undefined;
      }
      if (
        fixture.appendAcceptanceOnProbe === nextProbeCount &&
        fixture.deferredAcceptanceRequest
      ) {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          fixture.deferredAcceptanceRequest,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date().toISOString()
          }
        );
        fs.appendFileSync(
          fixture.activeRolloutPath,
          `${JSON.stringify({
            timestamp: "2026-08-06T00:00:02.000Z",
            type: "event_msg",
            payload: {
              type: "task_complete",
              turn_id: FIRST_NATIVE_TURN_ID,
              last_agent_message: "Recovered exact result"
            }
          })}\n`
        );
        fs.writeFileSync(
          fixture.screenPath,
          `Recovered exact result\n${codexTestComposerScreen()}`
        );
        fixture.appendAcceptanceOnProbe = undefined;
      }
      const processBirth = fs.readFileSync(
        fixture.processBirthPath,
        "utf8"
      ).trim();
      const stat = fs.statSync(fixture.activeRolloutPath);
      return {
        sessionId: fixture.activeNativeThreadId,
        processUuid: processUuid(pid, processBirth),
        processBirth,
        rollout: {
          fd: "12u",
          device: String(stat.dev),
          inode: String(stat.ino),
          path: fs.realpathSync(fixture.activeRolloutPath)
        },
        evidence: "open_rollout_fd"
      };
    }
  };
}

export function fixtureCodexOpenRootInventory(
  fixture: NoRolloutFixture,
  cwd = String(fixture.terminalControl.currentPath)
): CodexOpenRootRolloutInventory {
  const records = [`p${fixture.codexPid}`];
  for (const root of fixture.openRootRollouts ?? []) {
    const rolloutPath = fs.realpathSync(root.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    records.push(
      `f${root.fd}`,
      "tREG",
      `D${stat.dev}`,
      `i${stat.ino}`,
      `n${rolloutPath}`
    );
  }
  return inspectCodexOpenRootRolloutInventory({
    codexHome: fixture.codexHome,
    pid: fixture.codexPid,
    cwd,
    processBirth: fs.readFileSync(
      fixture.processBirthPath,
      "utf8"
    ).trim(),
    lsofOutput: `${records.join("\n")}\n`
  });
}

export function createFixtureLifecycleProvider(
  fixture: NoRolloutFixture
): TerminalThreadLifecycleCandidateProvider {
  const currentCandidate = (
    request: TerminalThreadLifecycleCandidateRequest
  ): TerminalThreadLifecycleCandidate | undefined => {
    if (
      !fixture.persistedCandidate ||
      path.resolve(request.cwd) !==
        path.resolve(String(fixture.terminalControl.currentPath))
    ) {
      return undefined;
    }
    const rolloutPath = fs.realpathSync(fixture.rolloutPath);
    const stat = fs.statSync(rolloutPath);
    const fileToken = {
      path: rolloutPath,
      device: String(stat.dev),
      inode: String(stat.ino),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
    const metadataFingerprint = createHash("sha256")
      .update(JSON.stringify({
        nativeThreadId: NATIVE_THREAD_ID,
        cwd: path.resolve(String(fixture.terminalControl.currentPath)),
        originator: "codex-tui",
        source: "cli",
        cliVersion: fixture.codexVersion,
        modelProvider: null,
        rolloutPath
      }))
      .digest("hex");
    const candidateToken = {
      schema: "agent-knock-knock/thread-candidate-token" as const,
      version: 1 as const,
      agent: "codex" as const,
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: path.resolve(String(fixture.terminalControl.currentPath)),
      source: "codex_rollout" as const,
      agentVersion: request.agentVersion,
      fileToken,
      metadataFingerprint
    };
    return {
      agent: "codex",
      nativeThreadId: NATIVE_THREAD_ID,
      cwd: candidateToken.cwd,
      source: "codex_rollout",
      rootInteractive: true,
      fileToken,
      agentVersion: request.agentVersion,
      sourceAgentVersion: fixture.codexVersion,
      updatedAtMs: 1_786_000_000_000,
      metadataFingerprint,
      candidateToken
    };
  };
  return {
    async listThreadLifecycleCandidates(request) {
      const candidate = currentCandidate(request);
      return candidate ? [candidate] : [];
    },
    async revalidateThreadLifecycleCandidate(candidateOrToken, request) {
      const current = currentCandidate(request);
      if (!current) {
        return { status: "unavailable", reason: "fixture candidate unavailable" };
      }
      const supplied = "candidateToken" in candidateOrToken
        ? candidateOrToken.candidateToken
        : candidateOrToken as TerminalThreadLifecycleCandidateToken;
      return JSON.stringify(supplied) === JSON.stringify(current.candidateToken)
        ? { status: "valid", candidate: current }
        : { status: "changed", reason: "fixture candidate token changed" };
    }
  };
}
