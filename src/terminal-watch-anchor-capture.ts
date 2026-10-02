/** Capture native Watch anchors without weakening backend identity checks. */
import { isCodexPaginatedReadCandidate } from "./codex-lifecycle-compatibility.js";
import { createHash } from "node:crypto";
import { CodexLegacyThreadHistoryError } from "./codex-paginated-observation.js";
import type { CodexPaginatedTaskAnchor } from "./codex-paginated-task.js";
import { capturePaginatedWatchAnchor as capturePaginatedAnchor } from "./codex-paginated-watch.js";
import { selectCodexUserExplicitSendWatchSource } from "./terminal-send-watch-policy.js";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import {
  captureClaudeTranscriptAnchor,
  captureClaudeHumanStartedActiveTaskAnchor
} from "./claude-local-transcript-provider.js";
import type { ExecutorKind } from "./executors.js";
import {
  captureCodexCandidateSetRolloutAcceptanceAnchor,
  captureCodexRolloutAcceptanceAnchor,
  captureCodexHumanStartedActiveTaskAnchor
} from "./terminal-submission-acceptance.js";
import {
  createClaudeUserExplicitFallbackWatchAnchor,
  createCodexUserExplicitFallbackWatchAnchor,
  type TerminalWatchAnchor,
  type UserExplicitFallbackWatchAnchor
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  TerminalWatchCliDependencies,
  TerminalWatchCliFacade
} from "./terminal-watch-cli-contract.js";
import {
  terminalControlForWatch,
  codexIdentity,
  terminalWorkspace,
  requiredString,
  positiveInteger
} from "./terminal-watch-terminal-identity.js";

export function watchAnchorVersionWarnings(
  anchor: TerminalWatchAnchor,
  terminal: Record<string, unknown>
): string[] {
  const runningVersion = stringValue(terminal.agent_version);
  if (!runningVersion) {
    return [
      "running_agent_version_unavailable: exact task observation remains enabled"
    ];
  }
  const artifactVersion = anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
    ? anchor.codex_version
    : anchor.schema ===
        "agent-knock-knock/claude-human-started-active-task-anchor"
      ? anchor.claude_version
      : undefined;
  if (!artifactVersion) return [];
  if (artifactVersion !== runningVersion) {
    return [
      `the active task artifact reports ${artifactVersion}, not the running ` +
      `coding-agent version ${runningVersion}; Watch remains enabled because ` +
      "version evidence is advisory"
    ];
  }
  return [];
}

export async function captureCodexFallbackWatchAnchor(
  input: Parameters<TerminalWatchCliFacade["prepareUserExplicitFallbackWatch"]>[0],
  rawTerminal: Record<string, unknown>, agentVersion: string, dependencies: TerminalWatchCliDependencies
): Promise<UserExplicitFallbackWatchAnchor | CodexPaginatedTaskAnchor> {
      let inventory = rawTerminal._codex_open_root_rollout_inventory;
      let paginated: CodexPaginatedTaskAnchor | undefined;
      if (isCodexPaginatedReadCandidate(agentVersion)) {
        try {
          paginated = await capturePaginatedWatchAnchor(rawTerminal, input.options, dependencies,
            input.requestText === undefined ? input.requestHash
              : createHash("sha256").update(input.requestText.replace(/\r\n?/gu, "\n").trim()).digest("hex"));
        } catch (error) {
          if (!(error instanceof CodexLegacyThreadHistoryError) || !isRecord(inventory) || !Array.isArray(inventory.roots)) throw error;
          const roots = inventory.roots.filter((root: CodexOpenRootRolloutInventory["roots"][number]) => root.sessionId === error.threadId);
          if (roots.length !== 1) throw error;
          inventory = { ...inventory, roots };
        }
      }
      const source = selectCodexUserExplicitSendWatchSource({
        agentVersion,
        legacyRootCount: isRecord(inventory) && Array.isArray(inventory.roots) ? inventory.roots.length : 0,
        paginatedAnchorAvailable: paginated !== undefined
      });
      if (source.source === "none") throw new Error(source.warning);
      if (paginated) {
        return paginated;
      } else {
      const acceptanceAnchor = isRecord(inventory)
        ? captureCodexCandidateSetRolloutAcceptanceAnchor({
            inventory: inventory as unknown as CodexOpenRootRolloutInventory,
            now: dependencies.now()
          })
        : captureCodexRolloutAcceptanceAnchor({
            nativeThreadId: requiredString(
              rawTerminal.native_agent_session_id,
              "Codex native thread id"
            ),
            processUuid: requiredString(
              rawTerminal.native_agent_process_uuid,
              "Codex process UUID"
            ),
            processBirth: requiredString(
              rawTerminal.native_agent_process_birth,
              "Codex process birth"
            ),
            mode: "existing",
            rollout: codexIdentity(rawTerminal).rollout!,
            now: dependencies.now()
          });
      return createCodexUserExplicitFallbackWatchAnchor({
        acceptanceAnchor,
        requestHash: input.requestHash,
        codexVersion: agentVersion
      });
      }

}

