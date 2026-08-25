import { spawnSync } from "node:child_process";
import type { CodingAgentSessionProvider } from "./agent-session-provider.js";
import type { ForkContextPackage } from "./codex-session-provider.js";
import type { ActiveCodexProcess } from "./codex-session-provider.js";
import { CodexLocalSessionProvider, InlineCodexLocalSessionAdapter } from
  "./codex-local-session-provider.js";
import { CodexStoreAdapter } from "./codex-store-adapter.js";
import { createCodexTerminalAgentAdapter, detectCodexDurableCompletion } from
  "./codex-terminal-agent-adapter.js";
import { createClaudeTerminalAgentAdapter, type ClaudeAgentRow } from
  "./claude-terminal-agent-adapter.js";
import { detectClaudeTranscriptCompletion, detectClaudeTranscriptPendingApproval }
  from "./claude-local-transcript-provider.js";
import {
  cleanProcessText,
  expandHome,
  parseJsonOption,
  resolveOptionalExecutable
} from "./cli-command-runtime.js";
import { cliRuntimeLog, type CliCommandDependencies } from "./cli-runtime-context.js";
import type { ExecutorKind } from "./executors.js";
import { HerdrTerminalControlProvider } from "./herdr-terminal-control-provider.js";
import {
  type TerminalAgentAdapterRegistry,
  type TerminalCompletionEvidence,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalNativeIdentityFence,
  type TerminalProcessSnapshot,
  type TerminalRuntimeIdentity,
  type TerminalThreadLifecycleCandidateProvider
} from "./terminal-agent-adapter.js";
import { TerminalAgentBridge, type TerminalIdentityVerificationRequest } from
  "./terminal-agent-bridge.js";
import { createProductionTerminalAgentRegistry } from "./terminal-agent-registry.js";
import { associateTerminalEndpointEvidence } from "./terminal-control-ref.js";
import {
  createTerminalControlProviderRegistry,
  StaticTerminalControlProvider,
  TmuxTerminalControlProvider,
  type TerminalControlProvider,
  type TerminalControlProviderRegistry,
  type TerminalPane
} from "./terminal-control-provider.js";
import { StaticTerminalProcessSource, SystemTerminalProcessSource,
  type TerminalProcessSource } from "./terminal-process-source.js";
import { isRecord, nonBlankString } from "./value-guards.js";

const TERMINAL_CONTROL_CAPABILITIES = ["screen_status", "send_keys",
  "terminal_approval", "screen_completion", "durable_completion",
  "terminal_cancel"] as const satisfies readonly TerminalControlCapability[];

export type TerminalRuntimeCliOptions = Readonly<Record<string, unknown>>;
type TerminalRuntimeDependencyKey = "terminalControlProviderRegistry" |
  "terminalProcessSource" | "loadClaudeAgentRows" |
  "agentVersionForRunningProcess" | "createAgentSessionProvider" |
  "codexLocalSessionAdapter" | "codexThreadLifecycleProvider" |
  "monotonicNowMs" | "sleep";

export type TerminalRuntimeCliDependencies = Readonly<Pick<
  CliCommandDependencies<TerminalRuntimeCliOptions>, TerminalRuntimeDependencyKey
