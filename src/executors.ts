export type OpenClawActor = "openclaw";
export type CodingAgentActor = "claude-code" | "codex";
export type Actor = OpenClawActor | CodingAgentActor;
export type ExecutorKind = "claude" | "codex";

export interface Executor {
  kind: ExecutorKind;
  actor: Actor;
  session: string;
  display_name: string;
  transport: "tmux";
}

export interface ExecutorDefinition {
  kind: ExecutorKind;
  actor: CodingAgentActor;
  defaultSession: string;
  displayName: string;
  aliases: readonly string[];
}

interface ResolveExecutorOptions {
  kind?: ExecutorKind | string;
  session?: string | undefined;
}

export const EXECUTORS = {
  claude: {
    kind: "claude",
    actor: "claude-code",
    defaultSession: "claude",
    displayName: "Claude Code",
    aliases: ["claude", "claude-code", "claudecode"]
  },
  codex: {
    kind: "codex",
    actor: "codex",
    defaultSession: "codex",
    displayName: "Codex",
    aliases: ["codex", "c"]
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
    transport: "tmux"
  };
}
