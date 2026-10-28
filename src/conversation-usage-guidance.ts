import { recordValue } from "./value-guards.js";
import { codexFolderTrustBlocked } from "./codex-folder-trust-surface.js";

type Row = Record<string, unknown>;
interface ConversationUsage {
  summary: string;
  available: string[];
  limitations: string[];
  next_steps: string[];
}

/** Display advice consumes current offers; it never grants an action or copies diagnostic text. */
export function withConversationUsage(row: Row, facts: Row = row): Row {
  return { ...row, usage: conversationUsage({ ...facts, ...row }) };
}

function offered(row: Row, name: string): boolean {
  const actions = recordValue(row.available_actions);
  if (actions) return actions[name] === true || Boolean(recordValue(actions[name]));
  return recordValue(row.capabilities)?.[name] === true;
}

function terminalOnly(row: Row): boolean {
  return String(row.conversation_id ?? row.id).startsWith("terminal:");
}

function explicitClaudeInput(row: Row): boolean {
  const action = recordValue(recordValue(row.available_actions)?.send);
  const input = recordValue(recordValue(row.action_inputs)?.send);
  return row.agent === "claude" && terminalOnly(row) && unresolvedIdentity(row) && offered(row, "send") &&
    (action?.scope ?? input?.scope) === "terminal_user_explicit";
}

function responseKind(row: Row): "question" | "continuation" | undefined {
  if (offered(row, "respond_interaction")) return "question";
  if (!offered(row, "respond")) return undefined;
  const action = recordValue(recordValue(row.available_actions)?.respond);
  const input = recordValue(recordValue(row.action_inputs)?.respond);
  return (action?.tool ?? input?.tool) === "agent_knock_knock_respond_interaction" ? "question" : "continuation";
}

function canAnswerRequests(row: Row): boolean {
  const capabilities = recordValue(row.capabilities);
  return offered(row, "approve") || responseKind(row) === "question" ||
    capabilities?.approve === true || capabilities?.interaction_respond === true;
}

function usableOperations(row: Row): string[] {
  const operations: string[] = [];
  if (offered(row, "status")) operations.push("Read current status");
  if (offered(row, "send")) operations.push("Send a task");
  if (offered(row, "watch")) operations.push(terminalOnly(row) ? "Observe terminal activity" : "Watch the current task");
  if (offered(row, "approve")) operations.push("Review and answer an approval request");
  const response = responseKind(row);
  if (response === "question") operations.push("Answer a pending question");
  if (response === "continuation") operations.push("Continue the managed task");
  if (offered(row, "native_inspect")) operations.push("Inspect the conversation");
  if (offered(row, "new_thread")) operations.push("Start a new conversation");
  if (offered(row, "clear_thread")) operations.push("Clear the current conversation");
  if (offered(row, "list_resumable_threads")) operations.push("Browse saved conversations");
  if (offered(row, "resume_thread")) operations.push("Resume a saved conversation");
  if (offered(row, "model_options") || offered(row, "set_model")) operations.push("View available model choices");
  if (offered(row, "permission_options") || offered(row, "set_permissions")) operations.push("Review permission choices");
  if (offered(row, "cancel")) operations.push("Request cancellation of current work");
  return operations;
}

