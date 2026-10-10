import path from "node:path";
import { parseCodexNativeConversationId } from "./codex-native-identity.js";
import { formatTerminalConversationId, parseTerminalConversationId } from "./terminal-agent-adapter.js";

type Row = Record<string, unknown>;
export interface ConversationRoutingIdentityOptions {
  /** @deprecated A configured scan home is not physical process evidence and is ignored. */
  defaultCodexHome?: string;
}
export interface ConversationRouteAssociation {
  terminalId: string;
  nativeId: string;
  threadId: string;
  codexHome: string;
  evidence: "resolved_native_identity" | "visible_status_card" | "closed_status_inspection";
}
type RejectedProof = { status: "unavailable" | "conflict" | "ambiguous"; reason: string };
export type ConversationRouteProof = { status: "exact"; association: ConversationRouteAssociation } | RejectedProof;
interface TerminalIdentity { terminalId: string; threadId: string; codexHome: string; evidence: ConversationRouteAssociation["evidence"] }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Legacy terminal IDs name the same exact provider, agent, endpoint and process. */
export function canonicalTerminalRouteId(value: string): string {
  const identity = parseTerminalConversationId(value);
  if (!identity) throw new Error("Invalid exact terminal route identity");
  return formatTerminalConversationId(identity);
}

export function terminalRouteIdsMatch(left: unknown, right: string): boolean {
  if (typeof left !== "string") return false;
  try { return canonicalTerminalRouteId(left) === canonicalTerminalRouteId(right); }
  catch { return false; }
}

/** Link only fresh physical identity evidence. A same-cwd or resume command match never participates. */
export function associateConversationRoutes(terminals: readonly Row[], nativeRows: readonly Row[],
  options: ConversationRoutingIdentityOptions = {}) {
  const associations: ConversationRouteAssociation[] = [];
  const unassociated: Array<{ terminalId: string; reason: string }> = [];
  for (const terminal of terminals) {
    const identity = terminalIdentity(terminal, options);
    const terminalId = text(terminal.id) ?? text(terminal.terminal_id) ?? "";
    if ("status" in identity) { unassociated.push({ terminalId, reason: identity.reason }); continue; }
    const candidates = nativeRows.flatMap(row => {
      const id = liveNativeId(row);
      if (!id) return [];
      const proof = proveIdentity(id, identity);
      return proof.status === "exact" ? [proof.association] : [];
    });
    if (candidates.length === 1) associations.push(candidates[0]);
    else unassociated.push({ terminalId, reason: candidates.length ? "ambiguous_native_identity" : "matching_loaded_backend_not_found" });
  }
  return { associations, unassociated };
}

/** Native-offline fallback still requires the exact fresh terminal thread and home.
 * This proves identity only; dispatch certainty and terminal input safety remain separate gates.
 */
export function proveNativeTerminalRoute(nativeId: string, terminal: Row,
  options: ConversationRoutingIdentityOptions = {}): ConversationRouteProof {
  const identity = terminalIdentity(terminal, options);
  return "status" in identity ? identity : proveIdentity(nativeId, identity);
}

/** Multiple exact aliases are useful for List but cannot select a fallback terminal implicitly. */
export function resolveNativeTerminalRoute(nativeId: string, terminals: readonly Row[],
  options: ConversationRoutingIdentityOptions = {}): ConversationRouteProof {
  const matches = terminals.map(terminal => proveNativeTerminalRoute(nativeId, terminal, options))
    .filter((proof): proof is Extract<ConversationRouteProof, { status: "exact" }> => proof.status === "exact");
  if (matches.length === 1) return matches[0];
  return { status: matches.length ? "ambiguous" : "unavailable",
    reason: matches.length ? "multiple_exact_terminal_aliases" : "no_exact_terminal_alias" };
}

/** The closed inspection transaction is internal evidence, never a user-supplied routing hint. */
export function withClosedStatusInspection(before: Row, after: Row, observation: Row): Row {
  const beforeId = liveTerminalId(before), afterId = liveTerminalId(after);
  if (typeof beforeId !== "string" || typeof afterId !== "string" || !terminalRouteIdsMatch(beforeId, afterId)) {
    throw new Error("Native status inspection lost its exact terminal identity; no task input was sent");
  }
  for (const key of ["pid", "native_agent_process_uuid", "native_agent_process_birth"]) {
    if (before[key] !== after[key]) throw new Error("Native status inspection changed terminal process incarnation; no task input was sent");
  }
  const threadId = uuid(observation.native_thread_id);
  if (observation.status !== "observed" || observation.inspection !== "status" || observation.agent !== "codex" ||
    !terminalRouteIdsMatch(observation.terminal_id, beforeId) || !threadId) {
    throw new Error("Native status inspection did not prove the exact selected Codex thread; no task input was sent");
  }
  const row = { ...after, _routing_inspection_thread_id: threadId };
  const proof = currentThreadIdentity(row);
  if ("status" in proof || proof.evidence !== "closed_status_inspection") {
    throw new Error("Native status inspection conflicted with current terminal identity or readiness; no task input was sent");
  }
  return row;
}

