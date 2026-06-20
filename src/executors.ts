export type OpenClawActor = "openclaw";
export type CodingAgentActor = "claude-code" | "codex" | "cursor";
export type Actor = OpenClawActor | CodingAgentActor;
export type ExecutorKind = "claude" | "codex" | "cursor";
export type SessionRecoveryStrategy = "native-session" | "explicit-decision";

export interface Executor {
  kind: ExecutorKind;
  actor: Actor;
  session: string;
  display_name: string;
  transport: "acpx";
}

export interface ExecutorDefinition {
  kind: ExecutorKind;
  actor: CodingAgentActor;
  acpxCommand: string;
  defaultSession: string;
  sessionPrefix: string;
  displayName: string;
  aliases: readonly string[];
  sessionConfigKeys: readonly string[];
  proxyConfigKeys: readonly string[];
  modelConfigKeys: readonly string[];
  proxyEnvKeys: readonly string[];
  sessionRecoveryStrategy: SessionRecoveryStrategy;
  supportsSessionEnsure: boolean;
  supportsCancel: boolean;
  modelEnvKey?: string;
}

interface ResolveExecutorOptions {
  kind?: ExecutorKind | string;
  session?: string | undefined;
}

export const EXECUTORS = {
  claude: {
    kind: "claude",
    actor: "claude-code",
    acpxCommand: "claude",
    defaultSession: "bidirectional",
    sessionPrefix: "akk-claude",
    displayName: "Claude Code",
    aliases: ["claude", "claude-code", "claudecode"],
    sessionConfigKeys: ["claudeSession", "defaultClaudeSession"],
    proxyConfigKeys: [],
    modelConfigKeys: [],
    proxyEnvKeys: [],
    sessionRecoveryStrategy: "native-session",
    supportsSessionEnsure: true,
    supportsCancel: true
  },
  codex: {
    kind: "codex",
    actor: "codex",
    acpxCommand: "codex",
    defaultSession: "codex",
    sessionPrefix: "akk-codex",
    displayName: "Codex",
    aliases: ["codex", "c"],
    sessionConfigKeys: ["codexSession", "defaultCodexSession"],
    proxyConfigKeys: ["codexAllProxy"],
    modelConfigKeys: ["codexModel"],
    proxyEnvKeys: ["CODEX_ALL_PROXY", "ALL_PROXY", "all_proxy"],
    sessionRecoveryStrategy: "native-session",
    supportsSessionEnsure: true,
    supportsCancel: true,
    modelEnvKey: "CODEX_ACPX_MODEL"
  },
  cursor: {
    kind: "cursor",
    actor: "cursor",
    acpxCommand: "cursor",
    defaultSession: "cursor",
    sessionPrefix: "akk-cursor",
    displayName: "Cursor",
    aliases: ["cursor"],
    sessionConfigKeys: ["cursorSession", "defaultCursorSession"],
    proxyConfigKeys: ["cursorAllProxy"],
    modelConfigKeys: ["cursorModel"],
    proxyEnvKeys: ["CURSOR_ALL_PROXY", "ALL_PROXY", "all_proxy"],
    sessionRecoveryStrategy: "explicit-decision",
    supportsSessionEnsure: true,
    supportsCancel: true,
    modelEnvKey: "CURSOR_ACPX_MODEL"
  }
} as const satisfies Record<ExecutorKind, ExecutorDefinition>;

export const EXECUTOR_KINDS = Object.keys(EXECUTORS) as ExecutorKind[];
export const CODING_AGENT_ACTORS = EXECUTOR_KINDS.map((kind) => EXECUTORS[kind].actor);
export const ACTORS = new Set<Actor>(["openclaw", ...CODING_AGENT_ACTORS]);

export function isExecutorKind(value: string): value is ExecutorKind {
  return Object.prototype.hasOwnProperty.call(EXECUTORS, value);
}

export function executorDefinitionForKind(kind: ExecutorKind | string): ExecutorDefinition {
  const normalizedKind = String(kind || "").toLowerCase();
  if (!isExecutorKind(normalizedKind)) {
    throw new Error(`unsupported executor: ${kind}`);
  }
  return EXECUTORS[normalizedKind];
}

export function executorDefinitionForAlias(alias: string): ExecutorDefinition | undefined {
  const normalizedAlias = String(alias || "").toLowerCase();
  return EXECUTOR_KINDS
    .map((kind) => EXECUTORS[kind] as ExecutorDefinition)
    .find((definition) => definition.aliases.includes(normalizedAlias));
}

export function resolveExecutor({ kind = "claude", session }: ResolveExecutorOptions = {}): Executor {
  const definition = executorDefinitionForKind(kind);
  return {
    kind: definition.kind,
    actor: definition.actor,
    session: session || definition.defaultSession,
    display_name: definition.displayName,
    transport: "acpx"
  };
}

export function acpxCommandForExecutor(executor: Pick<Executor, "kind">): string {
  return executorDefinitionForKind(executor.kind).acpxCommand;
}

export function sessionRecoveryStrategyForExecutor(executor: Pick<Executor, "kind">): SessionRecoveryStrategy {
  return executorDefinitionForKind(executor.kind).sessionRecoveryStrategy;
}

export function proxyEnvForExecutor(executor: Pick<Executor, "kind">, env: NodeJS.ProcessEnv): string | undefined {
  const definition = executorDefinitionForKind(executor.kind);
  for (const key of definition.proxyEnvKeys) {
    const value = env[key];
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function modelEnvForExecutor(executor: Pick<Executor, "kind">, env: NodeJS.ProcessEnv): string | undefined {
  const key = executorDefinitionForKind(executor.kind).modelEnvKey;
  return key ? env[key] : undefined;
}