/** Advice is recalculated on every projection, including after recovery or a state transition. */
function conversationUsage(row: Row): ConversationUsage {
  if (row.details_omitted === true && row.detail_reason === "list_row_budget") return {
    summary: "Read Status to see how to use this conversation.", available: ["Read current status"],
    limitations: ["This list entry was shortened. Other actions are omitted, not necessarily unavailable."],
    next_steps: ["Open Status for this exact conversation to see its current actions and any required recovery."]
  };
  const send = offered(row, "send"), watch = offered(row, "watch");
  const usage: ConversationUsage = { summary: send ? "Ready to receive a task."
    : watch ? "You can observe this conversation; task sending is unavailable."
    : "Task sending is unavailable; check the recovery steps below.",
  available: usableOperations(row), limitations: [], next_steps: [] };
  explainClaudeLifecycleReadiness(row, usage);
  if (explicitClaudeInput(row)) {
    usage.summary = "可以向此窗口发送任务。AKK 会输入文字并提交，但目前无法可靠确认后台任务的接受和完成状态；请在窗口中查看执行结果。";
    usage.limitations.push("Physical input confirms text submission and Enter dispatch, not native task acceptance or completion.");
    usage.next_steps.push("Explicitly select this terminal and use Send with terminal_id and request; check the result in that window.");
    if (watch) usage.next_steps.push("Watch can observe terminal activity; it cannot prove completion of this submitted task.");
    return usage;
  }
  if (!send) explainBlockedSend(row, usage);
  else usage.next_steps.push(watch ? "Use Send to assign work, or Watch to follow the current activity."
    : "Send a task, then use its returned Status to follow progress.");
  explainMonitoring(row, usage, send, watch);
  if (recordValue(row.native_store_authority)?.send_after_transfer === true && send) {
    usage.limitations.push("Sending first recovers an abandoned ownership record using verified recovery evidence.");
  }
  return usage;
}

function explainMonitoring(row: Row, usage: ConversationUsage, send: boolean, watch: boolean): void {
  const capabilities = recordValue(row.capabilities);
  if (!watch && send) {
    usage.limitations.push(row.activity_state === "idle"
      ? "There is no active task to watch while this conversation is idle."
      : "A current task could not be verified for Watch; use the Status returned by Send.");
  } else if (watch && capabilities?.interaction_notify === true && capabilities.approve === false &&
      capabilities.interaction_respond === false && !canAnswerRequests(row)) {
    usage.limitations.push("Monitoring can notify you; when prompted, check Status. Requests without an offered response action must be answered in the original terminal or app.");
  }
}

function explainBlockedSend(row: Row, usage: ConversationUsage): void {
  row = withExactManagementFacts(row);
  if (row.agent === "codex" && codexFolderTrustBlocked(row.approval_state)) {
    usage.summary = "Codex is waiting for a folder access decision in the original terminal.";
    usage.limitations.push("This is a local folder-trust decision; backend idle does not mean the terminal is ready. AKK does not choose or persist trust for you.");
    usage.next_steps.push("Review the folder access prompt yourself in the original terminal, then refresh List.");
    return;
  }
  const authority = recordValue(row.native_store_authority);
  if (authority?.state === "transferring" || authority?.state === "conflict" ||
      row.management_state === "conflict" || row.management_conflict) return explainOwnership(row, usage);
  if (row.management_state === "unavailable" || row.management_unavailable) {
    usage.limitations.push("AKK cannot currently verify its saved management records, so task sending is paused.");
    usage.next_steps.push("Open Status to inspect the storage or management error; restore access, then refresh List.");
    return;
  }
  if (["exited", "stopped", "dead"].includes(String(row.process_state)) || row.activity_state === "exited") {
    usage.limitations.push("The agent process is no longer running.");
    usage.next_steps.push("Start the agent in the original terminal, resume the conversation if needed, then refresh List.");
    return;
  }
  if (needsAnswer(row)) return explainPendingAnswer(row, usage);
  if (explainClaudeManagedSendReadiness(row, usage)) return;
  if (explainPhysicalReadiness(row, usage)) return;
  if (unresolvedIdentity(row)) return explainIdentity(row, usage);
  if (["working", "busy", "active", "running"].includes(String(row.activity_state))) {
    usage.limitations.push("This conversation is busy with existing work.");
    usage.next_steps.push(offered(row, "watch") ? "Use Watch to follow the current work; refresh List after it finishes."
      : "Check the original terminal or app, wait for current work to finish, then refresh List.");
    return;
  }
  if (row.connected === false || ["not_loaded", "unconfirmed", "disconnected"].includes(String(row.connection_state))) {
    usage.limitations.push("AKK has not verified a live connection to this conversation.");
    usage.next_steps.push("Open this conversation in its original app or terminal, wait until it is ready, then refresh List.");
    return;
  }
  usage.limitations.push("AKK could not verify that this conversation is ready to receive input.");
  usage.next_steps.push("Open Status and inspect the original terminal or app for a prompt or connection problem, then refresh List.");
}

