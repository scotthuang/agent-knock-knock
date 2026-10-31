import { recordValue } from "./value-guards.js";

export type CodexFailureStage = "backend_precheck" | "fallback_scan" | "rpc_dispatch";
export type CodexFallbackHealth = "unique_verified" | "no_match" | "multiple_matches" | "not_checked";
export interface CodexDeliveryDiagnostics {
  stage: CodexFailureStage;
  target_thread_id: string | null;
  dispatch_state: "not_sent" | "unknown" | "accepted";
  fallback: CodexFallbackHealth;
  reason: string;
  rpc_method?: string;
  rpc_code?: number;
  recent_list_match?: "matched" | "no_match" | "not_checked";
  recent_list_observed_at?: string;
}
const methods = new Set(["initialize", "thread/read", "thread/loaded/list", "thread/turns/list", "thread/items/list",
  "thread/resume", "turn/start", "turn/steer", "thread/settings/update"]);
const reasons = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "ENOTSOCK", "ETIMEDOUT", "closed", "timeout",
  "unsupported_capability", "thread_not_loaded", "thread_not_idle", "unsupported_thread", "stale_interaction",
  "invalid_response", "invalid_argument", "rpc_error", "pagination_limit", "duplicate_submission",
  "unmaterialized_thread", "unmaterialized_subscription", "no_exact_terminal_alias", "multiple_exact_terminal_aliases",
  "fallback_scan_failed", "backend_check_failed", "codex_native_identity_mismatch", "codex_native_send_pending",
  "codex_native_send_cancelled", "codex_native_submission_turn_conflict"]);
export function codexDiagnosticReason(value: unknown): string {
  return typeof value === "string" && reasons.has(value) ? value : "backend_check_failed";
}
export function codexDiagnosticThread(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{1,160}$/u.test(value) ? value : null;
}

/** Only these fields may cross the RPC/error/diagnostic-cache boundary. Never copy message, data or params. */
export function codexDeliveryDiagnostics(error: unknown, threadId: unknown, stage: CodexFailureStage,
  fallback: CodexFallbackHealth = "not_checked"): CodexDeliveryDiagnostics {
  const raw = recordValue(error) ?? {}, prior = recordValue(raw.diagnostics);
  const method = raw.rpcMethod ?? prior?.rpc_method, code = raw.rpcCode ?? prior?.rpc_code;
  return { stage, target_thread_id: codexDiagnosticThread(threadId),
    dispatch_state: raw.dispatchState === "unknown" || raw.dispatchState === "accepted" ? raw.dispatchState : "not_sent",
    fallback, reason: codexDiagnosticReason(raw.code ?? prior?.reason),
    ...(typeof method === "string" && methods.has(method) ? { rpc_method: method } : {}),
    ...(typeof code === "number" && Number.isSafeInteger(code) ? { rpc_code: code } : {}) };
}

/** Re-project persisted diagnostics too: disk records are not permission to expose arbitrary fields. */
export function parseCodexDeliveryDiagnostics(value: unknown): CodexDeliveryDiagnostics | undefined {
  const row = recordValue(value);
  if (!row || !["backend_precheck", "fallback_scan", "rpc_dispatch"].includes(String(row.stage)) ||
    !["unique_verified", "no_match", "multiple_matches", "not_checked"].includes(String(row.fallback)) ||
    !["not_sent", "unknown", "accepted"].includes(String(row.dispatch_state))) return undefined;
  const result = codexDeliveryDiagnostics({ code: row.reason, dispatchState: row.dispatch_state,
    rpcMethod: row.rpc_method, rpcCode: row.rpc_code }, row.target_thread_id,
  row.stage as CodexFailureStage, row.fallback as CodexFallbackHealth);
  if (["matched", "no_match", "not_checked"].includes(String(row.recent_list_match))) {
    result.recent_list_match = row.recent_list_match as CodexDeliveryDiagnostics["recent_list_match"];
  }
  if (typeof row.recent_list_observed_at === "string" && Number.isFinite(Date.parse(row.recent_list_observed_at))) {
    result.recent_list_observed_at = new Date(row.recent_list_observed_at).toISOString();
  }
  return result;
}

export function codexRecoveryActions(diagnostics?: CodexDeliveryDiagnostics): string[] {
  return diagnostics?.dispatch_state === "unknown" || diagnostics?.dispatch_state === "accepted"
    ? ["check_existing_receipt_before_resend"] : ["refresh_list", "copy_conversation_id_verbatim"];
}
export function codexDeliveryFailureMessage(message: string, diagnostics: CodexDeliveryDiagnostics): string {
  const clue = diagnostics.recent_list_match === "no_match"
    ? ` Supplied ID decoded thread ${diagnostics.target_thread_id} does not match any session in the recent List (${diagnostics.recent_list_observed_at}).` : "";
  const recovery = diagnostics.dispatch_state !== "not_sent"
    ? " Check the existing task receipt/Watch before considering another send; do not resend blindly."
    : " Refresh AKK List and use its conversation_id verbatim; restore the original thread in Codex first if needed.";
  return `${message}${clue}${recovery} Diagnostics: ${JSON.stringify(diagnostics)}`;
}
export class CodexDeliveryError extends Error {
  readonly code: string;
  readonly dispatchState: CodexDeliveryDiagnostics["dispatch_state"];
  constructor(message: string, readonly diagnostics: CodexDeliveryDiagnostics) {
    super(codexDeliveryFailureMessage(message, diagnostics)); this.name = "CodexDeliveryError";
    this.code = diagnostics.reason; this.dispatchState = diagnostics.dispatch_state;
  }
}

export interface CodexRoutingHealth {
  backend: "loaded" | "unavailable" | "check_failed";
  fallback: CodexFallbackHealth;
  check_depth: "discovery" | "snapshot";
  observed_at: string;
  last_failure: ({ observed_at: string } & CodexDeliveryDiagnostics) | null;
  recovery_actions: string[];
}
/** A missing terminal alias does not downgrade a working native route. Health never authorizes input. */
export function codexRoutingHealth(backend: CodexRoutingHealth["backend"], checkDepth: CodexRoutingHealth["check_depth"],
  observedAt: string, lastFailure: CodexRoutingHealth["last_failure"] = null): CodexRoutingHealth {
  return { backend, fallback: "not_checked", check_depth: checkDepth, observed_at: observedAt, last_failure: lastFailure,
    recovery_actions: lastFailure ? codexRecoveryActions(lastFailure) : backend === "loaded" ? [] : codexRecoveryActions() };
}

export function compactCodexRoutingHealth(value: unknown): CodexRoutingHealth | undefined {
  const row = recordValue(value);
  if (!row || !["loaded", "unavailable", "check_failed"].includes(String(row.backend)) ||
    !["discovery", "snapshot"].includes(String(row.check_depth)) ||
    !["unique_verified", "no_match", "multiple_matches", "not_checked"].includes(String(row.fallback)) ||
    typeof row.observed_at !== "string" || !Number.isFinite(Date.parse(row.observed_at))) return undefined;
  const failure = recordValue(row.last_failure), safe = parseCodexDeliveryDiagnostics(failure);
  const lastFailure = safe && typeof failure?.observed_at === "string" && Number.isFinite(Date.parse(failure.observed_at))
    ? { ...safe, observed_at: new Date(failure.observed_at).toISOString() } : null;
  return { ...codexRoutingHealth(row.backend as CodexRoutingHealth["backend"], row.check_depth as CodexRoutingHealth["check_depth"],
    new Date(row.observed_at).toISOString(), lastFailure), fallback: row.fallback as CodexFallbackHealth };
}
