import { DesktopTaskError } from "./desktop-task-service.js";
import type { DesktopResponseDependencies } from "./desktop-response-types.js";
import type { DesktopResponseRecord } from "./desktop-response-store.js";
import type { DesktopSnapshot, DesktopThreadIdentity } from "./desktop-types.js";

interface DispatchOptions {
  threadId: string;
  ownerClientId: string;
  expectedRevision: number;
  expectedTurnId: string;
  interactionId: string;
  beforeDispatch(snapshot: DesktopSnapshot): Promise<void>;
}

/** These acknowledgements mean sent; the durable service separately verifies native effects. */
export async function dispatchDesktopResponse(deps: DesktopResponseDependencies, target: DesktopThreadIdentity,
  record: DesktopResponseRecord, options: DispatchOptions): Promise<void> {
  if (record.interaction.kind === "async_question") {
    const receipt = await deps.answerAsync(target, { ...options, answer: record.answer!, clientUserMessageId: record.client_user_message_id! });
    if (receipt.turnId !== record.interaction.turnId || receipt.clientUserMessageId !== record.client_user_message_id) {
      throw new Error("Desktop async response receipt changed exact task identity");
    }
    return;
  }
  if (!deps.respondRequest) throw new DesktopTaskError("unsupported_capability", "Desktop request responses are unavailable", "not_sent");
  const receipt = await deps.respondRequest(target, { ...options, operationId: record.operation_id!, response: record.response! });
  if (receipt.turnId !== record.interaction.turnId || receipt.interactionId !== record.interaction.id ||
    receipt.requestId !== record.interaction.requestId || receipt.acknowledged !== true) {
    throw new Error("Desktop native response receipt changed exact request identity");
  }
}
