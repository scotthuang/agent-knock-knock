import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as terminalDelegateCliAdapter from
  "../src/terminal-delegate-cli-adapter.js";
import type {
  TerminalDelegateCliDependencies,
  TerminalDelegateCliOptions
} from "../src/terminal-delegate-cli-adapter.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import {
  createTerminalDelegateSendBindingRepository,
  TerminalDelegateSendBindingUncertainError,
  type TerminalDelegateSendBinding,
  type TerminalDelegateSendBindingRepository
} from "../src/terminal-delegate-send-binding.js";

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
}

interface DependencyOverrides {
  runtime?: Partial<TerminalDelegateCliDependencies["runtime"]>;
  terminalList?: Partial<TerminalDelegateCliDependencies["terminalList"]>;
  sendBinding?: TerminalDelegateSendBindingRepository;
  terminalCommand?: Partial<TerminalDelegateCliDependencies["terminalCommand"]>;
}

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

function userExplicitSendAction(
  terminalId: string,
  expectedTerminalToken = `physical-token:${terminalId}`,
  expectedManagedTerminalToken?: string
): Record<string, unknown> {
  return {
    tool: "agent_knock_knock_send",
    scope: "terminal_user_explicit",
    arguments: {
      selector: terminalId,
      expected_terminal_token: expectedTerminalToken,
      ...(expectedManagedTerminalToken
        ? { expected_managed_terminal_token: expectedManagedTerminalToken }
        : {})
    },
    missing_required: ["request"]
  };
}

function sendReadyTerminal(options: {
  id?: string;
  shortRef?: string;
  target?: string;
  panePid?: number;
  activity?: string;
  physicalToken?: string;
} = {}) {
  const id = options.id ?? "terminal-delegate";
  return {
    id,
    short_ref: options.shortRef ?? "@delegate",
    agent: "codex" as const,
    activity_state: options.activity ?? "idle",
    workspace: WORKSPACE,
    terminal_control: { ...terminalControl(options.target, options.panePid) },
    _terminal_user_explicit_send_action: userExplicitSendAction(
      id,
      options.physicalToken
    )
  };
}

function memorySendBindingRepository(): TerminalDelegateSendBindingRepository {
  const bindings = new Map<string, TerminalDelegateSendBinding>();
  const held = new Set<string>();
  const sameRequest = (
    binding: TerminalDelegateSendBinding,
    boundary: Parameters<TerminalDelegateSendBindingRepository["load"]>[0]
  ) => binding.requestHash === boundary.requestHash &&
    binding.requestedWorkspace === boundary.requestedWorkspace &&
    binding.requestedAgent === boundary.requestedAgent &&
    binding.openclawSession === boundary.openclawSession;
  return {
    pathFor: ({ messageId }) => `/memory/${messageId}`,
    acquire: (messageId) => {
      assert.equal(held.has(messageId), false, "message lock already held");
      held.add(messageId);
      return () => { held.delete(messageId); };
    },
    load: (boundary) => {
      const existing = bindings.get(boundary.messageId);
      if (existing && !sameRequest(existing, boundary)) {
        throw new Error("messageId has a different delegate request boundary");
      }
      return existing;
    },
    bind: (boundary, target) => {
      assert.equal(held.has(boundary.messageId), true, "message lock required");
      const existing = bindings.get(boundary.messageId);
      if (existing) {
        if (
          !sameRequest(existing, boundary) ||
          existing.terminalId !== target.terminalId ||
          existing.workspace !== target.workspace ||
          existing.terminalRuntimeKey !== target.terminalRuntimeKey ||
          existing.physicalToken !== target.physicalToken
        ) {
          throw new Error("messageId has a different physical terminal");
        }
        return { outcome: "replay", binding: existing };
      }
      const binding: TerminalDelegateSendBinding = {
        ...boundary,
        ...target,
        reservedAt: "2026-08-25T00:00:00.000Z"
      };
      bindings.set(boundary.messageId, binding);
      return { outcome: "reserved", binding };
    }
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
      terminalRuntimeKey: (control) =>
        `${control.kind}:${control.target}:${control.panePid ?? "unknown"}`,
      ...overrides.runtime
    },
    terminalList: {
      buildTerminalListGroup: async () => ({
        terminalControlled: [],
        summary: {}
      }),
      observeExactTerminal: async () => ({ state: "absent", summary: {} }),
      ...overrides.terminalList
    },
    sendBinding: overrides.sendBinding ?? memorySendBindingRepository(),
    terminalCommand: {
      runSend: async () => undefined,
      ...overrides.terminalCommand
    }
  };
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
  assert.doesNotMatch(
    declaration,
    /\bany\b|ResolvedTerminalConversation|ManagedSessionState|repository:/u
  );
  const events: string[] = [];
  const gateA = deferredGate();
  const gateB = deferredGate();
  const enteredA = deferredGate();
  const enteredB = deferredGate();
  t.after(() => {
    gateA.release();
    gateB.release();
  });
  const makeFacade = (
    marker: "A" | "B",
    gate: DeferredGate,
    entered: DeferredGate
  ) => terminalDelegateCliAdapter.createTerminalDelegateCliFacade(dependencies({
    terminalList: {
      buildTerminalListGroup: async () => ({
        terminalControlled: [sendReadyTerminal({
          id: `terminal-${marker}`,
          shortRef: `@${marker}`,
          target: `delegate-${marker}:0.0`,
          panePid: marker === "A" ? 71_001 : 71_002,
          physicalToken: `physical-${marker}`
        })],
        summary: {}
      })
    },
    terminalCommand: {
      runSend: async (options) => {
        events.push(`${marker}:send:before:${JSON.stringify(options)}`);
        entered.release();
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
  const sendA = makeFacade("A", gateA, enteredA).runDelegate(optionsA);
  const sendB = makeFacade("B", gateB, enteredB).runDelegate(optionsB);
  await Promise.all([enteredA.promise, enteredB.promise]);
  assert.deepEqual(events.map((event) => event.slice(0, 13)), [
    "A:send:before", "B:send:before"
  ]);
  const sentA = JSON.parse(events[0].slice(events[0].indexOf("{")));
  assert.deepEqual(sentA, {
    request: REQUEST,
    custom: "A",
    conversation: "terminal-A",
    message: REQUEST,
    messageId: MESSAGE_ID,
    workspace: WORKSPACE,
    background: true,
    expectedTerminalToken: "physical-A"
  });
  gateB.release();
  await sendB;
  gateA.release();
  await sendA;
  assert.deepEqual(events.slice(-2), ["B:send:after", "A:send:after"]);
});

test("a message without an id performs direct physical discovery", async () => {
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies()
  );

  await assert.rejects(
    facade.runDelegate({ request: REQUEST }),
    /No send-ready Codex or Claude Code pane is available/u
  );
});

test("working activity does not veto one physical Send", async () => {
  const sent: TerminalDelegateCliOptions[] = [];
  const terminalId = "terminal:v2:tmux:codex:working:0.0:71101";
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: [sendReadyTerminal({
            id: terminalId,
            shortRef: "@working",
            activity: "working",
            physicalToken: "physical-working"
          })],
          summary: {}
        })
      },
      terminalCommand: {
        runSend: async (options) => { sent.push(options); }
      }
    })
  );

  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversation, terminalId);
  assert.equal(sent[0].expectedTerminalToken, "physical-working");
  assert.equal(sent[0].expectedManagedTerminalToken, undefined);
});

