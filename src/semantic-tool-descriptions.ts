// Model-facing wording is data; execution and authority stay in the tool runtime.
export const semanticToolDescriptions = {
  akk: "Claude Code direct connections support discovery, idle task sends, bounded public progress and exact observation without tmux, Herdr, hooks or agent-side plugins. Unsupported controls require the original terminal; do not send ordinary text as approval or cancellation. Choose a conversation from AKK List; AKK prefers a verified backend and uses eligible terminal delivery when unavailable. Control loaded Codex CLI threads through their backend: discover, " +
    "send, watch completion, answer questions, approve requests and set permissions " +
    "without tmux or Herdr. Discover Codex Desktop conversations, send tasks and watch their completion; " +
    "Desktop supports typed asynchronous and blocking answers, approvals, current-thread permissions/model settings and exact task cancellation. Send coding work " +
    "through existing Codex or Claude Code shared terminals, " +
    "inspect managed Turns, observe a user-selected terminal with durable " +
    "read-only Terminal Watch, manage native threads, and safely inspect or " +
    "change an idle pane's native model selection or Codex permissions.",
  watch: "Claude direct Watch observes one exact native input; idle alone is not success. Send already includes monitoring. Pass conversation_id from List; AKK prefers the exact backend observation route. Retain the returned watch_id; an existing Watch never changes its task or transport. For direct Codex CLI, watch its exact " +
    "task with a default 720-minute hard deadline unless overridden. Send already returns its automatic Watch; do not create a duplicate for the same submission. Observe the " +
    "active task; use the returned codex-cli-watch ID for Status and interactions. " +
    "For Desktop, use the exact conversation_id from List to watch one currently " +
    "active native task. An unresolved identity or idle thread is refused; Desktop " +
    "questions and approvals can be answered after Status using the exact current interaction. " +
    "For terminals, start one durable read-only Terminal Watch for the user's exact selected " +
    "Codex or Claude Code terminal. AKK prefers an exact durable task anchor; if " +
    "version, artifact, task, managed-ownership, or action-advertisement evidence " +
    "is unavailable, it remains callable and returns warnings while using " +
    "best-effort terminal activity. That fallback reports stable-idle activity, " +
    "not proof of exact task completion. Watch creates no AKK Session or Turn, " +
    "may first resolve an idle terminal alias with a closed native status probe, and never adopts or blocks the terminal task.",
  unwatch: "Stop one exact durable terminal, Desktop or direct Codex CLI Watch by its authoritative watch_id. This " +
    "cancels observation only; it sends no terminal input and does not interrupt, " +
    "adopt, or otherwise mutate the human's coding-agent task.",
  list_resumable_threads: "List structurally verified native Codex or Claude Code threads for one exact " +
    "terminal. A valid unverified agent version remains callable with a " +
    "compatibility warning. Resume only a row with resumable=true by passing this " +
    "terminal_id and that row's complete native_thread_id. AKK retains candidate " +
    "and binding freshness evidence privately. Number and short-id fields are " +
    "slash-command display aids, never tool arguments. This is read-only for " +
    "Session/Turn state and creates no AKK Turn.",
  native_inspect: "Pass a listed conversation_id and inspection=status. AKK prefers the exact available backend. For a Desktop or direct Codex CLI conversation_id, read native backend status " +
    "without TUI input. For terminal_id, execute one closed native status inspection in an exact Codex or Claude Code " +
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
  status: "Inspect conversation_id from List; AKK prefers the exact backend, resolving an idle terminal alias with a safe native status probe when needed. For a task result use its returned watch_id or turn_id, without migrating that observation. Inspect direct Codex CLI conversation_id or codex-cli-watch watch_id through " +
    "its backend. CLI/Desktop progress contains at most 800 Unicode code points of redacted public commentary and short action summaries for that exact task, with read_at, nullable native latest_item_at, and truncated. Distinguish no_public_progress from read_error; neither proves completion. List has no progress body. Inspect " +
    "its backend, including current typed approvals and questions. Inspect one exact managed Turn by turn_id, a terminal or Desktop Watch " +
    "by watch_id, or a conversation_id returned by List. Desktop status reads " +
    "the original thread when reachable; metadata alone cannot prove live task " +
    "state. Desktop asynchronous/blocking questions and approvals support typed replies after Status. Targets " +
    "are mutually exclusive. Legacy Turn aliases and list-prefilled raw-terminal " +
    "selectors remain supported; never construct a conversation_id. User-selected " +
    "Watch status reports whether it uses an exact task anchor or best-effort " +
    "terminal activity without implying Watch sent or adopted the task; that task " +
    "may independently be managed. Automatic terminal_user_explicit fallback " +
    "Watch status describes the exact request AKK physically sent without " +
    "claiming a managed Turn. AKK never starts a coding agent.",
  send: "Claude direct Send supports idle sessions only; busy or blocked is not transport unavailability. Preserve any uncertain receipt and inspect Status instead of resending. Pass request and conversation_id from List. AKK prefers a backend only when the exact same live thread is proven, otherwise retaining eligible terminal delivery. Targeted conversation operations may use the safe native /status identity probe when needed; List sends no input. It never retries uncertain dispatch through another route. Backend busy or blocked state is not transport unavailability. For direct Codex CLI, AKK " +
    "uses a shared default 720-minute monitoring hard deadline unless overridden; terminal inactivity remains separate. Do not create another Watch when the receipt already provides automatic monitoring. AKK " +
    "submits once to the loaded backend thread, inherits its settings and binds " +
    "an exact native-task Watch for completion and interaction callbacks; no " +
    "terminal input or replacement process is used. Preserve uncertain receipts " +
    "and never repeat a send blindly. For Desktop, pass request and the exact conversation_id from List. AKK " +
    "requires a reachable idle original owner, inherits thread settings, sends " +
    "once and monitors the exact accepted task. It never automatically opens a " +
    "thread, approves, answers blocking questions or retries an uncertain Desktop send. " +
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
  respond_interaction: "For Desktop use its conversation_id or desktop-watch watch_id after Status shows " +
    "the current async_question or blocking_question. Answer every question in that request using " +
    "advertised single_select/free_text ids. For async questions only steer_current_turn is supported; omit delivery_mode for blocking questions. " +
    "AKK rechecks the original owner, exact active task and unchanged request. Use approve for approvals. A displayed expiry " +
    "triggers a live question recheck, not automatic refusal of the same pending question. " +
    "For Codex CLI use its listed conversation_id (including an exact terminal alias) or exact " +
    "codex-cli-watch watch_id and current interaction_id with typed answers. " +
    "The backend revalidates that exact request and turn; async replies use " +
    "steer_current_turn only; supply every question in that native request. " +
    "For terminal targets, answer exactly one current native interaction step shown by " +
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
  approve: "Use the listed conversation_id or its exact desktop-watch/codex-cli-watch watch_id " +
    "plus the pending interaction_id from Status, and the authorized approve_once " +
    "or reject decision. Dispatch one closed semantic decision for the current exact permission " +
    "request only after the user reviews and explicitly chooses it. decision " +
    "defaults to approve_once for compatibility. On terminal targets, reject is " +
    "available only on a managed Turn when the adapter proves a safe native reject choice. Use " +
    "turn_id for a managed Turn or terminal_id for a separately advertised " +
    "approve_once-only terminal action. AKK privately refreshes the prompt and " +
    "authority, then recaptures it under lock. Raw keys, indexes, and labels are " +
    "not accepted. Never retry an interrupted decision blindly.",
  renew: "Renew monitoring for an exact terminal turn_id or original Codex CLI/Desktop " +
    "task watch_id (also returned as turn_id by Send). Backend renewal verifies the original " +
    "bound task and extends its deadline using explicit minutes, then hard-timeout configuration, then the 720-minute default. Terminal managed renewal instead refreshes inactivity within its original hard lifetime. It never follows the current task or sends input.",
  recover: "Reobserve and reconcile one exact original Codex CLI or Desktop task using its " +
    "watch_id or send-produced turn_id and restart its monitor when appropriate. Only the " +
    "originating controller can recover it. This does not extend its deadline, replay input, " +
    "rebind to the current task, or detach management. Terminal binding repair uses its existing dedicated tools.",
  retry_callback: "Retry a persisted AKK callback that is known not to have reached the " +
    "originating controller. Select an exact terminal turn_id or backend watch_id/send-produced turn_id. " +
    "For backend tasks, supply notification_id when selection is ambiguous; otherwise AKK " +
    "selects the unique eligible notification. Accepted, uncertain, or leased delivery is never " +
    "replayed. The original callback message id and task identity are preserved.",
  cancel: "For Desktop, interrupt an exact watch_id task or conversation_id plus current " +
    "expected_native_turn_id from Status. Changed tasks are rejected; stopping a Watch alone never interrupts it. " +
    "Otherwise interrupt one exact AKK turn_id, or use only an unmanaged raw terminal row's " +
    "own prefilled cancel action. Claude sends Escape; Codex uses its declared " +
    "interrupt key. The shared terminal pane remains open for human takeover.",
  close: "Honor an explicit user request to close one managed terminal turn_id or exact " +
    "send-managed backend watch_id/send-produced turn_id and release AKK management. " +
    "Passive backend Watches use Unwatch. Backend Close never interrupts the native task and " +
    "requires its originating controller. Raw orphan recovery may instead use conversation_id with " +
    "expected_message_id or expected_transition_id. Close never sends terminal " +
    "input, stops the coding agent, or closes the shared pane. Deferred transfer, " +
    "Session, ledger, and callback cleanup is best-effort and cannot veto closing " +
    "the Turn; warnings identify metadata AKK preserved. Refresh list afterward " +
    "and use Watch if the coding agent is still working.",
  list: "List conversations and Watches. Choose conversation_id; AKK selects the available " +
    "route and merges only proven exact terminal/backend matches. Desktop defaults to saved expanded " +
    "sidebar membership, not the viewport; desktop_view=history selects saved history. Keep unconnected " +
    "rows and limitations. live_count covers this page; desktopSearch/desktopProject/desktopCursor " +
    "filter/page. Use available_actions/action_inputs and the agent-knock-knock skill; mutations revalidate privately.",
  model_options: "For a Desktop conversation_id, read current model/effort/collaboration mode; " +
    "the owner exposes no model catalog (catalog_available=false), so use only a model explicitly requested by the user. " +
    "For terminal_id, inspect the exact current native model catalog for one explicitly selected " +
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
  set_model: "For an idle Desktop conversation_id, set an explicit model/reasoning_effort tuple " +
    "and optional collaboration_mode plan/default, then verify the effective original-thread settings. " +
    "Desktop does not expose a model catalog; never guess available models. Scope is current_session and defaults stay unchanged. " +
    "For terminal_id, change exactly one already-open physical coding-agent pane to one semantic " +
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
    "approval, lifecycle, or send authority. List never runs a probe; targeted conversation routing may separately resolve " +
    "an idle terminal with the native status inspection.",
  identify_and_send: "Explicitly identify the foreground Codex native thread with one closed " +
    "/status probe, then dispatch one task while retaining the same terminal " +
    "lock. This is an optional managed-attachment enhancement, not a prerequisite " +
    "for ordinary human Send. The short-lived status observation never becomes " +
    "durable identity: only the rollout that uniquely accepts the exact task may " +
    "own the resulting Session/Turn. If the probe or boundary becomes uncertain, " +
    "AKK does not send or retry the task.",
} as const;

export const semanticCommandGuidance = [
  "Select conversations[] by title and project, then use its conversation_id. AKK prefers the backend for supported commands and uses the exact terminal when that operation has no backend implementation. Bound Watch/Turn operations retain their original provider. Only exact identity evidence merges duplicate representations; same directory is not identity. Keep returned Watch IDs and current interaction actions; never retry uncertain input on another route.",
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
    "retried. /akk watch follows user intent and prefers an " +
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
