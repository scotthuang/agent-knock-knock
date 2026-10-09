import { findDesktopAsyncAnswer } from "./desktop-async-interactions.js";
import { findDesktopRequestEffect } from "./desktop-request-interactions.js";
import type { DesktopResponseRecord } from "./desktop-response-store.js";
import type { DesktopSnapshot } from "./desktop-types.js";

/** A transport acknowledgement or disappearing prompt alone never confirms a response. */
export function desktopResponseEvidence(record: DesktopResponseRecord, snapshot: DesktopSnapshot): DesktopResponseRecord["evidence"] {
  if (record.interaction.kind === "async_question") {
    return findDesktopAsyncAnswer(snapshot, { turnId: record.interaction.turnId, interaction: record.interaction,
      answer: record.answer!, clientUserMessageId: record.client_user_message_id! }) ? "exact_async_answer_observed" : undefined;
  }
  const effect = findDesktopRequestEffect(snapshot, { interaction: record.interaction, response: record.response! });
  if (!effect) return undefined;
  if (effect.evidence === "exact_blocking_answer_observed") return effect.evidence;
  const turn = snapshot.turns.find(candidate => candidate.turnId === record.interaction.turnId);
  const item = turn?.items.find(candidate => candidate.id === effect.itemId);
  // The item must actually advance after this answer intent, not merely have an old terminal status.
  return item?.status !== undefined && item.status !== record.baseline_item_status ? effect.evidence : undefined;
}
