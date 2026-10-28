import { parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { exactClaudeTerminal } from "./claude-conversation-routing-identity.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { nonBlankString, recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
export type ClaudeManagedSendRoute = { kind: "native" } | { kind: "managed"; terminal: Row }
  | { kind: "blocked"; reason: string };

/** Preserve physical proof while applying Store eligibility from that scan's public action projection. */
export function withClaudeManagedSendAuthority(raw: Row, projected: Row | undefined, writable: boolean): Row {
  const automaticTransfer = recordValue(projected?.native_store_authority)?.send_after_transfer === true;
  const blocked = !projected || !automaticTransfer && (["conflict", "unavailable"].includes(String(projected.management_state))
    || Boolean(projected.management_conflict || projected.management_unavailable));
  const authority = Object.fromEntries(["native_store_authority", "management_state", "management_conflict", "management_unavailable"]
    .filter(key => projected?.[key] !== undefined).map(key => [key, projected![key]]));
  return { ...raw, ...authority, available_actions: projected?.available_actions ?? {},
    ...(raw.agent === "claude" ? { _claude_managed_send_eligible: raw._claude_managed_send_eligible === true && writable && !blocked } : {}) };
}

function controlledClaudeTerminal(row: Row): boolean {
  const control = recordValue(row.terminal_control);
  return row.agent === "claude" && row.process_state === "active"
    && parseTerminalConversationId(String(row.id))?.agent === "claude"
    && Array.isArray(control?.capabilities) && control.capabilities.includes("send_keys");
}

/** A current physical offer already includes process, input-owner and questionnaire checks. */
export function claudeUserExplicitTerminalSendOffer(row: Row): Row | undefined {
  const approval = recordValue(row.approval_state);
  const authority = recordValue(row.native_store_authority);
  if (!controlledClaudeTerminal(row) || approval?.scanned !== true || approval.blocked !== false
    || recordValue(row.physical_send_readiness)?.ready === false
    || ["conflict", "transferring"].includes(String(authority?.state))) return undefined;
  const send = recordValue(recordValue(row.available_actions)?.send);
  const args = recordValue(send?.arguments);
  return send?.tool === "agent_knock_knock_send" && send.scope === "terminal_user_explicit"
    && (args?.selector ?? args?.terminal_id) === row.id && nonBlankString(args?.expected_terminal_token)
    ? send : undefined;
}

/** The physical Send token remains required; managed execution must never fall back to an unmanaged send. */
export function claudeManagedTerminalSendBlockReason(row: Row): string | undefined {
  if (!controlledClaudeTerminal(row)) return "terminal_control_unavailable";
  const identity = recordValue(row.native_agent_identity_observation);
  if ((identity?.status ?? row.native_identity_state) !== "resolved"
    || !nonBlankString(row.native_agent_session_id)) return "terminal_identity_unresolved";
  const approval = recordValue(row.approval_state);
  if (row.activity_state !== "idle" || approval?.scanned !== true || approval.blocked !== false) return "terminal_busy_or_blocked";
  const readiness = recordValue(row.managed_send_readiness);
  if (readiness?.ready === false && nonBlankString(readiness.reason)) return String(readiness.reason);
  if (row._claude_managed_send_eligible !== true) return "terminal_managed_send_unavailable";
  const send = recordValue(recordValue(row.available_actions)?.send);
  const args = recordValue(send?.arguments);
  if (send?.tool !== "agent_knock_knock_send" || !nonBlankString(args?.expected_terminal_token)) return "terminal_send_unavailable";
  return undefined;
}

/** Absence permits native Send. A discovered physical counterpart with conflicting identity or state does not. */
export function claudeManagedSendRoute(nativeId: string, terminals: readonly Row[]): ClaudeManagedSendRoute {
  const native = parseClaudeNativeConversationId(nativeId);
  const candidates = terminals.filter(row => row.pid === native.pid && controlledClaudeTerminal(row));
  if (candidates.length === 0) return { kind: "native" };
  if (candidates.length !== 1) return { kind: "blocked", reason: "terminal_identity_ambiguous" };
  const terminal = candidates[0];
  if (!exactClaudeTerminal(nativeId, terminal)) return { kind: "blocked", reason: "terminal_identity_conflict" };
  const reason = claudeManagedTerminalSendBlockReason(terminal);
  return reason ? { kind: "blocked", reason } : { kind: "managed", terminal };
}