export function captureClaudeFallbackWatchAnchor(
  input: Parameters<TerminalWatchCliFacade["prepareUserExplicitFallbackWatch"]>[0],
  rawTerminal: Record<string, unknown>, agentVersion: string, dependencies: TerminalWatchCliDependencies
): UserExplicitFallbackWatchAnchor {
      const transcriptAnchor = captureClaudeTranscriptAnchor({
        sessionId: requiredString(
          rawTerminal.native_agent_session_id,
          "Claude native session id"
        ),
        cwd: terminalWorkspace(rawTerminal),
        pid: positiveInteger(rawTerminal.pid, "Claude PID"),
        claudeHome: stringValue(input.options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(
          input.options,
          { required: true }
        ),
        now: dependencies.now()
      });
      if (!transcriptAnchor) {
        throw new Error(
          "Claude transcript anchor is unavailable before terminal input"
        );
      }
      return createClaudeUserExplicitFallbackWatchAnchor({
        transcriptAnchor,
        requestHash: input.requestHash,
        claudeVersion: agentVersion
      });

}

async function capturePaginatedWatchAnchor(
  terminal: Record<string, unknown>, options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies, requestHash?: string
): Promise<CodexPaginatedTaskAnchor | undefined> {
  const bridge = dependencies.createBridge?.(options);
  if (dependencies.capturePaginatedAnchor) {
    return dependencies.capturePaginatedAnchor({ terminal, bridge: bridge!, requestHash,
      codexHome: stringValue(options.codexHome), now: dependencies.now });
  }
  if (!bridge) throw new Error("Codex paginated terminal inspection is unavailable");
  return capturePaginatedAnchor({ terminal, bridge, requestHash,
    codexHome: stringValue(options.codexHome), now: dependencies.now });
}

export async function capturePaginatedWatchAnchorWithLock(
  terminal: Record<string, unknown>, options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<CodexPaginatedTaskAnchor | undefined> {
  const release = dependencies.acquireTerminalLock(
    dependencies.storeDirFromOptions(options), terminalControlForWatch(terminal)
  );
  try { return await capturePaginatedWatchAnchor(terminal, options, dependencies); }
  finally { release(); }
}

export function captureTerminalWatchAnchor(
  agent: ExecutorKind,
  terminal: Record<string, unknown>,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): TerminalWatchAnchor | undefined {
  if (agent === "codex") {
    return captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity: codexIdentity(terminal),
      now: dependencies.now()
    });
  }
  return captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: requiredString(
      terminal.native_agent_session_id,
      "Claude native session id"
    ),
    cwd: terminalWorkspace(terminal),
    pid: positiveInteger(terminal.pid, "Claude PID"),
    claudeHome: stringValue(options.claudeHome),
    agentRows: dependencies.loadClaudeAgentRows(options, { required: true }),
    now: dependencies.now()
  });
}
