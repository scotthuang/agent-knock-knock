import { createHash } from "node:crypto";

export type ClaudeHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PermissionRequest"
  | "Stop"
  | "StopFailure"
  | "Notification";

export type ClaudeJsonValue =
  | null
  | boolean
  | number
  | string
  | ClaudeJsonValue[]
  | { [key: string]: ClaudeJsonValue };

export type ClaudeJsonObject = { [key: string]: ClaudeJsonValue };

export interface ClaudeHookInputBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  effort?: ClaudeJsonValue;
  agent_id?: string;
  agent_type?: string;
  /** Present in recent Claude Code hook payloads and useful for exact turn correlation. */
  prompt_id?: string;
}

export interface ClaudeSessionStartHookInput extends ClaudeHookInputBase {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact" | "fork";
  model?: string;
}

export interface ClaudeUserPromptSubmitHookInput extends ClaudeHookInputBase {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

export interface ClaudePermissionRequestHookInput extends ClaudeHookInputBase {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: ClaudeJsonValue;
  permission_suggestions?: ClaudeJsonValue[];
}

export interface ClaudeBackgroundTaskSummary extends ClaudeJsonObject {
  id: string;
  type: string;
  status: string;
  description: string;
}

export interface ClaudeSessionCronSummary extends ClaudeJsonObject {
  id: string;
  schedule: string;
  recurring: boolean;
  prompt: string;
}

export interface ClaudeStopHookInput extends ClaudeHookInputBase {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
  /** Undefined is intentionally distinct from an observed empty array. */
  background_tasks?: ClaudeBackgroundTaskSummary[];
  /** Undefined is intentionally distinct from an observed empty array. */
  session_crons?: ClaudeSessionCronSummary[];
}

export type ClaudeStopFailureCode =
  | "rate_limit"
  | "authentication_failed"
  | "oauth_org_not_allowed"
  | "billing_error"
  | "invalid_request"
  | "model_not_found"
  | "server_error"
  | "max_output_tokens"
  | "unknown";

export interface ClaudeStopFailureHookInput extends ClaudeHookInputBase {
  hook_event_name: "StopFailure";
  error: ClaudeStopFailureCode;
  error_details?: ClaudeJsonValue;
  last_assistant_message?: string;
}

export interface ClaudeNotificationHookInput extends ClaudeHookInputBase {
  hook_event_name: "Notification";
  message: string;
  title?: string;
  notification_type: string;
}

export type ClaudeHookInput =
  | ClaudeSessionStartHookInput
  | ClaudeUserPromptSubmitHookInput
  | ClaudePermissionRequestHookInput
  | ClaudeStopHookInput
  | ClaudeStopFailureHookInput
  | ClaudeNotificationHookInput;

export type ClaudePermissionBehavior = "allow" | "deny";

export type ClaudePermissionHookOutput = {
  hookSpecificOutput: {
    hookEventName: "PermissionRequest";
    decision:
      | { behavior: "allow" }
      | { behavior: "deny"; message: string; interrupt?: boolean };
  };
};

export function parseClaudeHookInput(value: unknown): ClaudeHookInput {
  const input = requireObject(value, "Claude hook input");
  const common = parseCommonInput(input);
  const hookEventName = requireString(input.hook_event_name, "hook_event_name");

  switch (hookEventName) {
    case "SessionStart": {
      const source = requireString(input.source, "source");
      if (source !== "startup" && source !== "resume" && source !== "clear" && source !== "compact" && source !== "fork") {
        throw new Error(`unsupported Claude SessionStart source: ${source}`);
      }
      return {
        ...common,
        hook_event_name: hookEventName,
        source,
        ...optionalStringProperty(input, "model")
      };
    }
    case "UserPromptSubmit":
      return {
        ...common,
        hook_event_name: hookEventName,
        prompt: requireString(input.prompt, "prompt", { allowEmpty: true })
      };
    case "PermissionRequest":
      return {
        ...common,
        hook_event_name: hookEventName,
        tool_name: requireString(input.tool_name, "tool_name"),
        tool_input: requireJsonValue(input.tool_input, "tool_input"),
        ...optionalJsonArrayProperty(input, "permission_suggestions")
      };
    case "Stop":
      return {
        ...common,
        hook_event_name: hookEventName,
        stop_hook_active: requireBoolean(input.stop_hook_active, "stop_hook_active"),
        ...optionalStringProperty(input, "last_assistant_message", { allowEmpty: true }),
        ...optionalBackgroundTasksProperty(input),
        ...optionalSessionCronsProperty(input)
      };
    case "StopFailure": {
      const error = requireString(input.error, "error") as ClaudeStopFailureCode;
      if (!CLAUDE_STOP_FAILURE_CODES.has(error)) {
        throw new Error(`unsupported Claude StopFailure error: ${error}`);
      }
      return {
        ...common,
        hook_event_name: hookEventName,
        error,
        ...optionalJsonProperty(input, "error_details"),
        ...optionalStringProperty(input, "last_assistant_message", { allowEmpty: true })
      };
    }
    case "Notification":
      return {
        ...common,
        hook_event_name: hookEventName,
        message: requireString(input.message, "message", { allowEmpty: true }),
        notification_type: requireString(input.notification_type, "notification_type"),
        ...optionalStringProperty(input, "title", { allowEmpty: true })
      };
    default:
      throw new Error(`unsupported Claude hook event: ${hookEventName}`);
  }
}

export function canonicalClaudePermissionFingerprint(
  input: ClaudePermissionRequestHookInput
): string {
  return createHash("sha256")
    .update(canonicalJson({
      version: 1,
      session_id: input.session_id,
      cwd: input.cwd,
      permission_mode: input.permission_mode ?? null,
      tool_name: input.tool_name,
      tool_input: input.tool_input
    }))
    .digest("hex");
}

export function claudePermissionHookOutput(
  decision: { behavior: ClaudePermissionBehavior; interrupt?: boolean; message?: string }
): ClaudePermissionHookOutput {
  return decision.behavior === "allow"
    ? {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" }
        }
      }
    : {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: "deny",
            message: decision.message ?? "Denied by Agent Knock Knock.",
            ...(decision.interrupt === undefined ? {} : { interrupt: decision.interrupt })
          }
        }
      };
}

