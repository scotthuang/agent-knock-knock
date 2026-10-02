import type { ExecutorKind } from "./executors.js";
import type { ActiveTerminalProcess, TerminalControlRef } from
  "./terminal-agent-adapter.js";
import type { TerminalListTerminalFacts } from "./terminal-list-facts.js";
import { renderTerminalPermissionControlActions } from "./terminal-list-renderer.js";
import { terminalPermissionControlAvailability } from
  "./terminal-permission-control-availability.js";
import { terminalPermissionControlProfileFor } from
  "./terminal-permission-control.js";

export function permissionControlCapability(agent: ExecutorKind, version?: string) {
  const profile = agent === "codex" && version
    ? terminalPermissionControlProfileFor(version)
    : undefined;
  return profile
    ? {
        status: "supported",
        agentVersion: profile.agentVersion,
        behaviorProfile: profile.behaviorProfile,
        scope: profile.scope
      }
    : {
        status: "unsupported",
        reason: "No verified native permission-control profile for this agent version."
      };
}

/** Project existing fresh List facts without another terminal read or identity guess. */
export function renderPermissionControlListActions(input: {
  session: ActiveTerminalProcess;
  terminalControl: TerminalControlRef;
  facts: TerminalListTerminalFacts;
  renderedActions: Record<string, unknown>;
}): Record<string, unknown> {
  const { facts, session } = input;
  return renderTerminalPermissionControlActions({
    renderedActions: input.renderedActions,
    availability: terminalPermissionControlAvailability({
      exactTerminalRow: true,
      terminalId: facts.physical.terminalId,
      processState: "active",
      agent: session.agent,
      pid: session.pid,
      terminalControl: input.terminalControl,
      processUuid: facts.physical.processIncarnation?.processUuid,
      processBirth: facts.physical.processIncarnation?.processBirth,
      agentVersion: facts.runtime.agentVersion,
      approvalScanned: facts.status.projected.approval_state.scanned === true,
      approvalBlocked: facts.status.projected.approval_state.blocked === true,
      terminalHasInteraction: facts.status.hasInteraction,
      terminalHasBlockingTurn: facts.store.terminalHasBlockingTurn,
      hasOrphanedDispatch: facts.store.hasOrphanedDispatch,
      inputOwnerBlocked: facts.composer.inputOwnerBlocked,
      exactEmptyComposer: facts.composer.automatedInputComposerReady,
      screenState: facts.status.projected.screen_state,
      activityState: facts.status.projected.activity_state
    })
  });
}
