import { isClaudeNativeUuid } from "./claude-native-identity.js";
import { isRecord } from "./value-guards.js";

type RecordValue = Record<string, unknown>;
const message = (record: RecordValue) => isRecord(record.message) ? record.message : undefined;
const blocks = (record: RecordValue): RecordValue[] => {
  const value = message(record)?.content;
  return Array.isArray(value) ? value.filter(isRecord) : [];
};
const toolFragment = (record: RecordValue, messageId: string) => record.type === "assistant" &&
  message(record)?.role === "assistant" && message(record)?.id === messageId &&
  blocks(record).some(block => block.type === "tool_use");
const toolResult = (record: RecordValue) => record.type === "user" &&
  blocks(record).some(block => block.type === "tool_result");

/** Parent edges establish causality, not a total order. Claude can emit fragments
 * of one tool message and their results on sibling edges. Join only that closed
 * message/tool batch; two independent continuations remain ambiguous.
 */
export function claudeNativeCausalChain(root: RecordValue, byParent: Map<string, RecordValue[]>,
  conflicts: Set<string>, sessionId: string, isInput: (record: RecordValue) => boolean): RecordValue[] | undefined {
  const seen = new Set<string>(), chain: RecordValue[] = [];
  const take = (record: RecordValue) => {
    if (!isClaudeNativeUuid(record.uuid) || seen.has(record.uuid) || conflicts.has(record.uuid) ||
        (record.sessionId ?? record.session_id) !== sessionId || record.isSidechain === true) return false;
    seen.add(record.uuid); chain.push(record); return true;
  };
  const children = (record: RecordValue) => (byParent.get(String(record.uuid)) ?? [])
    .filter(child => !(isInput(child) && child.type === "user"))
    .filter(child => !(child.type === "system" && child.subtype === "informational" && !byParent.has(String(child.uuid))));
  let current: RecordValue | undefined = root;
  while (current) {
    const id = message(current)?.id;
    if (typeof id === "string" && toolFragment(current, id)) {
      const batch = collectToolBatch(current, id, children);
      if (!batch || !batch.records.every(take)) return undefined;
      current = batch.next;
    } else {
      if (!take(current)) return undefined;
      if (current.type === "system" && current.subtype === "turn_duration") return chain;
      const next = children(current);
      if (next.length > 1) return undefined;
      current = next[0];
    }
  }
  return chain;
}

function collectToolBatch(start: RecordValue, messageId: string,
  children: (record: RecordValue) => RecordValue[]): { records: RecordValue[]; next?: RecordValue } | undefined {
  const pending = [start], records: RecordValue[] = [], exits: RecordValue[] = [];
  const seen = new Set<string>(), owners = new Set<string>(), results = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const record = pending[index];
    if (seen.has(String(record.uuid))) return undefined;
    seen.add(String(record.uuid)); records.push(record);
    for (const block of blocks(record)) {
      if (block.type === "tool_use") {
        if (typeof block.id !== "string" || owners.has(block.id)) return undefined;
        owners.add(block.id);
      } else if (block.type === "tool_result") {
        if (typeof block.tool_use_id !== "string" || results.has(block.tool_use_id)) return undefined;
        results.add(block.tool_use_id);
      }
    }
    for (const child of children(record)) {
      if (toolFragment(child, messageId) || toolResult(child)) pending.push(child);
      else exits.push(child);
    }
  }
  if (exits.length > 1 || [...results].some(id => !owners.has(id))) return undefined;
  // Missing results stay in the observation as pending tools. They never borrow
  // the final answer or a result belonging to another assistant message.
  return { records, next: exits[0] };
}
