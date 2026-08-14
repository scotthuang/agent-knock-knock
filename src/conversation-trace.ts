import fs from "node:fs";
import path from "node:path";
import { executorForConversation, type Conversation } from "./protocol.js";

type JsonRecord = Record<string, unknown>;
type TraceEvent = JsonRecord & { event?: string };

export function buildConversationTrace(
  conversation: Conversation,
  events: readonly TraceEvent[],
  logPath: string
) {
  const outputPath = traceOutputPath(conversation, events, logPath);
  const output = outputPath && fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8").slice(-256 * 1024)
    : "";
  const parsed = parseExecutorTraceOutput(output);
  const monitorEvents = events
    .filter((event) => typeof event.event === "string" && [
      "executor_launch",
      "executor_message_launch",
      "executor_monitor_launch",
      "executor_monitor_started",
      "conversation_stalled",
      "callback_delivery",
      "callback_gateway_method_delivery",
      "callback_chat_send_delivery",
      "callback_session_send_delivery"
    ].includes(event.event))
    .slice(-20)
    .map((event) => ({
      ts: event.ts,
      event: event.event,
      status: event.status,
      pid: event.pid,
      executor_pid: event.executor_pid,
      reason: event.reason,
      output_path: event.output_path
    }));

  return {
    source: output ? "executor_output_log" : "events_only",
    output_path: outputPath,
    thinking_redacted_count: parsed.thinkingRedactedCount,
    client_events: parsed.clientEvents.slice(-20),
    permission_requests: parsed.permissionRequests.slice(-10),
    tool_calls: parsed.toolCalls.slice(-20),
    agent_messages: parsed.agentMessages.slice(-8),
    done_events: parsed.doneEvents.slice(-5),
    monitor_events: monitorEvents,
    safety: {
      thinking: "redacted",
      tool_output: "summarized",
      callback_payloads: "redacted"
    }
  };
}

function traceOutputPath(
  conversation: Conversation,
  events: readonly TraceEvent[],
  logPath: string
): string | undefined {
  const launch = [...events].reverse().find((event) =>
    typeof event.event === "string" &&
    ["executor_message_launch", "executor_launch"].includes(event.event) &&
    typeof event.output_path === "string"
  );
  if (typeof launch?.output_path === "string" && launch.output_path) {
    return launch.output_path;
  }

  const executor = executorForConversation(conversation);
  const conversationDir = conversation.conversation_dir ?? path.dirname(logPath);
  const candidates = [
    path.join(conversationDir, `${executor.kind}-followup-output.log`),
    path.join(conversationDir, `${executor.kind}-output.log`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates.at(-1);
}

function parseExecutorTraceOutput(output: unknown) {
  const toolCalls: JsonRecord[] = [];
  const clientEvents: JsonRecord[] = [];
  const permissionRequests: JsonRecord[] = [];
  const agentMessages: JsonRecord[] = [];
  const doneEvents: JsonRecord[] = [];
  let thinkingRedactedCount = 0;
  let currentTool: JsonRecord | null = null;
  let captureOutputFor: JsonRecord | null = null;
  let capturedOutputLines: string[] = [];

  const flushToolOutput = () => {
    if (captureOutputFor && capturedOutputLines.length > 0) {
      captureOutputFor.output_preview = sanitizeTraceText(capturedOutputLines.join("\n"), 500);
    }
    captureOutputFor = null;
    capturedOutputLines = [];
  };

  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const text = rawLine.trim();
    if (!text) {
      continue;
    }

    if (text.startsWith("[") && captureOutputFor) {
      flushToolOutput();
    }

    const client = text.match(/^\[client\]\s+(.+?)(?:\s+\(([^)]+)\))?$/);
    if (client) {
      if (isPermissionTraceLine(text)) {
        permissionRequests.push({
          body: sanitizeTraceText(text, 240)
        });
      }
      clientEvents.push({
        name: sanitizeTraceText(client[1], 160),
        status: client[2] ? sanitizeTraceText(client[2], 80) : undefined
      });
      continue;
    }

    if (text.startsWith("[thinking]")) {
      thinkingRedactedCount += 1;
      agentMessages.push({
        kind: "thinking",
        body: "[redacted]"
      });
      continue;
    }

    const done = text.match(/^\[done\]\s*(.*)$/);
    if (done) {
      doneEvents.push({
        status: sanitizeTraceText(done[1] || "done", 120)
      });
      continue;
    }

    const tool = text.match(/^\[tool\]\s+(.+?)\s+\(([^)]+)\)$/);
    if (tool) {
      const toolCall: JsonRecord = {
        name: sanitizeTraceText(tool[1], 220),
        status: sanitizeTraceText(tool[2], 80)
      };
      toolCalls.push(toolCall);
      currentTool = toolCall;
      continue;
    }

    if (currentTool && text.startsWith("input:")) {
      currentTool.input_preview = sanitizeTraceText(text.slice("input:".length).trim(), 360);
      continue;
    }

    if (currentTool && text.startsWith("output:")) {
      captureOutputFor = currentTool;
      capturedOutputLines = [];
      continue;
    }

    if (captureOutputFor && !text.startsWith("[")) {
      if (capturedOutputLines.length < 8) {
        capturedOutputLines.push(text);
      }
      continue;
    }

    if (isPermissionTraceLine(text)) {
      permissionRequests.push({
        body: sanitizeTraceText(text, 240)
      });
      continue;
    }

    if (isAgentMessageTraceLine(text)) {
      agentMessages.push({
        kind: "message",
        body: sanitizeTraceText(text, 360)
      });
    }
  }

  flushToolOutput();

  return { toolCalls, clientEvents, permissionRequests, agentMessages, doneEvents, thinkingRedactedCount };
}

function sanitizeTraceText(value: unknown, maxLength = 240): string {
  return String(value ?? "")
    .replace(/--message-json\s+.*/g, "--message-json <redacted>")
    .replace(/--token\s+\S+/g, "--token <redacted>")
    .replace(/(gateway[_-]?token|api[_-]?key|token|password|secret)=\S+/gi, "$1=<redacted>")
    .slice(0, maxLength);
}

function isPermissionTraceLine(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("session/request_permission") ||
    (lower.includes("permission") && (lower.includes("request") ||
      lower.includes("approve") || lower.includes("allow")));
}

function isAgentMessageTraceLine(text: string): boolean {
  if (text.startsWith("[") || text.startsWith("{") ||
    text.startsWith("}") || text.startsWith("```")) {
    return false;
  }
  if (text.startsWith("input:") || text.startsWith("output:") ||
    text.startsWith("kind:")) {
    return false;
  }
  if (/^(call_id|process_id|turn_id|command|cwd):/i.test(text)) {
    return false;
  }
  return text.length >= 12;
}
