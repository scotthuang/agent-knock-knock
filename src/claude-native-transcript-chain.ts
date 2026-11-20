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
  conflicts: Set<string>, sessionId: string, isInput: (record: RecordValue) => boolean,
  requireCompleteTools = false): RecordValue[] | undefined {
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
      const batch = collectToolBatch(current, id, children, requireCompleteTools);
      if (!batch || !batch.records.every(take)) return undefined;
      current = batch.next;
    } else {
      if (requireCompleteTools && blocks(current).some(block => block.type === "tool_use" || block.type === "tool_result")) {
        return undefined;
      }
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
  children: (record: RecordValue) => RecordValue[], requireCompleteTools: boolean):
    { records: RecordValue[]; next?: RecordValue } | undefined {
  const pending = [start], records: RecordValue[] = [], exits: RecordValue[] = [];
  const seen = new Set<string>();
  const evidence: ToolBatchEvidence = { owners: new Map(), results: new Map() };
  for (let index = 0; index < pending.length; index++) {
    const record = pending[index];
    if (seen.has(String(record.uuid))) return undefined;
    seen.add(String(record.uuid)); records.push(record);
    if (!addToolBatchEvidence(record, messageId, evidence, requireCompleteTools)) return undefined;
    for (const child of children(record)) {
      if (toolFragment(child, messageId) || toolResult(child)) pending.push(child);
      else exits.push(child);
    }
  }
  const { owners, results } = evidence;
  if (exits.length > 1 || [...results.keys()].some(id => !owners.has(id))) return undefined;
  if (requireCompleteTools && (owners.size !== results.size ||
      [...results].some(([id, source]) => source !== owners.get(id)))) return undefined;
  // Missing results stay in the observation as pending tools. They never borrow
  // the final answer or a result belonging to another assistant message.
  return { records, next: exits[0] };
}

interface ToolBatchEvidence {
  owners: Map<string, unknown>;
  results: Map<string, unknown>;
}

function addToolBatchEvidence(record: RecordValue, messageId: string, evidence: ToolBatchEvidence,
  requireCompleteTools: boolean): boolean {
  for (const block of blocks(record)) {
    if (block.type === "tool_use") {
      if (typeof block.id !== "string" || !block.id.trim() || evidence.owners.has(block.id) ||
          requireCompleteTools && !toolFragment(record, messageId)) return false;
      evidence.owners.set(block.id, record.uuid);
    } else if (block.type === "tool_result") {
      const id = block.tool_use_id;
      if (typeof id !== "string" || !id.trim() || evidence.results.has(id) ||
          requireCompleteTools && (record.type !== "user" || message(record)?.role !== "user")) return false;
      evidence.results.set(id, record.sourceToolAssistantUUID);
    }
  }
  return true;
}

/** A completed turn may join tool fragments only if the whole exact turn is covered. */
export function hasClosedClaudeToolBatches(root: RecordValue, records: readonly RecordValue[],
  sessionId: string, isInput: (record: RecordValue) => boolean): boolean {
  const byParent = new Map<string, RecordValue[]>();
  for (const record of records) {
    if (record === root || typeof record.parentUuid !== "string") continue;
    const siblings = byParent.get(record.parentUuid) ?? [];
    siblings.push(record);
    byParent.set(record.parentUuid, siblings);
  }
  return claudeNativeCausalChain(root, byParent, new Set(), sessionId, isInput, true)?.length === records.length;
}
