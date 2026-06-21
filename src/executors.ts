export type OpenClawActor = "openclaw";
export type CodingAgentActor = "claude-code" | "codex" | "cursor";
export type Actor = OpenClawActor | CodingAgentActor;
export type ExecutorKind = "claude" | "codex" | "cursor";

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

export function parseLeadingExecutorAlias(input: string): { kind: ExecutorKind; request: string } | undefined {
  const trimmed = String(input || "").trim();
  const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\s+|[:：]\s*)([\s\S]+)$/u.exec(trimmed);
  if (!match) {
    return undefined;
  }

  const definition = executorDefinitionForAlias(match[1]);
  const request = match[2].trim();
  if (!definition || !request) {
    return undefined;
  }

  return {
    kind: definition.kind,
    request
  };
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

export function normalizeModelForExecutor(executor: Pick<Executor, "kind">, model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }

  const trimmed = model.trim();
  if (executor.kind !== "codex") {
    return trimmed;
  }

  const match = /^(.+)\/(low|medium|high|xhigh)$/i.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  return `${match[1]}[${match[2].toLowerCase()}]`;
}