>>;
export interface CodexCompletionContextMatch {
  context: ForkContextPackage; match: string;
  confidence: "high" | "medium" | "low";
}
export interface TerminalRuntimeCompletionPorts {
  detectExactBound(input: Readonly<{
    conversation: Readonly<Record<string, unknown>>;
    nativeTakeover?: Readonly<Record<string, unknown>>;
    request: TerminalDurableCompletionRequest;
    runtime?: Readonly<Record<string, unknown>>;
  }>): { handled: boolean; completion?: TerminalCompletionEvidence };
  loadCodexContexts(nativeTakeover?: Readonly<Record<string, unknown>>):
    Promise<readonly CodexCompletionContextMatch[]>;
}
export interface RuntimeNativeIdentityRequest {
  agent: ExecutorKind; pid: number; cwd?: string; preferredSessionId?: string;
  allowedCompanionIdentity?: TerminalNativeIdentityFence;
  allowedAdditionalIdentities?: readonly TerminalNativeIdentityFence[];
}
export interface TerminalRuntimeIdentityPorts {
  resolveCurrent(request: RuntimeNativeIdentityRequest): Promise<unknown>;
  assertRuntime(input: Readonly<{
    runtime?: TerminalRuntimeIdentity; currentIdentity: unknown;
    agent: ExecutorKind; pid: number;
  }>): void;
}
export interface TerminalRuntimeWorkspacePorts {
  assertConfigured(configured: unknown, candidate: unknown, subject: string): void;
}
export interface CreateTerminalRuntimeCliAdapterInput {
  options: TerminalRuntimeCliOptions; dependencies: TerminalRuntimeCliDependencies;
  completion: TerminalRuntimeCompletionPorts; identity: TerminalRuntimeIdentityPorts;
  workspace: TerminalRuntimeWorkspacePorts;
}
export interface TerminalRuntimeCliAdapter {
  createControlProviderRegistry(): TerminalControlProviderRegistry;
  createControlProvider(registry?: TerminalControlProviderRegistry): TerminalControlProvider;
  createProcessSource(): TerminalProcessSource;
  loadClaudeAgentRows(observation?: { required?: boolean }): ClaudeAgentRow[];
  createAgentRegistry(): TerminalAgentAdapterRegistry;
  createBridge(provider?: TerminalControlProvider,
    registry?: TerminalAgentAdapterRegistry): TerminalAgentBridge;
  createAgentSessionProvider(agent: string): CodingAgentSessionProvider;
  createThreadLifecycleCandidateProvider(
    agent: ExecutorKind
  ): TerminalThreadLifecycleCandidateProvider;
  listActiveSessionsWithTerminalControl(
    provider: CodingAgentSessionProvider,
    terminalProvider?: TerminalControlProvider
  ): Promise<ActiveCodexProcess[]>;
  agentVersionForRunningProcess(agent: ExecutorKind, pid: number): string | undefined;
}

/**
 * Build command-scoped terminal runtime infrastructure without process-global
 * provider state. Business completion and native-identity authority remain in
 * the callbacks supplied by the CLI composition root.
 */
export function createTerminalRuntimeCliAdapter(
  input: CreateTerminalRuntimeCliAdapterInput
): TerminalRuntimeCliAdapter {
  const createControlProviderRegistry = () => controlProviderRegistry(input);
  const createControlProvider = (
    registry: TerminalControlProviderRegistry = createControlProviderRegistry()
  ) => registry.asProvider();
  const createProcessSource = () => processSource(input);
  const loadClaudeAgentRows = (observation: { required?: boolean } = {}) =>
    claudeAgentRows(input, observation);
  const createAgentRegistry = () => terminalAgentRegistry(input, loadClaudeAgentRows);
  const createBridge = (
    terminalProvider: TerminalControlProvider = createControlProvider(),
    registry: TerminalAgentAdapterRegistry = createAgentRegistry()
  ) => terminalAgentBridge(input, {
    terminalProvider, registry, processSource: createProcessSource(), loadClaudeAgentRows
  });
  const createAgentSessionProvider = (agent: string) =>
    agentSessionProvider(input, agent);
  const createThreadLifecycleCandidateProvider = (agent: ExecutorKind) =>
    threadLifecycleCandidateProvider(input, agent);
  const listActiveSessionsWithTerminalControl = (
    provider: CodingAgentSessionProvider,
    terminalProvider: TerminalControlProvider = createControlProvider()
  ) => attachActiveSessions(input, provider, terminalProvider);
  return Object.freeze({
    createControlProviderRegistry, createControlProvider, createProcessSource,
    loadClaudeAgentRows, createAgentRegistry, createBridge,
    createAgentSessionProvider, createThreadLifecycleCandidateProvider,
    listActiveSessionsWithTerminalControl,
    agentVersionForRunningProcess: (agent: ExecutorKind, pid: number) =>
      runningAgentVersion(input, agent, pid)
  });
}