test("fresh omitted-target Send degrades when durable routing is unavailable", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-delegate-routing-unavailable-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeFile = path.join(root, "runtime-is-a-file");
  fs.writeFileSync(runtimeFile, "not a directory\n");
  const sent: TerminalDelegateCliOptions[] = [];
  const terminalId = "terminal:v2:tmux:codex:fresh:0.0:71102";
  const sendBinding = createTerminalDelegateSendBindingRepository({
    runtimeDir: runtimeFile
  });
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      sendBinding,
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: [sendReadyTerminal({
            id: terminalId,
            physicalToken: "physical-fresh"
          })],
          summary: {}
        })
      },
      terminalCommand: {
        runSend: async (options) => { sent.push(options); }
      }
    })
  );

  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].conversation, terminalId);
  assert.equal(sent[0].expectedTerminalToken, "physical-fresh");
  assert.match(
    String(sent[0].terminalUserSendRoutingWarning),
    /durable omitted-target routing was unavailable.*cannot be verified/u
  );
});

test("possible existing omitted-target binding still prevents reselection", async () => {
  let scans = 0;
  let sends = 0;
  const sendBinding: TerminalDelegateSendBindingRepository = {
    pathFor: ({ messageId }) => `/busy/${messageId}`,
    acquire() {
      throw new Error("acquire must not run after existing-binding uncertainty");
    },
    load() {
      throw new TerminalDelegateSendBindingUncertainError(
        "same-id binding is busy",
        { possibleExistingBinding: true }
      );
    },
    bind() {
      throw new Error("bind must not run after existing-binding uncertainty");
    }
  };
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      sendBinding,
      terminalList: {
        buildTerminalListGroup: async () => {
          scans += 1;
          return { terminalControlled: [], summary: {} };
        }
      },
      terminalCommand: {
        runSend: async () => { sends += 1; }
      }
    })
  );

  await assert.rejects(
    facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID }),
    /same-id binding is busy/u
  );
  assert.equal(scans, 0);
  assert.equal(sends, 0);
});

test("binding lock cleanup failure cannot veto an already selected route", async () => {
  const sent: TerminalDelegateCliOptions[] = [];
  const base = memorySendBindingRepository();
  const sendBinding: TerminalDelegateSendBindingRepository = {
    ...base,
    acquire(messageId) {
      const release = base.acquire(messageId);
      return () => {
        release();
        throw new Error("binding lock unlink failed");
      };
    }
  };
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      sendBinding,
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: [sendReadyTerminal({
            id: "terminal:v2:tmux:codex:release:0.0:71104",
            physicalToken: "physical-release"
          })],
          summary: {}
        })
      },
      terminalCommand: {
        runSend: async (options) => { sent.push(options); }
      }
    })
  );

  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });

  assert.equal(sent.length, 1);
  assert.match(
    String(sent[0].terminalUserSendRoutingWarning),
    /routing lock cleanup failed.*unlink failed/u
  );
});

