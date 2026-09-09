import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalInteractionCliAdapter,
  type TerminalInteractionCliDependencies
} from "../src/terminal-interaction-cli-adapter.js";
import {
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type ResolvedTerminalConversation,
  type TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { createConversation, type Conversation } from "../src/protocol.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const EXPIRES = "2026-09-07T12:10:00.000Z";
const FINGERPRINT = "a".repeat(64);
const SURFACE_ID = `tis_${"b".repeat(40)}`;
const INTERACTION_ID = "interaction_1234567890abcdef";
const QUESTION_ID = "question_1234567890abcdef";
const OPTION_ID = "option_1234567890abcdef";
const INTERACTION_NOTIFICATION = {
  terminal_bridge_message_id: "message-interaction",
  interaction_id: INTERACTION_ID,
  question_id: QUESTION_ID,
  prompt_fingerprint: FINGERPRINT,
  surface_id: SURFACE_ID,
  callback_message_id: "callback-interaction",
  callback_message_ts: NOW.toISOString()
};

const terminalControl = {
  kind: "tmux",
  target: "interaction:0.0",
  currentPath: "/workspace/project",
  panePid: 4242,
  capabilities: ["screen_status", "send_keys"]
} as TerminalControlRef;

function managedTurn(): Conversation {
  return {
    ...createConversation({
      userRequest: "ask a native question",
      sessionId: "session-interaction",
      turnId: "turn-interaction",
      executorKind: "claude",
      executorSession: "claude-interaction",
      openclawSession: "agent:main:main",
      workspace: "/workspace/project",
      now: NOW
    }),
    status: "waiting_for_agent",
    callback_delivery: {
      kind: "interaction_notification",
      status: "failed",
      attempts: 1,
      message: {
        id: "callback-interaction",
        metadata: {
          source: "terminal_bridge",
          reason: "interaction_required",
          interaction_state: {
            interaction_id: INTERACTION_ID,
            turn_id: "turn-interaction"
          }
        }
      }
    },
    native_session_takeover: {
      terminal_bridge: true,
      terminal_agent_pid: 4242,
      terminal_bridge_message_id: "message-interaction",
      terminal_bridge_interaction_notification: INTERACTION_NOTIFICATION,
      native_session_id: "terminal:v2:tmux:claude:interaction:0.0:4242",
      terminal_control: terminalControl
    }
  };
}

function responseJson(): string {
  return JSON.stringify({
    turn_id: "turn-interaction",
    interaction_id: INTERACTION_ID,
    answers: [{
      question_id: QUESTION_ID,
      response_kind: "single_select",
      selected_option_ids: [OPTION_ID]
    }]
  });
}

function harness(input: {
  bridge: Pick<TerminalAgentBridge, "resolveStoredTerminal" | "respondInteraction">;
  conversation?: Conversation;
  afterSave?: (conversation: Conversation, saveCount: number) => Conversation;
}) {
  let current = input.conversation ?? managedTurn();
  let saveCount = 0;
  const events: Record<string, unknown>[] = [];
  const printed: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const dependencies: TerminalInteractionCliDependencies = {
    selection: {
      loadConversation: () => ({
        conversation: current,
        statePath: "/store/conversations/turn-interaction/state.json",
        logPath: "/store/conversations/turn-interaction/events.ndjson"
      }),
      terminalControlFromTakeover: (value) => {
        if (!value || typeof value !== "object") return undefined;
        return (value as Record<string, unknown>).terminal_control as
          TerminalControlRef | undefined;
      }
    },
    authority: {
      runtimeIdentity: () => ({
        pid: 4242,
        conversationId: "turn-interaction",
        turnId: "turn-interaction",
        messageId: "message-interaction",
        terminalTarget: terminalControl.target,
        agentVersion: "2.1.263"
      }),
      assertTurnBindingCurrent: () => calls.push("binding"),
      assertManagedTerminalDispatchOwner: () => calls.push("owner"),
      sameTerminalIncarnation: (left, right) => left.target === right.target
    },
    terminal: {
      createBridge: () => input.bridge as TerminalAgentBridge
    },
    repository: {
      loadState: () => current,
      saveState: (_path, conversation) => {
        saveCount += 1;
        current = input.afterSave?.(conversation, saveCount) ?? conversation;
        calls.push("save");
      },
      appendEvent: (_path, event) => events.push(event),
      storeDirForConversationDir: () => "/store",
      withLockedTurn: async ({ operation }) => {
        calls.push("lock");
        return operation();
      }
    },
    monitor: {
      ensureAfterResponse: () => {
        calls.push("monitor");
        return { monitorPid: 9001 };
      }
    },
    runtime: {
      now: () => NOW,
      printJson: (value) => printed.push(value),
      log: (_level, event) => calls.push(`log:${event}`)
    }
  };
  return {
    facade: createTerminalInteractionCliAdapter(dependencies),
    current: () => current,
    events,
    printed,
    calls
  };
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    turn: "turn-interaction",
    interaction: INTERACTION_ID,
    responseJson: responseJson(),
    expectedInteractionFingerprint: FINGERPRINT,
    expectedInteractionExpiresAt: EXPIRES,
    openclawSession: "agent:main:main",
    ...overrides
  };
}

