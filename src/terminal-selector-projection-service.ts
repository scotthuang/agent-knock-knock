import { resolveExecutor } from "./protocol.js";
import type { SessionSelectorCandidate } from "./session-selector.js";
import { parseProcessElapsedSeconds } from "./terminal-process-facts.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

interface SelectorAction {
  [field: string]: unknown;
}

export interface TerminalSelectorEntry {
  agent?: string;
  available_actions?: unknown;
  command?: unknown;
  created_at?: unknown;
  cwd?: unknown;
  elapsed?: unknown;
  executor?: unknown;
  id?: unknown;
  managed?: unknown;
  process_state?: unknown;
  request?: unknown;
  source?: unknown;
  status?: unknown;
  updated_at?: unknown;
  workspace?: unknown;
  [field: string]: unknown;
}

export interface TerminalSelectorProjectionPolicy {
  isActiveStatus(status: string): boolean;
}

function managedTurnCanEnterApprovalPath(
  entry: TerminalSelectorEntry,
  policy: TerminalSelectorProjectionPolicy
): boolean {
  const executor = isRecord(entry.executor) ? entry.executor : undefined;
  return (
    entry.source === "managed_turn" &&
    executor?.transport === "tmux" &&
    policy.isActiveStatus(String(entry.status))
  );
}

function actionForCommand(
  entry: TerminalSelectorEntry,
  commandName: string,
  policy: TerminalSelectorProjectionPolicy
): SelectorAction | undefined {
  const actions = isRecord(entry.available_actions)
    ? entry.available_actions
    : {};
  const actionName = commandName === "retry-callback"
    ? "retry_callback"
    : commandName;
  if (isRecord(actions[actionName])) {
    return actions[actionName];
  }
  if (commandName !== "approve") {
    return undefined;
  }
  if (managedTurnCanEnterApprovalPath(entry, policy)) {
    return {
      tool: "agent_knock_knock_approve",
      arguments: { conversation_id: String(entry.id) }
    };
  }
  const managed = isRecord(entry.managed) ? entry.managed : undefined;
  const currentTurn = isRecord(managed?.current_turn)
    ? managed.current_turn
    : undefined;
  if (
    currentTurn &&
    managedTurnCanEnterApprovalPath(currentTurn, policy)
  ) {
    return {
      tool: "agent_knock_knock_approve",
      arguments: {
        conversation_id: String(
          currentTurn.conversation_id ?? currentTurn.id
        )
      }
    };
  }
  return undefined;
}

function actionTargetId(action: SelectorAction | undefined): string | undefined {
  const actionArguments = isRecord(action?.arguments)
    ? action.arguments
    : undefined;
  return stringValue(
    actionArguments?.session_id ??
      actionArguments?.turn_id ??
      actionArguments?.selector ??
      actionArguments?.conversation_id
  );
}

function entryRecency(
  entry: TerminalSelectorEntry,
  observedAtMs: number
): { updatedAtMs?: number } {
  const timestamp = Date.parse(String(
    entry.updated_at ?? entry.created_at ?? ""
  ));
  if (Number.isFinite(timestamp)) {
    return { updatedAtMs: timestamp };
  }
  const elapsedSeconds = parseProcessElapsedSeconds(entry.elapsed);
  return elapsedSeconds === undefined
    ? {}
    : { updatedAtMs: observedAtMs - elapsedSeconds * 1000 };
}

export function projectSessionSelectorCandidate(
  entry: TerminalSelectorEntry,
  commandName: string,
  observedAtMs: number,
  {
    defaultActionable,
    mutationsAllowed
  }: {
    defaultActionable: boolean;
    mutationsAllowed: boolean;
  },
  policy: TerminalSelectorProjectionPolicy
): SessionSelectorCandidate {
  const action = mutationsAllowed || commandName === "status"
    ? actionForCommand(entry, commandName, policy)
    : undefined;
  const targetId = actionTargetId(action);
  return {
    id: String(entry.id),
    ...(targetId && targetId !== entry.id ? { targetId } : {}),
    agent: resolveExecutor({ kind: entry.agent }).kind,
    actionable: action !== undefined,
    defaultActionable,
    ...entryRecency(entry, observedAtMs),
    source: stringValue(entry.source),
    status: stringValue(entry.status ?? entry.process_state),
    workspace: stringValue(entry.workspace ?? entry.cwd),
    label: stringValue(entry.request ?? entry.command)
  };
}
