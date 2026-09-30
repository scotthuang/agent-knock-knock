type TranscriptRecord = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function uuidValue(value: unknown): string | undefined {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : undefined;
}

/**
 * Claude can flush attachment records before their parent prompt/attachment.
 * Delay only those attachments until the parent is present. Conversational
 * records keep their physical order; the normal UUID, ancestry, version, and
 * foreground-chain checks still apply to the resulting turn.
 */
export function orderClaudePrewrittenAttachments(
  records: readonly TranscriptRecord[]
): TranscriptRecord[] {
  const availableUuids = new Set(records.flatMap((record) => {
    const uuid = uuidValue(record.uuid);
    return uuid ? [uuid] : [];
  }));
  const emittedUuids = new Set<string>();
  const delayedByParent = new Map<string, TranscriptRecord[]>();
  const ordered: TranscriptRecord[] = [];
  for (const record of records) {
    const parentUuid = uuidValue(record.parentUuid);
    if (
      record.type === "attachment" &&
      parentUuid &&
      availableUuids.has(parentUuid) &&
      !emittedUuids.has(parentUuid)
    ) {
      const delayed = delayedByParent.get(parentUuid) ?? [];
      delayed.push(record);
      delayedByParent.set(parentUuid, delayed);
      continue;
    }
    const ready = [record];
    while (ready.length > 0) {
      const next = ready.pop()!;
      ordered.push(next);
      const uuid = uuidValue(next.uuid);
      if (uuid) {
        emittedUuids.add(uuid);
        const delayed = delayedByParent.get(uuid);
        if (delayed) {
          delayedByParent.delete(uuid);
          ready.push(...delayed.reverse());
        }
      }
    }
  }
  if (delayedByParent.size > 0) {
    throw new Error("Claude transcript attachments have a cyclic parent UUID chain");
  }
  return ordered;
}

export function assertParentsPrecedeChildren(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>
): void {
  const indexes = new Map<TranscriptRecord, number>(
    records.map((record, index) => [record, index])
  );
  for (const record of records) {
    const parentUuid = uuidValue(record.parentUuid);
    const parent = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
    if (parent && (indexes.get(parent) ?? Number.POSITIVE_INFINITY) >=
      (indexes.get(record) ?? Number.NEGATIVE_INFINITY)) {
      throw new Error("Claude transcript parent UUID does not precede its child record");
    }
  }
}

/** Include every physical attachment offset belonging to the captured turn. */
export function earliestClaudeTranscriptRecordOffset(
  entries: readonly { record: TranscriptRecord; offsetBytes: number }[],
  turnRecords: readonly TranscriptRecord[],
  promptOffset: number
): number {
  const selected = new Set(turnRecords);
  return entries.reduce(
    (offset, entry) => selected.has(entry.record)
      ? Math.min(offset, entry.offsetBytes)
      : offset,
    promptOffset
  );
}

/** Start an incremental read at the exact prompt after attachment ordering. */
export function initialClaudeTranscriptCheckpointRecords(
  records: readonly TranscriptRecord[],
  promptUuid: string,
  hasCompletionSignal: (record: TranscriptRecord) => boolean
): readonly TranscriptRecord[] {
  const promptIndex = records.findIndex((record) =>
    uuidValue(record.uuid) === promptUuid
  );
  if (promptIndex <= 0) {
    return records;
  }
  // The physical anchor may start at an early attachment; after ordering,
  // only UUID-less session metadata may remain before the exact prompt.
  if (records.slice(0, promptIndex).some((record) =>
    uuidValue(record.uuid) !== undefined || hasCompletionSignal(record)
  )) {
    throw new Error("Claude active-task prefix contains an unlinked UUID branch");
  }
  return records.slice(promptIndex);
}
