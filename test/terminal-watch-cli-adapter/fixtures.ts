import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TerminalInteractionInputNotStartedError,
  type TerminalAgentBridge,
  type TerminalInteractionAuthorizationContext,
  type TerminalInteractionResponseExecution
} from "../../src/terminal-agent-bridge.js";
import type {
  Conversation
} from "../../src/protocol.js";
import {
  loadTerminalWatch
} from "../../src/terminal-watch-store.js";
import {
  normalizeTerminalInteractionResponseV2,
  type TerminalInteractionSubjectProjection
} from "../../src/terminal-interaction-protocol.js";

export const THREAD_ID = "019f0000-0000-7000-8000-000000000206";
export const TASK_ID = "019f0000-0000-7000-8000-000000000207";
export const TOKEN = "a".repeat(64);
export type RootUserRowOrder = "human-only" | "synthetic-first" | "human-first";

export const CODEX_FALLBACK_QUESTION_ONE = `
  Question 1/2 (2 unanswered)
  Choose a framework.

  › 1. React  Component model.
    2. Vue  Progressive framework.

  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt
`;

export const CODEX_FALLBACK_QUESTION_TWO = `
  Question 2/2 (1 unanswered)
  Choose a test runner.

  › 1. Vitest  Fast feedback.
    2. Node test  Built in.

  tab to add notes | enter to submit all | ←/→ to navigate questions | esc to interrupt
`;

export const CODEX_ASYNC_QUESTION_COLLAPSED = [
  "• Working (3s • esc to interrupt)",
  "",
  "• Queued follow-up inputs",
  "  ? 1 question",
  "    shift + ← to answer"
].join("\n");

export const CLAUDE_NATIVE_QUESTION = `
old conversation output
 ☐ Color

Which color do you prefer?

❯ 1. Red
     The color red
  2. Blue
     The color blue
  3. Type something.
────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

export function exactTerminalObservation(
  terminals: Array<Record<string, unknown>>,
  terminalId: string,
  projectedTerminal?: Record<string, unknown>
) {
  const matches = terminals.filter((terminal) => terminal.id === terminalId);
  return matches.length === 1
    ? {
        state: "available" as const,
        rawTerminal: matches[0],
        terminal: projectedTerminal ?? matches[0],
        summary: {}
      }
    : { state: "absent" as const, summary: {} };
}

export function withTerminalWatchScreen(
  terminal: Record<string, any>,
  excerpt: string
): Record<string, any> {
  return {
    ...terminal,
    _terminal_status_snapshot: {
      screen: { excerpt }
    }
  };
}

export function fallbackAcceptedTurnRecords(
  request: string,
  turnId: string
): unknown[] {
  return [
    {
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId }
    },
    {
      timestamp: "2026-08-21T01:00:01.001Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: request }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId }
      }
    },
    {
      timestamp: "2026-08-21T01:00:01.002Z",
      type: "event_msg",
      payload: { type: "user_message", message: request }
    }
  ];
}

export function fallbackRequestUserInputRecord(
  turnId: string,
  callId: string
): unknown {
  return {
    timestamp: "2026-08-21T01:00:01.500Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "request_user_input",
      call_id: callId,
      arguments: JSON.stringify({
        questions: [
          {
            id: "framework",
            header: "Framework",
            question: "Choose a framework.",
            options: [
              { label: "React", description: "Component model." },
              { label: "Vue", description: "Progressive framework." }
            ]
          },
          {
            id: "runner",
            header: "Test runner",
            question: "Choose a test runner.",
            options: [
              { label: "Vitest", description: "Fast feedback." },
              { label: "Node test", description: "Built in." }
            ]
          }
        ]
      }),
      internal_chat_message_metadata_passthrough: { turn_id: turnId }
    }
  };
}

export function createClaudeQuestionnaireFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-terminal-watch-claude-questionnaire-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, ".claude");
  const workspace = path.join(root, "workspace");
  const sessionId = "019f0000-0000-7000-8000-000000000311";
  const projectsDirectory = path.join(
    claudeHome,
    "projects",
    workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  const transcriptPath = path.join(projectsDirectory, `${sessionId}.jsonl`);
  fs.mkdirSync(projectsDirectory, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { recursive: true });
  const pid = 6311;
  const startedAt = 1784870000000;
  const version = "2.1.267";
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    uuid: "019f0000-0000-7000-8000-000000000312",
    parentUuid: null,
    isSidechain: false,
    entrypoint: "cli",
    timestamp: "2026-08-21T01:00:00.000Z",
    sessionId,
    version,
    cwd: workspace,
    type: "user",
    promptId: "019f0000-0000-7000-8000-000000000313",
    message: {
      role: "user",
      content: "Ask one native questionnaire"
    }
  })}\n`, { mode: 0o600 });
  let now = new Date("2026-08-21T01:00:00.100Z");
  const agentRows = [{
    pid,
    cwd: workspace,
    kind: "interactive" as const,
    sessionId,
    startedAt,
    status: "working" as const
  }];
  return {
    claudeHome,
    storeDir: path.join(root, "store"),
    agentRows,
    now: () => new Date(now),
    advance: () => {
      now = new Date("2026-08-21T01:00:02.000Z");
    },
    terminal: {
      id: "terminal:v2:claude:questionnaire-fixture",
      source: "terminal",
      agent: "claude",
      pid,
      workspace,
      cwd: workspace,
      native_agent_session_id: sessionId,
      native_agent_process_uuid: `claude-pid:${pid}:birth:${startedAt}`,
      native_agent_process_birth: String(startedAt),
      native_agent_process_started_at: startedAt,
      agent_version: version,
      lifecycle_binding_token: "e".repeat(64),
      activity_state: "working",
      approval_state: { blocked: false, approvable: false },
      terminal_control: {
        kind: "tmux",
        target: "claude-watch-session:0.0",
        session: "claude-watch-session",
        window: 0,
        pane: 0,
        panePid: 6300,
        currentCommand: "claude",
        currentPath: workspace,
        capabilities: ["screen_status", "durable_completion"]
      },
      available_actions: {
        watch: {
          tool: "agent_knock_knock_watch",
          arguments: {
            terminal_id: "terminal:v2:claude:questionnaire-fixture"
          },
          requires_user_intent: true,
          use: "Monitor this human-started external task."
        }
      }
    } as Record<string, any>
  };
}

