import test from "node:test";
import assert from "node:assert/strict";
import type {
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "../src/terminal-agent-adapter.js";
import {
  captureTerminalInteractionRuntimeOffer,
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  TerminalInteractionResponseBridge,
  type TerminalInteractionResponseInput
} from "../src/terminal-interaction-response-bridge.js";
import {
  StaticTerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type {
  TerminalControlRef,
  TerminalEndpointRef
} from "../src/terminal-control-ref.js";

const NOW = new Date("2026-09-07T04:00:00.000Z");
const PANE: TerminalPane = {
  kind: "tmux",
  target: "questionnaire-response:0.0",
  socketPath: "/tmp/client.sock",
  serverSocketPath: "/tmp/server.sock",
  paneId: "%88",
  session: "questionnaire-response",
  window: 0,
  pane: 0,
  panePid: 800,
  currentCommand: "codex",
  currentPath: "/repo"
};
const RUNTIME: TerminalRuntimeIdentity = {
  pid: 801,
  agentVersion: "0.153.4",
  turnId: "turn_response_1",
  messageId: "message_response_1",
  conversationId: "conversation_response_1",
  terminalTarget: PANE.target
};
const OPTIONS_SCREEN = `
  Question 1/1 (1 unanswered)
  Choose an option.

  › 1. Option 1  First choice.
    2. Option 2  Second choice.

  tab to add notes | enter to submit answer | esc to interrupt
`;
const CHANGED_SCREEN = OPTIONS_SCREEN.replace("Choose an option.", "Choose again.");
const FREE_TEXT_SCREEN = `
  Question 1/1 (1 unanswered)
  Share details.

  › Type your answer (optional)

  enter to submit answer | esc to interrupt
`;

type Event =
  | "capture"
  | "authorize"
  | "reserve"
  | "verify"
  | `text:${string}`
  | `keys:${string}`
  | `sleep:${number}`;

class RecordingProvider extends StaticTerminalControlProvider {
  readonly events: Event[];
  failText = false;

  constructor(events: Event[]) {
    super({ panes: [PANE] });
    this.events = events;
  }

  override async sendText(
    _terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    this.events.push(`text:${text}`);
    if (this.failText) {
      throw new Error("text result unknown");
    }
  }

  override async sendKeys(
    _terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    this.events.push(`keys:${keys.join(",")}`);
  }
}

function inspection(screen: string): TerminalScreenInspection {
  return {
    activity: { state: "idle", reason: "test questionnaire" },
    approval: {
      blocked: false,
      approvable: false,
      reason: "not a permission prompt"
    },
    screenExcerpt: screen
  };
}

async function fixture(screens: readonly string[]) {
  const events: Event[] = [];
  const provider = new RecordingProvider(events);
  const endpoint = (await provider.listTerminals())[0];
  assert.ok(endpoint);
  const control = provider.toControlRef(endpoint, ["screen_status", "send_keys"]);
  let captureIndex = 0;
  const service = new TerminalInteractionResponseBridge(provider, {
    captureInspection: async (_agent, currentControl) => {
      events.push("capture");
      const screen = screens[Math.min(captureIndex, screens.length - 1)] ?? "";
      captureIndex += 1;
      return {
        terminalControl: currentControl,
        screen,
        inspection: inspection(screen)
      };
    },
    verifyIdentity: async (_agent, currentControl) => {
      events.push("verify");
      return currentControl;
    },
    now: () => new Date(NOW),
    sleep: async (milliseconds) => {
      events.push(`sleep:${milliseconds}`);
    }
  });
  return { events, provider, service, control };
}

function offerFor(screen: string, control: TerminalControlRef) {
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex",
    terminalControl: control,
    screen,
    runtime: RUNTIME,
    now: NOW
  });
  assert.ok(offer);
  return offer;
}

function responseFor(
  offer: NonNullable<ReturnType<typeof captureTerminalInteractionRuntimeOffer>>,
  answer: TerminalInteractionResponseInput["answers"][number]
): TerminalInteractionResponseInput {
  return {
    interaction_id: offer.projection.interaction_id,
    ...(offer.projection.version === 2
      ? { subject: offer.projection.subject }
      : { turn_id: offer.projection.turn_id }),
    answers: [answer]
  };
}