export function canonicalJson(value: ClaudeJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonical JSON does not support non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function parseCommonInput(input: Record<string, unknown>): ClaudeHookInputBase {
  return {
    session_id: requireString(input.session_id, "session_id"),
    transcript_path: requireString(input.transcript_path, "transcript_path"),
    cwd: requireString(input.cwd, "cwd"),
    ...optionalStringProperty(input, "permission_mode"),
    ...optionalJsonProperty(input, "effort"),
    ...optionalStringProperty(input, "agent_id"),
    ...optionalStringProperty(input, "agent_type"),
    ...optionalStringProperty(input, "prompt_id")
  };
}

const CLAUDE_STOP_FAILURE_CODES = new Set<ClaudeStopFailureCode>([
  "rate_limit",
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "unknown"
]);

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string" || (!options.allowEmpty && value.trim().length === 0)) {
    throw new Error(`${field} must be ${options.allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function requireJsonValue(value: unknown, field: string): ClaudeJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} must contain only finite JSON numbers`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => requireJsonValue(entry, `${field}[${index}]`));
  }
  if (value && typeof value === "object") {
    const result: ClaudeJsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = requireJsonValue(entry, `${field}.${key}`);
    }
    return result;
  }
  throw new Error(`${field} must be valid JSON`);
}

function optionalStringProperty(
  input: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {}
): Record<string, string> {
  return input[key] === undefined ? {} : { [key]: requireString(input[key], key, options) };
}

function optionalJsonProperty(
  input: Record<string, unknown>,
  key: string
): Record<string, ClaudeJsonValue> {
  return input[key] === undefined ? {} : { [key]: requireJsonValue(input[key], key) };
}

function optionalJsonArrayProperty(
  input: Record<string, unknown>,
  key: string
): Record<string, ClaudeJsonValue[]> {
  if (input[key] === undefined) {
    return {};
  }
  if (!Array.isArray(input[key])) {
    throw new Error(`${key} must be an array`);
  }
  return { [key]: input[key].map((entry, index) => requireJsonValue(entry, `${key}[${index}]`)) };
}

function optionalObjectArrayProperty(
  input: Record<string, unknown>,
  key: string
): Record<string, ClaudeJsonObject[]> {
  if (input[key] === undefined) {
    return {};
  }
  if (!Array.isArray(input[key])) {
    throw new Error(`${key} must be an array`);
  }
  return {
    [key]: input[key].map((entry, index) => {
      const parsed = requireJsonValue(entry, `${key}[${index}]`);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${key}[${index}] must be an object`);
      }
      return parsed;
    })
  };
}

function optionalBackgroundTasksProperty(
  input: Record<string, unknown>
): { background_tasks?: ClaudeBackgroundTaskSummary[] } {
  const objects = optionalObjectArrayProperty(input, "background_tasks").background_tasks;
  if (!objects) {
    return {};
  }
  return {
    background_tasks: objects.map((entry, index) => ({
      ...entry,
      id: requireString(entry.id, `background_tasks[${index}].id`),
      type: requireString(entry.type, `background_tasks[${index}].type`),
      status: requireString(entry.status, `background_tasks[${index}].status`),
      description: requireString(entry.description, `background_tasks[${index}].description`, {
        allowEmpty: true
      })
    }))
  };
}

function optionalSessionCronsProperty(
  input: Record<string, unknown>
): { session_crons?: ClaudeSessionCronSummary[] } {
  const objects = optionalObjectArrayProperty(input, "session_crons").session_crons;
  if (!objects) {
    return {};
  }
  return {
    session_crons: objects.map((entry, index) => ({
      ...entry,
      id: requireString(entry.id, `session_crons[${index}].id`),
      schedule: requireString(entry.schedule, `session_crons[${index}].schedule`),
      recurring: requireBoolean(entry.recurring, `session_crons[${index}].recurring`),
      prompt: requireString(entry.prompt, `session_crons[${index}].prompt`, { allowEmpty: true })
    }))
  };
}