function threadLifecycleCandidateProvider(
  input: Pick<CreateTerminalRuntimeCliAdapterInput, "options" | "dependencies">,
  agent: ExecutorKind
): TerminalThreadLifecycleCandidateProvider {
  if (agent !== "codex") {
    throw new Error(`unsupported thread lifecycle candidate provider: ${agent}`);
  }
  return input.dependencies.codexThreadLifecycleProvider ?? new CodexStoreAdapter({
    codexHome: expandHome(input.options.codexHome as string | undefined)
  });
}

function agentSessionProvider(
  input: Pick<CreateTerminalRuntimeCliAdapterInput, "options" | "dependencies">,
  agent: string
): CodingAgentSessionProvider {
  if (agent !== "codex") {
    throw new Error(`unsupported agent session provider: ${agent as string}`);
  }
  const injected = input.dependencies.createAgentSessionProvider;
  if (injected) {
    return injected(agent, input.options);
  }
  const injectedAdapter = input.dependencies.codexLocalSessionAdapter;
  if (injectedAdapter) {
    return new CodexLocalSessionProvider(
      typeof injectedAdapter === "function"
        ? injectedAdapter(input.options)
        : injectedAdapter
    );
  }
  if (
    input.options.threadsJson ||
    input.options.processesJson ||
    input.options.rolloutsJson ||
    input.options.codexActiveSessionIdentitiesJson
  ) {
    return new CodexLocalSessionProvider(new InlineCodexLocalSessionAdapter({
      threads: parseJsonOption(input.options.threadsJson, "--threads-json") as
        ConstructorParameters<typeof InlineCodexLocalSessionAdapter>[0]["threads"],
      processes: parseJsonOption(input.options.processesJson, "--processes-json") as
        ConstructorParameters<typeof InlineCodexLocalSessionAdapter>[0]["processes"],
      rollouts: parseJsonOption(input.options.rolloutsJson, "--rollouts-json") as
        ConstructorParameters<typeof InlineCodexLocalSessionAdapter>[0]["rollouts"],
      activeSessionIdentities: parseJsonOption(
        input.options.codexActiveSessionIdentitiesJson,
        "--codex-active-session-identities-json"
      ) as ConstructorParameters<typeof InlineCodexLocalSessionAdapter>[0][
        "activeSessionIdentities"
      ]
    }));
  }
  return new CodexLocalSessionProvider(new CodexStoreAdapter({
    codexHome: expandHome(input.options.codexHome as string | undefined)
  }));
}