test("semantic choice preserves capture, authorization, reservation, and one-dispatch order", async () => {
  const { events, service, control } = await fixture([OPTIONS_SCREEN]);
  const offer = offerFor(OPTIONS_SCREEN, control);
  const question = offer.projection.questions[0];
  assert.equal(question?.response_kind, "single_select");
  if (question?.response_kind !== "single_select") return;

  const result = await service.respond(
    "codex",
    control,
    responseFor(offer, {
      question_id: question.question_id,
      response_kind: "single_select",
      selected_option_ids: [question.options[0]!.option_id]
    }),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at,
      runtime: RUNTIME,
      authorize: () => {
        events.push("authorize");
        return { approved: true };
      },
      beforeDispatch: () => {
        events.push("reserve");
      }
    }
  );

  assert.deepEqual(result, {
    responded: true,
    blocked: false,
    interactionId: offer.projection.interaction_id,
    questionId: question.question_id,
    responseKind: "single_select",
    outcome: "submitted_or_advanced"
  });
  assert.deepEqual(events, [
    "capture",
    "authorize",
    "capture",
    "reserve",
    "capture",
    "verify",
    "keys:1"
  ]);
});

test("Codex free text is one text write, paste settle, identity proof, then one Enter", async () => {
  const { events, service, control } = await fixture([FREE_TEXT_SCREEN]);
  const offer = offerFor(FREE_TEXT_SCREEN, control);
  const question = offer.projection.questions[0];
  assert.equal(question?.response_kind, "free_text");
  if (question?.response_kind !== "free_text") return;

  const result = await service.respond(
    "codex",
    control,
    responseFor(offer, {
      question_id: question.question_id,
      response_kind: "free_text",
      text: "typed answer"
    }),
    {
      agentVersion: "0.153.4",
      expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at,
      runtime: RUNTIME,
      authorize: () => {
        events.push("authorize");
        return { approved: true };
      },
      beforeDispatch: () => {
        events.push("reserve");
      }
    }
  );

  assert.equal(result.outcome, "submitted_or_advanced");
  assert.deepEqual(events, [
    "capture",
    "authorize",
    "capture",
    "reserve",
    "capture",
    "verify",
    "text:typed answer",
    "sleep:121",
    "verify",
    "keys:C-m"
  ]);
});

test("post-reservation drift proves zero input while a possible text write stays uncertain", async () => {
  const drift = await fixture([OPTIONS_SCREEN, OPTIONS_SCREEN, CHANGED_SCREEN]);
  const choiceOffer = offerFor(OPTIONS_SCREEN, drift.control);
  const choice = choiceOffer.projection.questions[0];
  assert.equal(choice?.response_kind, "single_select");
  if (choice?.response_kind !== "single_select") return;

  await assert.rejects(
    drift.service.respond(
      "codex",
      drift.control,
      responseFor(choiceOffer, {
        question_id: choice.question_id,
        response_kind: "single_select",
        selected_option_ids: [choice.options[0]!.option_id]
      }),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: choiceOffer.promptFingerprint,
        expectedExpiresAt: choiceOffer.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch: () => {
          drift.events.push("reserve");
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionInputNotStartedError);
      assert.equal(
        error.message,
        "native questionnaire changed after dispatch reservation"
      );
      return true;
    }
  );
  assert.deepEqual(drift.events, [
    "capture",
    "capture",
    "reserve",
    "capture"
  ]);

  const uncertain = await fixture([FREE_TEXT_SCREEN]);
  uncertain.provider.failText = true;
  const textOffer = offerFor(FREE_TEXT_SCREEN, uncertain.control);
  const textQuestion = textOffer.projection.questions[0];
  assert.equal(textQuestion?.response_kind, "free_text");
  if (textQuestion?.response_kind !== "free_text") return;

  await assert.rejects(
    uncertain.service.respond(
      "codex",
      uncertain.control,
      responseFor(textOffer, {
        question_id: textQuestion.question_id,
        response_kind: "free_text",
        text: "possibly delivered"
      }),
      {
        agentVersion: "0.153.4",
        expectedFingerprint: textOffer.promptFingerprint,
        expectedExpiresAt: textOffer.projection.expires_at,
        runtime: RUNTIME,
        beforeDispatch: () => {
          uncertain.events.push("reserve");
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionDispatchReservedError);
      assert.equal(error.stage, "text_uncertain");
      assert.equal(
        error.message,
        "terminal interaction text dispatch is uncertain: text result unknown"
      );
      return true;
    }
  );
  assert.equal(uncertain.events.includes("keys:C-m"), false);
});
