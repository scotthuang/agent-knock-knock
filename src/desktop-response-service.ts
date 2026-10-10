import { backendObservationStopped } from "./backend-task-recovery.js";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { desktopNonblank } from "./desktop-async-state.js";
import { desktopInteractions } from "./desktop-request-interactions.js";
import { assertDesktopInteraction, persistDesktopInteraction } from "./desktop-interaction-state.js";
import { desktopResponseEvidence } from "./desktop-response-evidence.js";
import { dispatchDesktopResponse } from "./desktop-response-dispatch.js";
import { validateDesktopResponseValue } from "./desktop-response-value.js";
import { assertDesktopResponseIdentity, desktopResponseId, type DesktopResponseRecord } from "./desktop-response-store.js";
import { DesktopTaskError } from "./desktop-task-service.js";
import type { DesktopInteraction, DesktopSnapshot } from "./desktop-types.js";
import type { DesktopResponseDependencies, DesktopResponseInput } from "./desktop-response-types.js";
export type { DesktopResponseDependencies, DesktopResponseInput } from "./desktop-response-types.js";
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(code) ? code : "desktop_response_observation_unavailable";
}
function currentInteraction(snapshot: DesktopSnapshot, input: DesktopResponseInput, expectedTurnId?: string): DesktopInteraction {
  const interactions = desktopInteractions(snapshot).filter(candidate => candidate.id === input.interactionId && candidate.threadId === input.target.threadId);
  const interaction = interactions.length === 1 ? interactions[0] : undefined;
  const active = snapshot.turns.filter(turn => turn.status === "inProgress");
  if (snapshot.threadId !== input.target.threadId || !snapshot.ownerClientId || snapshot.runtimeStatus !== "active" ||
    !snapshot.tailKnown || !interaction || active.length !== 1 || active[0].turnId !== interaction.turnId ||
    snapshot.latestTurnId !== interaction.turnId || expectedTurnId && interaction.turnId !== expectedTurnId) {
    throw new DesktopTaskError("stale_interaction", "The exact Desktop interaction is no longer active", "not_sent");
  }
  assertDesktopInteraction(interaction, input.target, expectedTurnId);
  return interaction;
}
function assertInput(input: DesktopResponseInput): void {
  assertDesktopResponseIdentity(input.desktopId, input.target);
  if (![input.controllerSession, input.interactionId, input.responseId].every(desktopNonblank)) {
    throw new DesktopTaskError("invalid_argument", "Desktop response requires controller, interaction and response ID");
  }
}
function assertDuplicate(record: DesktopResponseRecord, input: DesktopResponseInput, expectedTurnId?: string): void {
  if (record.controller_session !== input.controllerSession || record.desktop_id !== input.desktopId ||
    record.interaction.id !== input.interactionId || record.answer !== input.answer || !isDeepStrictEqual(record.response, input.response) ||
    expectedTurnId && record.interaction.turnId !== expectedTurnId) {
    throw new DesktopTaskError("desktop_response_conflict", "This Desktop interaction already has a different response intent");
  }
}
function itemStatus(snapshot: DesktopSnapshot, interaction: DesktopInteraction): string | undefined {
  return snapshot.turns.find(turn => turn.turnId === interaction.turnId)?.items.find(item => item.id === interaction.itemId)?.status;
}