function successfulBridge() {
  return {
    async resolveStoredTerminal(
      ..._args: Parameters<TerminalAgentBridge["resolveStoredTerminal"]>
    ): Promise<ResolvedTerminalConversation> {
      return {
        conversationId: "terminal:v2:tmux:claude:interaction:0.0:4242",
        agent: "claude" as const,
        pid: 4242,
        legacy: false,
        adapter: {} as ResolvedTerminalConversation["adapter"],
        terminalControl
      };
    },
    async respondInteraction(_agent, _control, response, executionOptions) {
      const projection = {
        interaction_id: INTERACTION_ID
      } as never;
      const context = {
        agent: "claude" as const,
        terminalControl,
        fingerprint: FINGERPRINT,
        projection,
        response,
        runtime: executionOptions.runtime
      };
      const authorized = await executionOptions.authorize?.(context);
      assert.equal(authorized?.approved, true);
      await executionOptions.beforeDispatch?.(context);
      return {
        responded: true,
        blocked: false,
        interactionId: INTERACTION_ID,
        questionId: QUESTION_ID,
        responseKind: "single_select" as const,
        outcome: "submitted_or_advanced" as const
      };
    }
  } satisfies Pick<
    TerminalAgentBridge,
    "resolveStoredTerminal" | "respondInteraction"
  >;
}

test("semantic interaction response reserves once, audits without text, and resumes monitor", async () => {
  const subject = harness({ bridge: successfulBridge() });

  await subject.facade.runRespondInteraction(options());

  const takeover = subject.current().native_session_takeover as
    Record<string, unknown>;
  assert.equal(subject.current().status, "waiting_for_agent");
  assert.equal(takeover.terminal_bridge_interaction_dispatch, undefined);
  assert.equal(takeover.terminal_bridge_last_interaction_id, INTERACTION_ID);
  assert.equal(
    takeover.terminal_bridge_last_interaction_fingerprint,
    FINGERPRINT
  );
  assert.equal(
    takeover.terminal_bridge_last_interaction_surface_id,
    SURFACE_ID
  );
  assert.equal(
    takeover.terminal_bridge_last_interaction_message_id,
    "message-interaction"
  );
  assert.equal(
    takeover.terminal_bridge_interaction_notification,
    undefined
  );
  assert.equal(
    (subject.current().callback_delivery as Record<string, unknown>).status,
    "superseded"
  );
  assert.equal(subject.events.length, 1);
  assert.equal(subject.events[0]?.event, "terminal_interaction_response_send");
  assert.doesNotMatch(JSON.stringify(subject.events), /selected_option_ids/u);
  assert.equal(subject.printed[0]?.responded, true);
  assert.equal(subject.printed[0]?.monitor_pid, 9001);
  assert.equal(subject.calls.filter((call) => call === "save").length, 2);
  assert.ok(subject.calls.includes("owner"));
  assert.ok(subject.calls.includes("monitor"));
});

test("controller-session mismatch fails before terminal resolution", async () => {
  let resolved = false;
  const bridge = successfulBridge();
  const subject = harness({
    bridge: {
      ...bridge,
      async resolveStoredTerminal(...args) {
        resolved = true;
        return bridge.resolveStoredTerminal(...args);
      }
    }
  });

  await assert.rejects(
    () => subject.facade.runRespondInteraction(
      options({ openclawSession: "agent:other:session" })
    ),
    /different controller session/u
  );
  assert.equal(resolved, false);
});