export function createFixture(
  t: test.TestContext,
  rootUserRowOrder: RootUserRowOrder = "human-only",
  codexVersion = "0.148.0"
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-watch-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolloutPath = path.join(root, "rollout.jsonl");
  const request = "Human-started task";
  const humanRootUserRow = {
    timestamp: "2026-08-21T01:00:00.010Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const syntheticContextRow = {
    timestamp: rootUserRowOrder === "synthetic-first"
      ? "2026-08-21T01:00:00.009Z"
      : "2026-08-21T01:00:00.012Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context>\n  <cwd>${root}</cwd>\n</environment_context>`
      }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const humanUserMessageEvent = {
    timestamp: "2026-08-21T01:00:00.011Z",
    type: "event_msg",
    payload: { type: "user_message", message: request }
  };
  const rootTaskRecords = rootUserRowOrder === "human-only"
    ? [humanRootUserRow, humanUserMessageEvent]
    : rootUserRowOrder === "synthetic-first"
      ? [syntheticContextRow, humanRootUserRow, humanUserMessageEvent]
      : [humanRootUserRow, humanUserMessageEvent, syntheticContextRow];
  fs.writeFileSync(
    rolloutPath,
    [
      {
        timestamp: "2026-08-21T00:59:59.000Z",
        type: "session_meta",
        payload: {
          id: THREAD_ID,
          timestamp: "2026-08-21T00:00:00.000Z",
          cwd: root,
          originator: "codex-tui",
          source: "cli",
          cli_version: codexVersion
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: TASK_ID }
      },
      ...rootTaskRecords
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  let now = new Date("2026-08-21T01:00:00.100Z");
  const processBirth = "Fri Aug 21 08:59:00 2026";
  return {
    rolloutPath,
    storeDir: path.join(root, "store"),
    now: () => new Date(now),
    advance: () => {
      now = new Date("2026-08-21T01:00:02.000Z");
    },
    setNow: (value: string) => {
      now = new Date(value);
    },
    terminal: {
      id: "terminal:v2:watch-fixture",
      source: "terminal",
      agent: "codex",
      pid: 6206,
      workspace: root,
      cwd: root,
      native_agent_session_id: THREAD_ID,
      native_agent_process_uuid: `codex-pid:6206:birth:${processBirth}`,
      native_agent_process_birth: processBirth,
      native_agent_rollout: {
        fd: "12r",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: rolloutPath
      },
      agent_version: codexVersion,
      native_thread_lifecycle: {
        status: "supported",
        behaviorProfile: codexVersion === "0.148.0"
          ? "codex-tui-0.148.0"
          : "codex-tui-generic-v1",
        versionCompatibility: codexVersion === "0.148.0"
          ? "verified"
          : "unverified",
        ...(codexVersion === "0.148.0"
          ? {}
          : {
              compatibilityWarning:
                `Codex ${codexVersion} has not been regression-tested by AKK`
            })
      },
      lifecycle_binding_token: TOKEN,
      activity_state: "working",
      approval_state: { blocked: false, approvable: false },
      terminal_control: {
        kind: "tmux",
        target: "watch-session:0.0",
        session: "watch-session",
        window: 0,
        pane: 0,
        panePid: 6200,
        currentCommand: "codex",
        currentPath: root,
        capabilities: ["screen_status", "durable_completion"]
      },
      available_actions: {
        watch: {
          tool: "agent_knock_knock_watch",
          arguments: {
            terminal_id: "terminal:v2:watch-fixture"
          },
          ...(codexVersion === "0.148.0"
            ? {}
            : {
                compatibility_warning:
                  `Codex ${codexVersion} has not been regression-tested by AKK`
              }),
          requires_user_intent: true,
          use: "Monitor this human-started external task."
        }
      }
    }
  };
}

export function withCodexCandidateInventory(
  terminal: Record<string, any>
): Record<string, any> {
  const processUuid = String(terminal.native_agent_process_uuid);
  const processBirth = String(terminal.native_agent_process_birth);
  const rollout = structuredClone(record(terminal.native_agent_rollout));
  return {
    ...terminal,
    _codex_open_root_rollout_inventory: codexInventoryForTerminal(
      terminal,
      [{
        sessionId: String(terminal.native_agent_session_id),
        processUuid,
        processBirth,
        rollout,
        evidence: "codex_open_root_rollout" as const
      }]
    )
  };
}

export function codexInventoryForTerminal(
  terminal: Record<string, any>,
  roots: Array<Record<string, unknown>>
) {
  const authority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid: Number(terminal.pid),
    processUuid: String(terminal.native_agent_process_uuid),
    processBirth: String(terminal.native_agent_process_birth),
    roots
  };
  return {
    ...authority,
    status: roots.length === 0 ? "verified_absent" as const :
      roots.length === 1 ? "resolved" as const : "unbound" as const,
    ...(roots.length > 1
      ? { reason: "multiple_open_root_rollouts" as const }
      : {}),
    inventoryFingerprint: createHash("sha256")
      .update(JSON.stringify(authority))
      .digest("hex")
  };
}

export function managedTurn(): Conversation {
  return {
    session_id: "session-managed-206",
    turn_id: "turn-managed-206",
    conversation_id: "turn-managed-206",
    user_request: "managed request",
    openclaw_session: "agent:main:main",
    claude_session: "",
    executor: { kind: "codex" },
    workspace: "/tmp/managed-watch",
    status: "running",
    response_rounds_used: 0,
    soft_limit: 10,
    hard_limit: 20,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:01.000Z"
  } as Conversation;
}

export function managedInteractionTurn(
  surfaceId: string,
  promptFingerprint: string,
  openclawSession = "agent:main:main",
  options: {
    respond?: boolean;
    state?: "pending" | "manual_required";
    omitNotifiedAt?: boolean;
  } = {}
): Conversation {
  const turn = managedTurn();
  const interactionId = "ti_managed_watch_arbitration_fixture";
  const questionId = "question_managed_watch_arbitration_fixture";
  const respond = options.respond !== false;
  return {
    ...turn,
    openclaw_session: openclawSession,
    native_session_takeover: {
      terminal_bridge_interaction_notification: {
        interaction_id: interactionId,
        question_id: questionId,
        prompt_fingerprint: promptFingerprint,
        surface_id: surfaceId,
        ...(options.omitNotifiedAt
          ? {}
          : { notified_at: "2026-08-21T01:00:02.500Z" }),
        interaction_state: {
          schema: "agent-knock-knock/terminal-interaction",
          version: 1,
          interaction_id: interactionId,
          turn_id: turn.turn_id,
          agent: "codex",
          kind: "questionnaire",
          state: options.state ?? (respond ? "pending" : "manual_required"),
          step: { index: 1, total: 1 },
          questions: [{
            question_id: questionId,
            prompt: "Choose a framework",
            required: true,
            response_kind: "single_select",
            options: [
              { option_id: "option_react", label: "React" },
              { option_id: "option_vue", label: "Vue" }
            ]
          }],
          expires_at: "2026-08-21T01:10:00.000Z",
          capabilities: {
            respond,
            batch_response: false,
            free_text: false,
            multi_select: false
          }
        }
      }
    }
  };
}

export function managedConsumedInteractionTurn(
  surfaceId: string,
  promptFingerprint: string,
  openclawSession = "agent:main:main"
): Conversation {
  return {
    ...managedTurn(),
    openclaw_session: openclawSession,
    status: "waiting_for_agent",
    native_session_takeover: {
      terminal_bridge_last_interaction_id:
        "ti_managed_watch_consumed_fixture",
      terminal_bridge_last_interaction_surface_id: surfaceId,
      terminal_bridge_last_interaction_fingerprint: promptFingerprint,
      terminal_bridge_last_interaction_at: "2026-08-21T01:00:02.500Z"
    }
  };
}

export type WatchBridgeMode = "success" | "input_not_started" | "input_uncertain";

export function watchInteractionBridge(input: {
  storeDir: string;
  watchId(): string;
  mode: WatchBridgeMode;
  onTerminalInput(): void;
  afterAuthorize?(context: TerminalInteractionAuthorizationContext):
    void | Promise<void>;
}): TerminalAgentBridge {
  const bridge: Pick<TerminalAgentBridge, "respondInteraction"> = {
    async respondInteraction(
      agent,
      terminalControl,
      response,
      options
    ): Promise<TerminalInteractionResponseExecution> {
      const watch = loadTerminalWatch(input.storeDir, input.watchId());
      const projection = watch.current_interaction?.projection;
      assert.ok(projection);
      const context: TerminalInteractionAuthorizationContext = {
        agent,
        terminalControl,
        fingerprint: projection.prompt_fingerprint,
        projection,
        response: normalizeTerminalInteractionResponseV2(
          response,
          projection,
          { allowExpiredForLiveRecapture: true }
        ),
        runtime: options.runtime
      };
      const authorization = await options.authorize?.(context) ?? {
        approved: true
      };
      if (!authorization.approved) {
        return {
          responded: false,
          blocked: true,
          reason: authorization.reason,
          interactionId: response.interaction_id
        };
      }
      await input.afterAuthorize?.(context);
      await options.beforeDispatch?.(context);
      if (input.mode === "input_not_started") {
        throw new TerminalInteractionInputNotStartedError(
          "fixture proved no terminal input was attempted"
        );
      }
      input.onTerminalInput();
      if (input.mode === "input_uncertain") {
        throw new Error("fixture lost terminal acknowledgement after input");
      }
      const answer = response.answers[0];
      return {
        responded: true,
        blocked: false,
        interactionId: response.interaction_id,
        questionId: answer?.question_id,
        responseKind: answer?.response_kind,
        outcome: "submitted_or_advanced"
      };
    }
  };
  return bridge as TerminalAgentBridge;
}

export function watchInteractionResponse(
  projection: TerminalInteractionSubjectProjection
): string {
  assert.equal(projection.subject.kind, "terminal_watch");
  const question = projection.questions[0];
  assert.equal(question?.response_kind, "single_select");
  if (!question || question.response_kind !== "single_select") {
    throw new Error("expected single-select Watch fixture");
  }
  return JSON.stringify({
    interaction_id: projection.interaction_id,
    subject: projection.subject,
    answers: [{
      question_id: question.question_id,
      response_kind: "single_select",
      selected_option_ids: [question.options[0].option_id]
    }]
  });
}

export function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}
