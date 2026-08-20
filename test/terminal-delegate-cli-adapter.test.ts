import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";

import * as terminalDelegateCliAdapter from
  "../src/terminal-delegate-cli-adapter.js";
import type {
  TerminalDelegateCliDependencies,
  TerminalDelegateCliOptions
} from "../src/terminal-delegate-cli-adapter.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import type { Conversation } from "../src/protocol.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import { terminalBridgeRequestFingerprint } from
  "../src/terminal-dispatch-receipt.js";
import { terminalSubmissionPayload } from
  "../src/terminal-dispatch-execution.js";

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
}

interface DependencyOverrides {
  runtime?: Partial<TerminalDelegateCliDependencies["runtime"]>;
  repository?: Partial<TerminalDelegateCliDependencies["repository"]>;
  authority?: Partial<TerminalDelegateCliDependencies["authority"]>;
  terminalList?: Partial<TerminalDelegateCliDependencies["terminalList"]>;
  terminalCommand?: Partial<TerminalDelegateCliDependencies["terminalCommand"]>;
}

const STORE_DIR = "/delegate/store";
const WORKSPACE = "/delegate/workspace";
const REQUEST = "Implement the exact delegate route";
const MESSAGE_ID = "delegate-message-1";

function deferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

function terminalControl(
  target = "delegate:0.0",
  panePid = 71_001
): TerminalControlRef {
  return {
    kind: "tmux",
    target,
    session: target.split(":")[0],
    window: 0,
    pane: 0,
    panePid,
    capabilities: []
  };
}

function delegateReceipt(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    message_id: MESSAGE_ID,
    message_type: "task",
    message_body_hash: createHash("sha256").update(REQUEST).digest("hex"),
    request_hash: terminalBridgeRequestFingerprint(
      terminalSubmissionPayload(REQUEST)
    ),
    store_dir: STORE_DIR,
    status: "agent_accepted",
    ...overrides
  };
}

function ownerConversation(options: {
  receipt?: Record<string, unknown>;
  target?: string;
  panePid?: number;
  conversationId?: string;
  workspace?: string;
  eventLogPath?: string;
  agent?: "claude" | "codex";
} = {}): Conversation {
  const agent = options.agent ?? "codex";
  return {
    session_id: `session-${agent}`,
    turn_id: `turn-${agent}`,
    conversation_id: `turn-${agent}`,
    status: "waiting_for_agent",
    workspace: options.workspace ?? WORKSPACE,
    event_log_path: options.eventLogPath,
    executor: {
      kind: agent,
      actor: agent === "codex" ? "codex" : "claude-code",
      session: agent,
      display_name: agent,
      transport: "tmux"
    },
    native_session_takeover: {
      native_session_id: options.conversationId ?? "terminal-delegate",
      terminal_control: terminalControl(options.target, options.panePid),
      terminal_bridge_submission_receipts: [
        options.receipt ?? delegateReceipt()
      ]
    }
  } as unknown as Conversation;
}

function managedSession(options: {
  agent?: "claude" | "codex";
  completeRollout?: boolean;
} = {}): ManagedSessionState {
  const agent = options.agent ?? "codex";
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: `managed-${agent}`,
    agent,
    workspace: WORKSPACE,
    status: "bound",
    binding: {
      binding_id: `binding-${agent}`,
      generation: 1,
      terminal_id: "terminal-delegate",
      terminal_control: terminalControl(),
      native_process: {
        pid: 71_101,
        evidence: "delegate-test",
        ...(options.completeRollout
          ? { rollout: { fd: "17", device: "dev", inode: "71", path: "/rollout" } }
          : {})
      },
      bound_at: "2026-08-20T00:00:00.000Z",
      last_verified_at: "2026-08-20T00:00:00.000Z"
    },
    lineage: { created_by: "attach" },
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z"
  };
}

function dependencies(
  overrides: DependencyOverrides = {}
): TerminalDelegateCliDependencies {
  return {
    runtime: {
      canonicalWorkspace: (value) => String(value),
      required: (value, message) => {
        if (value === undefined || value === "") throw new Error(message);
        return value;
      },
      storeDir: () => STORE_DIR,
      ...overrides.runtime
    },
    repository: {
      listConversations: () => [],
      readEvents: () => [],
      storeDirForConversation: () => STORE_DIR,
      ...overrides.repository
    },
    authority: {
      assertSafeAbortedTerminalRetryBinding: () => undefined,
      ...overrides.authority
    },
    terminalList: {
      buildTerminalListGroup: async () => ({
        terminalControlled: [],
        summary: {}
      }),
      terminalDispatchOwnership: () => ({ state: "none" }),
      ...overrides.terminalList
    },
    terminalCommand: {
      runSend: async () => undefined,
      ...overrides.terminalCommand
    }
  } as TerminalDelegateCliDependencies;
}

