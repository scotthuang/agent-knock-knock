import { randomUUID } from "node:crypto";
import path from "node:path";
import { cliDependencies, cliEnv, cliNow, cliNowMs, cliPid, cliSleepSync, writeCliStdout, runCliCommandExecution, setCliExitCode } from "./cli-runtime-context.js";
import { codexNativeRuntimeOptions } from "./codex-native-cli-adapter.js";
import { createCodexNativeRuntime, type CodexNativeRuntime } from "./codex-native-runtime.js";
import { isCodexNativeConversationId, parseCodexNativeConversationId } from "./codex-native-identity.js";
import { nativeErrorCode } from "./codex-native-task-service.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { associateConversationRoutes, resolveNativeTerminalRoute, proveNativeTerminalRoute, withClosedStatusInspection, canonicalTerminalRouteId, terminalRouteIdsMatch, type ConversationRouteAssociation } from "./conversation-routing-identity.js";
import type { ConversationRouteChoice } from "./conversation-route-store.js";
import { createConversationRuntimeRouteStore } from "./conversation-runtime-route-store.js";
import { dispatchConversationRoute } from "./conversation-route-dispatch.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { recordValue, nonBlankString } from "./value-guards.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import { isCodexPaginatedReadCandidate } from "./codex-lifecycle-compatibility.js";
import { selectLegacyConversationRoute } from "./conversation-route-legacy.js";
import { defaultStoreDir } from "./store.js";
import { expandHome } from "./cli-command-runtime.js";
import { conversationCommandPolicy, conversationRoutedOptions, prepareConversationTerminalOptions, routedCommand } from "./conversation-routing-commands.js";

type Options = Record<string, unknown>;
type Row = Record<string, unknown>;
type Selection = ConversationRouteChoice & { reason?: string };
export interface ConversationRoutingCliPorts {
  terminals(options: Options, terminalId?: string): Promise<Row[]>;
  /** Executes the existing command without entering this router again. */
  execute(command: string, options: Options): Promise<Row>;
}
const preflightUnavailable = new Set(["ENOENT", "ECONNREFUSED", "ECONNRESET", "ENOTSOCK", "ETIMEDOUT", "closed", "timeout", "unsupported_capability", "thread_not_loaded"]);

export async function executeConversationCommand(command: string | undefined, options: Options,
  terminals: ConversationRoutingCliPorts["terminals"], execute: (command: string | undefined, options: Options) => Promise<void>): Promise<void> {
  if (await dispatchRoutedConversationCli(command, options, {
    terminals: cliDependencies().conversationRoutingTerminals ?? terminals,
    execute: async (selectedCommand, selectedOptions) => {
      const result = await runCliCommandExecution(selectedCommand, selectedOptions, { ...cliDependencies(), stdout: undefined },
        () => execute(selectedCommand, selectedOptions));
      setCliExitCode(result.exitCode);
      return JSON.parse(result.stdout);
    }
  })) return;
  await execute(command, options);
}

/** A read failure is fallback evidence only here, before either task transport is invoked. */
export function backendPreflightUnavailable(error: unknown): boolean {
  const value = recordValue(error);
  return preflightUnavailable.has(nativeErrorCode(error)) && value?.dispatchState !== "unknown" && value?.dispatchState !== "accepted";
}

export async function dispatchRoutedConversationCli(command: string | undefined, original: Options,
  ports: ConversationRoutingCliPorts): Promise<boolean> {
  const target = routingTarget(command, original);
  if (!target || !command) return false;
  const options = { ...original };
  if (command === "send") options.messageId ??= randomUUID();
  const configuration = codexNativeRuntimeOptions(options);
  const runtime = (cliDependencies().createCodexNativeRuntime ?? createCodexNativeRuntime)(configuration);
  const identityOptions = {};
  const input = command === "send" ? {
    controllerSession: nonBlankString(options.openclawSession) ?? "agent:main:main",
    messageId: String(options.messageId), requestText: String(options.message ?? options.request ?? ""), canonicalTarget: target
  } : undefined;
  const terminalRuntimeDir = cliEnv().AKK_RUNTIME_DIR ? path.resolve(expandHome(cliEnv().AKK_RUNTIME_DIR)!) : path.join(path.dirname(defaultStoreDir()), "runtime-v2");
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  try {
    const result = await dispatchConversationRoute({ command, input,
      store: input ? createConversationRuntimeRouteStore(configuration.storeDir, terminalRuntimeDir, locks, { now: cliNow }) : undefined,
      select: async () => canonicalRouteSelection(await ((input ? selectLegacyConversationRoute({ input, nativeTasks: runtime.tasks,
        expectedTerminalToken: nonBlankString(options.expectedTerminalToken), managedOnly: options.managedOnly === true,
        terminalRuntimeDir }) : undefined)
        ?? selectConversationRoute({ command, target, options, runtime, ports, identityOptions }))),
      execute: async choice => {
        const selectedOptions = conversationRoutedOptions(command, options, choice.route, choice.targetId);
        const selectedCommand = routedCommand(command, options, choice.route);
        if (choice.route === "terminal") await prepareTerminalFallback({ command: selectedCommand, target, choice, selectedOptions, options, ports, identityOptions });
        return ports.execute(selectedCommand, selectedOptions);
      }
    });
    writeCliStdout(JSON.stringify(result, null, 2) + "\n");
    return true;
  } finally { await runtime.close(); }
}