async function attachActiveSessions(
  input: CreateTerminalRuntimeCliAdapterInput,
  provider: CodingAgentSessionProvider,
  terminalProvider: TerminalControlProvider
): Promise<ActiveCodexProcess[]> {
  const activeSessions = await provider.listActiveSessions();
  const activePids = new Set(activeSessions.map((session) => session.pid));
  const processTree = activePids.size > 0
    ? await processSource(input).listProcessSnapshots(
        (snapshot) => activePids.has(snapshot.pid),
        { includeCwd: false, includeAncestors: true }
      )
    : [];
  return terminalAgentBridge(input, {
    terminalProvider,
    registry: terminalAgentRegistry(input,
      (observation = {}) => claudeAgentRows(input, observation)),
    processSource: processSource(input),
    loadClaudeAgentRows: (observation = {}) => claudeAgentRows(input, observation)
  }).attachProcesses(provider.agent, activeSessions, { processTree });
}
function controlProviderRegistry({ options, dependencies }: Pick<
  CreateTerminalRuntimeCliAdapterInput,
  "options" | "dependencies">): TerminalControlProviderRegistry {
  const injected = dependencies.terminalControlProviderRegistry;
  if (injected) {
    return injected;
  }
  const isStatic = Boolean(options.terminalsJson || options.terminalScreensJson ||
    options.processesJson);
  return createTerminalControlProviderRegistry([
    isStatic
      ? new StaticTerminalControlProvider({
          panes: options.terminalsJson
            ? parseJsonOption(options.terminalsJson, "--terminals-json") as TerminalPane[]
            : [],
          screens: options.terminalScreensJson
            ? parseJsonOption(options.terminalScreensJson,
                "--terminal-screens-json") as Record<string, string>
            : {}
        })
      : new TmuxTerminalControlProvider(),
    ...(isStatic ? [] : [new HerdrTerminalControlProvider()])
  ]);
}
function processSource({ options, dependencies }: Pick<
  CreateTerminalRuntimeCliAdapterInput,
  "options" | "dependencies">): TerminalProcessSource {
  const injected = dependencies.terminalProcessSource;
  if (injected) {
    return injected;
  }
  const isStatic = Boolean(options.terminalsJson || options.terminalScreensJson ||
    options.processesJson);
  if (isStatic) {
    return new StaticTerminalProcessSource(
      options.processesJson
        ? parseJsonOption(options.processesJson, "--processes-json") as
          readonly TerminalProcessSnapshot[]
        : []
    );
  }
  return new SystemTerminalProcessSource();
}
function claudeAgentRows(
  input: Pick<CreateTerminalRuntimeCliAdapterInput, "options" | "dependencies">,
  observation: { required?: boolean }
): ClaudeAgentRow[] {
  const injected = input.dependencies.loadClaudeAgentRows;
  if (injected) {
    return injected(input.options, observation);
  }
  const value = readClaudeAgentRowsValue(input.options, observation);
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : undefined;
  if (!rows) {
    if (observation.required) {
      throw new Error("Claude agent session observation returned an unsupported " +
        "result shape; refusing to treat the process as a virgin session");
    }
    return [];
  }
  return normalizeClaudeAgentRows(rows);
}
function readClaudeAgentRowsValue(
  options: TerminalRuntimeCliOptions,
  observation: { required?: boolean }
): unknown {
  if (options.claudeAgentsJson !== undefined) {
    return typeof options.claudeAgentsJson === "string"
      ? parseJsonOption(options.claudeAgentsJson, "--claude-agents-json")
      : options.claudeAgentsJson;
  }
  if (options.processesJson || options.terminalsJson || options.terminalScreensJson) {
    return [];
  }
  const claudeExecutable = resolveOptionalExecutable("claude");
  if (!claudeExecutable) {
    if (observation.required) {
      throw new Error("Claude agent session observation is unavailable because " +
        "the Claude CLI could not be resolved");
    }
    return [];
  }
  const result = spawnSync(claudeExecutable, ["agents", "--json", "--all"], {
    encoding: "utf8", maxBuffer: 1024 * 1024 * 10, timeout: 10_000
  });
  if (result.error || result.status !== 0) {
    cliRuntimeLog("warn", "claude_agents_list_failed", {
      status: result.status ?? null,
      error: result.error?.message,
      stderr: textSummary(cleanProcessText(result.stderr))
    });
    if (observation.required) {
      throw new Error("Claude agent session observation failed; refusing to " +
        "treat the process as a virgin session");
    }
    return [];
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    cliRuntimeLog("warn", "claude_agents_list_invalid_json",
      { stdout: textSummary(result.stdout) });
    if (observation.required) {
      throw new Error("Claude agent session observation returned invalid JSON; " +
        "refusing to treat the process as a virgin session");
    }
    return [];
  }
}
function normalizeClaudeAgentRows(rows: readonly unknown[]): ClaudeAgentRow[] {
  return rows.flatMap((row): ClaudeAgentRow[] => {
    if (!isRecord(row) || !Number.isInteger(Number(row.pid))) {
      return [];
    }
    return [{
      pid: Number(row.pid),
      ...(nonBlankString(row.cwd) ? { cwd: nonBlankString(row.cwd) } : {}),
      ...(nonBlankString(row.kind) ? { kind: nonBlankString(row.kind) } : {}),
      ...(nonBlankString(row.sessionId) ? { sessionId: nonBlankString(row.sessionId) } : {}),
      ...(Number.isSafeInteger(Number(row.startedAt)) && Number(row.startedAt) > 0
        ? { startedAt: Number(row.startedAt) }
        : {}),
      ...(nonBlankString(row.status) ? { status: nonBlankString(row.status) } : {}),
      ...(nonBlankString(row.waitingFor) ?
        { waitingFor: nonBlankString(row.waitingFor) } : {})
    }];
  });
}
function terminalAgentRegistry(
  input: CreateTerminalRuntimeCliAdapterInput,
  loadClaudeAgentRows: (observation?: { required?: boolean }) => ClaudeAgentRow[]
): TerminalAgentAdapterRegistry {
  return createProductionTerminalAgentRegistry({
    overrides: [
      createCodexTerminalAgentAdapter({
        detectDurableCompletion: (request) => detectCodexCompletion(
          request, input.completion)
      }),
      createClaudeTerminalAgentAdapter({
        agentRows: loadClaudeAgentRows(),
        detectPendingApproval(request) {
          return detectClaudeTranscriptPendingApproval(request, {
            claudeHome: expandHome(input.options.claudeHome as string | undefined),
            agentRows: loadClaudeAgentRows()
          });
        },
        async detectDurableCompletion(request) {
          return detectClaudeTranscriptCompletion(request, {
            claudeHome: expandHome(input.options.claudeHome as string | undefined),
            agentRows: loadClaudeAgentRows()
          });
        }
      })
    ]
  });
}
async function detectCodexCompletion(
  request: TerminalDurableCompletionRequest,
  completion: TerminalRuntimeCompletionPorts
): Promise<TerminalCompletionEvidence | undefined> {
  const runtime = isRecord(request.context) ? request.context : undefined;
  const conversation = runtime?.conversation;
  const nativeTakeover = isRecord(runtime?.nativeTakeover) ?
    runtime.nativeTakeover : undefined;
  if (!isRecord(conversation)) {
    return undefined;
  }
  const exactCompletion = completion.detectExactBound(
    { conversation, nativeTakeover, request, runtime });
  if (exactCompletion.handled) {
    return exactCompletion.completion;
  }
  return detectPlausibleCodexCompletion(request,
    await completion.loadCodexContexts(nativeTakeover));
}
function detectPlausibleCodexCompletion(
  request: TerminalDurableCompletionRequest,
  contextMatches: readonly CodexCompletionContextMatch[]
): TerminalCompletionEvidence | undefined {
  const matches: TerminalCompletionEvidence[] = [];
  const detectionErrors: string[] = [];
  for (const contextMatch of contextMatches) {
    try {
      const evidence = detectCodexDurableCompletion(
        { ...request, context: contextMatch.context });
      if (evidence) {
        matches.push({
          ...evidence,
          confidence: contextMatch.confidence,
          metadata: {
            ...evidence.metadata, context_match: contextMatch.match,
            session: contextMatch.context.source
          }
        });
      }
    } catch (error) {
      detectionErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (detectionErrors.length > 0) {
    throw new Error("could not inspect every plausible Codex completion: " +
      detectionErrors.join("; "));
  }
  if (matches.length > 1) {
    throw new Error("multiple same-cwd Codex sessions match the managed " +
      "terminal request");
  }
  return matches[0];
}
interface BridgeComposition {
  terminalProvider: TerminalControlProvider; registry: TerminalAgentAdapterRegistry;
  processSource: TerminalProcessSource;
  loadClaudeAgentRows(observation?: { required?: boolean }): ClaudeAgentRow[];
}
function terminalAgentBridge(
  input: CreateTerminalRuntimeCliAdapterInput,
  composition: BridgeComposition
): TerminalAgentBridge {
  return new TerminalAgentBridge({
    registry: composition.registry, terminalProvider: composition.terminalProvider,
    ...(input.dependencies.monotonicNowMs ?
      { nowMs: input.dependencies.monotonicNowMs } : {}),
    ...(input.dependencies.sleep ? { sleep: input.dependencies.sleep } : {}),
    verifyIdentity: (request) => verifyTerminalIdentity(input, composition, request)
  });
}
async function verifyTerminalIdentity(
  input: CreateTerminalRuntimeCliAdapterInput,
  composition: BridgeComposition,
  request: Readonly<TerminalIdentityVerificationRequest>
): Promise<{ terminalControl: TerminalControlRef }> {
  const { agent, pid, terminalControl, runtime } = request;
  const adapter = composition.registry.require(agent);
  const provider = composition.terminalProvider;
  const resolvedTerminal = await provider.resolve(provider.endpoint(terminalControl));
  const expectedWorkspace = input.options.workspace ??
    resolvedTerminal.route.currentPath ?? terminalControl.currentPath;
  if (!expectedWorkspace) {
    throw new Error(`refusing terminal access to ${terminalControl.target}; ` +
      "its workspace is unavailable");
  }
  const snapshots = await composition.processSource.listProcessSnapshots(
    (candidate) => candidate.pid === pid,
    { includeCwd: true, includeAncestors: true }
  );
  const snapshot = requireTerminalProcessCurrent({
    workspace: input.workspace, provider, adapter, agent, pid, terminalControl,
    resolvedTerminal, expectedWorkspace, snapshots,
    candidate: snapshots.find((candidate) => candidate.pid === pid)
  });
  const currentNativeIdentity = requiresNativeIdentity(runtime)
    ? await input.identity.resolveCurrent({
        agent,
        pid,
        cwd: snapshot.cwd ?? resolvedTerminal.route.currentPath,
        preferredSessionId: preferredNativeSessionId(runtime),
        allowedCompanionIdentity: runtime?.allowedPreMaterializationNativeIdentity,
        allowedAdditionalIdentities: runtime?.allowedAdditionalNativeIdentities
      })
    : undefined;
  input.identity.assertRuntime(
    { runtime, currentIdentity: currentNativeIdentity, agent, pid });
  assertExactClaudeAgentIdentity({
    composition, adapter, agent, pid,
    cwd: snapshot.cwd ?? resolvedTerminal.route.currentPath, runtime
  });
  return {
    terminalControl: provider.toControlRef(resolvedTerminal,
      terminalControl.capabilities)
  };
}
type RuntimeAgentAdapter = ReturnType<TerminalAgentAdapterRegistry["require"]>;
type RuntimeResolvedTerminal = Awaited<
  ReturnType<TerminalControlProvider["resolve"]>
>;
interface CurrentTerminalProcessInput {
  workspace: TerminalRuntimeWorkspacePorts; provider: TerminalControlProvider;
  adapter: RuntimeAgentAdapter; agent: ExecutorKind; pid: number;
  terminalControl: TerminalControlRef; expectedWorkspace: unknown;
  resolvedTerminal: RuntimeResolvedTerminal;
  candidate?: TerminalProcessSnapshot;
  snapshots: readonly TerminalProcessSnapshot[];
}
function requireTerminalProcessCurrent(
  input: Readonly<CurrentTerminalProcessInput>
): TerminalProcessSnapshot {
  if (!input.candidate || !input.adapter.classifyProcess(input.candidate)) {
    throw new Error(`terminal conversation agent ${input.agent} with pid ` +
      `${input.pid} is no longer active`);
  }
  if (!input.provider.containsProcess(input.resolvedTerminal, input.candidate,
    input.snapshots)) {
    throw new Error(`terminal conversation agent ${input.agent} with pid ` +
      `${input.pid} no longer belongs to pane ${input.terminalControl.target}`);
  }
  input.workspace.assertConfigured(input.expectedWorkspace, input.candidate.cwd,
    `terminal access to ${input.terminalControl.target} by agent process ${input.pid}`);
  input.workspace.assertConfigured(input.expectedWorkspace,
    input.resolvedTerminal.route.currentPath,
    `terminal access to ${input.terminalControl.target} by terminal endpoint`);
  return input.candidate;
}
function requiresNativeIdentity(runtime?: TerminalRuntimeIdentity): boolean {
  return Boolean(runtime?.nativeSessionId || runtime?.nativeProcessUuid ||
    runtime?.nativeProcessBirth || runtime?.nativeRollout ||
    runtime?.requireNativeProcessUuid || runtime?.requireExactClaudeAgentRow ||
    runtime?.nativeProcessStartedAt || runtime?.exactClaudeAgentState ||
    runtime?.requireNativeRolloutIdentity || runtime?.expectedNativeSessionId ||
    runtime?.expectedEmptyNativeSession ||
    runtime?.allowedPreMaterializationNativeIdentity ||
    runtime?.allowedAdditionalNativeIdentities?.length);
}
function preferredNativeSessionId(runtime?: TerminalRuntimeIdentity): string | undefined {
  const expectedSessionId = runtime?.expectedNativeSessionId ?? runtime?.nativeSessionId;
  return runtime?.allowedPreMaterializationNativeIdentity &&
    expectedSessionId &&
    runtime.allowedPreMaterializationNativeIdentity.sessionId !== expectedSessionId
    ? expectedSessionId
    : undefined;
}
function assertExactClaudeAgentIdentity(input: Readonly<{
  composition: BridgeComposition; adapter: RuntimeAgentAdapter;
  agent: ExecutorKind; pid: number; cwd?: string;
  runtime?: TerminalRuntimeIdentity;
}>): void {
  if (input.runtime?.requireExactClaudeAgentRow !== true) {
    return;
  }
  if (
    input.agent !== "claude" ||
    !Number.isSafeInteger(input.runtime.nativeProcessStartedAt) ||
    Number(input.runtime.nativeProcessStartedAt) <= 0 ||
    !input.runtime.nativeSessionId
  ) {
    throw new Error(`native ${input.agent} inspection has an incomplete exact ` +
      "process identity; refresh list before controlling the terminal");
  }
  const agentRows = input.composition.loadClaudeAgentRows({ required: true });
  const observation = input.adapter.observeThreadLifecycle?.({
    operation: { kind: "new_thread" }, phase: "before", pid: input.pid,
    processStartedAt: input.runtime.nativeProcessStartedAt,
    cwd: input.cwd,
    agentRows
  });
  const exactRows = agentRows.filter((row) => row.pid === input.pid);
  const expectedState = input.runtime.exactClaudeAgentState ?? "idle";
  const stateMatches = expectedState === "idle"
    ? observation?.idle === true
    : observation?.idle === false && exactRows.length === 1 &&
      exactRows[0].status === "waiting" &&
      exactRows[0].waitingFor === "dialog open";
  if (
    observation?.status !== "observed" || !stateMatches ||
    observation.nativeThreadId !== input.runtime.nativeSessionId
  ) {
    throw new Error("native Claude agents identity, cwd, or idle state changed " +
      `for process ${input.pid}; refresh list before controlling the terminal`);
  }
}
function runningAgentVersion(
  input: Pick<CreateTerminalRuntimeCliAdapterInput, "options" | "dependencies">,
  agent: ExecutorKind, pid: number
): string | undefined {
  const injected = input.dependencies.agentVersionForRunningProcess;
  if (injected) {
    return injected(agent, pid, input.options);
  }
  const fixture = input.options.agentVersionsJson ? parseJsonOption(
    input.options.agentVersionsJson, "--agent-versions-json") : undefined;
  if (isRecord(fixture)) {
    return nonBlankString(fixture[String(pid)]) ?? nonBlankString(fixture[agent]);
  }
  if (
    input.options.agentVersionsJson !== undefined ||
    input.options.processesJson !== undefined ||
    input.options.terminalsJson !== undefined ||
    input.options.terminalScreensJson !== undefined
  ) {
    // Keep executable version lookup inside the same explicitly static
    // observation boundary instead of inspecting an unrelated host PID.
    return undefined;
  }
  const lsof = resolveOptionalExecutable("lsof");
  if (!lsof) {
    return undefined;
  }
  const result = spawnSync(lsof, ["-a", "-p", String(pid), "-d", "txt", "-Fn"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }
  );
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const paths = String(result.stdout ?? "").split(/\r?\n/u)
    .filter((line) => line.startsWith("n")).map((line) => line.slice(1));
  const pathVersions = paths.flatMap((executablePath): string[] => {
    const pattern = agent === "codex"
      ? /\/releases\/(\d+\.\d+\.\d+)(?:-[^/]*)?\/bin\/codex$/u
      : /\/claude\/versions\/(\d+\.\d+\.\d+)$/u;
    const match = pattern.exec(executablePath);
    return match ? [match[1]] : [];
  });
  const versions = [...new Set(pathVersions)];
  return versions.length === 1 ? versions[0] : undefined;
}
/** Decode the provider-owned terminal control payload without product policy. */
export function terminalControlFromTakeover(nativeTakeover: unknown):
  TerminalControlRef | undefined {
  if (!isRecord(nativeTakeover)) {
    return undefined;
  }
  const terminalControl = nativeTakeover.terminal_control;
  if (!isRecord(terminalControl) ||
    !(terminalControl.kind === "tmux" || terminalControl.kind === "herdr")) {
    return undefined;
  }
  const target = nonBlankString(terminalControl.target);
  const session = nonBlankString(terminalControl.session);
  const panePid = Number(terminalControl.panePid);
  if (!target || !session || !Number.isSafeInteger(panePid) || panePid <= 0) {
    return undefined;
  }
  const storedCapabilities = Array.isArray(terminalControl.capabilities) ?
    terminalControl.capabilities.filter(isTerminalControlCapability) : [];
  const capabilities = storedCapabilities.length > 0 ? storedCapabilities :
    [...TERMINAL_CONTROL_CAPABILITIES];
  const control = terminalControl.kind === "tmux"
    ? tmuxControl(terminalControl, { target, session, panePid, capabilities })
    : herdrControl(terminalControl, { target, session, panePid, capabilities });
  if (!control) {
    return undefined;
  }
  const endpointEvidence = nativeTakeover.terminal_endpoint;
  if (endpointEvidence !== undefined) {
    try {
      associateTerminalEndpointEvidence(control, endpointEvidence);
    } catch {
      return undefined;
    }
  }
  return control;
}
interface TerminalControlBase { target: string; session: string; panePid: number;
  capabilities: TerminalControlCapability[]; }
function tmuxControl(raw: Readonly<Record<string, unknown>>,
  base: TerminalControlBase): TerminalControlRef | undefined {
  const window = Number(raw.window);
  const pane = Number(raw.pane);
  if (!Number.isInteger(window) || !Number.isInteger(pane)) {
    return undefined;
  }
  return {
    kind: "tmux", target: base.target, session: base.session, window, pane,
    panePid: base.panePid, currentCommand: nonBlankString(raw.currentCommand),
    currentPath: nonBlankString(raw.currentPath), socketPath: nonBlankString(raw.socketPath),
    capabilities: base.capabilities
  };
}
function herdrControl(raw: Readonly<Record<string, unknown>>,
  base: TerminalControlBase): TerminalControlRef | undefined {
  const socketPath = nonBlankString(raw.socketPath);
  const workspaceId = nonBlankString(raw.workspaceId);
  const tabId = nonBlankString(raw.tabId);
  const paneId = nonBlankString(raw.paneId);
  const terminalId = nonBlankString(raw.terminalId);
  if (!socketPath || !workspaceId || !tabId || !paneId || !terminalId) {
    return undefined;
  }
  return {
    kind: "herdr", target: base.target, socketPath, session: base.session,
    sessionDir: nonBlankString(raw.sessionDir), workspaceId, tabId, paneId, terminalId,
    panePid: base.panePid, currentCommand: nonBlankString(raw.currentCommand),
    currentPath: nonBlankString(raw.currentPath), capabilities: base.capabilities
  };
}
function isTerminalControlCapability(value: unknown):
  value is TerminalControlCapability {
  return typeof value === "string" &&
    (TERMINAL_CONTROL_CAPABILITIES as readonly string[]).includes(value);
}
function textSummary(text: unknown, maxLength = 240):
  { length: number; preview?: string } {
  const value = String(text ?? "");
  return { length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined };
}