test("an omitted-target message id never reselects another terminal", async () => {
  const sent: TerminalDelegateCliOptions[] = [];
  const sendBinding = memorySendBindingRepository();
  let selectedName = "A";
  let scans = 0;
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      sendBinding,
      terminalList: {
        buildTerminalListGroup: async () => {
          scans += 1;
          const terminalId =
            `terminal:v2:tmux:codex:binding-${selectedName}:0.0:71103`;
          return {
            terminalControlled: [sendReadyTerminal({
              id: terminalId,
              shortRef: `@binding-${selectedName}`,
              target: `binding-${selectedName}:0.0`,
              panePid: 71_103,
              activity: "working",
              physicalToken: `physical-${selectedName}`
            })],
            summary: {}
          };
        }
      },
      terminalCommand: {
        runSend: async (options) => { sent.push(options); }
      }
    })
  );

  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });
  selectedName = "B";
  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });

  assert.equal(scans, 1);
  assert.deepEqual(sent.map((options) => options.conversation), [
    "terminal:v2:tmux:codex:binding-A:0.0:71103",
    "terminal:v2:tmux:codex:binding-A:0.0:71103"
  ]);
  assert.deepEqual(sent.map((options) => options.expectedTerminalToken), [
    "physical-A",
    "physical-A"
  ]);
});

test("one message id cannot silently change its request boundary", async () => {
  let scans = 0;
  let sends = 0;
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => {
          scans += 1;
          return {
            terminalControlled: [sendReadyTerminal({
              physicalToken: "physical-boundary"
            })],
            summary: {}
          };
        }
      },
      terminalCommand: {
        runSend: async () => { sends += 1; }
      }
    })
  );

  await facade.runDelegate({ request: REQUEST, messageId: MESSAGE_ID });
  await assert.rejects(
    facade.runDelegate({
      request: `${REQUEST} but changed`,
      messageId: MESSAGE_ID
    }),
    /different delegate request boundary/u
  );
  assert.equal(scans, 1);
  assert.equal(sends, 1);
});

test("discovery preserves options and refreshes only managed fast-path authority", async () => {
  const sent: TerminalDelegateCliOptions[] = [];
  const facade = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: [sendReadyTerminal({
            id: "terminal-idle",
            activity: "working",
            physicalToken: "physical-current"
          })],
          summary: {}
        }),
        observeExactTerminal: async () => ({
          state: "available",
          rawTerminal: {},
          terminal: {
            id: "terminal-idle",
            workspace: WORKSPACE,
            available_actions: {
              send: userExplicitSendAction(
                "terminal-idle",
                "physical-current",
                "managed-current"
              )
            }
          },
          summary: {}
        })
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
  assert.equal(JSON.stringify(sent[0]), JSON.stringify({
    request: REQUEST,
    marker: "keep",
    conversation: "terminal-idle",
    message: REQUEST,
    workspace: WORKSPACE,
    background: true,
    expectedTerminalToken: "physical-current",
    expectedManagedTerminalToken: "managed-current"
  }));

  const ambiguous = terminalDelegateCliAdapter.createTerminalDelegateCliFacade(
    dependencies({
      terminalList: {
        buildTerminalListGroup: async () => ({
          terminalControlled: ["first", "second"].map((name, index) =>
            sendReadyTerminal({
              id: `terminal-${name}`,
              shortRef: `@${name}`,
              target: `${name}:0.0`,
              panePid: 72_001 + index
            })
          ),
          summary: {}
        })
      }
    })
  );
  await assert.rejects(
    ambiguous.runDelegate({ request: REQUEST, workspace: WORKSPACE }),
    /Multiple send-ready coding-agent panes match/u
  );
});

test("omitted-target routing has no managed Store dependency and unlocks before Send", () => {
  const source = fs.readFileSync(
    new URL("../src/terminal-delegate-cli-adapter.js", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /listConversations|terminalBridgeSubmissionReceipts|native_session_takeover/u
  );
  const resolveSource = compiledFunctionSource(
    "resolveDelegateSendRoute",
    "sendDelegatePhysicalRoute"
  );
  assertOrdered(resolveSource, [
    "const existingBinding",
    "dependencies.sendBinding.load(boundary)",
    "dependencies.sendBinding.acquire(messageId)",
    "concurrentBinding = dependencies.sendBinding.load(boundary)",
    "discoverDelegatePhysicalRoute",
    "dependencies.sendBinding.bind",
    "releaseBindingLock?.()"
  ]);
  assertOrdered(source, [
    "releaseBindingLock?.();",
    "dependencies.terminalCommand.runSend"
  ]);
});