function explainPhysicalReadiness(row: Row, usage: ConversationUsage): boolean {
  const readiness = recordValue(row.physical_send_readiness);
  if (row.agent !== "claude" || readiness?.ready !== false) return false;
  if (readiness.reason === "screen_not_scanned") {
    usage.limitations.push("AKK did not scan this window, so it cannot verify that input is safe.");
    usage.next_steps.push("Call List again with noApprovalScan:false, or omit that option (CLI: omit --no-approval-scan). Check the refreshed Send action before sending.");
  } else if (readiness.reason === "screen_unavailable") {
    usage.limitations.push("AKK could not read this window, so it cannot verify that input is safe.");
    usage.next_steps.push("Open Status to inspect the capture error; restore terminal-provider access, then refresh List with pane scanning enabled.");
  } else if (readiness.reason === "foreground_running") {
    usage.limitations.push("Claude is still executing its current turn; AKK will not inject another task into it.");
    usage.next_steps.push("Wait for Claude's current turn to finish, then refresh List. Background shells alone do not block Send.");
  } else if (readiness.reason === "foreground_unproven") {
    usage.limitations.push("Claude still shows running-work controls, and AKK cannot verify that its foreground turn has finished.");
    usage.next_steps.push("Wait for Claude to show that its turn is done, then refresh List. Do not cancel a background shell just to enable Send.");
  } else if (readiness.reason === "stash_not_empty" || readiness.reason === "cleanup_marker_present") {
    usage.limitations.push(readiness.reason === "stash_not_empty"
      ? "This window has a stashed draft; AKK has paused Send before changing it."
      : "This window contains an AKK-style cleanup marker; AKK has paused Send without erasing it.");
    usage.next_steps.push(typeof readiness.message === "string" ? readiness.message : readiness.reason === "stash_not_empty"
      ? "Wait until Claude is idle. With an empty input box, press Ctrl+S once to restore the draft, save or clear it yourself, then refresh List and retry."
      : "Do not submit the marker. Remove only the AKK marker, save any other text, then empty the input box, refresh List, and retry.");
  } else if (readiness.reason === "composer_not_empty") {
    usage.limitations.push("This window contains an unsent draft. AKK will preserve it.");
    usage.next_steps.push("Send, save, or clear that draft yourself in the window, then refresh List before using Send.");
  } else {
    usage.limitations.push(readiness.reason === "footer_unrecognized"
      ? "AKK cannot recognize the controls below this window's input box, so it has paused automatic input."
      : "AKK cannot verify an empty main input box in this window, so it has paused automatic input.");
    usage.next_steps.push("Return to Claude's main input box, close any menu or overlay, and refresh List. If it remains unavailable, use the window manually and report its visible controls.");
  }
  return true;
}

function explainClaudeManagedSendReadiness(row: Row, usage: ConversationUsage): boolean {
  const readiness = recordValue(row.managed_send_readiness);
  if (row.agent !== "claude" || readiness?.ready !== false) return false;
  usage.limitations.push("AKK cannot currently verify managed completion tracking for this Claude session.");
  usage.next_steps.push(typeof readiness.message === "string" ? readiness.message
    : "Check Status and the Claude reader, then refresh List and retry.");
  usage.next_steps.push("If an explicit terminal Send action is offered, you may select that terminal yourself and inspect the result in its window; managed Send will not switch to that route automatically.");
  return true;
}

function explainClaudeLifecycleReadiness(row: Row, usage: ConversationUsage): void {
  row = withExactManagementFacts(row);
  const readiness = recordValue(row.thread_lifecycle_readiness);
  if (row.agent !== "claude" || offered(row, "new_thread") || readiness?.ready !== false) return;
  usage.limitations.push("Starting or switching Claude threads is unavailable because the current idle process could not be verified.");
  usage.next_steps.push(typeof readiness.message === "string" ? readiness.message
    : "Check Status and the Claude reader, wait for Claude to finish, then refresh List before changing threads.");
}

