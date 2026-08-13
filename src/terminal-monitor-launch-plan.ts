import type { Conversation } from "./protocol.js";

type JsonRecord = Record<string, unknown>;

export interface TerminalMonitorLaunchOptions {
  agentTimeoutMinutes?: unknown;
  agentHardTimeoutMinutes?: unknown;
  monitorPollIntervalMs?: unknown;
  monitorHandoffPollIntervalMs?: unknown;
  codexHome?: string;
  claudeHome?: string;
  disableTerminalBridgeMonitor?: boolean;
}

interface LaunchPlanInput {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  options: TerminalMonitorLaunchOptions;
  entryPath: string;
  environment: NodeJS.ProcessEnv;
}

interface MonitorLaunchPlanInput extends LaunchPlanInput {
  defaultAgentTimeoutMinutes?: number;
  defaultAgentHardTimeoutMinutes?: number;
  defaultPollIntervalMs?: number;
}

export interface TerminalMonitorTimeoutPlan {
  agentTimeoutMinutes: number;
  agentHardTimeoutMinutes: number;
  pollIntervalMs: number;
}

export interface DetachedTerminalMonitorPlan {
  args: string[];
  environment: NodeJS.ProcessEnv;
}

export interface TerminalBridgeMonitorLaunchPlan
  extends DetachedTerminalMonitorPlan, TerminalMonitorTimeoutPlan {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function takeover(conversation: Conversation): JsonRecord | undefined {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

export function withoutGatewayTokens(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const cleaned = { ...environment };
  delete cleaned.AKK_GATEWAY_TOKEN;
  delete cleaned.OPENCLAW_GATEWAY_TOKEN;
  return cleaned;
}

function basePlan(input: LaunchPlanInput, args: string[]): DetachedTerminalMonitorPlan {
  return {
    args: [input.entryPath, ...args],
    environment: withoutGatewayTokens(input.environment)
  };
}

export function terminalMonitorTimeoutPlan(
  input: Pick<MonitorLaunchPlanInput, "conversation" | "options" |
    "defaultAgentTimeoutMinutes" | "defaultAgentHardTimeoutMinutes" |
    "defaultPollIntervalMs">
): TerminalMonitorTimeoutPlan {
  const nativeTakeover = takeover(input.conversation);
  return {
    agentTimeoutMinutes: Number(
      input.options.agentTimeoutMinutes ??
        nativeTakeover?.terminal_bridge_inactivity_timeout_minutes ??
        input.defaultAgentTimeoutMinutes ?? 60
    ),
    agentHardTimeoutMinutes: Number(
      input.options.agentHardTimeoutMinutes ??
        nativeTakeover?.terminal_bridge_hard_timeout_minutes ??
        input.defaultAgentHardTimeoutMinutes ?? 720
    ),
    pollIntervalMs: Number(
      input.options.monitorPollIntervalMs ?? input.defaultPollIntervalMs ?? 5000
    )
  };
}

export function planLaunch(
  input: MonitorLaunchPlanInput
): TerminalBridgeMonitorLaunchPlan | undefined {
  const nativeTakeover = takeover(input.conversation);
  if (
    nativeTakeover?.terminal_bridge !== true ||
    input.options.disableTerminalBridgeMonitor === true
  ) {
    return undefined;
  }
  const timeouts = terminalMonitorTimeoutPlan(input);
  const plan = basePlan(input, [
    "monitor", "--terminal-bridge", "--state", input.statePath,
    "--log", input.logPath,
    "--agent-timeout-minutes", String(timeouts.agentTimeoutMinutes),
    "--agent-hard-timeout-minutes", String(timeouts.agentHardTimeoutMinutes),
    "--poll-interval-ms", String(timeouts.pollIntervalMs)
  ]);
  if (input.options.codexHome) {
    plan.args.push("--codex-home", input.options.codexHome);
  }
  const claudeHome = input.options.claudeHome ??
    stringValue(nativeTakeover.claude_home);
  if (claudeHome) {
    plan.args.push("--claude-home", claudeHome);
  }
  return { ...plan, ...timeouts };
}

export function planHandoffLaunch(
  input: LaunchPlanInput
): DetachedTerminalMonitorPlan | undefined {
  const nativeTakeover = takeover(input.conversation);
  const messageId = stringValue(nativeTakeover?.terminal_bridge_message_id);
  if (
    input.options.disableTerminalBridgeMonitor === true ||
    nativeTakeover?.terminal_bridge !== true ||
    !messageId
  ) {
    return undefined;
  }
  const plan = basePlan(input, [
    "monitor", "--terminal-bridge-handoff", "--state", input.statePath,
    "--log", input.logPath, "--expected-terminal-message-id", messageId
  ]);
  for (const [value, option] of [
    [input.options.monitorPollIntervalMs, "--monitor-poll-interval-ms"],
    [input.options.monitorHandoffPollIntervalMs, "--monitor-handoff-poll-interval-ms"]
  ] as const) {
    const milliseconds = Number(value);
    if (Number.isFinite(milliseconds) && milliseconds > 0) {
      plan.args.push(option, String(milliseconds));
    }
  }
  if (input.options.codexHome) {
    plan.args.push("--codex-home", input.options.codexHome);
  }
  const claudeHome = input.options.claudeHome ??
    stringValue(nativeTakeover.claude_home);
  if (claudeHome) {
    plan.args.push("--claude-home", claudeHome);
  }
  return plan;
}

export function planAfterApproval(
  input: MonitorLaunchPlanInput & { activeMonitorPresent: boolean }
): {
  monitor?: DetachedTerminalMonitorPlan;
  handoff?: DetachedTerminalMonitorPlan;
} {
  return input.activeMonitorPresent
    ? { handoff: planHandoffLaunch(input) }
    : { monitor: planLaunch(input) };
}