test("callback gateway session never replaces the Turn's OpenClaw owner", async () => {
  const conversation = {
    ...managedTurn(),
    gateway_session: "agent:callback:route"
  };
  const owner = harness({ bridge: successfulBridge(), conversation });
  await owner.facade.runRespondInteraction(options());
  assert.equal(owner.current().status, "waiting_for_agent");

  let resolved = false;
  const bridge = successfulBridge();
  const callbackRoute = harness({
    conversation,
    bridge: {
      ...bridge,
      async resolveStoredTerminal(...args) {
        resolved = true;
        return bridge.resolveStoredTerminal(...args);
      }
    }
  });
  await assert.rejects(
    () => callbackRoute.facade.runRespondInteraction(options({
      openclawSession: "agent:callback:route"
    })),
    /different controller session/u
  );
  assert.equal(resolved, false);
});

test("a successfully consumed interaction fingerprint cannot be replayed", async () => {
  const subject = harness({ bridge: successfulBridge() });

  await subject.facade.runRespondInteraction(options());
  await assert.rejects(
    () => subject.facade.runRespondInteraction(options()),
    /fingerprint was already consumed/u
  );
  assert.equal(
    subject.calls.filter((call) => call === "monitor").length,
    1
  );
});

test("post-reservation uncertainty stalls the Turn and preserves one-shot receipt", async () => {
  const bridge = successfulBridge();
  const subject = harness({
    bridge: {
      ...bridge,
      async respondInteraction(agent, control, response, executionOptions) {
        const projection = { interaction_id: INTERACTION_ID } as never;
        const context = {
          agent,
          terminalControl: control,
          fingerprint: FINGERPRINT,
          projection,
          response,
          runtime: executionOptions.runtime
        };
        await executionOptions.beforeDispatch?.(context);
        throw new TerminalInteractionDispatchReservedError(
          "key_uncertain",
          "key dispatch outcome is uncertain"
        );
      }
    }
  });

  await assert.rejects(
    () => subject.facade.runRespondInteraction(options()),
    (error: unknown) =>
      error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry
  );
  const takeover = subject.current().native_session_takeover as
    Record<string, unknown>;
  const dispatch = takeover.terminal_bridge_interaction_dispatch as
    Record<string, unknown>;
  assert.equal(subject.current().status, "stalled");
  assert.equal(dispatch.state, "uncertain");
  assert.equal(dispatch.interaction_id, INTERACTION_ID);
  assert.deepEqual(
    takeover.terminal_bridge_interaction_notification,
    INTERACTION_NOTIFICATION
  );
  assert.equal(
    takeover.terminal_bridge_last_interaction_message_id,
    undefined
  );
  assert.equal(subject.events[0]?.event,
    "terminal_interaction_response_uncertain");
  assert.doesNotMatch(JSON.stringify(subject.events), /selected_option_ids/u);
  assert.equal(subject.calls.includes("monitor"), false);
});

test("proven zero-input abort clears the exact reservation without stalling", async () => {
  const bridge = successfulBridge();
  const subject = harness({
    conversation: {
      ...managedTurn(),
      status: "waiting_for_openclaw"
    },
    bridge: {
      ...bridge,
      async respondInteraction(agent, control, response, executionOptions) {
        const projection = { interaction_id: INTERACTION_ID } as never;
        const context = {
          agent,
          terminalControl: control,
          fingerprint: FINGERPRINT,
          projection,
          response,
          runtime: executionOptions.runtime
        };
        const authorized = await executionOptions.authorize?.(context);
        assert.equal(authorized?.approved, true);
        await executionOptions.beforeDispatch?.(context);
        throw new TerminalInteractionInputNotStartedError(
          "native questionnaire changed after dispatch reservation"
        );
      }
    }
  });

  await assert.rejects(
    () => subject.facade.runRespondInteraction(options()),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionInputNotStartedError);
      assert.equal(error.code, "AKK_TERMINAL_INTERACTION_INPUT_NOT_STARTED");
      assert.equal(error.stage, "input_not_started");
      return true;
    }
  );
  const takeover = subject.current().native_session_takeover as
    Record<string, unknown>;
  assert.equal(subject.current().status, "waiting_for_openclaw");
  assert.equal(takeover.terminal_bridge_interaction_dispatch, undefined);
  assert.deepEqual(
    takeover.terminal_bridge_interaction_notification,
    INTERACTION_NOTIFICATION
  );
  assert.equal(
    takeover.terminal_bridge_last_interaction_fingerprint,
    undefined
  );
  assert.equal(
    takeover.terminal_bridge_last_interaction_message_id,
    undefined
  );
  assert.equal(subject.events.length, 1);
  assert.equal(
    subject.events[0]?.event,
    "terminal_interaction_response_not_started"
  );
  assert.doesNotMatch(JSON.stringify(subject.events), /selected_option_ids/u);
  assert.equal(
    subject.events.some((event) =>
      event.event === "terminal_interaction_response_uncertain"),
    false
  );
  assert.equal(subject.calls.filter((call) => call === "save").length, 2);
});