function compiledFunctionSource(name: string, nextName: string): string {
  const source = fs.readFileSync(
    new URL("../src/terminal-delegate-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered token ${token}`);
    cursor = found + token.length;
  }
}

test("delegate facade exports one factory and isolates concurrent send closures", async (t) => {
  assert.deepEqual(Object.keys(terminalDelegateCliAdapter), [
    "createTerminalDelegateCliFacade"
  ]);
  const declaration = fs.readFileSync(
    new URL("../src/terminal-delegate-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(declaration, /\bany\b|ResolvedTerminalConversation/u);
  const events: string[] = [];
  const gateA = deferredGate();
  const gateB = deferredGate();
  t.after(() => {
    gateA.release();
    gateB.release();
  });
  const makeFacade = (marker: "A" | "B", gate: DeferredGate) =>
    terminalDelegateCliAdapter.createTerminalDelegateCliFacade(dependencies({
      repository: {
        listConversations: () => [ownerConversation()],
        readEvents: () => [],
        storeDirForConversation: () => STORE_DIR
      },
      terminalCommand: {
        runSend: async (options) => {
          events.push(`${marker}:send:before:${JSON.stringify(options)}`);
          await gate.promise;
          events.push(`${marker}:send:after`);
        }
      }
    }));
  const optionsA: TerminalDelegateCliOptions = {
    request: REQUEST,
    custom: "A",
    conversation: "old",
    message: "old",
    messageId: MESSAGE_ID
  };
  const optionsB = { ...optionsA, custom: "B" };
  const sendA = makeFacade("A", gateA).runDelegate(optionsA);
  const sendB = makeFacade("B", gateB).runDelegate(optionsB);
  assert.deepEqual(events.map((event) => event.slice(0, 13)), [
    "A:send:before", "B:send:before"
  ]);
  const sentA = JSON.parse(events[0].slice(events[0].indexOf("{") ));
  assert.deepEqual(sentA, {
    request: REQUEST,
    custom: "A",
    conversation: "terminal-delegate",
    message: REQUEST,
    messageId: MESSAGE_ID,
    workspace: WORKSPACE,
    background: true
  });
  gateB.release();
  await sendB;
  gateA.release();
  await sendA;
  assert.deepEqual(events.slice(-2), ["B:send:after", "A:send:after"]);
});

test("missing message id performs zero Store reads and event facts fill receipt fields", async () => {
  let storeReads = 0;
  const noId = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      runtime: {
        storeDir: () => {
          storeReads += 1;
          return STORE_DIR;
        }
      },
      repository: {
        listConversations: () => {
          storeReads += 1;
          return [];
        }
      }
    })
  );
  await assert.rejects(
    noId.runDelegate({ request: REQUEST }),
    /No idle Codex or Claude Code pane is available/u
  );
  assert.equal(storeReads, 0);

  const sent: TerminalDelegateCliOptions[] = [];
  const fallbackOwner = ownerConversation({
    eventLogPath: "/delegate/events.ndjson",
    receipt: delegateReceipt({
      message_type: undefined,
      message_body_hash: undefined
    })
  });
  const fallback = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      repository: {
        listConversations: () => [fallbackOwner],
        readEvents: () => [{
          message: { id: MESSAGE_ID, type: "task", body: REQUEST }
        }],
        storeDirForConversation: () => STORE_DIR
      },
      terminalCommand: { runSend: async (options) => { sent.push(options); } }
    })
  );
  await fallback.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });
  assert.equal(sent[0].conversation, "terminal-delegate");

  const duplicate = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      repository: {
        listConversations: () => [fallbackOwner],
        readEvents: () => [
          { message: { id: MESSAGE_ID, type: "task", body: REQUEST } },
          { message: { id: MESSAGE_ID, type: "task", body: REQUEST } }
        ],
        storeDirForConversation: () => STORE_DIR
      }
    })
  );
  await assert.rejects(
    duplicate.runDelegate({ request: REQUEST, messageId: MESSAGE_ID }),
    /duplicate durable messages/u
  );
});

