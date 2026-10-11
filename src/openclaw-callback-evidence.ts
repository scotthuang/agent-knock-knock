import { isRecord } from "./value-guards.js";

export interface GatewayDispatchEvidence {
  request_phase: "connection_handshake" | "before_dispatch" | "submitted" | "unknown";
  request_dispatched?: boolean;
  evidence_source: "gateway_transport_error" | "legacy_structured_handshake";
  gateway_error_kind: string;
}

function dispatchMetadata(error: Record<string, unknown>) {
  const flags = ["requestDispatched", "request_dispatched"]
    .filter(key => Object.hasOwn(error, key)).map(key => error[key]);
  const phases = ["phase", "requestPhase", "request_phase"]
    .filter(key => Object.hasOwn(error, key)).map(key => error[key]);
  const knownPhases = ["connection_handshake", "before_dispatch", "submitted", "unknown"];
  if (flags.some(flag => typeof flag !== "boolean") || new Set(flags).size > 1 ||
      phases.some(phase => typeof phase !== "string" || !knownPhases.includes(phase)) || new Set(phases).size > 1) return undefined;
  return { phase: phases[0], dispatched: flags[0], present: flags.length > 0 || phases.length > 0 };
}

/** Parse the CLI's error envelope, never an arbitrary timeout substring.
 * The legacy handshake case adapts the OpenClaw 2026.9.9 CLI contract: its
 * opening handshake precedes hello and the primary RPC; a post-RPC close stops
 * that invocation rather than reconnecting. Unknown shapes remain uncertain.
 */
export function gatewayDispatchEvidence(text: string): GatewayDispatchEvidence | undefined {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(payload) || payload.ok !== false || !isRecord(payload.error)) return undefined;
  const error = payload.error;
  if (error.type !== "gateway_transport_error" || typeof error.kind !== "string" || !["closed", "timeout"].includes(error.kind)) return undefined;
  const unknown: GatewayDispatchEvidence = { request_phase: "unknown", evidence_source: "gateway_transport_error",
    gateway_error_kind: String(error.kind) };
  const metadata = dispatchMetadata(error);
  if (!metadata) return unknown;
  const { phase, dispatched } = metadata;
  if (dispatched === true) return { ...unknown, request_phase: "submitted", request_dispatched: true };
  if (phase === "submitted") return unknown; // Contradiction or missing dispatch evidence.
  if (dispatched === false && phase !== "unknown") return { ...unknown,
    request_phase: phase === "connection_handshake" ? phase : "before_dispatch", request_dispatched: false };
  if (metadata.present) return unknown;
  if (error.kind === "closed" && error.reason === "Opening handshake has timed out") return {
    ...unknown, request_phase: "connection_handshake", request_dispatched: false,
    evidence_source: "legacy_structured_handshake"
  };
  return unknown;
}

/** Only positive evidence for the exact run can settle an uncertain send.
 * A timeout may mean no record OR an active run. Neither proves acceptance.
 * No response bodies, terminal replies, or channel receipts are retained.
 */
export function callbackAcceptanceObservation(text: string, runId: string): "pending" | "ok" | "error" | undefined {
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return undefined; }
  if (!isRecord(payload) || payload.runId !== runId) return undefined;
  if (payload.status === "pending" && payload.timeoutPhase === "queue" && payload.providerStarted === false) return "pending";
  if ((payload.status === "ok" || payload.status === "error") &&
      typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt) && payload.startedAt > 0 &&
      typeof payload.endedAt === "number" && Number.isFinite(payload.endedAt) && payload.endedAt >= payload.startedAt) return payload.status;
  return undefined;
}
