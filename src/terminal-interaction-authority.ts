import type { TerminalInteractionAgent } from
  "./terminal-interaction-protocol.js";

export const TERMINAL_INTERACTION_AUTHORITY_SCHEMA =
  "agent-knock-knock/terminal-interaction-authority" as const;
export const TERMINAL_INTERACTION_AUTHORITY_VERSION = 1 as const;

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
