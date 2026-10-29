import { EXECUTOR_KINDS } from "./executors.js";
import { writeCliStdout } from "./cli-runtime-context.js";

export function usage() {
  const agentList = EXECUTOR_KINDS.join("|");
  writeCliStdout(`Usage:
  agent-knock-knock --help
  agent-knock-knock --version
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--reconcile] [--approval-scan | --no-approval-scan] [--terminal-debug] [--desktop-view sidebar|history] [--desktop-search <text>] [--desktop-project <id|path>] [--desktop-limit <1-100>] [--desktop-cursor <cursor>]
  agent-knock-knock watches [--hours <1-48>] [--limit <1-100>] [--cursor <cursor>] [--agent codex|claude] [--status <status>] [--conversation <exact-id>] [--store-dir <dir>]
  agent-knock-knock watch-terminal --terminal <exact-terminal-id> --openclaw-session <session> [--hard-timeout-minutes <minutes>] [--store-dir <dir>] [--openclaw-bin <path>]
  agent-knock-knock watch-status --watch <terminal-watch-id> [--store-dir <dir>]
  agent-knock-knock unwatch-terminal --watch <terminal-watch-id> [--store-dir <dir>]
  agent-knock-knock reconcile-watches [--store-dir <dir>]
  agent-knock-knock status [--turn <turn-id|selector>] [--conversation <selector>] [--store-dir <dir>] [--reconcile] [--trace]
  agent-knock-knock send [--session <session-id|selector>] [--conversation <selector>] --message <text> [--expected-terminal-token <token>] [--type task] [--agent-timeout-minutes <minutes>] [--agent-hard-timeout-minutes <minutes>]
  agent-knock-knock desktop-create --operation-id <desktop-create:sha256> --openclaw-session <controller> [--project <name|native-id>] [--cwd <path>] [--title <text>] [--message <first-task>] [--agent-hard-timeout-minutes <minutes>]
  agent-knock-knock desktop-create --operation-id <previous-operation-id> --openclaw-session <controller> --resume-creation
  agent-knock-knock new-thread --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock clear-thread --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock list-resumable-threads --terminal <exact-terminal-id> [--selection-scope <opaque-scope>]
  agent-knock-knock native-inspect --terminal <exact-terminal-id> --inspection status --expected-binding-token <token>
  agent-knock-knock model-options --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock permission-options --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock set-permissions --terminal <exact-terminal-id> --expected-binding-token <token> --expected-catalog-fingerprint <sha256> --mode <advertised-permission-id>
  agent-knock-knock repair-model-control --terminal <exact-terminal-id> --expected-binding-token <token>
  agent-knock-knock set-model --terminal <exact-terminal-id> --expected-binding-token <token> --expected-catalog-fingerprint <sha256> --model <semantic-id> --reasoning-effort <low|medium|high|xhigh|max|ultra>
  agent-knock-knock identify-foreground --terminal <exact-terminal-id> --expected-terminal-token <token>
  agent-knock-knock resume-thread --terminal <exact-terminal-id> --native-thread <uuid> --expected-binding-token <token> --candidate-token <token>
  agent-knock-knock resume-thread --terminal <exact-terminal-id> (--selection-handle <handle> | --selection-snapshot <id> (--selection-number <n> | --selection-short-id <@id>)) --selection-scope <opaque-scope>
  agent-knock-knock reconcile-binding --terminal <exact-terminal-id> --conflicting-session <session-id> --expected-session-revision <n> --expected-binding-token <token> --expected-terminal-token <token>
  agent-knock-knock transfer-store-authority --terminal <exact-terminal-id> --expected-authority-token <fresh-list-token> [--maintenance-acknowledgement]
  agent-knock-knock respond --turn <turn-id|selector> --message <text> [--conversation <selector>]
  agent-knock-knock respond-interaction (--turn <turn-id|selector> | --watch <watch-id>) --interaction <id> --response-json <json> --expected-interaction-fingerprint <fingerprint> --expected-interaction-expires-at <timestamp>  # async_question defaults to advertised steer_current_turn (delivery_mode may select queue_next_turn); questionnaire forbids it; never use raw keys or menu indexes
  agent-knock-knock approve [--turn <turn-id|selector>] [--conversation <selector>] [--decision approve_once|reject] [--expected-terminal-token <token>] --expected-approval-fingerprint <fingerprint>
  agent-knock-knock cancel [--turn <turn-id|selector>] [--conversation <selector>]
  agent-knock-knock renew (--watch <backend-watch-id> | --turn <turn-id|selector> | --conversation <legacy-selector>) [--minutes <positive-minutes>] [--openclaw-session <originating-controller>]
  agent-knock-knock recover (--watch <backend-watch-id> | --turn <backend-watch-id>) --openclaw-session <originating-controller>
  agent-knock-knock retry-callback (--watch <backend-watch-id> | --turn <turn-id|selector> | --conversation <legacy-selector>) [--notification-id <backend-notification-id>] [--openclaw-session <originating-controller>]
  agent-knock-knock close (--watch <backend-watch-id> | --turn <turn-id|selector> | --conversation <legacy-selector>) [--openclaw-session <originating-controller>] [--reason <text>] [--expected-message-id <message-id> | --expected-transition-id <transition-id> | --expected-handoff-token <token>]  # recovery fences are terminal-only; passive backend Watches use unwatch-terminal
  agent-knock-knock install-openclaw [--verify] [--openclaw-bin <path>] [--skill-path <path>] [--skill-only] [--no-restart]
  agent-knock-knock doctor [--openclaw-bin <path>] [--tmux-bin <path>] [--herdr-bin <path>]
  agent-knock-knock host-profile example
  agent-knock-knock host-profile list
  agent-knock-knock host-profile validate <profile.json|built-in-id> [--host <id> --host-version <version>]
  agent-knock-knock doctor --host-profile <profile.json|built-in-id> --host <id> --host-version <version>
  agent-knock-knock host-bridge --profile <profile.json|built-in-id> --host <id> --host-version <version> [--store-dir <dir>]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}
