// Model-facing wording is data; execution and authority stay in the tool runtime.
export const semanticToolDescriptions = {
  akk: "Discover Codex Desktop conversations, send tasks and watch their completion; " +
    "Desktop approvals and questions require manual handling. Send coding work " +
    "through existing Codex or Claude Code shared terminals, " +
    "inspect managed Turns, observe a user-selected terminal with durable " +
    "read-only Terminal Watch, manage native threads, and safely inspect or " +
    "change an idle pane's native model selection or Codex permissions.",
  watch: "For Desktop, use the exact conversation_id from List to watch one currently " +
    "active native task. An unresolved identity or idle thread is refused; Desktop " +
    "questions and approvals are notification-only and require manual handling. " +
    "For terminals, start one durable read-only Terminal Watch for the user's exact selected " +
    "Codex or Claude Code terminal. AKK prefers an exact durable task anchor; if " +
    "version, artifact, task, managed-ownership, or action-advertisement evidence " +
    "is unavailable, it remains callable and returns warnings while using " +
    "best-effort terminal activity. That fallback reports stable-idle activity, " +
    "not proof of exact task completion. Watch creates no AKK Session or Turn, " +
    "sends no terminal input, and never adopts or blocks the terminal task.",
  unwatch: "Stop one exact durable terminal or Desktop Watch by its authoritative watch_id. This " +
    "cancels observation only; it sends no terminal input and does not interrupt, " +
    "adopt, or otherwise mutate the human's coding-agent task.",
  list_resumable_threads: "List structurally verified native Codex or Claude Code threads for one exact " +
    "terminal. A valid unverified agent version remains callable with a " +
    "compatibility warning. Resume only a row with resumable=true by passing this " +
    "terminal_id and that row's complete native_thread_id. AKK retains candidate " +
    "and binding freshness evidence privately. Number and short-id fields are " +
    "slash-command display aids, never tool arguments. This is read-only for " +
    "Session/Turn state and creates no AKK Turn.",
  native_inspect: "Execute one closed native status inspection in an exact Codex or Claude Code " +
    "terminal. Verified versions use their regression-tested profile; unverified " +
    "complete x.y.z versions remain callable through the generic runtime protocol " +
    "and return a compatibility warning. Pass only terminal_id and " +
    "inspection=status; AKK refreshes binding authority privately. Arbitrary " +
    "slash commands remain unavailable. This creates no AKK Session, Turn, " +
    "receipt, monitor, or callback.",
  new_thread: "Start and verify a clean native coding-agent thread in the exact terminal_id " +
    "after explicit user intent. A valid unverified agent version remains " +
    "callable with a compatibility warning. AKK refreshes lifecycle authority " +
    "privately. Never send /clear as ordinary task text. This creates a new AKK " +
    "Session but no Turn.",
  reconcile_binding: "Detach one exact conflicting managed Session binding without adopting the " +
    "live replacement thread. Pass only the advertised terminal_id and " +
    "conflicting_session_id after explicit user confirmation; AKK refreshes all " +
    "revision and binding authority privately. This sends no coding-agent input " +
    "and creates no Turn.",
  resume_thread: "Resume one exact structurally verified historical native thread after " +
    "explicit user intent. A valid unverified agent version remains callable with " +
    "a compatibility warning. Pass only terminal_id and one complete " +
    "native_thread_id from a resumable=true row; AKK refreshes binding and " +
    "candidate evidence privately. This creates or reactivates an AKK Session but " +
    "no Turn.",
  status: "Inspect one exact managed Turn by turn_id, a terminal or Desktop Watch " +
    "by watch_id, or a conversation_id returned by List. Desktop status reads " +
    "the original thread when reachable; metadata alone cannot prove live task " +
    "state. Desktop questions and approvals require manual handling. Targets " +
    "are mutually exclusive. Legacy Turn aliases and list-prefilled raw-terminal " +
    "selectors remain supported; never construct a conversation_id. User-selected " +
    "Watch status reports whether it uses an exact task anchor or best-effort " +
    "terminal activity without implying Watch sent or adopted the task; that task " +
    "may independently be managed. Automatic terminal_user_explicit fallback " +
    "Watch status describes the exact request AKK physically sent without " +
    "claiming a managed Turn. AKK never starts a coding agent.",
  send: "For Desktop, pass request and the exact conversation_id from List. AKK " +
    "requires a reachable idle original owner, inherits thread settings, sends " +
    "once and monitors the exact accepted task. It never automatically opens a " +
    "thread, approves, answers questions or retries an uncertain Desktop send. " +
    "For terminals, start a new AKK Turn, use one advertised terminal_user_explicit " +
    "user-priority send, or explicitly recover one current uncertain submission " +
    "only through its advertised retry_submission action. Ordinary send requires " +
    "request and may use session_id or terminal_id exactly as advertised. " +
    "terminal_user_explicit requires one exact live physical terminal/process, a " +
    "scanned non-blocked approval state, and no input-owning native " +
    "questionnaire/editor, menu, or read-only viewer; parsed working activity, " +
    "Codex rollout ambiguity, AKK management state, ordinary main-Composer " +
    "visibility, stability, exactness, and existing draft contents do not veto " +
    "physical delivery. Profiled Codex 0.154.0/0.155.1 exact collapsed " +
    "async-question summaries remain sendable, while expanded, clipped, or " +
    "ambiguous editors receive zero input. Codex sends C-u once to replace the " +
    "current Composer; Claude Code uses a sentinel-backed native C-s stash-clear " +
    "transaction that is independent of the cursor position and does not " +
    "interrupt an active turn, then proves the main Composer empty. Each injects " +
    "the request, waits through the paste window, and dispatches Enter exactly " +
    "once without a post-text Composer veto. A source-less Codex terminal freezes " +
    "all current rollout roots before input, then promotes a provisional " +
    "Session/Turn only when exactly one anchored or newly opened rollout durably " +
    "accepts the exact request hash; zero matches remain pending and ambiguity " +
    "becomes uncertain without replay. If managed preparation fails before input, " +
    "AKK still delivers once as unmanaged work, then best-effort attaches an " +
    "exact Terminal Watch callback. After exact request acceptance and terminal " +
    "attribution, a supported questionnaire on that Watch may expose owner-bound " +
    "response authority through Status and its watch_id; terminal-activity " +
    "observations and manual_required interactions remain notification-only. Read " +
    "terminal_input_dispatched, agent_acceptance, management_mode, " +
    "observation_mode, and capabilities independently. Watch attachment failure " +
    "never changes a successful Send. Once the mutation sequence begins, an " +
    "uncertain result must not be automatically retried. Retry submission is the " +
    "mutually exclusive exact {turn_id} form and cannot change request text or " +
    "routing. Draft text, composer digests, and opaque freshness authority stay " +
    "private. A Turn id is never an ordinary-send destination. Managed acceptance " +
    "is asynchronous: yield and wait for its callback or an explicit status " +
    "request.",
  respond: "Respond to a question or blocked callback in one exact in-flight AKK turn. " +
    "This continues that turn and does not create a new turn; for later ordinary " +
    "work refresh agent_knock_knock_list and use that terminal row's currently " +
    "advertised send action.",
  respond_interaction: "Answer exactly one current native interaction step shown by " +
    "agent_knock_knock_status in this controller conversation. Supply exactly one " +
    "authoritative subject target: turn_id for a managed Turn or watch_id for an " +
    "interactive Terminal Watch, plus interaction_id and one typed semantic " +
    "answer. single_select uses selected_option_ids with one advertised " +
    "option_id; free_text uses text; confirm uses confirm. For async_question, " +
    "delivery_mode defaults to steer_current_turn; select queue_next_turn " +
    "explicitly only when advertised; omit it for a blocking questionnaire. AKK " +
    "consumes only that subject's displayed private offer and revalidates the " +
    "exact discriminator-specific shape, prompt, owner, task attribution, and " +
    "terminal authority before any input. A displayed expiry is a freshness " +
    "boundary: after it passes, AKK must prove the same exact live interaction " +
    "again instead of rejecting an otherwise live prompt. Raw keys, menu indexes, " +
    "rendered labels, fingerprints, versions, and terminal commands are never " +
    "accepted. An uncertain response must never be retried blindly.",
  approve: "Dispatch one closed semantic decision for the current exact permission " +
    "request only after the user reviews and explicitly chooses it. decision " +
    "defaults to approve_once for compatibility; reject is available only on a " +
    "managed Turn when the adapter proves a safe native reject choice. Use " +
    "turn_id for a managed Turn or terminal_id for a separately advertised " +
    "approve_once-only terminal action. AKK privately refreshes the prompt and " +
    "authority, then recaptures it under lock. Raw keys, indexes, and labels are " +
    "not accepted. Never retry an interrupted decision blindly.",
  renew: "Renew monitoring for one exact stalled turn_id without sending text or keys " +
    "to the coding agent. Use this when the user wants a still-live long-running " +
    "terminal task to keep monitoring after an inactivity stall.",
  retry_callback: "Retry a persisted AKK callback for an exact turn that failed before reaching " +
    "the controller Host. The original callback message id and turn identity are " +
    "reused for idempotent delivery.",
  cancel: "Interrupt one exact AKK turn_id, or use only an unmanaged raw terminal row's " +
    "own prefilled cancel action. Claude sends Escape; Codex uses its declared " +
    "interrupt key. The shared terminal pane remains open for human takeover.",
  close: "Honor an explicit user request to close one managed turn_id and release AKK " +
    "management. Raw orphan recovery may instead use conversation_id with " +
    "expected_message_id or expected_transition_id. Close never sends terminal " +
    "input, stops the coding agent, or closes the shared pane. Deferred transfer, " +
    "Session, ledger, and callback cleanup is best-effort and cannot veto closing " +
    "the Turn; warnings identify metadata AKK preserved. Refresh list afterward " +
    "and use Watch if the coding agent is still working.",
  list: "List terminals, Desktop conversation candidates and Watches. Desktop " +
    "metadata is distinct from verified live capabilities. Use desktopSearch, " +
    "desktopProject and desktopCursor to find more candidates. The compact " +
    "projection has available_actions and action_inputs for exact targets. " +
    "Follow the agent-knock-knock skill for action meaning and safety; AKK " +
    "privately revalidates every mutation.",
  model_options: "Inspect the exact current native model catalog for one explicitly selected " +
    "physical Codex or Claude Code pane. This is the required read-only first " +
    "step before set_model. Profiled Codex 0.154.0/0.155.1 accepts one exact " +
    "current native Session or a verified-zero-rollout pane without " +
    "identify_foreground; Claude Code still requires one exact current native " +
    "Session. AKK requires an exact live pane/process, no active Turn, and no " +
    "approval, questionnaire/editor, or read-only viewer. The Composer must be " +
    "empty unless current List privately binds this action to one exact stable " +
    "profiled Codex 0.154.0/0.155.1 /model residual, which AKK may continue into " +
    "the native picker without retyping it. That residual-bound authority is " +
    "consumed by discovery; after restoring an exact empty Composer, AKK retains " +
    "only fresh ordinary terminal/catalog authority for one set_model attempt in " +
    "this exact controller conversation. It obtains model ids and " +
    "reasoning-effort values from the native UI/runtime and exposes only semantic " +
    "choices. Codex advertises scope=current_and_new_sessions; Claude Code " +
    "advertises scope=current_session. Arbitrary commands, keys, menu indexes, " +
    "labels, and hidden authority are never accepted.",
  repair_model_control: "Clear one exact stale profiled Codex 0.154.0/0.155.1 /model completion " +
    "surface, exact bare /model Composer, or exact open native model picker left " +
    "by a failed native model-control attempt. This explicit one-shot repair is " +
    "available only when the current AKK list proves the same exact pane/process, " +
    "the closed profiled model-control residue, no active Turn, and no approval, " +
    "questionnaire/editor, or read-only viewer. Pass only terminal_id; AKK " +
    "privately derives and revalidates every physical, screen, and Composer fence " +
    "before each reversible cleanup input. It never submits a task, selects a " +
    "model, approves a prompt, accepts raw commands or keys, or automatically " +
    "continues into model_options/set_model. An open picker receives dismissal " +
    "authority only, never Enter authority. outcome=uncertain must never be " +
    "retried automatically.",
  set_model: "Change exactly one already-open physical coding-agent pane to one semantic " +
    "model and reasoning-effort tuple from the immediately preceding " +
    "model_options result in this same controller conversation. AKK consumes the " +
    "private current-snapshot offer, revalidates the exact pane/process plus idle " +
    "and empty native UI under lock, rejects active Turns and every input-owning " +
    "prompt/viewer, and verifies the effective postcondition. Profiled Codex " +
    "0.154.0/0.155.1 accepts one exact current native Session or a " +
    "verified-zero-rollout pane without identify_foreground; Claude Code still " +
    "requires one exact current native Session. Codex scope is " +
    "current_and_new_sessions: the model and ordinary efforts (including max) are " +
    "persisted, but ultra remains current-session-only; the future model is " +
    "reported while the native TUI's unobservable fallback effort is omitted. " +
    "Claude Code scope is current_session and leaves future defaults unchanged. " +
    "Parameters never accept scope, raw commands, slash text, keys, menu indexes, " +
    "display labels, fingerprints, or tokens. outcome=uncertain must never be " +
    "retried automatically.",
  identify_foreground: "Explicitly identify the foreground Codex native thread in one exact idle " +
    "terminal by issuing the closed /status probe once. The result is a " +
    "short-lived diagnostic bound to the current pane, process, cwd, and screen " +
    "generation; it creates no Session or Turn and grants no later response, " +
    "approval, lifecycle, or send authority. Ordinary list/status never runs this " +
    "probe.",
  identify_and_send: "Explicitly identify the foreground Codex native thread with one closed " +
    "/status probe, then dispatch one task while retaining the same terminal " +
    "lock. This is an optional managed-attachment enhancement, not a prerequisite " +
    "for ordinary human Send. The short-lived status observation never becomes " +
    "durable identity: only the rollout that uniquely accepts the exact task may " +
    "own the resulting Session/Turn. If the probe or boundary becomes uncertain, " +
    "AKK does not send or retry the task.",
} as const;