function terminalIdentity(terminal: Row, options: ConversationRoutingIdentityOptions): TerminalIdentity | RejectedProof {
  const terminalId = liveTerminalId(terminal);
  if (typeof terminalId !== "string") return terminalId;
  const home = terminalHome(terminal, options);
  if (typeof home !== "string") return home;
  const thread = currentThreadIdentity(terminal);
  return "status" in thread ? thread : { terminalId, codexHome: home, ...thread };
}

function currentThreadIdentity(terminal: Row): Pick<TerminalIdentity, "threadId" | "evidence"> | RejectedProof {
  const nativeId = uuid(terminal.native_agent_session_id), cardId = uuid(terminal.native_agent_status_card_session_id);
  const inspected = uuid(terminal._routing_inspection_thread_id);
  const conflict = threadIdentityConflict(nativeId, cardId, inspected);
  if (conflict) return conflict;
  const ready = terminal.activity_state === "idle" && record(terminal.approval_state)?.blocked !== true;
  if (inspected && ready) return { threadId: inspected, evidence: "closed_status_inspection" };
  const observation = record(terminal.native_agent_identity_observation);
  const resolved = observation?.status === "resolved" || !observation && terminal.native_identity_state === "resolved";
  if (nativeId && resolved) return { threadId: nativeId, evidence: "resolved_native_identity" };
  if (cardId && ready) return { threadId: cardId, evidence: "visible_status_card" };
  return unavailable("current_native_thread_identity_missing");
}

function threadIdentityConflict(nativeId?: string, cardId?: string, inspected?: string): RejectedProof | undefined {
  if (nativeId && cardId && nativeId !== cardId) return { status: "conflict", reason: "native_identity_status_card_conflict" };
  if (inspected && [nativeId, cardId].some(id => id !== undefined && id !== inspected)) {
    return { status: "conflict", reason: "native_identity_inspection_conflict" };
  }
  return undefined;
}

function liveTerminalId(terminal: Row): string | RejectedProof {
  const terminalId = text(terminal.id) ?? text(terminal.terminal_id);
  if (terminal.agent !== "codex" || terminal.process_state !== "active" || !terminalId?.startsWith("terminal:")) {
    return unavailable("not_a_live_codex_terminal");
  }
  if (!Number.isSafeInteger(terminal.pid) || Number(terminal.pid) < 2 ||
    !text(terminal.native_agent_process_uuid) || !text(terminal.native_agent_process_birth)) {
    return unavailable("physical_process_incarnation_missing");
  }
  return terminalId;
}

function terminalHome(terminal: Row, _options: ConversationRoutingIdentityOptions): string | RejectedProof {
  const supplied = [terminal.codex_home, terminal.native_agent_codex_home, terminal._codex_home].filter(value => value !== undefined);
  const homes = supplied.map(normalizeHome);
  if (homes.some(home => home === undefined)) return unavailable("invalid_codex_home_evidence");
  const unique = [...new Set(homes)];
  if (unique.length > 1) return { status: "conflict", reason: "codex_home_evidence_conflict" };
  const home = unique[0];
  return home ?? unavailable("codex_home_evidence_missing");
}

function proveIdentity(nativeId: string, identity: TerminalIdentity): ConversationRouteProof {
  let native;
  try { native = parseCodexNativeConversationId(nativeId); }
  catch { return unavailable("invalid_native_conversation_id"); }
  if (native.codexHome !== identity.codexHome || uuid(native.threadId) !== identity.threadId) {
    return { status: "conflict", reason: "native_terminal_identity_mismatch" };
  }
  return { status: "exact", association: { ...identity, nativeId, threadId: native.threadId } };
}
function liveNativeId(row: Row): string | undefined {
  if (row.agent !== "codex" || row.source !== "codex_cli" || row.connection_state !== "loaded_backend_verified") return undefined;
  const id = text(row.conversation_id) ?? text(row.id);
  if (!id) return undefined;
  try {
    const identity = parseCodexNativeConversationId(id);
    return uuid(row.native_thread_id) === uuid(identity.threadId) ? id : undefined;
  } catch { return undefined; }
}
function normalizeHome(value: unknown): string | undefined { return typeof value === "string" && path.isAbsolute(value) ? path.resolve(value) : undefined; }
function uuid(value: unknown): string | undefined { return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function record(value: unknown): Row | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function unavailable(reason: string): RejectedProof { return { status: "unavailable", reason }; }