function canonicalRouteSelection(choice: Selection): Selection {
  return choice.route === "terminal" ? { ...choice, targetId: canonicalTerminalRouteId(choice.targetId) } : choice;
}

function routingTarget(command: string | undefined, original: Options): string | undefined {
  const target = nonBlankString(original.conversation ?? original.conversationId ?? original.terminal ?? original.session);
  if (!command || !target || !conversationCommandPolicy(command, original)) return undefined;
  const native = isCodexNativeConversationId(target);
  const terminal = native ? undefined : parseTerminalConversationId(target);
  if (!native && terminal?.agent !== "codex") return undefined;
  // Diagnostic managed-only sends intentionally bypass physical inventory and routing.
  if (terminal && original.managedOnly === true) return undefined;
  assertRoutedInput(command, original, native);
  return target;
}

function assertRoutedInput(command: string, original: Options, native: boolean): void {
  if (!native && command === "send") terminalSubmissionPayload(String(original.message ?? original.request ?? ""));
  if (["conversation", "conversationId", "terminal", "session"].filter(key => original[key] !== undefined).length !== 1) {
    throw new Error("Conversation routing accepts exactly one conversation or terminal target");
  }
  if (command === "send" && (original.type ?? "task") !== "task") throw new Error("ordinary send only accepts message type task");
}

async function prepareTerminalFallback(input: { command: string; target: string; choice: ConversationRouteChoice;
  selectedOptions: Options; options: Options; ports: ConversationRoutingCliPorts; identityOptions: { defaultCodexHome?: string } }) {
  const { command, target, choice, selectedOptions, options, ports, identityOptions } = input;
  const rows = await ports.terminals(options, canonicalTerminalRouteId(choice.targetId));
  if (rows.length !== 1 || !terminalRouteIdsMatch(rows[0].id, choice.targetId) || isCodexNativeConversationId(target) && proveNativeTerminalRoute(target, rows[0], identityOptions).status !== "exact") {
    throw new Error("The selected conversation no longer has its exact terminal fallback; no input was sent");
  }
  prepareConversationTerminalOptions(command, selectedOptions, rows[0]);
}

async function selectConversationRoute(input: {
  command: string; target: string; options: Options; runtime: CodexNativeRuntime;
  ports: ConversationRoutingCliPorts; identityOptions: { defaultCodexHome?: string };
}): Promise<Selection> {
  const { target, options, runtime, ports, identityOptions } = input;
  if (isCodexNativeConversationId(target)) return selectNativeConversationRoute(input);
  const terminalId = canonicalTerminalRouteId(target);
  const terminals = await ports.terminals(options, terminalId);
  if (terminals.length !== 1 || !terminalRouteIdsMatch(terminals[0].id, target)) throw new Error("The exact selected terminal is unavailable");
  const policy = conversationCommandPolicy(input.command, options)!;
  if (!policy.backend) return { route: "terminal", targetId: terminalId, reason: "backend_operation_unavailable" };
  const discovery = await runtime.catalog.discover();
  const unsafe = discovery.errors.find(error => !preflightUnavailable.has(error.error_code));
  if (unsafe) throw new Error(`Backend discovery failed verification: ${unsafe.error_code}; no terminal fallback was attempted`);
  const rows = discovery.sessions.map(entry => ({ id: entry.nativeId, conversation_id: entry.nativeId,
    native_thread_id: entry.threadId, source: "codex_cli", agent: "codex", connection_state: "loaded_backend_verified" }));
  let match: ConversationRouteAssociation | undefined = associateConversationRoutes(terminals, rows, identityOptions).associations[0];
  // All supported conversation operations share identity acquisition. The existing closed transaction
  // may briefly inspect an idle CLI; a working/blocked terminal is never disturbed to learn its thread.
  if (!match && rows.length && mayInspectMissingAlias(terminals[0])) {
    match = await inspectMissingAlias(input, terminals[0], rows);
  }
  if (!match) {
    if (policy.requireBackend) throw new Error("The native interaction requires its exact backend identity; no terminal response was sent");
    return { route: "terminal", targetId: terminalId, reason: rows.length ? "native_identity_unresolved" : "backend_unavailable" };
  }
  try {
    const snapshot = await runtime.read(parseCodexNativeConversationId(match.nativeId));
    if (snapshot.threadId !== match.threadId || snapshot.thread.id !== match.threadId) throw new Error("Backend conversation identity mismatch");
    if (snapshot.loaded) return { route: "native", targetId: match.nativeId, reason: "exact_terminal_alias" };
  } catch (error) { if (!backendPreflightUnavailable(error)) throw error; }
  if (policy.requireBackend) throw new Error("The native interaction backend is unavailable; no terminal response was sent");
  return { route: "terminal", targetId: terminalId, reason: "backend_unavailable" };
}