test("durable receipt and route conflicts retain validation precedence", async () => {
  const run = (owners: Conversation[]) =>
    terminalDelegateCliAdapter.createTerminalDelegateCliFacade(dependencies({
      repository: {
        listConversations: () => owners,
        readEvents: () => [],
        storeDirForConversation: () => STORE_DIR
      }
    })).runDelegate({ request: REQUEST, messageId: MESSAGE_ID });

  await assert.rejects(
    run([
      ownerConversation(),
      ownerConversation({ target: "conflict:0.0", panePid: 71_002 })
    ]),
    /multiple durable delegate receipts/u
  );
  const safeReceipt = delegateReceipt({ status: "aborted", safe_to_retry: true });
  await assert.rejects(
    run([
      ownerConversation({ receipt: safeReceipt }),
      ownerConversation({
        receipt: safeReceipt,
        target: "conflict:0.0",
        panePid: 71_002
      })
    ]),
    /conflicting terminal routes/u
  );
  await assert.rejects(
    run([ownerConversation({
      receipt: delegateReceipt({ request_hash: "wrong-request" })
    })]),
    /does not match its original delegate request boundary/u
  );

  const owner = ownerConversation();
  const takeover = owner.native_session_takeover;
  let takeoverReads = 0;
  Object.defineProperty(owner, "native_session_takeover", {
    get() {
      takeoverReads += 1;
      return takeover;
    }
  });
  const repositoryFirst = terminalDelegateCliAdapter
    .createTerminalDelegateCliFacade(dependencies({
      repository: {
        listConversations: () => [owner],
        readEvents: () => [],
        storeDirForConversation: () => { throw new Error("store boundary first"); }
      }
    }));
  await assert.rejects(
    repositoryFirst.runDelegate({ request: REQUEST, messageId: MESSAGE_ID }),
    /store boundary first/u
  );
  assert.equal(takeoverReads, 4);
});

test("safe-aborted retry chooses Session except for a complete Codex rollout", async () => {
  const safeOwner = ownerConversation({
    receipt: delegateReceipt({ status: "aborted", safe_to_retry: true })
  });
  const route = async (session: ManagedSessionState | undefined) => {
    const sent: TerminalDelegateCliOptions[] = [];
    const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
      dependencies({
        repository: {
          listConversations: () => [safeOwner],
          readEvents: () => [],
          storeDirForConversation: () => STORE_DIR
        },
        authority: {
          assertSafeAbortedTerminalRetryBinding: () => session
        },
        terminalCommand: {
          runSend: async (options) => { sent.push(options); }
        }
      })
    );
    await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });
    return sent[0];
  };

  const claudeRoute = await route(managedSession({ agent: "claude" }));
  assert.equal(claudeRoute.session, "managed-claude");
  assert.equal(claudeRoute.conversation, undefined);
  const codexRoute = await route(managedSession({
    agent: "codex",
    completeRollout: true
  }));
  assert.equal(codexRoute.conversation, "terminal-delegate");
  assert.equal(codexRoute.session, undefined);
  await assert.rejects(
    route(undefined),
    /no restored retry Session/u
  );
});

test("discovery selection and compiled stable-route reads preserve exact order", async () => {
  const sent: TerminalDelegateCliOptions[] = [];
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: [{
            id: "terminal-idle",
            short_ref: "@idle",
            agent: "codex",
            activity_state: "idle",
            workspace: WORKSPACE,
            terminal_control: {
              ...terminalControl(),
              target: "delegate:0.0"
            }
          }],
          summary: {}
        }),
        terminalDispatchOwnership: () => ({ state: "none" })
      },
      terminalCommand: { runSend: async (options) => { sent.push(options); } }
    })
  );
  await facade.runDelegate({
    request: REQUEST,
    marker: "keep",
    conversation: "old",
    message: "old"
  });
  assert.deepEqual(Object.keys(sent[0]), [
    "request", "marker", "conversation", "message", "workspace", "background"
  ]);
  assert.equal(JSON.stringify(sent[0]), JSON.stringify({
    request: REQUEST,
    marker: "keep",
    conversation: "terminal-idle",
    message: REQUEST,
    workspace: WORKSPACE,
    background: true
  }));

  const ambiguous = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: ["first", "second"].map((name, index) => ({
            id: `terminal-${name}`,
            short_ref: `@${name}`,
            agent: "codex",
            activity_state: "idle",
            workspace: WORKSPACE,
            terminal_control: {
              ...terminalControl(`${name}:0.0`, 72_001 + index),
              target: `${name}:0.0`
            }
          })),
          summary: {}
        }),
        terminalDispatchOwnership: () => ({ state: "none" })
      }
    })
  );
  await assert.rejects(
    ambiguous.runDelegate({ request: REQUEST, workspace: WORKSPACE }),
    /Multiple idle coding-agent panes match/u
  );

  const stable = compiledFunctionSource(
    "stableDelegateTerminalRoute",
    "assertSingleDelegateCandidate"
  );
  assertOrdered(stable, [
    "options.messageId",
    "runtime.storeDir",
    "terminalSubmissionPayload",
    "options.openclawSession",
    "repository.listConversations",
    "terminalBridgeSubmissionReceipts",
    "routedDelegateReceipt",
    "selectedStableDelegateRoute"
  ]);
  const routed = compiledFunctionSource(
    "routedDelegateReceipt",
    "selectedStableDelegateRoute"
  );
  assertOrdered(routed, [
    "repository.storeDirForConversation",
    "owner.native_session_takeover",
    "terminalControlFromTakeover",
    "delegateEventMessage",
    "receipt.message_type",
    "receipt.message_body_hash",
    "runtime.canonicalWorkspace",
    "receipt.store_dir",
    "receipt.request_hash",
    "receipt.openclaw_session",
    "executorForConversation"
  ]);
});
