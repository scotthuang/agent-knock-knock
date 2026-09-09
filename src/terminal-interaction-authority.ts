import type {
  TerminalInteractionAgent,
  TerminalInteractionResponseAuthority,
  TerminalInteractionSubject
} from
  "./terminal-interaction-protocol.js";

export const TERMINAL_INTERACTION_AUTHORITY_SCHEMA =
  "agent-knock-knock/terminal-interaction-authority" as const;
export const TERMINAL_INTERACTION_AUTHORITY_VERSION = 1 as const;
export const TERMINAL_INTERACTION_SUBJECT_AUTHORITY_VERSION = 2 as const;

export type TerminalInteractionAuthorityState =
  | "durable_candidate"
  | "live_surface_unconfirmed"
  | "stable_pending"
  | "published"
  | "response_reserved"
  | "executing_step"
  | "awaiting_step_advance"
  | "native_resolved"
  | "superseded"
  | "response_uncertain";

/**
 * Owner-private terminal mutation authority. Public renderers and OpenClaw
 * schemas must never import this module or copy any of these fields into a
 * TerminalInteractionProjection.
 */
export interface TerminalInteractionAuthority {
  readonly authority_schema: typeof TERMINAL_INTERACTION_AUTHORITY_SCHEMA;
  readonly authority_version: typeof TERMINAL_INTERACTION_AUTHORITY_VERSION;
  readonly interaction_id: string;
  readonly turn_id: string;
  readonly agent: TerminalInteractionAgent;
  readonly state: TerminalInteractionAuthorityState;
  readonly source_interaction_id: string;
  readonly native_turn_id?: string;
  readonly native_thread_id?: string;
  readonly source_file_identity: string;
  readonly source_fingerprint: string;
  readonly live_frame_fingerprint: string;
  readonly runtime_profile: string;
  readonly process_incarnation: string;
  readonly owner_session: string;
  readonly turn_revision: string;
  readonly terminal_binding_id: string;
  readonly terminal_binding_generation: number;
  readonly current_step: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_proven_stage?: string;
}

/**
 * Subject-aware private authority. Unlike the v1 managed-only record above,
 * this shape can fence an exact Watch without inventing a Turn id.
 */
export interface TerminalInteractionSubjectAuthority {
  readonly authority_schema: typeof TERMINAL_INTERACTION_AUTHORITY_SCHEMA;
  readonly authority_version:
    typeof TERMINAL_INTERACTION_SUBJECT_AUTHORITY_VERSION;
  readonly interaction_id: string;
  readonly subject: TerminalInteractionSubject;
  readonly agent: TerminalInteractionAgent;
  readonly state: TerminalInteractionAuthorityState;
  readonly response_authority: TerminalInteractionResponseAuthority;
  readonly surface_id: string;
  readonly prompt_fingerprint: string;
  readonly source_interaction_id: string;
  readonly native_turn_id?: string;
  readonly native_thread_id?: string;
  readonly source_file_identity: string;
  readonly live_frame_fingerprint: string;
  readonly runtime_profile: string;
  readonly process_incarnation: string;
  readonly owner_session: string;
  readonly terminal_binding_id: string;
  readonly terminal_binding_generation: number;
  readonly exact_task_anchor_fingerprint: string;
  readonly current_step: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly last_proven_stage?: string;
}

export type TerminalInteractionAnyAuthority =
  | TerminalInteractionAuthority
  | TerminalInteractionSubjectAuthority;

export type TerminalInteractionResponderClass =
  | "managed_turn"
  | "exact_request_watch"
  | "exact_task_watch"
  | "activity_watch";

export interface TerminalInteractionResponderClaim {
  readonly owner_id: string;
  readonly owner_session: string;
  readonly surface_id: string;
  readonly responder_class: TerminalInteractionResponderClass;
  readonly response_authority: TerminalInteractionResponseAuthority;
}

const RESPONDER_CLASS_PRIORITY: Readonly<Record<
  TerminalInteractionResponderClass,
  number
>> = Object.freeze({
  managed_turn: 400,
  exact_request_watch: 300,
  exact_task_watch: 200,
  activity_watch: 100
});

/**
 * Deterministic arbitration for claims about one native surface. Notification
 * fan-out remains a caller policy; this chooses terminal mutation ownership.
 */
export function selectTerminalInteractionResponder(
  claims: readonly TerminalInteractionResponderClaim[]
): TerminalInteractionResponderClaim | undefined {
  return claims
    .filter((claim) => claim.response_authority === "executable")
    .slice()
    .sort((left, right) => {
      const priority = RESPONDER_CLASS_PRIORITY[right.responder_class] -
        RESPONDER_CLASS_PRIORITY[left.responder_class];
      if (priority !== 0) {
        return priority;
      }
      const session = left.owner_session.localeCompare(right.owner_session);
      return session !== 0 ? session : left.owner_id.localeCompare(right.owner_id);
    })[0];
}