async function selectNativeConversationRoute(input: {
  command: string; target: string; options: Options; runtime: CodexNativeRuntime;
  ports: ConversationRoutingCliPorts; identityOptions: { defaultCodexHome?: string };
}): Promise<Selection> {
  const { target, options, runtime, ports, identityOptions } = input;
  const identity = parseCodexNativeConversationId(target);
  const policy = conversationCommandPolicy(input.command, options)!;
  if (policy.backend) {
    try {
      const snapshot = await runtime.read(identity);
      if (snapshot.threadId !== identity.threadId || snapshot.thread.id !== identity.threadId) throw new Error("Backend conversation identity mismatch");
      if (snapshot.loaded) return { route: "native", targetId: target, reason: "backend_available" };
    } catch (error) { if (!backendPreflightUnavailable(error)) throw error; }
  }
  if (policy.requireBackend) throw new Error("The native interaction backend is unavailable; no terminal response was sent");
  const proof = resolveNativeTerminalRoute(target, await ports.terminals(options), identityOptions);
  if (proof.status !== "exact") throw new Error(`${policy.backend ? "Backend unavailable" : "AKK has no equivalent backend operation"}; no unique verified terminal fallback: ${proof.reason}`);
  return { route: "terminal", targetId: canonicalTerminalRouteId(proof.association.terminalId), reason: policy.backend ? "backend_unavailable" : "backend_operation_unavailable" };
}

function mayInspectMissingAlias(terminal: Row): boolean {
  if (terminal.activity_state !== "idle" || recordValue(terminal.approval_state)?.blocked === true) return false;
  if (!nonBlankString(terminal.native_agent_codex_home ?? terminal.codex_home)) return false;
  if (!isCodexPaginatedReadCandidate(terminal.agent_version) || nonBlankString(terminal.native_agent_session_id)) return false;
  const observation = recordValue(terminal.native_agent_identity_observation);
  return (observation?.status ?? terminal.native_identity_state) === "verified_absent";
}

async function inspectMissingAlias(input: {
  target: string; options: Options; ports: ConversationRoutingCliPorts; identityOptions: { defaultCodexHome?: string };
}, before: Row, rows: Row[]) {
  const prior = { ...before };
  if (!terminalRouteIdsMatch(prior.id, input.target)) throw new Error("Native status inspection did not find the exact selected terminal; no task input was sent");
  const terminalId = canonicalTerminalRouteId(input.target);
  const action = recordValue(recordValue(before.available_actions)?.native_inspect);
  const args = recordValue(action?.arguments);
  if (action?.tool !== "agent_knock_knock_native_inspect" || !nonBlankString(args?.expected_binding_token)) return undefined;
  const observation = await input.ports.execute("native-inspect",
    inspectionOptions(input.options, terminalId, String(args!.expected_binding_token)));
  const after = await input.ports.terminals(input.options, terminalId);
  if (after.length !== 1) throw new Error("Native status inspection lost its exact terminal; no task input was sent");
  const inspected = withClosedStatusInspection(prior, after[0], observation);
  const result = associateConversationRoutes([inspected], rows, input.identityOptions);
  const ambiguous = result.unassociated.find(item => item.reason !== "matching_loaded_backend_not_found");
  if (ambiguous) throw new Error(`Native status inspection could not safely resolve its backend: ${ambiguous.reason}; no task input was sent`);
  return result.associations[0];
}

function inspectionOptions(options: Options, target: string, token: string): Options {
  return { storeDir: options.storeDir, logDir: options.logDir, codexHome: options.codexHome,
    terminal: target, inspection: "status", expectedBindingToken: token };
}
