import { codexRuntimeCompatibilityProfile } from "./codex-lifecycle-compatibility.js";
import { claudeRuntimeCompatibilityWarning } from "./claude-lifecycle-compatibility.js";
import { isUserExplicitFallbackWatch, isTerminalActivityWatch, isPaginatedSendWatch, type TerminalWatch } from "./terminal-watch-record.js";

export function publicTerminalWatch(
  watch: TerminalWatch,
  additionalWarnings: readonly string[] = [],
  exposeInteraction = false
): Record<string, unknown> {
  const pending = watch.notification_outbox.filter(({ status }) =>
    status === "pending" || status === "delivering" || status === "failed"
  ).length;
  const capturedAgentVersion = terminalWatchCapturedAgentVersion(watch);
  const compatibilityWarning = capturedAgentVersion === undefined
    ? undefined
    : watch.agent === "codex"
      ? codexRuntimeCompatibilityProfile(capturedAgentVersion)
        ?.compatibilityWarning
      : claudeRuntimeCompatibilityWarning(capturedAgentVersion);
  const userExplicitFallback = isUserExplicitFallbackWatch(watch) || isPaginatedSendWatch(watch);
  const terminalActivityFallback = isTerminalActivityWatch(watch);
  const warnings = [...new Set([
    ...(watch.warnings ?? []),
    ...additionalWarnings
  ])];
  const latestFailedCallback = [...watch.notification_outbox]
    .reverse()
    .find(({ status }) => status === "failed");
  const currentInteraction = exposeInteraction && watch.status === "active" &&
      watch.current_interaction &&
      ["pending", "reserved", "response_uncertain"].includes(
        watch.current_interaction.aggregate.state
      )
    ? watch.current_interaction
    : undefined;
  const interactionProjection = currentInteraction?.aggregate.state ===
      "reserved"
    ? {
        ...currentInteraction.projection,
        state: "response_uncertain" as const,
        capabilities: {
          ...currentInteraction.projection.capabilities,
          respond: false
        }
      }
    : currentInteraction?.projection;
  return {
    watch_id: watch.watch_id,
    source: userExplicitFallback
      ? "terminal_user_explicit_fallback_watch"
      : terminalActivityFallback
        ? "terminal_activity_watch"
        : "user_selected_terminal_watch",
    watch_mode: terminalActivityFallback ? "terminal_activity" : "exact_task",
    confidence: terminalActivityFallback ? "best_effort" : "exact",
    interaction_policy: watch.interaction_policy,
    capabilities: {
      interaction_notify: true,
      interaction_respond: Boolean(
        interactionProjection?.state === "pending" &&
        interactionProjection.capabilities.respond
      )
    },
    agent: watch.agent,
    terminal_id: watch.terminal.terminal_id,
    native_thread_id: terminalWatchNativeThreadId(watch),
    workspace: watch.terminal.workspace,
    status: watch.status,
    activity_state: watch.status === "active" ? "watching" : "settled",
    created_at: watch.created_at,
    deadline_at: watch.deadline_at,
    updated_at: watch.updated_at,
    last_activity_at: watch.last_activity_at,
    ...(compatibilityWarning
      ? { compatibility_warning: compatibilityWarning }
      : {}),
    ...(warnings.length > 0
      ? { warnings }
      : {}),
    callback: {
      pending,
      delivered: watch.notification_outbox.filter(
        ({ status }) => status === "delivered"
      ).length,
      failed: watch.notification_outbox.filter(
        ({ status }) => status === "failed"
      ).length,
      superseded: watch.notification_outbox.filter(
        ({ status }) => status === "superseded"
      ).length,
      ...(latestFailedCallback?.last_error_code
        ? { last_error_code: latestFailedCallback.last_error_code }
        : {})
    },
    ...(interactionProjection
      ? {
          interaction_state: interactionProjection,
          interaction_prompt_fingerprint:
            interactionProjection.prompt_fingerprint
        }
      : {}),
    ...(watch.settlement
      ? {
          settlement: {
            kind: watch.settlement.kind,
            observed_at: watch.settlement.observed_at,
            reason_code: watch.settlement.reason_code,
            completion_text: watch.settlement.completion_text,
            completion_id: watch.settlement.completion_id,
            completion_timestamp: watch.settlement.completion_timestamp
          }
        }
      : {}),
    available_actions: {
      status: {
        tool: "agent_knock_knock_status",
        arguments: { watch_id: watch.watch_id }
      },
      ...(watch.status === "active"
        ? {
            unwatch: {
              tool: "agent_knock_knock_unwatch",
              arguments: { watch_id: watch.watch_id },
              requires_user_intent: true
            }
          }
        : {}),
      ...(interactionProjection?.state === "pending" &&
          interactionProjection.capabilities.respond
        ? {
            respond_interaction: {
              tool: "agent_knock_knock_respond_interaction",
              arguments: { watch_id: watch.watch_id },
              requires_user_intent: true
            }
          }
        : {})
    }
  };
}

export function terminalWatchCapturedAgentVersion(
  watch: TerminalWatch
): string | undefined {
  switch (watch.anchor.schema) {
    case "agent-knock-knock/codex-human-started-active-task-anchor":
    case "agent-knock-knock/codex-paginated-task-anchor":
    case "agent-knock-knock/codex-user-explicit-fallback-watch-anchor":
      return watch.anchor.codex_version;
    case "agent-knock-knock/claude-human-started-active-task-anchor":
    case "agent-knock-knock/claude-user-explicit-fallback-watch-anchor":
      return watch.anchor.claude_version;
    case "agent-knock-knock/terminal-activity-watch-anchor":
      return watch.anchor.agent_version;
  }
}

export function terminalWatchNativeThreadId(
  watch: TerminalWatch
): string | undefined {
  switch (watch.anchor.schema) {
    case "agent-knock-knock/codex-human-started-active-task-anchor":
    case "agent-knock-knock/codex-paginated-task-anchor":
      return watch.anchor.native_thread_id;
    case "agent-knock-knock/claude-human-started-active-task-anchor":
      return watch.anchor.session_id;
    case "agent-knock-knock/codex-user-explicit-fallback-watch-anchor":
      return watch.anchor.acceptance_anchor.version === 1
        ? watch.anchor.acceptance_anchor.native_thread_id
        : undefined;
    case "agent-knock-knock/claude-user-explicit-fallback-watch-anchor":
      return watch.anchor.transcript_anchor.session_id;
    case "agent-knock-knock/terminal-activity-watch-anchor":
      return undefined;
  }
}