export const semanticCommandGuidance = [
  "Use /akk permissions on an advertised idle Codex terminal before /akk " +
    "set-permissions. Read the current permission mode and returned built-in " +
    "choices, then apply the requested or authorized mode. Full Access is an " +
    "ordinary option with no additional user confirmation; AKK automatically " +
    "handles its native confirmation inside the closed permission transaction, " +
    "never through generic approve. Ordinary Send does not change permissions. " +
    "Scope is the current session/thread and may survive Resume; global defaults " +
    "remain unchanged. Send the task only after a verified matching effective " +
    "mode. An uncertain result must not be retried automatically.",
  "Use /akk <task> when exactly one send-ready coding-agent terminal pane " +
    "should receive new work. Send-ready means an exact live process and terminal " +
    "plus a scanned, non-blocked approval state. Parsed working activity and " +
    "ordinary main-Composer visibility, stability, exactness, or existing draft " +
    "contents do not veto this user-priority path. A proven input-owning native " +
    "approval, questionnaire/editor, menu, or read-only viewer remains a " +
    "zero-input boundary; profiled Codex 0.154.0/0.155.1 exact collapsed " +
    "async-question summaries remain sendable, while expanded, clipped, or " +
    "ambiguous editors do not. Codex sends C-u once to replace the current " +
    "Composer; Claude Code uses a sentinel-backed native C-s stash-clear " +
    "transaction that is independent of the cursor position and does not " +
    "interrupt an active turn, then proves the main Composer empty. Each injects " +
    "the request, waits through the paste window, and dispatches Enter exactly " +
    "once; after text injection, no Composer observation may veto Enter. Managed " +
    "Send may still require exact empty before input, while native inspection and " +
    "native lifecycle input remain exact-empty-only. Broken or stale AKK " +
    "management activity records do not veto the user's physical Send. Structured " +
    "tools use only semantic identifiers returned by AKK: session_id for an exact " +
    "managed context, terminal_id for the currently verified pane, turn_id for " +
    "one managed Turn, watch_id for one Terminal Watch, and native_thread_id for " +
    "one resumable native thread. Draft text, composer digests, and opaque " +
    "freshness authority stay private; AKK revalidates them under its locks. Once " +
    "the mutation sequence begins, an uncertain result must not be automatically " +
    "retried. /akk watch is read-only and follows user intent: it prefers an " +
    "exact task anchor, but version, artifact, managed ownership, and " +
    "action-advertisement uncertainty degrade to a warning-bearing " +
    "terminal-activity Watch instead of vetoing the request. New/clear/resume, " +
    "approval, reconciliation, handoff, and recovery still require the documented " +
    "user intent or explicit confirmation. AKK never starts a coding-agent " +
    "process.",
  "Use /akk models on one exact currently advertised physical pane before /akk " +
    "set-model. Profiled Codex 0.154.0/0.155.1 may use either one exact current " +
    "native Session or a verified-zero-rollout pane; identify_foreground is " +
    "diagnostic and is never a prerequisite for that zero-rollout path. Claude " +
    "Code still requires one exact current native Session. Both steps require no " +
    "active Turn and no approval, questionnaire/editor, or read-only viewer. " +
    "model_options normally requires an empty Composer; when List binds it to one " +
    "exact stable Codex /model residual, it may continue only that residual into " +
    "read-only catalog discovery. repair_model_control remains the separate " +
    "clear-only alternative and never presses Enter or selects anything. Only ids " +
    "and reasoning efforts from that current native catalog are valid. Codex " +
    "changes the current session and persists the selected model for future " +
    "sessions; ordinary efforts, including max, are also persisted, while ultra " +
    "remains current-session-only and Codex chooses a non-ultra future fallback. " +
    "Claude Code changes only the current session. Read effective and " +
    "new_session_defaults separately. Model control never accepts slash text, raw " +
    "keys, menu indexes, display labels, scope overrides, or private authority; " +
    "an uncertain outcome must not be retried automatically."
] as const;