function withExactManagementFacts(row: Row): Row {
  const controls = Array.isArray(row.terminal_controls) ? row.terminal_controls : row.control_records;
  const control = Array.isArray(controls) && controls.length === 1 ? recordValue(controls[0]) : undefined;
  if (!control) return row;
  return { ...Object.fromEntries(["management_state", "management_conflict", "management_unavailable", "native_store_authority", "physical_send_readiness",
    "managed_send_readiness", "thread_lifecycle_readiness"]
    .filter(name => control[name] !== undefined).map(name => [name, control[name]])), ...row };
}

function unresolvedIdentity(row: Row): boolean {
  const identity = recordValue(row.native_agent_identity_observation)?.status ?? row.native_identity_state;
  return ["terminal_identity_unresolved", "terminal_identity_ambiguous", "terminal_identity_conflict"].includes(String(row.send_blocked_reason)) ||
    terminalOnly(row) && identity !== undefined && identity !== "resolved";
}

function explainIdentity(row: Row, usage: ConversationUsage): void {
  const observation = recordValue(row.native_agent_identity_observation);
  if (row.agent === "claude" && terminalOnly(row) && observation?.window_role === "background_view") {
    usage.summary = "This window displays a background conversation; a safe terminal Send action is not currently available.";
    usage.limitations.push("AKK cannot currently verify safe input to this window, and cannot prove native background task acceptance or completion.");
    usage.next_steps.push("Inspect this window, answer any pending prompt or close any menu or editor, then refresh List. Use Send if a terminal input action appears; otherwise continue manually and inspect Status.");
    usage.next_steps.push("For managed task tracking, open another terminal and start an ordinary Claude conversation with your usual command; keep existing background work running.");
    return;
  }
  const recheck = recordValue(observation?.recheck);
  const checkedAgain = recheck?.attempted === true && ["unresolved", "failed"].includes(String(recheck.status));
  usage.limitations.push(checkedAgain
    ? "AKK checked again but still could not identify the running conversation, so it cannot safely send a task here."
    : "AKK could not identify the running conversation, so it cannot safely send a task here.");
  if (offered(row, "identify_foreground")) {
    usage.next_steps.push("Use the offered Identify foreground action, then refresh List before sending.");
  } else {
    usage.next_steps.push("Finish or save any current work in this pane. Exit the agent, launch it again with your usual command, resume the conversation if needed, then refresh List.");
    usage.next_steps.push("If it is still unrecognized, use that terminal directly and report the discovery problem; restarting is not a guaranteed repair.");
  }
}

function needsAnswer(row: Row): boolean {
  return recordValue(row.approval_state)?.blocked === true || row.manual_required === true ||
    Number(row.pending_interaction_count) > 0 || ["permission prompt", "input needed"].includes(String(row.waiting_for));
}

function explainPendingAnswer(row: Row, usage: ConversationUsage): void {
  usage.limitations.push("There is a pending approval or question to review before sending more work.");
  usage.next_steps.push(canAnswerRequests(row)
    ? "Open Status, review the pending request, and use its offered approval or answer action with your decision; then refresh List."
    : "Return to the original terminal or app and answer the pending prompt; then refresh List.");
}

function explainOwnership(row: Row, usage: ConversationUsage): void {
  const transferring = recordValue(row.native_store_authority)?.state === "transferring";
  usage.limitations.push(transferring ? "Ownership recovery is still in progress; task sending is paused."
    : "Another saved management record claims this conversation; sending is paused to prevent duplicate control.");
  if (offered(row, "transfer_store_authority")) {
    usage.next_steps.push("Open Status, review the offered ownership transfer, and request it only if you intend to move control to this host; then refresh List.");
  } else if (offered(row, "reconcile_binding")) {
    usage.next_steps.push("Open Status and review the offered binding recovery before deciding to detach the old binding; then refresh List.");
  } else {
    usage.next_steps.push(transferring ? "Wait for recovery to finish, then refresh List. If it remains pending, inspect Status before retrying."
      : "Open Status to identify the current owner. Stop its work before requesting recovery; do not delete its saved records.");
  }
}
