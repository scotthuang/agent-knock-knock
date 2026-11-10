import { isRecord, nonBlankString as nonEmptyString } from "./value-guards.js";

/** A returned Bash launch is background work, not an outstanding foreground tool.
 * Keep agent/workflow, ambiguous tool ownership, and pending-count fences intact.
 */
export function hasBlockingCompletionWork(record: Record<string, unknown>, records: readonly Record<string, unknown>[]): boolean {
  if (!hasUnresolvedBackgroundWork(record)) return false;
  const message = isRecord(record.message) ? record.message : undefined;
  const blocks = Array.isArray(message?.content) ? message.content : [];
  if (record.type === "assistant") {
    const content = blocks.map(block => isRecord(block) && block.type === "tool_use" &&
      block.name === "Bash" && isRecord(block.input)
      ? { ...block, input: { ...block.input, run_in_background: false, runInBackground: false } }
      : block);
    return hasUnresolvedBackgroundWork({ ...record, message: { ...message, content } });
  }
  const results = blocks.filter(block => isRecord(block) && block.type === "tool_result");
  if (record.type !== "user" || results.length !== 1 || !isRecord(results[0])) return true;
  const id = results[0].tool_use_id;
  const owners = records.flatMap(owner => {
    const msg = isRecord(owner.message) ? owner.message : undefined;
    return owner.type === "assistant" && Array.isArray(msg?.content)
      ? msg.content.filter(block => isRecord(block) && block.type === "tool_use" && block.id === id)
      : [];
  });
  if (owners.length !== 1 || !isRecord(owners[0]) || owners[0].name !== "Bash") return true;
  // Retain record-level pending counts; only the linked shell result is exempt.
  return hasUnresolvedBackgroundWork({ ...record, toolUseResult: undefined });
}

export function hasUnresolvedBackgroundWork(record: Record<string, unknown>): boolean {
  if ([
    record.pendingBackgroundAgentCount,
    record.pendingWorkflowCount
  ].some((value) =>
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) !== 0)
  )) {
    return true;
  }
  if (
    record.type === "assistant" &&
    isRecord(record.message) &&
    Array.isArray(record.message.content)
  ) {
    for (const block of record.message.content) {
      if (!isRecord(block) || block.type !== "tool_use") {
        continue;
      }
      const toolName = nonEmptyString(block.name)?.toLowerCase();
      if (
        toolName?.startsWith("cron") ||
        toolName === "agent" ||
        toolName === "sendmessage" ||
        structuredBoolean(block.input, ["run_in_background", "runInBackground"]) === true
      ) {
        return true;
      }
    }
  }
  const toolUseResult = isRecord(record.toolUseResult)
    ? record.toolUseResult
    : undefined;
  const backgroundStatus = nonEmptyString(toolUseResult?.status);
  return nonEmptyString(toolUseResult?.backgroundTaskId) !== undefined ||
    structuredBoolean(toolUseResult, ["isAsync"]) === true ||
    (
      backgroundStatus !== undefined &&
      ["async_launched", "remote_launched", "teammate_spawned"].includes(backgroundStatus)
    ) ||
    structuredBoolean(toolUseResult, [
    "run_in_background",
    "runInBackground",
    "is_background",
    "isBackground",
    "backgroundedByUser",
    "assistantAutoBackgrounded"
  ]) === true;
}

function structuredBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    if (typeof value[key] === "boolean") {
      return value[key] as boolean;
    }
  }
  return undefined;
}
