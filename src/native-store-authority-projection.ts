import { nonBlankString, recordValue } from "./value-guards.js";

type Row = Record<string, unknown>;
const readActions = new Set(["status", "watch", "list_resumable_threads"]);
const readCapabilities = new Set(["status", "watch", "list_resumable_threads", "interaction_notify"]);

function readOnlyActions(value: unknown): Row {
  return Object.fromEntries(Object.entries(recordValue(value) ?? {}).filter(([name]) =>
    readActions.has(name)));
}

function readOnlyManagedRecord(value: unknown): unknown {
  const record = recordValue(value);
  if (!record) return value;
  return { ...record, ...(record.actionable !== undefined ? { actionable: false } : {}), ...(record.available_actions ? {
    available_actions: readOnlyActions(record.available_actions)
  } : {}) };
}

function readOnlyManagement(value: unknown): Row | undefined {
  const managed = recordValue(value);
  if (!managed) return undefined;
  return { ...managed,
    ...(managed.current_turn ? { current_turn: readOnlyManagedRecord(managed.current_turn) } : {}),
    ...(managed.recent_turn ? { recent_turn: readOnlyManagedRecord(managed.recent_turn) } : {}),
    ...(Array.isArray(managed.history) ? { history: managed.history.map(readOnlyManagedRecord) } : {}) };
}

/** Apply a verified Store conflict after ordinary action selection, including physical Send overrides. */
export function withNativeStoreAuthorityConflict(row: Row, authorityValue: unknown, recoveryActions: Row = {}): Row {
  const authority = recordValue(authorityValue);
  if (!authority || !["conflict", "transferring"].includes(String(authority.state))) return row;
  const send = authority.send_after_transfer === true ? recordValue(recordValue(row.available_actions)?.send) : undefined;
  const capabilities = Object.fromEntries(Object.entries(recordValue(row.capabilities) ?? {})
    .map(([key, value]) => [key, readCapabilities.has(key) ? value : false]));
  const { handoff_decision: _handoff, send_blocked_reason: _sendBlocked, ...safe } = row;
  const managed = readOnlyManagement(row.managed);
  return { ...safe, management_state: "conflict", native_store_authority: authority,
    management_conflict: { code: "native_thread_store_authority", ...authority },
    next_action: recoveryActions.transfer_store_authority ? "transfer_store_authority" : send ? "send" : "inspect_store_authority",
    ...(recordValue(row.interaction_hint) ? { interaction_hint: { ...recordValue(row.interaction_hint), actionable: false } } : {}),
    ...(row.interaction_state ? { interaction_state: Array.isArray(row.interaction_state)
      ? row.interaction_state.map(readOnlyManagedRecord) : readOnlyManagedRecord(row.interaction_state) } : {}),
    ...(!send ? { send_blocked_reason: authority.reason ?? "native_thread_store_authority" } : {}),
    capabilities: { ...capabilities, send: Boolean(send), transfer_store_authority: Boolean(recoveryActions.transfer_store_authority) },
    available_actions: { ...readOnlyActions(row.available_actions), ...(send ? { send } : {}), ...recoveryActions },
    ...(managed ? { managed } : {}) };
}

/** Keep authority fingerprints private while publishing the independently authorized transfer offer. */
export function projectNativeStoreAuthority(terminal: Row, observationValue: unknown, mutationsAllowed: boolean): Row {
  const observation = recordValue(observationValue);
  if (!observation || !["conflict", "transferring"].includes(String(observation.state))) return terminal;
  const authority: Row = { state: observation.state, reason: observation.reason,
    source_store_dir: observation.sourceStoreDir, session_id: observation.sessionId,
    generation: observation.generation, owner_status: observation.ownerStatus,
    transfer_eligible: observation.transferEligible === true,
    automatic_eligible: observation.automaticEligible === true,
    send_after_transfer: observation.automaticEligible === true && mutationsAllowed &&
      !terminal.management_conflict && !terminal.management_unavailable &&
      !["conflict", "unavailable"].includes(String(terminal.management_state)) &&
      Boolean(recordValue(recordValue(terminal.available_actions)?.send)) };
  const fingerprint = nonBlankString(observation.fingerprint);
  const id = nonBlankString(terminal.id ?? terminal.conversation_id);
  const recovery = mutationsAllowed && observation.transferEligible === true && fingerprint && id
    ? { transfer_store_authority: { tool: "agent_knock_knock_reconcile_binding", requires_user_intent: true,
        ...(observation.ownerStatus === "legacy" ? { missing_required: ["maintenance_acknowledgement"] } : {}),
        arguments: { operation: "transfer_store_authority", terminal_id: id, expected_authority_token: fingerprint } } }
    : {};
  return withNativeStoreAuthorityConflict(terminal, authority, recovery);
}