test("zero-input cleanup never overwrites a different durable reservation", async () => {
  const replacementDispatch = {
    state: "reserved",
    attempt_id: "attempt-newer-reservation",
    interaction_id: INTERACTION_ID,
    interaction_prompt_fingerprint: "b".repeat(64),
    response_sha256: "c".repeat(64),
    terminal_target: terminalControl.target,
    terminal_bridge_message_id: "message-interaction",
    reserved_at: "2026-09-07T12:00:01.000Z"
  };
  const bridge = successfulBridge();
  const subject = harness({
    conversation: {
      ...managedTurn(),
      status: "waiting_for_openclaw"
    },
    afterSave(conversation, saveCount) {
      if (saveCount !== 1) return conversation;
      const takeover = conversation.native_session_takeover as
        Record<string, unknown>;
      return {
        ...conversation,
        native_session_takeover: {
          ...takeover,
          terminal_bridge_interaction_dispatch: replacementDispatch
        },
        updated_at: replacementDispatch.reserved_at
      };
    },
    bridge: {
      ...bridge,
      async respondInteraction(agent, control, response, executionOptions) {
        const projection = { interaction_id: INTERACTION_ID } as never;
        const context = {
          agent,
          terminalControl: control,
          fingerprint: FINGERPRINT,
          projection,
          response,
          runtime: executionOptions.runtime
        };
        const authorized = await executionOptions.authorize?.(context);
        assert.equal(authorized?.approved, true);
        await executionOptions.beforeDispatch?.(context);
        throw new TerminalInteractionInputNotStartedError(
          "native questionnaire changed after dispatch reservation"
        );
      }
    }
  });

  await assert.rejects(
    () => subject.facade.runRespondInteraction(options()),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInteractionDispatchReservedError);
      assert.equal(error.stage, "reservation_uncertain");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  const takeover = subject.current().native_session_takeover as
    Record<string, unknown>;
  assert.equal(subject.current().status, "waiting_for_openclaw");
  assert.deepEqual(
    takeover.terminal_bridge_interaction_dispatch,
    replacementDispatch
  );
  assert.equal(subject.events.length, 0);
  assert.equal(subject.calls.filter((call) => call === "save").length, 1);
});

test("an expired displayed timestamp reaches the bridge live-recapture path", async () => {
  const subject = harness({ bridge: successfulBridge() });
  await subject.facade.runRespondInteraction(options({
    expectedInteractionExpiresAt: NOW.toISOString()
  }));

  assert.equal(subject.current().status, "waiting_for_agent");
  assert.equal(subject.printed[0]?.responded, true);
  assert.ok(subject.calls.includes("owner"));
  assert.ok(subject.calls.includes("save"));
});

test("invalid expiry timestamps and response JSON fail before terminal input", async () => {
  const subject = harness({ bridge: successfulBridge() });
  await assert.rejects(
    () => subject.facade.runRespondInteraction(options({
      expectedInteractionExpiresAt: "not-a-timestamp"
    })),
    /valid timestamp/u
  );
  await assert.rejects(
    () => subject.facade.runRespondInteraction(options({
      responseJson: "{"
    })),
    /response-json/u
  );
  assert.equal(subject.calls.length, 0);
});