/** One durable answer per native question, shared across direct and Watch response routes. */
export function createDesktopResponseService(deps: DesktopResponseDependencies) {
  const repo = deps.repository; const now = deps.now ?? (() => new Date()); const uuid = deps.randomUUID ?? randomUUID;
  function status(id: string): DesktopResponseRecord {
    const record = repo.load(id);
    if (!record) throw new DesktopTaskError("desktop_response_not_found", "Desktop response was not found");
    return record;
  }
  function update(id: string, operation: (record: DesktopResponseRecord) => void): DesktopResponseRecord {
    return repo.withLock(id, () => {
      const record = status(id); operation(record); record.updated_at = now().toISOString(); return repo.save(record, record.revision);
    });
  }
  async function reconcile(id: string): Promise<DesktopResponseRecord> {
    const previous = status(id);
    if (["confirmed", "not_sent", "reserved"].includes(previous.state)) return previous;
    let snapshot: DesktopSnapshot;
    try { snapshot = await deps.observe(previous.target); }
    catch (error) { return update(id, record => { if (record.state !== "confirmed") record.error_code = errorCode(error); }); }
    if (snapshot.threadId !== previous.target.threadId) throw new DesktopTaskError("desktop_identity_mismatch", "Desktop response observation changed thread");
    const evidence = desktopResponseEvidence(previous, snapshot);
    return update(id, record => {
      if (!evidence || !["sent", "uncertain"].includes(record.state)) return;
      record.state = "confirmed"; record.evidence = evidence; delete record.error_code;
    });
  }
  function reserve(input: DesktopResponseInput, interaction: DesktopInteraction, snapshot: DesktopSnapshot): { record: DesktopResponseRecord; claimed: boolean } {
    const id = desktopResponseId(input.target, input.interactionId); const date = now().toISOString();
    return repo.withLock(id, () => {
      const existing = repo.load(id);
      if (existing) {
        assertDuplicate(existing, input);
        if (existing.state !== "not_sent") return { record: existing, claimed: false };
        existing.not_sent_history = [...(existing.not_sent_history ?? []), { attempt: existing.attempts, observed_at: existing.updated_at,
          ...(existing.error_code ? { error_code: existing.error_code } : {}),
          ...(existing.baseline_item_status !== undefined ? { baseline_item_status: existing.baseline_item_status } : {}) }];
        if (interaction.kind !== "async_question") existing.baseline_item_status = itemStatus(snapshot, interaction);
        existing.state = "reserved"; existing.attempts++; existing.updated_at = date; delete existing.error_code;
        return { record: repo.save(existing, existing.revision), claimed: true };
      }
      const record: DesktopResponseRecord = { schema: "agent-knock-knock/desktop-response", version: 1, revision: 1, id,
        created_at: date, updated_at: date, target: structuredClone(input.target), desktop_id: input.desktopId,
        controller_session: input.controllerSession, response_id: input.responseId, interaction: persistDesktopInteraction(interaction),
        ...(interaction.kind === "async_question" ? { answer: input.answer, client_user_message_id: uuid() }
          : { response: structuredClone(input.response), operation_id: uuid(), baseline_item_status: itemStatus(snapshot, interaction) }),
        state: "reserved", attempts: 1 };
      return { record: repo.save(record, null), claimed: true };
    });
  }
  function withWatch<T>(watchId: string | undefined, input: DesktopResponseInput, operation: () => T): T {
    if (!watchId) return operation();
    return deps.tasks.withLock(watchId, () => {
      const task = deps.tasks.load(watchId);
      if (!task || task.controller_session !== input.controllerSession) throw new DesktopTaskError("desktop_controller_mismatch", "Watch response requires its owning controller", "not_sent");
      if (backendObservationStopped(task)) throw new DesktopTaskError("desktop_watch_stopped", "Desktop Watch observation has stopped", "not_sent");
      return operation();
    });
  }
  async function dispatch(input: DesktopResponseInput, snapshot: DesktopSnapshot, record: DesktopResponseRecord, watchId?: string): Promise<void> {
    try {
      const options = { threadId: input.target.threadId, ownerClientId: snapshot.ownerClientId,
        expectedRevision: snapshot.revision, expectedTurnId: record.interaction.turnId, interactionId: record.interaction.id,
        beforeDispatch: async (fresh: DesktopSnapshot) => {
          const question = currentInteraction(fresh, input, record.interaction.turnId);
          if (fresh.ownerClientId !== snapshot.ownerClientId || fresh.revision < snapshot.revision || question.id !== record.interaction.id) {
            throw new DesktopTaskError("snapshot_changed", "Desktop interaction changed before response dispatch", "not_sent");
          }
          withWatch(watchId, input, () => update(record.id, current => {
            if (current.state !== "reserved") throw new DesktopTaskError("desktop_response_already_claimed", "Desktop response was already dispatched", "not_sent");
            current.state = "uncertain";
          }));
        } };
      await dispatchDesktopResponse(deps, input.target, record, options);
      update(record.id, current => { if (current.state !== "confirmed") current.state = "sent"; });
    } catch (error) {
      update(record.id, current => {
        if (current.state === "confirmed") return;
        current.state = (error as { dispatchState?: string })?.dispatchState === "not_sent" ? "not_sent" : "uncertain";
        current.error_code = errorCode(error);
      });
    }
  }
  async function respond(input: DesktopResponseInput, expectedTurnId?: string, watchId?: string): Promise<DesktopResponseRecord> {
    assertInput(input); withWatch(watchId, input, () => undefined);
    const id = desktopResponseId(input.target, input.interactionId); const previous = repo.load(id);
    if (previous) { assertDuplicate(previous, input, expectedTurnId); if (previous.state !== "not_sent") return reconcile(id); }
    const snapshot = await deps.observe(input.target); const interaction = currentInteraction(snapshot, input, expectedTurnId);
    validateDesktopResponseValue(interaction, input);
    const reserved = withWatch(watchId, input, () => reserve(input, interaction, snapshot));
    if (!reserved.claimed) return reserved.record;
    await dispatch(input, snapshot, reserved.record, watchId);
    return reconcile(id);
  }
  return {
    respond: (input: DesktopResponseInput) => respond(input), reconcile, status, list: () => repo.list(),
    async respondWatch(watchId: string, input: Omit<DesktopResponseInput, "target" | "desktopId">) {
      const task = deps.tasks.load(watchId);
      if (!task || task.controller_session !== input.controllerSession) throw new DesktopTaskError("desktop_controller_mismatch", "Watch response requires its owning controller");
      if (backendObservationStopped(task)) throw new DesktopTaskError("desktop_watch_stopped", "Desktop Watch observation has stopped", "not_sent");
      if (!task.native_turn_id) throw new DesktopTaskError("stale_interaction", "Desktop Watch has no exact task anchor");
      return respond({ ...input, target: task.target, desktopId: task.desktop_id }, task.native_turn_id, watchId);
    }
  };
}
