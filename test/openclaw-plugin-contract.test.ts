import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import plugin, {
  createOpenClawPluginForTest
} from "../src/openclaw-plugin.js";
import * as openclawPluginRuntime from "../src/openclaw-plugin.js";
import {
  approveParameters,
  closeParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  resumeThreadParameters,
  sendParameters,
  unwatchParameters,
  watchParameters
} from "../src/openclaw-plugin-schemas.js";
import { registerOpenClawCallbackGateway } from
  "../src/openclaw-plugin-callback-adapter.js";
import { isAkkModelFacingPrivateAuthorityField } from
  "../src/openclaw-plugin-helpers.js";
import {
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS,
  consumeOpenClawPrivateAuthorityOffer,
  openClawApprovalAuthorityOfferKey,
  peekOpenClawPrivateAuthorityOffer,
  rememberOpenClawPrivateAuthorityOffer
} from "../src/openclaw-private-authority-offers.js";
import { createConversation, createMessage } from "../src/protocol.js";

type Manifest = {
  description?: string;
  activation?: {
    onCommands?: string[];
  };
  commandAliases?: Array<{
    name?: string;
  }>;
  contracts?: {
    tools?: string[];
  };
  skills?: string[];
  toolMetadata?: Record<string, unknown>;
};

type ToolDefinition = {
  name?: string;
  description?: string;
  parameters?: {
    additionalProperties?: boolean;
    required?: string[];
    oneOf?: Array<{
      required?: string[];
      not?: {
        required?: string[];
        anyOf?: Array<{ required?: string[] }>;
      };
    }>;
    anyOf?: Array<{ required?: string[] }>;
    allOf?: Array<{
      if?: { required?: string[] };
      then?: { required?: string[] };
    }>;
    not?: {
      required?: string[];
      anyOf?: Array<{ required?: string[] }>;
    };
    properties?: Record<string, {
      description?: string;
      [key: string]: unknown;
    }>;
  };
  execute?: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content?: Array<{
      type?: string;
      text?: string;
    }>;
    details?: Record<string, unknown>;
    isError?: boolean;
  }>;
};

type ToolFactory = (context: Record<string, never>) => ToolDefinition;

type ContractTestApi = {
  pluginConfig: Record<string, never>;
  logger: {
    info(): void;
    warn(): void;
  };
  registerGatewayMethod(...args: unknown[]): void;
  registerService(service: unknown): void;
  registerCommand(command: { name?: string }): void;
  registerTool(
    tool: ToolDefinition | ToolFactory,
    options?: {
      name?: string;
      optional?: boolean;
    }
  ): void;
};

type GatewayMethodHandler = (context: {
  params: unknown;
  respond(
    ok: boolean,
    result?: unknown,
    error?: {
      code?: string;
      message?: string;
    }
  ): void;
}) => Promise<void>;

function assertNoModelOpaqueAuthority(
  value: unknown,
  pathLabel = "$"
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoModelOpaqueAuthority(item, `${pathLabel}[${index}]`)
    );
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const forbidden = isAkkModelFacingPrivateAuthorityField(key);
    assert.equal(
      forbidden,
      false,
      `${pathLabel}.${key} must not cross the model-facing contract`
    );
    assertNoModelOpaqueAuthority(item, `${pathLabel}.${key}`);
  }
}

function assertModelToolResultHasNoOpaqueAuthority(
  result: Awaited<ReturnType<NonNullable<ToolDefinition["execute"]>>> | undefined
): void {
  assert.ok(result, "the model-facing tool result must exist");
  assertNoModelOpaqueAuthority(result.details, "$.details");
  const textBlocks = result.content?.filter((item) => item.type === "text") ?? [];
  assert.ok(textBlocks.length > 0, "the model-facing tool result must contain text");
  for (const [index, block] of textBlocks.entries()) {
    assertNoModelOpaqueAuthority(
      JSON.parse(String(block.text ?? "null")),
      `$.content[${index}]`
    );
  }
}

test("OpenClaw model-facing mutation schemas contain only semantic targets", () => {
  const mutationSchemas = {
    send: sendParameters,
    native_inspect: nativeInspectParameters,
    new_thread: newThreadParameters,
    reconcile_binding: reconcileBindingParameters,
    resume_thread: resumeThreadParameters,
    approve: approveParameters,
    close: closeParameters,
    watch: watchParameters,
    unwatch: unwatchParameters
  };
  assertNoModelOpaqueAuthority(mutationSchemas, "$.mutationSchemas");
  assert.deepEqual(sendParameters.not, {
    required: ["session_id", "terminal_id"]
  });
  assert.deepEqual(nativeInspectParameters.required, [
    "terminal_id",
    "inspection"
  ]);
  assert.deepEqual(newThreadParameters.required, ["terminal_id"]);
  assert.deepEqual(reconcileBindingParameters.required, [
    "terminal_id",
    "conflicting_session_id"
  ]);
  assert.deepEqual(resumeThreadParameters.required, [
    "terminal_id",
    "native_thread_id"
  ]);
  assert.deepEqual(approveParameters.anyOf, [
    { required: ["turn_id"] },
    { required: ["terminal_id"] }
  ]);
  assert.deepEqual(approveParameters.not, {
    required: ["turn_id", "terminal_id"]
  });
  assert.deepEqual(watchParameters.required, ["terminal_id"]);
  assert.deepEqual(unwatchParameters.required, ["watch_id"]);
  assert.ok(closeParameters.properties.expected_message_id);
  assert.ok(closeParameters.properties.expected_transition_id);
});

test("private authority offers are isolated, bounded, merged, expiring, and single-use", () => {
  const api = {};
  const otherApi = {};
  const key = openClawApprovalAuthorityOfferKey(
    "agent:main:offers",
    "openclaw-conversation-a",
    {
    type: "turn_id",
    id: "turn-offer"
    }
  );
  const nowMs = 1_000;

  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:one", keep: true }
  }, nowMs);
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two" },
    fingerprint: "a".repeat(64)
  }, nowMs + 1);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 2),
    undefined,
    "changed authority must invalidate rather than replace a displayed offer"
  );
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two" },
    fingerprint: "a".repeat(64)
  }, nowMs + 2);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 3),
    undefined,
    "passive rediscovery must not reactivate changed authority"
  );
  assert.equal(
    consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 3),
    undefined,
    "the first rejected mutation attempt clears the invalidation tombstone"
  );
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    args: { terminal_id: "terminal:two", keep: true },
    fingerprint: "a".repeat(64)
  }, nowMs + 4);

  const merged = peekOpenClawPrivateAuthorityOffer(api, key, nowMs + 5);
  assert.deepEqual(merged, {
    args: { terminal_id: "terminal:two", keep: true },
    fingerprint: "a".repeat(64)
  });
  assert.equal(Object.isFrozen(merged), true);
  assert.equal(Object.isFrozen(merged?.args), true);
  assert.equal(peekOpenClawPrivateAuthorityOffer(otherApi, key, nowMs + 5), undefined);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-b",
        { type: "turn_id", id: "turn-offer" }
      ),
      nowMs + 5
    ),
    undefined,
    "a /new or /reset conversation incarnation cannot consume an old offer"
  );
  assert.deepEqual(
    consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 5),
    merged
  );
  assert.equal(consumeOpenClawPrivateAuthorityOffer(api, key, nowMs + 5), undefined);

  rememberOpenClawPrivateAuthorityOffer(api, key, { fingerprint: "b" }, nowMs);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      key,
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS
    ),
    undefined
  );

  for (let index = 0; index <= OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT; index += 1) {
    rememberOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: `turn-${index}`
        }
      ),
      { sequence: index },
      nowMs + index
    );
  }
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: "turn-0"
        }
      ),
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT + 1
    ),
    undefined
  );
  assert.deepEqual(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:offers",
        "openclaw-conversation-a",
        {
        type: "turn_id",
        id: `turn-${OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT}`
        }
      ),
      nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT + 1
    ),
    { sequence: OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT }
  );
});

test("approval callbacks preserve review text but require incarnation-bound status", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedInjection: Record<string, unknown> | undefined;
  let response: { ok: boolean; result?: Record<string, any> } | undefined;
  const fingerprint = "c".repeat(64);
  const reviewedCommit = "e".repeat(64);
  const conversation = {
    ...createConversation({
      userRequest: "approval callback",
      sessionId: "session-approval",
      turnId: "turn-approval",
      openclawSession: "agent:main:approval",
      executorKind: "codex",
      executorSession: "codex-approval"
    }),
    native_session_takeover: {
      terminal_bridge_approval: { fingerprint }
    }
  };
  const message = createMessage({
    conversation,
    id: "message-approval",
    from: "codex",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: [
      "Codex is waiting for approval.",
      "Ask the user to review the request.",
      `Command: inspect token_fingerprint.ts at commit ${reviewedCommit}`,
      "expected_session_revision: 7",
      "--expected-binding-token business-approval-example",
      "If the user approves, call `agent_knock_knock_approve` with:",
      `- expected_approval_fingerprint: ${fingerprint}`,
      `Equivalent user command: \`AKK approve turn-approval --expected-approval-fingerprint ${fingerprint}\``
    ].join("\n"),
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_fingerprint: fingerprint,
      approval_candidate: { fingerprint },
      terminal_status: {
        approval_state: { fingerprint }
      }
    }
  });
  const api: Record<string, any> = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(injection: Record<string, unknown>) {
          capturedInjection = injection;
          return {
            enqueued: true,
            id: "approval-injection",
            sessionKey: injection.sessionKey
          };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") callbackHandler = handler;
    }
  };
  registerOpenClawCallbackGateway(api);

  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:approval",
      conversation,
      message
    },
    respond(ok, result) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {})
      };
    }
  });

  assert.equal(response?.ok, true);
  const key = openClawApprovalAuthorityOfferKey(
    "agent:main:approval",
    "openclaw-conversation-a",
    { type: "turn_id", id: "turn-approval" }
  );
  assert.equal(peekOpenClawPrivateAuthorityOffer(api, key), undefined);
  const visible = [
    String(capturedInjection?.text ?? ""),
    String((response?.result?.chat_send as Record<string, unknown>)?.message ?? "")
  ].join("\n");
  assert.match(visible, /agent_knock_knock_status/u);
  assert.match(visible, /Do not call approve/u);
  assert.match(visible, /\{"turn_id":"turn-approval"\}/u);
  assert.match(
    visible,
    new RegExp(`token_fingerprint\\.ts at commit ${reviewedCommit}`, "u")
  );
  assert.match(visible, /expected_session_revision: 7/u);
  assert.match(
    visible,
    /--expected-binding-token business-approval-example/u
  );
  assert.doesNotMatch(visible, /agent_knock_knock_respond/u);
  assert.doesNotMatch(
    visible,
    /expected_approval_fingerprint|--expected-approval-fingerprint/iu
  );
  assert.doesNotMatch(visible, new RegExp(fingerprint, "u"));
});

test("approval callbacks fail closed to status when private authority is incomplete", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedText = "";
  let responseOk = false;
  const conversation = createConversation({
    userRequest: "incomplete approval callback",
    sessionId: "session-incomplete",
    turnId: "turn-incomplete",
    openclawSession: "agent:main:incomplete",
    executorKind: "codex",
    executorSession: "codex-incomplete"
  });
  const message = createMessage({
    conversation,
    id: "message-incomplete",
    from: "codex",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: "Codex is waiting for approval.",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_fingerprint: "d".repeat(64)
    }
  });
  const api: Record<string, any> = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(injection: Record<string, unknown>) {
          capturedText = String(injection.text ?? "");
          return { enqueued: true };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") callbackHandler = handler;
    }
  };
  registerOpenClawCallbackGateway(api);

  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:incomplete",
      conversation,
      message
    },
    respond(ok) {
      responseOk = ok;
    }
  });

  assert.equal(responseOk, true);
  assert.match(capturedText, /agent_knock_knock_status/u);
  assert.match(capturedText, /\{"turn_id":"turn-incomplete"\}/u);
  assert.match(capturedText, /Do not call approve yet/u);
  assert.doesNotMatch(capturedText, /fingerprint|token|--expected-/iu);
  assert.equal(
    peekOpenClawPrivateAuthorityOffer(
      api,
      openClawApprovalAuthorityOfferKey(
        "agent:main:incomplete",
        "openclaw-conversation-a",
        { type: "turn_id", id: "turn-incomplete" }
      )
    ),
    undefined
  );
});

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const manifestPath = path.join(packageRoot, "openclaw.plugin.json");
const skillSource = path.join(
  packageRoot,
  "templates",
  "openclaw-skills",
  "agent-knock-knock",
  "SKILL.md"
);

test("OpenClaw runtime registrations match the published manifest", () => {
  const manifest = readManifest();
  const registeredCommands: string[] = [];
  const registeredTools: string[] = [];
  const toolDefinitions = new Map<string, ToolDefinition>();

  const api: ContractTestApi = {
    pluginConfig: {},
    logger: {
      info() {},
      warn() {}
    },
    registerGatewayMethod() {},
    registerService() {},
    registerCommand(command) {
      registeredCommands.push(requiredName(command.name, "runtime command"));
    },
    registerTool(tool, options) {
      const definition = typeof tool === "function" ? tool({}) : tool;
      const runtimeName = requiredName(definition.name, "runtime tool");
      const metadataName = requiredName(options?.name, "tool registration metadata");
      assert.equal(metadataName, runtimeName);
      registeredTools.push(runtimeName);
      toolDefinitions.set(runtimeName, definition);
    }
  };

  (
    plugin as unknown as {
      register(api: ContractTestApi): void;
    }
  ).register(api);

  for (const [name, definition] of toolDefinitions) {
    assertNoModelOpaqueAuthority(
      definition.parameters,
      `$.registeredTools.${name}.parameters`
    );
  }

  const contractedTools = requiredStringArray(
    manifest.contracts?.tools,
    "contracts.tools"
  );
  const activatedCommands = requiredStringArray(
    manifest.activation?.onCommands,
    "activation.onCommands"
  );
  const commandAliases = (manifest.commandAliases ?? []).map((alias) =>
    requiredName(alias.name, "command alias")
  );
  const metadataTools = Object.keys(manifest.toolMetadata ?? {});

  assert.deepEqual(sorted(registeredTools), sorted(contractedTools));
  assert.deepEqual(registeredTools, [
    "agent_knock_knock_list",
    "agent_knock_knock_watch",
    "agent_knock_knock_unwatch",
    "agent_knock_knock_list_resumable_threads",
    "agent_knock_knock_native_inspect",
    "agent_knock_knock_new_thread",
    "agent_knock_knock_reconcile_binding",
    "agent_knock_knock_resume_thread",
    "agent_knock_knock_status",
    "agent_knock_knock_send",
    "agent_knock_knock_respond",
    "agent_knock_knock_approve",
    "agent_knock_knock_renew",
    "agent_knock_knock_retry_callback",
    "agent_knock_knock_cancel",
    "agent_knock_knock_close"
  ]);
  const schemaBytes = JSON.stringify(
    registeredTools.map((name) => [name, toolDefinitions.get(name)?.parameters])
  );
  assert.equal(
    createHash("sha256").update(schemaBytes).digest("hex"),
    "de1f2eb6aef8caefac403a5b5aa6f960d5c83f3699f3365c10571cf577144968"
  );
  assert.deepEqual(sorted(metadataTools), sorted(contractedTools));
  assert.equal(contractedTools.length, 16);
  assert.match(
    manifest.description ?? "",
    /exact-version native status inspection/u
  );
  assert.deepEqual(
    sorted(registeredCommands),
    sorted(activatedCommands)
  );

  const listTool = toolDefinitions.get("agent_knock_knock_list");
  assert.ok(listTool);
  assert.match(listTool.description ?? "", /terminals\[\]/u);
  assert.match(listTool.description ?? "", /terminal_watches\[\]/u);
  assert.match(listTool.description ?? "", /semantic IDs/u);
  assert.match(listTool.description ?? "", /session_exact.*session_id/u);
  assert.match(listTool.description ?? "", /terminal_follow_current.*terminal_id/u);
  assert.match(listTool.description ?? "", /managed controls use turn_id/u);
  assert.match(listTool.description ?? "", /freshness authority private/u);
  assert.doesNotMatch(listTool.description ?? "", /follow_up/u);
  assert.doesNotMatch(
    listTool.description ?? "",
    /delegated|terminal_controlled|tasks\[\]/u
  );
  assert.equal(
    Object.hasOwn(listTool.parameters?.properties ?? {}, "managedOnly"),
    false
  );
  assert.deepEqual(
    sorted(commandAliases),
    sorted(registeredCommands)
  );
  assert.equal(contractedTools.includes("agent_knock_knock_send"), true);
  assert.equal(contractedTools.includes("agent_knock_knock_respond"), true);
  assert.equal(contractedTools.includes("agent_knock_knock_watch"), true);
  assert.equal(contractedTools.includes("agent_knock_knock_unwatch"), true);
  assert.equal(
    contractedTools.includes("agent_knock_knock_list_resumable_threads"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_native_inspect"),
    true
  );
  assert.equal(contractedTools.includes("agent_knock_knock_new_thread"), true);
  assert.equal(
    contractedTools.includes("agent_knock_knock_reconcile_binding"),
    true
  );
  assert.equal(
    contractedTools.includes("agent_knock_knock_resume_thread"),
    true
  );
  for (const removedTool of [
    "agent_knock_knock_delegate",
    "agent_knock_knock_describe",
    "agent_knock_knock_agent_takeover"
  ]) {
    assert.equal(contractedTools.includes(removedTool), false);
  }
  const configProperties = (
    readManifest() as Manifest & {
      configSchema?: { properties?: Record<string, unknown> };
    }
  ).configSchema?.properties ?? {};
  assert.equal("defaultAgent" in configProperties, false);
  assert.equal("workspace" in configProperties, false);
});

test("OpenClaw list, threads, and status results expose semantic ids only", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-model-boundary-")
  );
  const fakeCli = path.join(tempDir, "model-boundary.cjs");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const tools = new Map<string, ToolDefinition>();
  const fixtures = {
    list: {
      expected_session_revision: 7,
      session_revisions: [6, 7],
      binding_ids: ["private-binding-id"],
      terminal_binding_id: "private-terminal-binding-id",
      terminal_binding_generation: 5,
      binding_token: "private-binding-token",
      lifecycle_binding_token: "private-lifecycle-token",
      recovery: {
        expected_message_id: "message-semantic-id",
        expected_transition_id: "transition-semantic-id"
      },
      terminals: [{
        id: terminalId,
        handoff_decision: {
          live_native_thread_id: "private-handoff-live-native-id"
        },
        approval_state: {
          approvable: true,
          fingerprint: "private-approval-fingerprint"
        },
        available_actions: {
          send: {
            tool: "agent_knock_knock_send",
            arguments: {
              selector: terminalId,
              expected_terminal_token: "private-terminal-token",
              request: "continue"
            }
          },
          approve: {
            tool: "agent_knock_knock_approve",
            arguments: {
              conversation_id: terminalId,
              expected_approval_fingerprint: "private-approval-fingerprint",
              expected_terminal_token: "private-terminal-token"
            }
          },
          close: {
            tool: "agent_knock_knock_close",
            arguments: {
              turn_id: "turn-handoff",
              reason: "superseded_by_human_context_switch",
              expected_handoff_token: "private-handoff-token"
            }
          }
        }
      }]
    },
    "list-resumable-threads": {
      terminal_id: terminalId,
      expected_binding_token: "private-binding-token",
      selection_snapshot: {
        snapshot_id: "private-selection-snapshot",
        expected_session_revision: 9
      },
      threads: [{
        native_thread_id: "22222222-2222-4222-8222-222222222222",
        resumable: true,
        candidate_token: "private-candidate-token",
        selection_handle: "private-selection-handle"
      }]
    },
    status: {
      conversation_id: "turn-status",
      session_id: "session-status",
      turn_id: "turn-status",
      conversation: {
        conversation_id: "turn-status",
        session_id: "session-status",
        turn_id: "turn-status",
        openclaw_session: "private-openclaw-session",
        gateway_session: "private-gateway-session",
        gateway_method: "private-gateway-method",
        gateway_url: "ws://private-gateway.example",
        openclaw_bin: "/private/bin/openclaw",
        callback_route: {
          schema: "agent-knock-knock/callback-route",
          version: 1,
          transport: "openclaw_gateway_v1",
          profile_id: "private-callback-profile",
          profile_revision: "private-callback-profile-revision",
          controller_session_id: "private-controller-session",
          capabilities: { wake: true, respond: true }
        },
        callback_delivery: {
          callback_envelope: {
            schema: "agent-knock-knock/callback-envelope",
            version: 1,
            delivery_id: "private-callback-delivery",
            message_id: "private-callback-message"
          },
          attempt_outcome: {
            disposition: "accepted",
            acceptance_id: "private-callback-acceptance"
          },
          message: {
            body:
              `Approval authority\nexpected_approval_fingerprint: ${"f".repeat(64)}\n` +
              "inspect token_fingerprint.ts after approval\n" +
              "expected_session_revision: 7\n" +
              "--expected-binding-token business-callback-example"
          }
        },
        native_session_takeover: {
          codex_rollout_acceptance_anchor: {
            candidate_rollouts: [{
              native_thread_id: "private-anchor-thread",
              rollout: {
                path: "/private/rollout.jsonl",
                device: 1,
                inode: 2
              },
              offset_bytes: 123
            }]
          },
          terminal_bridge_submission: {
            acceptance_evidence: {
              requestHash: "c".repeat(64),
              acceptanceId: "private-acceptance-id"
            }
          }
        }
      },
      status: "waiting_for_agent",
      bookkeeping_warning: "expected revision 5, actual revision 6",
      request:
        `inspect token_fingerprint.ts at commit ${"1".repeat(64)}; ` +
        "tokens, fingerprints, revisions, and CAS are ordinary request text\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-example",
      completion:
        `completed token_fingerprint.ts at commit ${"2".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-completion-example",
      terminal_screen:
        `screen mentions token_fingerprint.ts at commit ${"3".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-screen-example",
      recent_events: [{
        body:
          `Equivalent command: --expected-approval-fingerprint ${"f".repeat(64)}\n` +
          "ordinary token wording remains visible\n" +
          "expected_session_revision: 7\n" +
          "--expected-binding-token business-event-example"
      }],
      approval_state: {
        approvable: true,
        fingerprint: "private-status-fingerprint",
        policy_evidence: {
          command_sha256: "d".repeat(64)
        },
        request_detail:
          "inspect token_fingerprint.ts at commit eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n" +
          "expected_session_revision: 7\n" +
          "--expected-binding-token business-request-detail-example"
      },
      nested: {
        reason: "expected revision 7, actual revision 8",
        stalledReason: "expected revision 9, actual revision 10",
        expected_binding_token: "private-status-token",
        expected_session_revision: 11,
        expectedSessionRevision: 12,
        "expected-session-revision": 13,
        terminal_binding_id: "private-status-binding-id",
        terminal_binding_generation: 6,
        terminalBindingGeneration: 7,
        nonce: "private-status-nonce",
        terminal_bridge_request_hash: "a".repeat(64),
        approval_snapshot_digest: "b".repeat(64),
        screen: {
          approval: {
            policyEvidence: {
              commandSha256: "e".repeat(64)
            }
          }
        },
        missing_required: [
          "expected_terminal_token",
          "expected_message_id"
        ],
        expected_message_id: "message-status-id",
        expected_transition_id: "transition-status-id"
      }
    }
  };

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fixtures = ${JSON.stringify(fixtures)};`,
        `const action = process.argv[2];`,
        `if (action === "renew") { process.stderr.write("expected revision 7, actual revision 8; terminal token ${"f".repeat(64)}"); process.exit(9); }`,
        `process.stdout.write(JSON.stringify(fixtures[action] ?? {}));`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({ sessionKey: "agent:test:model-boundary" } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    const listed = await tools.get("agent_knock_knock_list")?.execute?.(
      "list-model-boundary",
      {}
    );
    const threads = await tools
      .get("agent_knock_knock_list_resumable_threads")
      ?.execute?.("threads-model-boundary", { terminal_id: terminalId });
    const status = await tools.get("agent_knock_knock_status")?.execute?.(
      "status-model-boundary",
      { turn_id: "turn-status" }
    );

    for (const result of [listed, threads, status]) {
      assertModelToolResultHasNoOpaqueAuthority(result);
      const encoded = JSON.stringify(result);
      for (const privateValue of [
        "private-binding-token",
        "private-terminal-token",
        "private-candidate-token",
        "private-handoff-token",
        "private-approval-fingerprint",
        "private-status-fingerprint",
        "private-callback-profile",
        "private-controller-session",
        "private-callback-delivery",
        "private-callback-acceptance",
        "private-openclaw-session",
        "private-gateway-session",
        "private-gateway-method",
        "private-gateway.example",
        "/private/bin/openclaw"
      ]) {
        assert.equal(encoded.includes(privateValue), false, privateValue);
      }
    }

    const listDetails = listed?.details ?? {};
    const terminals = Array.isArray(listDetails.terminals)
      ? listDetails.terminals
      : [];
    const terminal = isRecord(terminals[0]) ? terminals[0] : {};
    const actions = isRecord(terminal.available_actions)
      ? terminal.available_actions
      : {};
    const send = isRecord(actions.send) && isRecord(actions.send.arguments)
      ? actions.send.arguments
      : {};
    const approve = isRecord(actions.approve) &&
        isRecord(actions.approve.arguments)
      ? actions.approve.arguments
      : {};
    assert.equal(send.terminal_id, terminalId);
    assert.equal(Object.hasOwn(send, "selector"), false);
    assert.equal(approve.terminal_id, terminalId);
    assert.equal(Object.hasOwn(approve, "conversation_id"), false);
    const approveBeforeCall = isRecord(actions.approve) &&
        isRecord(actions.approve.before_call)
      ? actions.approve.before_call
      : {};
    assert.deepEqual(approveBeforeCall.arguments, {
      conversation_id: terminalId
    });
    assert.equal(Object.hasOwn(listDetails, "session_revisions"), false);
    assert.equal(Object.hasOwn(listDetails, "binding_ids"), false);
    assert.equal(Object.hasOwn(listDetails, "terminal_binding_id"), false);
    assert.equal(
      Object.hasOwn(listDetails, "terminal_binding_generation"),
      false
    );
    assert.equal(
      isRecord(terminal.handoff_decision) &&
        Object.hasOwn(terminal.handoff_decision, "live_native_thread_id"),
      false
    );
    assert.equal(
      isRecord(listDetails.recovery)
        ? listDetails.recovery.expected_message_id
        : undefined,
      "message-semantic-id"
    );
    assert.equal(
      isRecord(listDetails.recovery)
        ? listDetails.recovery.expected_transition_id
        : undefined,
      "transition-semantic-id"
    );
    const statusNested = isRecord(status?.details?.nested)
      ? status.details.nested
      : {};
    assert.equal(
      isRecord(status?.details?.conversation) &&
        Object.hasOwn(status.details.conversation, "native_session_takeover"),
      false
    );
    assert.equal(
      isRecord(status?.details?.conversation) &&
        Object.hasOwn(status.details.conversation, "callback_route"),
      false
    );
    for (const field of [
      "openclaw_session",
      "gateway_session",
      "gateway_method",
      "gateway_url",
      "openclaw_bin"
    ]) {
      assert.equal(
        isRecord(status?.details?.conversation) &&
          Object.hasOwn(status.details.conversation, field),
        false,
        field
      );
    }
    assert.equal(Object.hasOwn(statusNested, "terminal_binding_id"), false);
    assert.equal(
      Object.hasOwn(statusNested, "terminal_binding_generation"),
      false
    );
    assert.equal(
      isRecord(status?.details?.approval_state)
        ? status.details.approval_state.request_detail
        : undefined,
      "inspect token_fingerprint.ts at commit eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-detail-example"
    );
    const callbackBody = isRecord(status?.details?.conversation) &&
        isRecord(status.details.conversation.callback_delivery) &&
        isRecord(status.details.conversation.callback_delivery.message)
      ? String(status.details.conversation.callback_delivery.message.body)
      : "";
    assert.match(callbackBody, /inspect token_fingerprint\.ts after approval/u);
    assert.match(callbackBody, /expected_session_revision: 7/u);
    assert.match(
      callbackBody,
      /--expected-binding-token business-callback-example/u
    );
    assert.doesNotMatch(
      callbackBody,
      /expected_approval_fingerprint|[f]{64}/u
    );
    const recentEventBody = Array.isArray(status?.details?.recent_events) &&
        isRecord(status.details.recent_events[0])
      ? String(status.details.recent_events[0].body)
      : "";
    assert.match(recentEventBody, /ordinary token wording remains visible/u);
    assert.match(recentEventBody, /expected_session_revision: 7/u);
    assert.match(
      recentEventBody,
      /--expected-binding-token business-event-example/u
    );
    assert.doesNotMatch(
      recentEventBody,
      /expected-approval-fingerprint|[f]{64}/u
    );
    assert.match(String(statusNested.reason), /private authority changed/u);
    assert.doesNotMatch(String(statusNested.reason), /revision|7|8/iu);
    assert.match(
      String(status?.details?.bookkeeping_warning),
      /private authority changed/u
    );
    assert.match(String(statusNested.stalledReason), /private authority changed/u);
    assert.equal(Object.hasOwn(statusNested, "expectedSessionRevision"), false);
    assert.equal(Object.hasOwn(statusNested, "expected-session-revision"), false);
    assert.equal(Object.hasOwn(statusNested, "terminalBindingGeneration"), false);
    assert.equal(Object.hasOwn(statusNested, "nonce"), false);
    assert.equal(
      status?.details?.request,
      `inspect token_fingerprint.ts at commit ${"1".repeat(64)}; ` +
        "tokens, fingerprints, revisions, and CAS are ordinary request text\n" +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-request-example"
    );
    assert.equal(
      status?.details?.completion,
      `completed token_fingerprint.ts at commit ${"2".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-completion-example"
    );
    assert.equal(
      status?.details?.terminal_screen,
      `screen mentions token_fingerprint.ts at commit ${"3".repeat(64)}\n` +
        "expected_session_revision: 7\n" +
        "--expected-binding-token business-screen-example"
    );
    assert.deepEqual(statusNested.missing_required, ["expected_message_id"]);
    assert.equal(statusNested.expected_transition_id, "transition-status-id");
    await assert.rejects(
      () => tools.get("agent_knock_knock_renew")!.execute!(
        "renew-private-error",
        { turn_id: "turn-status" }
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /private authority changed/u);
        assert.doesNotMatch(
          error.message,
          /token|fingerprint|revision|[a-f0-9]{64}/iu
        );
        return true;
      }
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw split authorities retain approval, lifecycle, and supervisor contracts", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const configProperties = manifest.configSchema.properties;
  assert.equal("workspace" in configProperties, false);
  const autoApproveRule = configProperties.autoApprove.properties.rules.items;
  assert.equal(autoApproveRule.required.includes("workspaces"), true);
  assert.equal(autoApproveRule.properties.workspaces.type, "array");
  assert.equal(autoApproveRule.properties.workspaces.minItems, 1);
  assert.equal("maxItems" in autoApproveRule.properties.workspaces, false);
  assert.equal(autoApproveRule.properties.workspaces.items.type, "string");
  assert.equal(autoApproveRule.properties.workspaces.items.minLength, 1);
  assert.equal(configProperties.agentTimeoutMinutes.type, "number");
  assert.equal(configProperties.agentHardTimeoutMinutes.type, "number");
  assert.equal(configProperties.agentHardTimeoutMinutes.exclusiveMinimum, 0);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_renew"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_renew.optional, true);
  assert.equal(manifest.contracts.tools.includes("agent_knock_knock_respond"), true);
  assert.equal(manifest.toolMetadata.agent_knock_knock_respond.optional, true);
  assert.equal(manifest.contracts.tools.length, 16);
  for (const terminalWatchTool of [
    "agent_knock_knock_watch",
    "agent_knock_knock_unwatch"
  ]) {
    assert.equal(manifest.contracts.tools.includes(terminalWatchTool), true);
    assert.equal(manifest.toolMetadata[terminalWatchTool].optional, true);
  }
  for (const lifecycleTool of [
    "agent_knock_knock_list_resumable_threads",
    "agent_knock_knock_native_inspect",
    "agent_knock_knock_new_thread",
    "agent_knock_knock_reconcile_binding",
    "agent_knock_knock_resume_thread"
  ]) {
    assert.equal(manifest.contracts.tools.includes(lifecycleTool), true);
    assert.equal(manifest.toolMetadata[lifecycleTool].optional, true);
  }

  const schemasSource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin-schemas.ts"),
    "utf8"
  );
  const commandSource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin-command-adapter.ts"),
    "utf8"
  );
  const supervisorSource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin-supervisor.ts"),
    "utf8"
  );
  const terminalListSource = fs.readFileSync(
    path.join(packageRoot, "src", "terminal-list-cli-adapter.ts"),
    "utf8"
  );
  const entrySource = fs.readFileSync(
    path.join(packageRoot, "src", "openclaw-plugin.ts"),
    "utf8"
  );
  assert.match(
    schemasSource,
    /export const sendParameters =[\s\S]*?agentTimeoutMinutes:[\s\S]*?agentHardTimeoutMinutes:/u
  );
  assert.match(
    schemasSource,
    /export const approveParameters =[\s\S]*?not: \{ required: \["turn_id", "terminal_id"\] \}[\s\S]*?anyOf: \[[\s\S]*?required: \["turn_id"\][\s\S]*?required: \["terminal_id"\]/u
  );
  for (const privateCliFence of [
    "--expected-approval-fingerprint",
    "--expected-binding-token",
    "--expected-terminal-token",
    "--candidate-token"
  ]) {
    assert.match(
      commandSource,
      new RegExp(privateCliFence, "u"),
      `${privateCliFence} remains an adapter-private CLI fence`
    );
  }
  assert.match(commandSource, /name: "agent_knock_knock_renew"/u);
  assert.match(commandSource, /name: "agent_knock_knock_watch"/u);
  assert.match(commandSource, /name: "agent_knock_knock_unwatch"/u);
  assert.match(commandSource, /name: "agent_knock_knock_new_thread"/u);
  assert.match(commandSource, /name: "agent_knock_knock_reconcile_binding"/u);
  assert.match(commandSource, /name: "agent_knock_knock_list_resumable_threads"/u);
  assert.match(commandSource, /name: "agent_knock_knock_native_inspect"/u);
  assert.match(commandSource, /name: "agent_knock_knock_resume_thread"/u);
  assert.match(
    commandSource,
    /rememberDisplayedPrivateAuthorityOffers[\s\S]*?rememberDisplayedHandoffActions[\s\S]*?rememberDisplayedReconcileActions/u
  );
  assert.match(
    commandSource,
    /authoritativeHandoffActionArguments[\s\S]*?handoff_decision[\s\S]*?take_over_current/u
  );
  assert.match(
    commandSource,
    /authoritativeTerminalActionArguments[\s\S]*?available_actions/u
  );
  assert.doesNotMatch(
    commandSource,
    /collectToolActionArguments|collectApprovalFingerprints/u
  );
  assert.match(
    commandSource,
    /consumeDisplayedPrivateAction[\s\S]*?authority changed after it was shown/u
  );
  assert.match(
    commandSource,
    /buildPrivateApprovalArgs[\s\S]*?consumeOpenClawPrivateAuthorityOffer[\s\S]*?currentFingerprint !== offeredFingerprint/u
  );
  assert.doesNotMatch(
    commandSource,
    /structured one-time Hook|pending structured permission/u
  );
  assert.doesNotMatch(commandSource, /install-claude-hooks/u);
  assert.match(
    supervisorSource,
    /createMonitorReconciliationService[\s\S]*?agent-knock-knock-monitor-reconciliation/u
  );
  assert.match(
    supervisorSource,
    /const args = \["reconcile-monitors", "--reason", reason\][\s\S]*?--terminal-monitors-only[\s\S]*?catch \(error\)[\s\S]*?logger\.warn/u
  );
  assert.match(
    supervisorSource,
    /const args = \["reconcile-watches"\][\s\S]*?monitor supervision deferred after error[\s\S]*?watchReconciliationArgs\(\)[\s\S]*?Terminal Watch supervision deferred after error/u
  );
  assert.match(
    supervisorSource,
    /const reconcileStartup = async[\s\S]*?runCliAsync\([\s\S]*?reconciliationArgs\("startup_reconciliation"\)[\s\S]*?runCliAsync\([\s\S]*?watchReconciliationArgs\(\)[\s\S]*?inFlight = reconcileStartup\(\)/u
  );
  assert.match(
    terminalListSource,
    /const activeWatchedTerminals = new Set\(\s*observedTerminalWatches[\s\S]*?withoutAvailableAction\(terminal, "watch"\)/u
  );
  assert.match(
    entrySource,
    /registerOpenClawCallbackGateway[\s\S]*?registerOpenClawCommands/u
  );
  const skill = fs.readFileSync(skillSource, "utf8");
  assert.match(skill, /agent_knock_knock_renew/u);
  assert.match(skill, /agent_knock_knock_list_resumable_threads/u);
  assert.match(skill, /agent_knock_knock_native_inspect/u);
});

test("OpenClaw entry runtime and declaration expose only the stable plugin API", () => {
  assert.deepEqual(Object.keys(openclawPluginRuntime).sort(), [
    "createOpenClawPluginForTest",
    "default"
  ]);
  const declaration = fs.readFileSync(
    path.join(packageRoot, "dist", "src", "openclaw-plugin.d.ts"),
    "utf8"
  );
  assert.equal((declaration.match(/\bexport\b/gu) ?? []).length, 2);
  assert.match(
    declaration,
    /export declare function createOpenClawPluginForTest\(/u
  );
  assert.match(declaration, /export default plugin;/u);
});

test("OpenClaw plugin instances keep relay paths and config isolated by API", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-instance-isolation-")
  );
  const registerInstance = (
    relayPath: string,
    storeDir: string,
    tools: Map<string, ToolDefinition>
  ): void => {
    (
      createOpenClawPluginForTest(relayPath) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });
  };

  try {
    const instances = ["left", "right"].map((label) => {
      const relayPath = path.join(tempDir, `${label}.cjs`);
      const callsPath = path.join(tempDir, `${label}.ndjson`);
      fs.writeFileSync(
        relayPath,
        [
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
          `process.stdout.write(JSON.stringify({ marker: ${JSON.stringify(label)}, conversation_id: "turn-${label}", session_id: "session-${label}", turn_id: "turn-${label}" }));`
        ].join("\n"),
        "utf8"
      );
      const tools = new Map<string, ToolDefinition>();
      registerInstance(relayPath, `/stores/${label}`, tools);
      return { label, callsPath, tools };
    });

    const results = await Promise.all(instances.map(async (instance) => {
      const status = instance.tools.get("agent_knock_knock_status");
      assert.ok(status);
      return status.execute?.(`status-${instance.label}`, {
        turn_id: `turn-${instance.label}`
      });
    }));
    assert.deepEqual(
      results.map((result) => result?.details?.marker),
      ["left", "right"]
    );
    for (const instance of instances) {
      const calls = fs.readFileSync(instance.callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls, [[
        "status",
        "--reconcile",
        "--turn",
        `turn-${instance.label}`,
        "--store-dir",
        `/stores/${instance.label}`
      ]]);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw native inspection is a closed status-only terminal action", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-native-inspect-")
  );
  const fakeCli = path.join(tempDir, "native-inspect.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: { native_inspect: {`,
        `    tool: "agent_knock_knock_native_inspect",`,
        `    arguments: { terminal_id: terminalId, expected_binding_token: "fresh-inspection-token" }`,
        `  } }`,
        `}] } : {`,
        `  status: "observed", inspection: "status", agent: "codex",`,
        `  agent_version: "0.146.1", terminal_id: terminalId,`,
        `  expected_binding_token: "must-not-reach-model",`,
        `  turn_created: false, session_created: false`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        storeDir: "/private/akk-store",
        codexHome: "/private/custom-codex"
      },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    const inspectTool = tools.get("agent_knock_knock_native_inspect");
    assert.ok(inspectTool);
    assert.deepEqual(inspectTool.parameters?.required, [
      "terminal_id",
      "inspection"
    ]);
    assert.equal(inspectTool.parameters?.additionalProperties, false);
    const properties = inspectTool.parameters?.properties ?? {};
    assert.deepEqual(sorted(Object.keys(properties)), [
      "inspection",
      "terminal_id"
    ]);
    assert.equal(Object.hasOwn(properties, "command"), false);
    const inspectionSchema = isRecord(properties.inspection)
      ? properties.inspection
      : {};
    assert.deepEqual(inspectionSchema.enum, ["status"]);
    const terminalSchema = isRecord(properties.terminal_id)
      ? properties.terminal_id
      : {};
    assert.match(String(terminalSchema.pattern ?? ""), /terminal:v/u);
    assert.match(
      String(inspectionSchema.description ?? ""),
      /Codex 0\.146\.0\/0\.146\.1\/0\.147\.0\/0\.148\.0/u
    );
    assert.match(
      String(inspectionSchema.description ?? ""),
      /Claude Code 2\.1\.218\/2\.1\.226\/2\.1\.237/u
    );
    assert.match(
      inspectTool.description ?? "",
      /creates no AKK Session, Turn, receipt, monitor, or callback/u
    );
    assert.match(inspectTool.description ?? "", /arbitrary slash commands/iu);

    const result = await inspectTool.execute?.("native-status", {
      terminal_id: terminalId,
      inspection: "status"
    });
    assert.equal(result?.details?.status, "observed");
    assert.equal(result?.details?.turn_created, false);
    assertModelToolResultHasNoOpaqueAuthority(result);
    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(
      calls[1],
      [
        "native-inspect",
        "--terminal",
        terminalId,
        "--inspection",
        "status",
        "--expected-binding-token",
        "fresh-inspection-token",
        "--store-dir",
        "/private/akk-store",
        "--codex-home",
        "/private/custom-codex"
      ]
    );

    await assert.rejects(
      () => inspectTool.execute!("unsupported-inspection", {
        terminal_id: terminalId,
        inspection: "usage"
      }),
      /inspection must be status/u
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw native-thread tools keep CLI fences private while semantic calls refresh them", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-native-thread-")
  );
  const fakeCli = path.join(tempDir, "native-thread.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const currentThreadId = "11111111-1111-4111-8111-111111111111";
  const resumeThreadId = "22222222-2222-4222-8222-222222222222";
  const lifecycleFailurePath = path.join(tempDir, "lifecycle-failure.txt");
  const tools = new Map<string, ToolDefinition>();
  let command:
    | {
        handler?: (context: {
          args: string;
          sessionKey: string;
          sessionId?: string;
        }) => Promise<any>;
      }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const action = args[0];`,
        `const failureStatus = fs.existsSync(${JSON.stringify(lifecycleFailurePath)}) ? fs.readFileSync(${JSON.stringify(lifecycleFailurePath)}, "utf8").trim() : "";`,
        `const terminalId = ${JSON.stringify(terminalId)};`,
        `const currentThreadId = ${JSON.stringify(currentThreadId)};`,
        `const resumeThreadId = ${JSON.stringify(resumeThreadId)};`,
        `const result = action === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: {`,
        `    new_thread: { tool: "agent_knock_knock_new_thread", arguments: { terminal_id: terminalId, expected_binding_token: "fresh-binding-token" } },`,
        `    reconcile_binding: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 7, expected_binding_token: "fresh-conflict-binding-token", expected_terminal_token: "fresh-terminal-token" } }`,
        `  }`,
        `}] } : action === "list-resumable-threads" ? {`,
        `  terminal_id: terminalId,`,
        `  current_session_id: "session-current",`,
        `  current_native_thread_id: currentThreadId,`,
        `  expected_binding_token: "fresh-binding-token",`,
        `  threads: [{ native_thread_id: resumeThreadId, resumable: true, candidate_token: "fresh-candidate-token" }]`,
        `} : failureStatus && (action === "new-thread" || action === "resume-thread") ? {`,
        `  status: failureStatus, operation: action === "new-thread" ? "new_thread" : "resume_thread", terminal_id: terminalId,`,
        `  transition_id: "transition-recovery-required", do_not_retry: true, turn_created: false,`,
        `  reason: "expected revision 7, actual revision 8"`,
        `} : action === "new-thread" ? {`,
        `  status: "committed", operation: "new_thread", terminal_id: terminalId,`,
        `  previous_session_id: "session-current", session_id: "session-new",`,
        `  previous_native_thread_id: currentThreadId, native_thread_id: "33333333-3333-4333-8333-333333333333",`,
        `  binding_generation: 2, turn_created: false`,
        `} : action === "reconcile-binding" ? {`,
        `  status: "reconciled", outcome: "detached_conflicting_binding", terminal_id: terminalId,`,
        `  session_id: "session-conflict", session_revision: 8, terminal_input_sent: false, turn_created: false, refresh_required: true`,
        `} : {`,
        `  status: "committed", operation: "resume_thread", terminal_id: terminalId,`,
        `  previous_session_id: "session-current", session_id: "session-resumed",`,
        `  previous_native_thread_id: currentThreadId, native_thread_id: resumeThreadId,`,
        `  binding_generation: 2, turn_created: false`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        storeDir: "/private/akk-store",
        codexHome: "/private/custom-codex"
      },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:lifecycle",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    const listTool = tools.get("agent_knock_knock_list_resumable_threads");
    const terminalListTool = tools.get("agent_knock_knock_list");
    const newTool = tools.get("agent_knock_knock_new_thread");
    const reconcileTool = tools.get("agent_knock_knock_reconcile_binding");
    const resumeTool = tools.get("agent_knock_knock_resume_thread");
    assert.ok(listTool);
    assert.ok(terminalListTool);
    assert.ok(newTool);
    assert.ok(reconcileTool);
    assert.ok(resumeTool);
    assert.deepEqual(listTool.parameters?.required, ["terminal_id"]);
    assert.deepEqual(newTool.parameters?.required, ["terminal_id"]);
    assert.deepEqual(resumeTool.parameters?.required, [
      "terminal_id",
      "native_thread_id"
    ]);
    assert.deepEqual(reconcileTool.parameters?.required, [
      "terminal_id",
      "conflicting_session_id"
    ]);
    assert.equal(listTool.parameters?.additionalProperties, false);
    assert.equal(newTool.parameters?.additionalProperties, false);
    assert.equal(reconcileTool.parameters?.additionalProperties, false);
    assert.equal(resumeTool.parameters?.additionalProperties, false);
    for (const definition of [
      listTool,
      newTool,
      reconcileTool,
      resumeTool
    ]) {
      const terminalSchema = definition.parameters?.properties?.terminal_id;
      assert.match(
        isRecord(terminalSchema) ? String(terminalSchema.pattern ?? "") : "",
        /terminal:v/u
      );
    }
    assert.match(newTool.description ?? "", /no Turn/u);
    assert.match(reconcileTool.description ?? "", /explicit user confirmation/u);
    assert.match(reconcileTool.description ?? "", /creates no Turn/u);
    assert.match(resumeTool.description ?? "", /resumable=true/u);

    const listed = await listTool.execute?.("list-threads", {
      terminal_id: terminalId
    });
    assertModelToolResultHasNoOpaqueAuthority(listed);
    assert.equal(
      Object.hasOwn(listed?.details ?? {}, "expected_binding_token"),
      false
    );
    const created = await newTool.execute?.("new-thread", {
      terminal_id: terminalId
    });
    assert.equal(created?.details?.session_id, "session-new");
    assert.equal(Object.hasOwn(created?.details ?? {}, "turn_id"), false);
    const resumed = await resumeTool.execute?.("resume-thread", {
      terminal_id: terminalId,
      native_thread_id: resumeThreadId
    });
    assert.equal(resumed?.details?.session_id, "session-resumed");
    assert.equal(Object.hasOwn(resumed?.details ?? {}, "turn_id"), false);
    const terminalList = await terminalListTool.execute?.(
      "list-reconcile-authority",
      {}
    );
    assertModelToolResultHasNoOpaqueAuthority(terminalList);
    const reconciled = await reconcileTool.execute?.("reconcile-binding", {
      terminal_id: terminalId,
      conflicting_session_id: "session-conflict"
    });
    assert.equal(reconciled?.details?.status, "reconciled");
    assert.equal(reconciled?.details?.terminal_input_sent, false);
    assert.equal(reconciled?.details?.turn_created, false);
    const threadsSlash = await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(threadsSlash?.text ?? "", /1 resumable/u);
    const chooseSlash = await command?.handler?.({
      args: `resume-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(chooseSlash?.text ?? "", new RegExp(resumeThreadId, "u"));
    const newSlash = await command?.handler?.({
      args: `new-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(newSlash?.text ?? "", /No AKK Turn was created/u);
    const clearSlash = await command?.handler?.({
      args: `clear-thread ${terminalId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(clearSlash?.text ?? "", /started and verified/u);
    const resumeSlash = await command?.handler?.({
      args: `resume-thread ${terminalId} ${resumeThreadId}`,
      sessionKey: "agent:test:lifecycle"
    });
    assert.match(resumeSlash?.text ?? "", /resumed and verified/u);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0], [
      "list-resumable-threads",
      "--terminal",
      terminalId,
      "--store-dir",
      "/private/akk-store",
      "--codex-home",
      "/private/custom-codex"
    ]);
    const newThreadCalls = calls.filter(([action]) => action === "new-thread");
    const resumeThreadCalls = calls.filter(
      ([action]) => action === "resume-thread"
    );
    const reconcileCalls = calls.filter(
      ([action]) => action === "reconcile-binding"
    );
    assert.equal(newThreadCalls.length, 3);
    assert.equal(resumeThreadCalls.length, 2);
    assert.equal(reconcileCalls.length, 1);
    for (const args of [...newThreadCalls, ...resumeThreadCalls]) {
      assert.equal(
        args[args.indexOf("--expected-binding-token") + 1],
        "fresh-binding-token"
      );
    }
    for (const args of resumeThreadCalls) {
      assert.equal(
        args[args.indexOf("--candidate-token") + 1],
        "fresh-candidate-token"
      );
    }
    assert.deepEqual(reconcileCalls[0]?.slice(0, 15), [
      "reconcile-binding",
      "--terminal",
      terminalId,
      "--conflicting-session",
      "session-conflict",
      "--expected-session-revision",
      "7",
      "--expected-binding-token",
      "fresh-conflict-binding-token",
      "--expected-terminal-token",
      "fresh-terminal-token",
      "--store-dir",
      "/private/akk-store",
      "--codex-home",
      "/private/custom-codex"
    ]);
    for (const args of calls.filter((candidate) =>
      candidate[0] !== "list"
    )) {
      assert.equal(
        args[args.indexOf("--codex-home") + 1],
        "/private/custom-codex"
      );
    }

    fs.writeFileSync(lifecycleFailurePath, "uncertain");
    const uncertainNewTool = await newTool.execute?.("new-thread-uncertain", {
      terminal_id: terminalId
    });
    const uncertainResumeTool = await resumeTool.execute?.(
      "resume-thread-uncertain",
      {
        terminal_id: terminalId,
        native_thread_id: resumeThreadId
      }
    );
    for (const failed of [uncertainNewTool, uncertainResumeTool]) {
      assert.equal(failed?.isError, true);
      assert.equal(failed?.details?.status, "uncertain");
      assert.equal(failed?.details?.do_not_retry, true);
      assert.match(String(failed?.details?.reason), /private authority changed/u);
      assert.doesNotMatch(String(failed?.details?.reason), /revision|7|8/iu);
    }

    fs.writeFileSync(lifecycleFailurePath, "verified_recovery_required");
    const failedResumeSlash = await command?.handler?.({
      args: `resume-thread ${terminalId} ${resumeThreadId}`,
      sessionKey: "agent:test:lifecycle-recovery-required"
    });
    assert.equal(failedResumeSlash?.isError, true);
    assert.match(failedResumeSlash?.text ?? "", /Session commit requires recovery/u);
    assert.match(failedResumeSlash?.text ?? "", /do not retry automatically/iu);
    assert.match(failedResumeSlash?.text ?? "", /exact lifecycle recovery action/u);
    assert.doesNotMatch(failedResumeSlash?.text ?? "", /resumed and verified/u);
    assert.match(failedResumeSlash?.text ?? "", /private authority changed/u);
    assert.doesNotMatch(failedResumeSlash?.text ?? "", /revision|7|8/iu);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw Resume shortcuts preserve the displayed snapshot and previous exact action", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-resume-navigation-")
  );
  const fakeCli = path.join(tempDir, "resume-navigation.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
  const firstThreadId = "11111111-1111-4111-8111-111111111111";
  const secondThreadId = "22222222-2222-4222-8222-222222222222";
  const snapshotId = "rs_abcdefghijklmnopqrstuv";
  let command:
    | {
        handler?: (context: {
          args: string;
          sessionKey: string;
          sessionId?: string;
        }) => Promise<any>;
      }
    | undefined;
  try {
    fs.writeFileSync(fakeCli, [
      `const fs = require("node:fs");`,
      `const args = process.argv.slice(2);`,
      `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
      `const terminalId = ${JSON.stringify(terminalId)};`,
      `const first = ${JSON.stringify(firstThreadId)};`,
      `const second = ${JSON.stringify(secondThreadId)};`,
      `const snapshotId = ${JSON.stringify(snapshotId)};`,
      `const result = args[0] === "list-resumable-threads" ? {`,
      `  terminal_id: terminalId, current_session_id: "session-current", current_native_thread_id: first,`,
      `  expected_binding_token: "fresh-binding",`,
      `  selection_snapshot: { snapshot_id: snapshotId, expires_at: "2099-01-01T00:00:00.000Z" },`,
      `  previous: { native_thread_id: second, available_actions: { resume_thread: { arguments: { terminal_id: terminalId, native_thread_id: second, expected_binding_token: "previous-binding", candidate_token: "previous-candidate" } } } },`,
      `  threads: [`,
      `    { native_thread_id: first, selection_number: 1, short_id: "@11111111", selection_handle: snapshotId + ":1", resumable: true, candidate_token: "first-candidate" },`,
      `    { native_thread_id: second, selection_number: 2, short_id: "@22222222", selection_handle: snapshotId + ":2", resumable: true, candidate_token: "second-candidate" }`,
      `  ]`,
      `} : { status: "committed", operation: "resume_thread", terminal_id: terminalId, session_id: "session-resumed", native_thread_id: second, turn_created: false };`,
      `process.stdout.write(JSON.stringify(result));`
    ].join("\n"), "utf8");

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { storeDir: "/private/akk-store" },
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool() {}
    });

    await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `resume-thread ${terminalId} 2`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `threads ${terminalId}`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    const resetRejected = await command?.handler?.({
      args: `resume-thread ${terminalId} @22222222`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-b"
    });
    assert.equal(resetRejected?.isError, true);
    assert.match(resetRejected?.text ?? "", /last displayed snapshot/u);
    await command?.handler?.({
      args: `resume-thread ${terminalId} @22222222`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });
    await command?.handler?.({
      args: `resume-thread ${terminalId} previous`,
      sessionKey: "agent:test:snapshot",
      sessionId: "openclaw-conversation-a"
    });

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls.map((args) => args[0]), [
      "list-resumable-threads",
      "resume-thread",
      "list-resumable-threads",
      "resume-thread",
      "list-resumable-threads",
      "resume-thread"
    ]);
    assert.deepEqual(
      calls[1].slice(0, 7),
      [
        "resume-thread",
        "--terminal",
        terminalId,
        "--selection-snapshot",
        snapshotId,
        "--selection-number",
        "2"
      ]
    );
    assert.equal(calls[3][calls[3].indexOf("--selection-short-id") + 1], "@22222222");
    assert.equal(calls[5][calls[5].indexOf("--native-thread") + 1], secondThreadId);
    assert.equal(calls[5][calls[5].indexOf("--expected-binding-token") + 1], "previous-binding");
    assert.equal(calls[5][calls[5].indexOf("--candidate-token") + 1], "previous-candidate");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw routing and reconciliation omit a global workspace argument", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-send-paths-"));
  const fakeCli = path.join(tempDir, "delegate.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const eventLogPath = path.join(tempDir, "events.ndjson");
  const followCurrentTerminalId =
    "terminal:v2:tmux:codex:work:0.0:1234";
  let sendTool: ToolDefinition | undefined;
  let sendToolFactory: ToolFactory | undefined;
  let respondTool: ToolDefinition | undefined;
  let reconciliationService: {
    start?(): void;
    stop?(): void | Promise<void>;
  } | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const args = process.argv.slice(2);`,
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";`,
        `const sendResult = ${JSON.stringify({
          conversation: {
            conversation_id: "turn-1",
            session_id: "session-1",
            turn_id: "turn-1",
            status: "waiting_for_agent",
            state_path: statePath,
            event_log_path: eventLogPath,
            executor: {
              kind: "codex",
              session: "terminal:v2:tmux:codex:work:0.0:123"
            }
          },
          terminal_control: {
            target: "work:0.0",
            panePid: 123
          },
          delivered: true,
          background: true
        })};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: terminalId, available_actions: { send: {`,
        `    tool: "agent_knock_knock_send",`,
        `    arguments: { selector: terminalId, expected_terminal_token: "terminal-token-current", request: "continue" }`,
        `  } }`,
        `}] } : sendResult;`,
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n")
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService(service: {
        start?(): void;
        stop?(): void | Promise<void>;
      }) {
        reconciliationService = service;
      },
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:main",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name === "agent_knock_knock_send") {
          sendTool = definition;
          sendToolFactory = typeof tool === "function" ? tool : undefined;
        }
        if (options?.name === "agent_knock_knock_respond") {
          respondTool = definition;
        }
      }
    });

    assert.equal(typeof sendTool?.execute, "function");
    assert.equal(sendTool?.parameters?.additionalProperties, false);
    assert.equal(sendTool?.parameters?.required, undefined);
    assert.deepEqual(sendTool?.parameters?.oneOf, [
      {
        required: ["request"],
        not: { required: ["turn_id"] }
      },
      {
        required: ["turn_id"],
        not: {
          anyOf: [
            { required: ["request"] },
            { required: ["session_id"] },
            { required: ["terminal_id"] },
            { required: ["type"] },
            { required: ["idleTimeoutMinutes"] },
            { required: ["agentTimeoutMinutes"] },
            { required: ["agentHardTimeoutMinutes"] }
          ]
        }
      }
    ]);
    assert.deepEqual(sendTool?.parameters?.not, {
      required: ["session_id", "terminal_id"]
    });
    assert.equal(
      "timeoutSeconds" in (sendTool?.parameters?.properties ?? {}),
      false
    );
    const sendTypeSchema = sendTool?.parameters?.properties?.type;
    assert.deepEqual(
      isRecord(sendTypeSchema) ? sendTypeSchema.enum : undefined,
      ["task"]
    );
    for (const field of [
      "session_id",
      "terminal_id",
      "request",
      "turn_id"
    ]) {
      const schema = sendTool?.parameters?.properties?.[field];
      assert.equal(
        isRecord(schema) ? schema.minLength : undefined,
        1,
        `${field} must reject empty strings at the schema boundary`
      );
    }
    const idleTimeoutSchema = sendTool?.parameters?.properties?.idleTimeoutMinutes;
    assert.match(
      isRecord(idleTimeoutSchema)
        ? String(idleTimeoutSchema.description ?? "")
        : "",
      /idle or completed AKK Turn record is retained/u
    );
    assert.match(sendTool?.description ?? "", /session_id/u);
    assert.match(sendTool?.description ?? "", /terminal_id/u);
    assert.match(sendTool?.description ?? "", /exact \{turn_id\} form/u);
    assert.match(sendTool?.description ?? "", /freshness authority privately/u);
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-answer", {
        request: "Do not route this as an ordinary send",
        type: "answer"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-invalid-control", {
        session_id: "session-1",
        request: "Do not route this control message",
        type: "control"
      }),
      /ordinary send type must be task/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-ambiguous-target", {
        session_id: "session-1",
        terminal_id: followCurrentTerminalId,
        request: "Do not choose one target silently"
      }),
      /only one of session_id or terminal_id/u
    );
    await assert.rejects(
      () => sendTool!.execute!("tool-call-short-terminal", {
        terminal_id: "@a1b2c3d4",
        request: "Do not expand a short selector under a terminal fence"
      }),
      /terminal_id must be the exact full terminal identifier/u
    );
    for (const [field, value] of [
      ["session_id", ""],
      ["session_id", "   "],
      ["terminal_id", ""],
      ["terminal_id", "   "]
    ] as const) {
      await assert.rejects(
        () => sendTool!.execute!(`tool-call-empty-${field}`, {
          [field]: value,
          request: "Never fall back to automatic terminal selection"
        }),
        new RegExp(`${field} is required`, "u")
      );
    }
    const result = await sendTool?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    assert.equal(result?.details?.state_path, statePath);
    assert.equal(result?.details?.event_log_path, eventLogPath);
    assert.equal(result?.details?.session_id, "session-1");
    assert.equal(result?.details?.turn_id, "turn-1");
    await sendTool?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    await sendTool?.execute?.("tool-call-2", {
      session_id: "session-1",
      request: "Start a distinct turn"
    });
    await sendTool?.execute?.("tool-call-3", {
      terminal_id: followCurrentTerminalId,
      request: "Discover the initial terminal"
    });
    assert.deepEqual(respondTool?.parameters?.required, ["turn_id", "request"]);
    const respondResult = await respondTool?.execute?.("tool-call-4", {
      turn_id: "turn-1",
      request: "Use the safer implementation"
    });
    assert.equal(respondResult?.details?.session_id, "session-1");
    assert.equal(respondResult?.details?.turn_id, "turn-1");
    await respondTool?.execute?.("tool-call-4", {
      turn_id: "turn-1",
      request: "Use the safer implementation"
    });
    assert.equal(typeof reconciliationService?.start, "function");
    reconciliationService?.start?.();
    const otherSessionSend = sendToolFactory?.({
      sessionKey: "agent:test:other",
      sessionId: "openclaw-conversation-a"
    } as never);
    await otherSessionSend?.execute?.("tool-call-1", {
      request: "Verify the send output contract"
    });
    await respondTool?.execute?.("tool-call-1", {
      turn_id: "turn-1",
      request: "Keep send and respond idempotency domains separate"
    });
    const nextConversationSend = sendToolFactory?.({
      sessionKey: "agent:test:main",
      sessionId: "openclaw-conversation-b"
    } as never);
    await nextConversationSend?.execute?.("tool-call-1", {
      request: "Verify a reset OpenClaw conversation is isolated"
    });
    await sendTool?.execute?.("tool-call-follow-current", {
      terminal_id: followCurrentTerminalId,
      request: "Continue in the human-selected terminal context"
    });
    await reconciliationService?.stop?.();
    const allCalls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    const reconciliationCalls = allCalls.filter(
      ([command]) => command === "reconcile-monitors" ||
        command === "reconcile-watches"
    );
    const privateListCalls = allCalls.filter(([command]) => command === "list");
    const calls = allCalls.filter(
      ([command]) => command !== "reconcile-monitors" &&
        command !== "reconcile-watches" &&
        command !== "list"
    );
    assert.equal(privateListCalls.length, 2);
    assert.equal(calls[0]?.[0], "delegate");
    assert.equal(calls[0]?.includes("--agent"), false);
    assert.equal(calls[0]?.includes("--workspace"), false);
    const expectedToolCall1MessageId =
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-1"
      ])).digest("hex")}`;
    const optionValue = (args: string[], name: string): string | undefined => {
      const index = args.indexOf(name);
      return index >= 0 ? args[index + 1] : undefined;
    };
    assert.equal(
      optionValue(calls[0] ?? [], "--message-id"),
      expectedToolCall1MessageId
    );
    assert.equal(
      optionValue(calls[1] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "the same OpenClaw tool call must reuse one redacted idempotency key"
    );
    assert.deepEqual(calls[2]?.slice(0, 5), [
      "send",
      "--session",
      "session-1",
      "--message",
      "Start a distinct turn"
    ]);
    assert.equal(calls[2]?.includes("--workspace"), false);
    assert.equal(
      optionValue(calls[2] ?? [], "--message-id"),
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-2"
      ])).digest("hex")}`
    );
    assert.deepEqual(calls[3]?.slice(0, 5), [
      "send",
      "--conversation",
      followCurrentTerminalId,
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    assert.equal(
      optionValue(calls[3] ?? [], "--message"),
      "Discover the initial terminal"
    );
    assert.equal(
      optionValue(calls[3] ?? [], "--message-id"),
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_send",
        "tool-call-3"
      ])).digest("hex")}`
    );
    assert.deepEqual(calls[4]?.slice(0, 5), [
      "respond",
      "--turn",
      "turn-1",
      "--message",
      "Use the safer implementation"
    ]);
    const expectedRespondMessageId =
      `msg-openclaw-${createHash("sha256").update(JSON.stringify([
        "agent:test:main",
        "openclaw-conversation-a",
        "agent_knock_knock_respond",
        "tool-call-4"
      ])).digest("hex")}`;
    assert.equal(
      optionValue(calls[4] ?? [], "--message-id"),
      expectedRespondMessageId
    );
    assert.equal(
      optionValue(calls[5] ?? [], "--message-id"),
      expectedRespondMessageId,
      "the same OpenClaw respond call must reuse one redacted idempotency key"
    );
    assert.equal(
      optionValue(calls[4] ?? [], "--openclaw-session"),
      "agent:test:main"
    );
    assert.deepEqual(
      reconciliationCalls.map(([command]) => command),
      ["reconcile-monitors", "reconcile-watches"]
    );
    assert.equal(reconciliationCalls[0]?.includes("--workspace"), false);
    assert.equal(reconciliationCalls[1]?.includes("--workspace"), false);
    assert.notEqual(
      optionValue(calls[6] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "the same tool call id in another OpenClaw Session must be isolated"
    );
    assert.notEqual(
      optionValue(calls[7] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "send and respond must have separate idempotency domains"
    );
    assert.notEqual(
      optionValue(calls[8] ?? [], "--message-id"),
      expectedToolCall1MessageId,
      "a new OpenClaw conversation incarnation must not replay an old receipt"
    );
    assert.deepEqual(calls[9]?.slice(0, 5), [
      "send",
      "--conversation",
      followCurrentTerminalId,
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    assert.equal(
      optionValue(calls[9] ?? [], "--message"),
      "Continue in the human-selected terminal context"
    );
  } finally {
    await reconciliationService?.stop?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw send retry uses only the currently advertised exact Turn form", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-send-retry-")
  );
  const fakeCli = path.join(tempDir, "send-retry.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const turnId = "turn-submission-uncertain";
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const args = process.argv.slice(2);`,
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const turnId = ${JSON.stringify(turnId)};`,
        `const result = args[0] === "list" ? { terminals: [{`,
        `  id: "terminal:v2:tmux:codex:retry:0.0:1234",`,
        `  available_actions: { retry_submission: {`,
        `    tool: "agent_knock_knock_send",`,
        `    arguments: { turn_id: turnId },`,
        `    requires_explicit_user_confirmation: true`,
        `  } }`,
        `}] } : {`,
        `  conversation_id: turnId, session_id: "session-retry",`,
        `  turn_id: turnId, status: "stalled",`,
        `  submission_outcome: "pending_acceptance"`,
        `};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({
                sessionKey: "agent:test:retry",
                sessionId: "openclaw-retry"
              } as never)
            : tool;
        }
      }
    });

    for (const extra of [
      { request: "never inject replacement text" },
      { session_id: "session-retry" },
      { terminal_id: "terminal:v2:tmux:codex:retry:0.0:1234" },
      { agentTimeoutMinutes: 1 },
      { openclawSession: "caller-selected-route" }
    ]) {
      await assert.rejects(
        () => sendTool!.execute!("invalid-retry-form", {
          turn_id: turnId,
          ...extra
        }),
        /retry_submission accepts exactly turn_id/u
      );
    }
    await assert.rejects(
      () => sendTool!.execute!("invalid-retry-selector", {
        turn_id: "@deadbeef"
      }),
      /turn_id must be an authoritative managed id/u
    );

    const result = await sendTool?.execute?.("retry-once", {
      turn_id: turnId
    });
    assert.equal(result?.details?.turn_id, turnId);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0], ["list", "--reconcile"]);
    assert.deepEqual(calls[1], ["send", "--turn", turnId]);
    for (const forbidden of [
      "--message",
      "--session",
      "--conversation",
      "--agent-timeout-minutes",
      "--openclaw-session",
      "--gateway-session",
      "--gateway-method"
    ]) {
      assert.equal(calls[1]?.includes(forbidden), false, forbidden);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw monitor supervisor reconciles repeatedly without overlap and stops cleanly", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-plugin-monitor-supervisor-")
  );
  const fakeCli = path.join(tempDir, "supervisor.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const activePath = path.join(tempDir, "active");
  const startupReadyPath = path.join(tempDir, "startup-ready");
  const startupGatePath = path.join(tempDir, "startup-gate");
  let service: {
    start?(): void;
    stop?(): void | Promise<void>;
  } | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        'const fs = require("node:fs");',
        `const callsPath = ${JSON.stringify(callsPath)};`,
        `const activePath = ${JSON.stringify(activePath)};`,
        "const args = process.argv.slice(2);",
        "if (fs.existsSync(activePath)) { fs.appendFileSync(callsPath, JSON.stringify({ phase: 'overlap', args }) + '\\n'); }",
        "fs.writeFileSync(activePath, String(process.pid));",
        "fs.appendFileSync(callsPath, JSON.stringify({ phase: 'start', args }) + '\\n');",
        `if (args[0] === "reconcile-monitors" && args.includes("startup_reconciliation")) {`,
        `  fs.writeFileSync(${JSON.stringify(startupReadyPath)}, "ready");`,
        "  const deadline = Date.now() + 1000;",
        `  while (!fs.existsSync(${JSON.stringify(startupGatePath)}) && Date.now() < deadline) {`,
        "    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);",
        "  }",
        `  if (!fs.existsSync(${JSON.stringify(startupGatePath)})) process.exit(88);`,
        "}",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);",
        "fs.rmSync(activePath, { force: true });",
        "fs.appendFileSync(callsPath, JSON.stringify({ phase: 'end', args }) + '\\n');",
        "process.stdout.write(JSON.stringify({ checked: 1, launched: 0, already_running: 1, skipped: 0, errors: 0 }));"
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli, {
        monitorSupervisorIntervalMs: 20
      }) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService(value: typeof service) {
        service = value;
      },
      registerCommand() {},
      registerTool() {}
    });

    assert.equal(typeof service?.start, "function");
    assert.equal(typeof service?.stop, "function");
    const startupBeganAt = Date.now();
    service?.start?.();
    assert.equal(
      Date.now() - startupBeganAt < 500,
      true,
      "Terminal Watch startup reconciliation must not block the Gateway event loop"
    );
    const readyDeadline = Date.now() + 1_000;
    while (!fs.existsSync(startupReadyPath) && Date.now() < readyDeadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(startupReadyPath), true);
    fs.writeFileSync(startupGatePath, "continue");
    const deadline = Date.now() + 2_000;
    while (
      (!fs.existsSync(callsPath) ||
        readSupervisorCalls(callsPath).filter((entry) => entry.phase === "start")
          .length < 4) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await service?.stop?.();
    const stoppedCalls = readSupervisorCalls(callsPath);
    assert.equal(
      stoppedCalls.filter((entry) => entry.phase === "start").length >= 4,
      true
    );
    assert.equal(
      stoppedCalls.some((entry) => entry.phase === "overlap"),
      false
    );
    const starts = stoppedCalls.filter((entry) => entry.phase === "start");
    assert.equal(starts[0]?.args[0], "reconcile-monitors");
    assert.equal(starts[1]?.args[0], "reconcile-watches");
    assert.equal(starts[2]?.args[0], "reconcile-monitors");
    assert.equal(starts[3]?.args[0], "reconcile-watches");
    assert.equal(optionAfter(starts[0]?.args ?? [], "--reason"), "startup_reconciliation");
    assert.equal(optionAfter(starts[2]?.args ?? [], "--reason"), "monitor_supervision");
    assert.equal(starts[1]?.args.includes("--reason"), false);
    assert.equal(starts[3]?.args.includes("--reason"), false);
    assert.equal(starts[0]?.args.includes("--terminal-monitors-only"), false);
    assert.equal(starts[1]?.args.includes("--terminal-monitors-only"), false);
    assert.equal(starts[2]?.args.includes("--terminal-monitors-only"), true);
    assert.equal(starts[3]?.args.includes("--terminal-monitors-only"), false);
    const countAfterStop = stoppedCalls.length;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(readSupervisorCalls(callsPath).length, countAfterStop);
  } finally {
    await service?.stop?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw supervisor isolates managed monitor and Terminal Watch failures", async () => {
  const runFailureCase = async (
    failingCommand: "reconcile-monitors" | "reconcile-watches"
  ): Promise<void> => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `akk-plugin-supervisor-${failingCommand}-`)
    );
    const fakeCli = path.join(tempDir, "supervisor-failure.cjs");
    const callsPath = path.join(tempDir, "calls.ndjson");
    const warnings: string[] = [];
    let service: {
      start?(): void;
      stop?(): void | Promise<void>;
    } | undefined;

    try {
      fs.writeFileSync(
        fakeCli,
        [
          'const fs = require("node:fs");',
          "const args = process.argv.slice(2);",
          `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
          `if (args[0] === ${JSON.stringify(failingCommand)}) { process.stderr.write("injected failure"); process.exit(9); }`,
          "process.stdout.write(JSON.stringify({ checked: 1, launched: 0, already_running: 1, skipped: 0, changed: 0, callbacks_delivered: 0, errors: 0 }));"
        ].join("\n"),
        "utf8"
      );

      (
        createOpenClawPluginForTest(fakeCli, {
          monitorSupervisorIntervalMs: 20
        }) as unknown as {
          register(api: Record<string, any>): void;
        }
      ).register({
        pluginConfig: {},
        logger: {
          info() {},
          warn(message: string) {
            warnings.push(message);
          }
        },
        registerGatewayMethod() {},
        registerService(value: typeof service) {
          service = value;
        },
        registerCommand() {},
        registerTool() {}
      });

      service?.start?.();
      const deadline = Date.now() + 2_000;
      while (
        (!fs.existsSync(callsPath) ||
          fs.readFileSync(callsPath, "utf8").trim().split("\n").length < 4) &&
        Date.now() < deadline
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      await service?.stop?.();
      const calls = fs.readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.deepEqual(calls.slice(0, 4).map((args) => args[0]), [
        "reconcile-monitors",
        "reconcile-watches",
        "reconcile-monitors",
        "reconcile-watches"
      ]);
      assert.equal(
        warnings.some((message) =>
          failingCommand === "reconcile-monitors"
            ? message.includes("monitor supervision deferred") ||
              message.includes("monitor reconciliation skipped")
            : message.includes("Terminal Watch supervision deferred") ||
              message.includes("Terminal Watch reconciliation skipped")
        ),
        true
      );
    } finally {
      await service?.stop?.();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };

  await runFailureCase("reconcile-monitors");
  await runFailureCase("reconcile-watches");
});

test("OpenClaw controls distinguish managed turns from list-prefilled raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-turn-controls-"));
  const fakeCli = path.join(tempDir, "controls.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const changedAuthorityPath = path.join(tempDir, "changed-authority");
  const tools = new Map<string, ToolDefinition>();
  const toolFactories = new Map<string, ToolFactory>();
  let command:
    | {
        handler?: (context: {
          args: string;
          sessionKey: string;
          sessionId?: string;
        }) => Promise<any>;
      }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const args = process.argv.slice(2);`,
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        `const fs = require("node:fs");`,
        `const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";`,
        `const changed = fs.existsSync(${JSON.stringify(changedAuthorityPath)});`,
        `const approvalFingerprint = (changed ? "b" : "a").repeat(64);`,
        `const terminalToken = changed ? "terminal-token-changed" : "terminal-token-current";`,
        `const listResult = { terminals: [{ id: terminalId,`,
        `  available_actions: {`,
        `    approve: { tool: "agent_knock_knock_approve", arguments: { conversation_id: terminalId, expected_approval_fingerprint: approvalFingerprint, expected_terminal_token: terminalToken } },`,
        `    reconcile_binding: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 7, expected_binding_token: "conflict-binding-current", expected_terminal_token: terminalToken } }`,
        `  },`,
        `  handoff_decision: { kind: "active_turn_requires_decision", choices: { take_over_current: { action: { tool: "agent_knock_knock_close", arguments: { turn_id: "turn-active", reason: "superseded_by_human_context_switch" }, requires_explicit_user_confirmation: true } } } },`,
        `  audit_history: {`,
        `    reconcile: { tool: "agent_knock_knock_reconcile_binding", arguments: { terminal_id: terminalId, conflicting_session_id: "session-conflict", expected_session_revision: 6, expected_binding_token: "stale-conflict-binding", expected_terminal_token: "stale-terminal-token" } },`,
        `    handoff: { tool: "agent_knock_knock_close", arguments: { turn_id: "turn-active", reason: "superseded_by_human_context_switch", expected_handoff_token: "stale-handoff" } }`,
        `  },`,
        `  managed: { current_turn: { turn_id: "turn-approve", available_actions: {`,
        `    approve: { tool: "agent_knock_knock_approve", arguments: { turn_id: "turn-approve", expected_approval_fingerprint: approvalFingerprint } }`,
        `  } } }`,
        `}] };`,
        `const unresolvedLifecycle = args.includes("transition-current") || args.includes("transition-from-list");`,
        `const turnIndex = args.indexOf("--turn");`,
        `const conversationIndex = args.indexOf("--conversation");`,
        `const statusTarget = turnIndex >= 0 ? args[turnIndex + 1] : conversationIndex >= 0 ? args[conversationIndex + 1] : undefined;`,
        `const staleCallback = { message: { metadata: { terminal_status: { approval_state: { approvable: true, fingerprint: "f".repeat(64) } } } } };`,
        `const statusResult = statusTarget?.startsWith("terminal:") ? { source: "terminal_control", conversation_id: statusTarget, approval_state: { approvable: true, fingerprint: approvalFingerprint }, callback_delivery: staleCallback } : { conversation_id: statusTarget, session_id: "session-controls", turn_id: statusTarget, approval_state: { approvable: true, fingerprint: approvalFingerprint }, callback_delivery: staleCallback };`,
        `const result = args[0] === "list" ? listResult : args[0] === "status" ? statusResult : args[0] === "reconcile-binding" ? { status: "reconciled", terminal_id: terminalId, turn_created: false } : unresolvedLifecycle ? {`,
        `  source: "terminal_control",`,
        `  terminal_control: { target: "work:0.0" },`,
        `  closed: false,`,
        `  terminal_dispatch_resolved: false,`,
        `  transition_id: "transition-from-list",`,
        `  blocked: true,`,
        `  do_not_retry: true,`,
        `  reason: "live identity mismatch"`,
        `} : {};`,
        `process.stdout.write(JSON.stringify(result));`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function"
          ? tool({
              sessionKey: "agent:test:controls",
              sessionId: "openclaw-conversation-a"
            } as never)
          : tool;
        if (options?.name) {
          tools.set(options.name, definition);
          if (typeof tool === "function") {
            toolFactories.set(options.name, tool);
          }
        }
      }
    });

    const statusTool = tools.get("agent_knock_knock_status");
    assert.ok(statusTool, "agent_knock_knock_status must be registered");
    assert.ok(statusTool.parameters?.properties?.turn_id);
    assert.ok(statusTool.parameters?.properties?.conversation_id);
    assert.ok(statusTool.parameters?.properties?.watch_id);
    assert.deepEqual(statusTool.parameters?.anyOf, [
      { required: ["turn_id"] },
      { required: ["conversation_id"] },
      { required: ["watch_id"] }
    ]);
    assert.deepEqual(statusTool.parameters?.not, {
      anyOf: [
        { required: ["turn_id", "conversation_id"] },
        { required: ["turn_id", "watch_id"] },
        { required: ["conversation_id", "watch_id"] }
      ]
    });
    const watchTool = tools.get("agent_knock_knock_watch");
    assert.ok(watchTool, "agent_knock_knock_watch must be registered");
    assert.deepEqual(watchTool.parameters?.required, ["terminal_id"]);
    assert.equal(watchTool.parameters?.additionalProperties, false);
    assert.equal(
      Object.hasOwn(
        watchTool.parameters?.properties ?? {},
        "expected_binding_token"
      ),
      false
    );
    assert.match(
      watchTool.description ?? "",
      /exact terminal_id.*revalidates current observation authority internally/u
    );
    const unwatchTool = tools.get("agent_knock_knock_unwatch");
    assert.ok(unwatchTool, "agent_knock_knock_unwatch must be registered");
    assert.deepEqual(unwatchTool.parameters?.required, ["watch_id"]);
    assert.equal(unwatchTool.parameters?.additionalProperties, false);

    for (const name of [
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const definition = tools.get(name);
      assert.ok(definition, `${name} must be registered`);
      assert.ok(definition.parameters?.properties?.turn_id);
      assert.ok(definition.parameters?.properties?.conversation_id);
      assert.deepEqual(definition.parameters?.anyOf, [
        { required: ["turn_id"] },
        { required: ["conversation_id"] }
      ]);
      assert.deepEqual(
        definition.parameters?.not,
        name === "agent_knock_knock_close"
          ? {
              anyOf: [
                { required: ["turn_id", "conversation_id"] },
                {
                  required: [
                    "expected_message_id",
                    "expected_transition_id"
                  ]
                }
              ]
            }
          : { required: ["turn_id", "conversation_id"] }
      );
    }
    const sendTurnSchema = tools.get("agent_knock_knock_send")
      ?.parameters?.properties?.turn_id;
    assert.ok(sendTurnSchema);
    assert.match(
      String(sendTurnSchema.description ?? ""),
      /available_actions\.retry_submission[\s\S]*exactly \{turn_id\}/u
    );
    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      const conversationSchema = tools.get(name)?.parameters?.properties
        ?.conversation_id;
      const description = isRecord(conversationSchema)
        ? String(conversationSchema.description ?? "")
        : "";
      assert.match(description, /raw-terminal|raw terminal/u, name);
      assert.match(description, /never construct|never guess/u, name);
    }
    const closeTool = tools.get("agent_knock_knock_close");
    assert.equal(closeTool?.parameters?.additionalProperties, false);
    assert.ok(closeTool?.parameters?.properties?.expected_message_id);
    assert.ok(closeTool?.parameters?.properties?.expected_transition_id);
    assert.equal(
      Object.hasOwn(
        closeTool?.parameters?.properties ?? {},
        "expected_handoff_token"
      ),
      false
    );
    assert.match(closeTool?.description ?? "", /expected_transition_id/u);
    assert.match(closeTool?.description ?? "", /cannot veto closing the Turn/u);
    const approveTool = tools.get("agent_knock_knock_approve");
    assert.ok(approveTool);
    assert.deepEqual(approveTool.parameters?.anyOf, [
      { required: ["turn_id"] },
      { required: ["terminal_id"] }
    ]);
    assert.deepEqual(approveTool.parameters?.not, {
      required: ["turn_id", "terminal_id"]
    });
    assertNoModelOpaqueAuthority(
      approveTool.parameters,
      "$.agent_knock_knock_approve.parameters"
    );
    await assert.rejects(
      () => approveTool.execute!("ambiguous-approval-target", {
        turn_id: "turn-managed",
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234"
      }),
      /approve requires exactly one of turn_id or terminal_id/u
    );
    await assert.rejects(
      () => approveTool.execute!("approval-without-offer", {
        turn_id: "turn-no-offer"
      }),
      /requires a current approval request shown by agent_knock_knock_status in this OpenClaw conversation/u
    );
    assert.equal(
      fs.existsSync(callsPath),
      false,
      "missing model-session authority must fail before spawning the CLI"
    );

    await assert.rejects(
      () => closeTool!.execute!("ambiguous-recovery-fence", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234",
        expected_message_id: "message-current",
        expected_transition_id: "transition-current"
      }),
      /only one of expected_message_id or expected_transition_id/u
    );
    await closeTool!.execute!("managed-handoff-ignores-private-fence", {
      turn_id: "turn-active-with-recovery-id",
      reason: "superseded_by_human_context_switch",
      expected_message_id: "message-current"
    });
    await assert.rejects(
      () => closeTool!.execute!("raw-handoff-target", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234",
        reason: "superseded_by_human_context_switch"
      }),
      /requires the exact managed turn_id/u
    );

    for (const name of [
      "agent_knock_knock_status",
      "agent_knock_knock_renew",
      "agent_knock_knock_retry_callback",
      "agent_knock_knock_cancel",
      "agent_knock_knock_close"
    ]) {
      await assert.rejects(
        () => tools.get(name)!.execute!("ambiguous-turn-target", {
          turn_id: "turn-modern",
          conversation_id: "turn-legacy-other"
        }),
        /only one of turn_id or conversation_id/u,
        name
      );
    }
    await assert.rejects(
      () => statusTool.execute!("ambiguous-watch-target", {
        turn_id: "turn-modern",
        watch_id: "terminal-watch-modern"
      }),
      /exactly one of turn_id, conversation_id, or watch_id/u
    );

    const sendTool = tools.get("agent_knock_knock_send");
    const respondTool = tools.get("agent_knock_knock_respond");
    for (const invalidSessionId of [
      "only",
      "@deadbeef",
      "terminal:v2:tmux:codex:work:0.0:1234"
    ]) {
      await assert.rejects(
        () => sendTool!.execute!("invalid-session-id", {
          session_id: invalidSessionId,
          request: "must not reinterpret an authoritative id"
        }),
        /session_id must be an authoritative managed id/u
      );
    }
    for (const invalidTurnId of [
      "latest",
      "@deadbeef",
      "terminal:v2:tmux:codex:work:0.0:1234"
    ]) {
      await assert.rejects(
        () => respondTool!.execute!("invalid-turn-id", {
          turn_id: invalidTurnId,
          request: "must not reinterpret an authoritative id"
        }),
        /turn_id must be an authoritative managed id/u
      );
      await assert.rejects(
        () => tools.get("agent_knock_knock_status")!.execute!(
          "invalid-status-turn-id",
          { turn_id: invalidTurnId }
        ),
        /turn_id must be an authoritative managed id/u
      );
    }

    const displayedList = await tools.get("agent_knock_knock_list")?.execute?.(
      "list-private-authority",
      {}
    );
    assertModelToolResultHasNoOpaqueAuthority(displayedList);
    const displayedApproval = await tools
      .get("agent_knock_knock_status")
      ?.execute?.("status-private-approval", {
        turn_id: "turn-approve"
      });
    assertModelToolResultHasNoOpaqueAuthority(displayedApproval);
    const foreignApprove = toolFactories
      .get("agent_knock_knock_approve")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await assert.rejects(
      () => foreignApprove!.execute!("cross-session-approval", {
        turn_id: "turn-approve"
      }),
      /in this OpenClaw conversation/u
    );
    const foreignReconcile = toolFactories
      .get("agent_knock_knock_reconcile_binding")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await assert.rejects(
      () => foreignReconcile!.execute!("cross-session-reconcile", {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
        conflicting_session_id: "session-conflict"
      }),
      /in this OpenClaw session/u
    );
    const foreignClose = toolFactories
      .get("agent_knock_knock_close")
      ?.({
        sessionKey: "agent:test:controls",
        sessionId: "openclaw-conversation-b"
      } as never);
    await foreignClose!.execute!("cross-session-handoff", {
      turn_id: "turn-active-foreign",
      reason: "superseded_by_human_context_switch"
    });
    await statusTool.execute?.("watch-status", {
      watch_id: "terminal-watch-status"
    });
    await watchTool.execute?.("watch", {
      terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
      hardTimeoutMinutes: 30
    });
    await unwatchTool.execute?.("unwatch", {
      watch_id: "terminal-watch-status"
    });
    await tools.get("agent_knock_knock_approve")?.execute?.("approve", {
      turn_id: "turn-approve"
    });
    const displayedTerminalApproval = await tools
      .get("agent_knock_knock_status")
      ?.execute?.("terminal-status-private-approval", {
        conversation_id: "terminal:v2:tmux:codex:work:0.0:1234"
      });
    assertModelToolResultHasNoOpaqueAuthority(displayedTerminalApproval);
    await tools.get("agent_knock_knock_approve")?.execute?.(
      "terminal-scoped-approve",
      {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234"
      }
    );
    const reconciled = await tools
      .get("agent_knock_knock_reconcile_binding")
      ?.execute?.("reconcile-semantic-only", {
        terminal_id: "terminal:v2:tmux:codex:work:0.0:1234",
        conflicting_session_id: "session-conflict"
      });
    assert.equal(reconciled?.details?.status, "reconciled");
    await tools.get("agent_knock_knock_renew")?.execute?.("renew", {
      turn_id: "turn-renew"
    });
    await tools.get("agent_knock_knock_retry_callback")?.execute?.("retry", {
      turn_id: "turn-retry"
    });
    await tools.get("agent_knock_knock_cancel")?.execute?.("cancel", {
      turn_id: "turn-cancel"
    });
    await tools.get("agent_knock_knock_close")?.execute?.("close", {
      turn_id: "turn-close"
    });
    await tools.get("agent_knock_knock_close")?.execute?.("take-over-current", {
      turn_id: "turn-active",
      reason: "superseded_by_human_context_switch"
    });
    const blockedCloseTool = await tools.get("agent_knock_knock_close")?.execute?.(
      "recover-lifecycle",
      {
        conversation_id:
          "terminal:v2:tmux:codex:work:0.0:1234",
        expected_transition_id: "transition-current"
      }
    );
    assert.equal(blockedCloseTool?.isError, true);
    assert.equal(blockedCloseTool?.details?.terminal_dispatch_resolved, false);
    assert.equal(blockedCloseTool?.details?.blocked, true);
    const slashRecovery = await command?.handler?.({
      args:
        `close terminal:v2:tmux:codex:work:0.0:1234 ` +
        "--expected-transition-id transition-from-list",
      sessionKey: "agent:test:lifecycle-recovery"
    });
    assert.equal(slashRecovery?.isError, true);
    assert.match(
      slashRecovery?.text ?? "",
      /did not clear the unresolved terminal dispatch fence/u
    );
    assert.match(slashRecovery?.text ?? "", /remains blocked/u);
    assert.match(slashRecovery?.text ?? "", /Do not retry/u);
    assert.doesNotMatch(slashRecovery?.text ?? "", /Turn record closed/u);

    await tools.get("agent_knock_knock_status")?.execute?.(
      "status-before-authority-change",
      { turn_id: "turn-approve" }
    );
    const approveCallsBeforeChange = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[])
      .filter(([action]) => action === "approve").length;
    fs.writeFileSync(changedAuthorityPath, "changed", "utf8");
    await assert.rejects(
      () => approveTool.execute!("approval-authority-changed", {
        turn_id: "turn-approve"
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /approval request changed after it was shown/u);
        assert.doesNotMatch(
          error.message,
          /(?:a{64}|b{64}|terminal-token|fingerprint)/iu
        );
        return true;
      }
    );

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(
      calls.filter(([action]) => action === "approve").length,
      approveCallsBeforeChange,
      "changed authority must fail before the approve CLI is spawned"
    );
    const callFor = (action: string): string[] | undefined =>
      calls.find(([candidate]) => candidate === action);
    assert.deepEqual(callFor("watch-terminal"), [
      "watch-terminal",
      "--terminal",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--hard-timeout-minutes",
      "30",
      "--openclaw-session",
      "agent:test:controls"
    ]);
    assert.deepEqual(callFor("unwatch-terminal"), [
      "unwatch-terminal",
      "--watch",
      "terminal-watch-status"
    ]);
    assert.deepEqual(callFor("reconcile-binding"), [
      "reconcile-binding",
      "--terminal",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--conflicting-session",
      "session-conflict",
      "--expected-session-revision",
      "7",
      "--expected-binding-token",
      "conflict-binding-current",
      "--expected-terminal-token",
      "terminal-token-current"
    ]);
    const approveCalls = calls.filter(([action]) => action === "approve");
    assert.deepEqual(approveCalls, [
      [
        "approve",
        "--turn",
        "turn-approve",
        "--expected-approval-fingerprint",
        "a".repeat(64)
      ],
      [
        "approve",
        "--conversation",
        "terminal:v2:tmux:codex:work:0.0:1234",
        "--expected-approval-fingerprint",
        "a".repeat(64),
        "--expected-terminal-token",
        "terminal-token-current"
      ]
    ]);
    const handoffClose = calls.find((args) =>
      args[0] === "close" &&
      args.includes("superseded_by_human_context_switch")
    );
    assert.deepEqual(handoffClose, [
      "close",
      "--turn",
      "turn-active-with-recovery-id",
      "--reason",
      "superseded_by_human_context_switch",
      "--expected-message-id",
      "message-current"
    ]);
    const recoveryClose = calls.find((args) =>
      args[0] === "close" && args.includes("transition-current")
    );
    assert.deepEqual(recoveryClose?.slice(0, 5), [
      "close",
      "--conversation",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--expected-transition-id",
      "transition-current"
    ]);
    const slashRecoveryClose = calls.find((args) =>
      args[0] === "close" && args.includes("transition-from-list")
    );
    assert.deepEqual(slashRecoveryClose, [
      "close",
      "--turn",
      "terminal:v2:tmux:codex:work:0.0:1234",
      "--reason",
      "Native-thread lifecycle transition recovered from /akk command",
      "--expected-transition-id",
      "transition-from-list"
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw status includes purpose context and a bounded terminal screen", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-status-"));
  const fakeCli = path.join(tempDir, "status.cjs");
  let statusTool: ToolDefinition | undefined;
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const result = {
  conversation_id: "managed-terminal-1",
  session_id: "session-status",
  turn_id: "managed-terminal-1",
  conversation: {
    conversation_id: "managed-terminal-1",
    session_id: "session-status",
    turn_id: "managed-terminal-1",
    status: "waiting_for_agent",
    callback_delivery: {
      status: "pending",
      attempts: 2,
      next_attempt_at: "2026-08-06T12:30:00.000Z"
    }
  },
  summary: {
    conversation_id: "managed-terminal-1",
    session_id: "session-status",
    turn_id: "managed-terminal-1",
    agent: "codex",
    status: "waiting_for_agent",
    session: "work:0.0",
    callback_delivery: {
      status: "pending",
      attempts: 2,
      attempt_state: "in_flight",
      next_attempt_at: "2026-08-06T12:30:00.000Z"
    }
  },
  about: "Review the current branch",
  confidence: "high",
  limitations: ["history is bounded"],
  terminal_status: {
    agent: "codex",
    activity_state: "working"
  },
  terminal_screen: {
    excerpt: "Running focused tests"
  }
};
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: { workspace: tempDir },
      logger: {
        info() {},
        warn() {}
      },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name === "agent_knock_knock_status") {
          statusTool = definition;
        }
      }
    });

    const toolResult = await statusTool?.execute?.("tool-call-status", {
      conversation_id: "only"
    });
    assert.equal(toolResult?.details?.about, "Review the current branch");
    assert.equal(toolResult?.details?.confidence, "high");
    assert.deepEqual(toolResult?.details?.limitations, ["history is bounded"]);

    const slashResult = await command?.handler?.({
      args: "status only",
      sessionKey: "agent:test:main"
    });
    assert.match(slashResult?.text ?? "", /about: Review the current branch/u);
    assert.match(slashResult?.text ?? "", /terminal screen:\nRunning focused tests/u);
    assert.match(slashResult?.text ?? "", /^session: session-status$/mu);
    assert.match(slashResult?.text ?? "", /^turn: managed-terminal-1$/mu);
    assert.match(
      slashResult?.text ?? "",
      /^turn status: waiting_for_agent$/mu
    );
    assert.match(
      slashResult?.text ?? "",
      /^terminal activity: working$/mu
    );
    assert.doesNotMatch(slashResult?.text ?? "", /AKK Watch available/u);
    assert.doesNotMatch(slashResult?.text ?? "", /^status:/mu);
    assert.match(
      slashResult?.text ?? "",
      /^callback: pending, attempt 2, in flight, next retry 2026-08-06T12:30:00\.000Z$/mu
    );
    assert.doesNotMatch(slashResult?.text ?? "", /^conversation:/mu);
    assert.doesNotMatch(slashResult?.text ?? "", /work:0\.0/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("public command results label AKK sessions and turns instead of native sessions", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-public-wording-"));
  const fakeCli = path.join(tempDir, "public-wording.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const turnId = \`turn-\${action}\`;
const sessionId = \`session-\${action}\`;
const conversation = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  status: action === "close" ? "closed" : "waiting_for_agent",
  executor: { kind: "codex", session: \`native-\${action}\` }
};
const result = {
  conversation_id: turnId,
  session_id: sessionId,
  turn_id: turnId,
  conversation,
  summary: {
    conversation_id: turnId,
    session_id: sessionId,
    turn_id: turnId,
    agent: "codex",
    status: conversation.status,
    session: \`native-summary-\${action}\`
  },
  executor: conversation.executor,
  terminal_control: { target: \`native-pane-\${action}\` },
  delivered: true,
  background: true,
  approved: action === "approve",
  cancel_requested: action === "cancel",
  agent_timeout_minutes: 20,
  agent_hard_timeout_minutes: 120
};
if (action === "retry-callback") {
  delete result.session_id;
  delete result.turn_id;
  delete result.conversation.session_id;
  delete result.conversation.turn_id;
  delete result.summary.session_id;
  delete result.summary.turn_id;
  result.conversation.callback_delivery = { attempts: 2 };
}
process.stdout.write(JSON.stringify(result));
`,
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand(value: typeof command) {
        command = value;
      },
      registerTool() {}
    });

    const cases = [
      {
        args: "Review public wording",
        action: "delegate",
        sessionId: "session-delegate",
        turnId: "turn-delegate"
      },
      {
        args: "status turn-status",
        action: "status",
        sessionId: "session-status",
        turnId: "turn-status"
      },
      {
        args: "renew turn-renew 20",
        action: "renew",
        sessionId: "session-renew",
        turnId: "turn-renew"
      },
      {
        args: "retry-callback turn-retry-callback",
        action: "retry-callback",
        sessionId: "turn-retry-callback",
        turnId: "turn-retry-callback"
      },
      {
        args: "cancel turn-cancel",
        action: "cancel",
        sessionId: "session-cancel",
        turnId: "turn-cancel"
      },
      {
        args: "close turn-close done",
        action: "close",
        sessionId: "session-close",
        turnId: "turn-close"
      }
    ];

    for (const item of cases) {
      const result = await command?.handler?.({
        args: item.args,
        sessionKey: "agent:test:public-wording"
      });
      const text = String(result?.text ?? "");
      assert.match(text, new RegExp(`^session: ${item.sessionId}$`, "mu"), item.action);
      assert.match(text, new RegExp(`^turn: ${item.turnId}$`, "mu"), item.action);
      assert.doesNotMatch(text, /^conversation:/mu, item.action);
      assert.doesNotMatch(text, /native-/u, item.action);
    }

    const closeResult = await command?.handler?.({
      args: "close turn-close done",
      sessionKey: "agent:test:public-wording"
    });
    assert.match(closeResult?.text ?? "", /AKK Turn record closed\./u);
    assert.doesNotMatch(closeResult?.text ?? "", /AKK session closed/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw surfaces delivered-but-unfenced sends as errors that must not be retried", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-unfenced-"));
  const fakeCli = path.join(tempDir, "unfenced.cjs");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      `process.stdout.write(${JSON.stringify(JSON.stringify({
        conversation_id: "turn-unfenced",
        session_id: "session-unfenced",
        turn_id: "turn-unfenced",
        status: "delivered_unfenced",
        submission_outcome: "submitted",
        do_not_retry: true,
        reason: "native identity did not bind",
        conversation: {
          conversation_id: "turn-unfenced",
          session_id: "session-unfenced",
          turn_id: "turn-unfenced",
          status: "stalled",
          executor: { kind: "codex", session: "native-unfenced" }
        }
      }))});`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({ sessionKey: "agent:test:unfenced" } as never)
            : tool;
        }
      },
      registerCommand(value: typeof command) {
        command = value;
      }
    });

    for (const args of [
      "Inspect the repository",
      "codex: Inspect the repository"
    ]) {
      const result = await command?.handler?.({
        args,
        sessionKey: "agent:test:unfenced"
      });
      assert.equal(result?.isError, true, args);
      assert.match(result?.text ?? "", /could not bind|could not fence/u, args);
      assert.match(result?.text ?? "", /do not retry/u, args);
      assert.doesNotMatch(result?.text ?? "", /yield now/u, args);
    }

    assert.equal(typeof sendTool?.execute, "function");
    const toolResponse = await sendTool?.execute?.("unfenced-send", {
      request: "Inspect the repository"
    });
    assert.equal(toolResponse?.isError, true);
    assert.equal(toolResponse?.details?.status, "submission_unfenced");
    assert.equal(toolResponse?.details?.do_not_retry, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("OpenClaw preserves safe and unsafe aborted submission retry boundaries", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-aborted-"));
  const fakeCli = path.join(tempDir, "aborted.cjs");
  const modePath = path.join(tempDir, "mode.txt");
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  let sendTool: ToolDefinition | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        `const fs = require("node:fs");`,
        `const safe = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim() === "safe";`,
        `process.stdout.write(JSON.stringify({`,
        `  conversation_id: "turn-aborted",`,
        `  session_id: "session-aborted",`,
        `  turn_id: "turn-aborted",`,
        `  status: "submission_aborted",`,
        `  submission_outcome: "aborted",`,
        `  delivered: false,`,
        `  safe_to_retry: safe,`,
        `  do_not_retry: !safe,`,
        `  reason: safe ? "durable safe abort" : "aborted receipt was not durable",`,
        `  conversation: {`,
        `    conversation_id: "turn-aborted",`,
        `    session_id: "session-aborted",`,
        `    turn_id: "turn-aborted",`,
        `    status: "idle",`,
        `    executor: { kind: "codex", session: "native-aborted" }`,
        `  }`,
        `}));`
      ].join("\n"),
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        if (options?.name === "agent_knock_knock_send") {
          sendTool = typeof tool === "function"
            ? tool({ sessionKey: "agent:test:aborted" } as never)
            : tool;
        }
      },
      registerCommand(value: typeof command) {
        command = value;
      }
    });

    for (const safe of [true, false]) {
      fs.writeFileSync(modePath, safe ? "safe" : "unsafe", "utf8");
      const slashResult = await command?.handler?.({
        args: "Inspect the repository",
        sessionKey: "agent:test:aborted"
      });
      assert.equal(slashResult?.isError, true);
      if (safe) {
        assert.match(slashResult?.text ?? "", /may be retried/u);
        assert.doesNotMatch(slashResult?.text ?? "", /do not retry/u);
      } else {
        assert.match(slashResult?.text ?? "", /do not retry/u);
        assert.match(slashResult?.text ?? "", /inspect/u);
        assert.doesNotMatch(slashResult?.text ?? "", /may be retried/u);
      }

      const toolResult = await sendTool?.execute?.(
        safe ? "safe-abort" : "unsafe-abort",
        { request: "Inspect the repository" }
      );
      assert.equal(toolResult?.isError, true);
      assert.equal(toolResult?.details?.submission_outcome, "aborted");
      assert.equal(toolResult?.details?.safe_to_retry, safe);
      assert.equal(toolResult?.details?.do_not_retry, !safe);
      assert.match(
        String(toolResult?.details?.note ?? ""),
        safe ? /may be retried/u : /do not retry/iu
      );
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("plugin tool results reject partial identity and do not invent Turn ids for raw terminals", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-result-identity-"));
  const fakeCli = path.join(tempDir, "identity.cjs");
  const tools = new Map<string, ToolDefinition>();

  try {
    fs.writeFileSync(
      fakeCli,
      `const action = process.argv[2];
const result = action === "status"
  ? { source: "terminal_control", conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
  : { conversation: { conversation_id: "turn-partial", session_id: "session-partial" } };
process.stdout.write(JSON.stringify(result));`,
      "utf8"
    );
    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {},
      logger: { info() {}, warn() {} },
      registerGatewayMethod() {},
      registerService() {},
      registerCommand() {},
      registerTool(
        tool: ToolDefinition | ToolFactory,
        options?: { name?: string }
      ) {
        const definition = typeof tool === "function" ? tool({}) : tool;
        if (options?.name) {
          tools.set(options.name, definition);
        }
      }
    });

    await assert.rejects(
      () => tools.get("agent_knock_knock_send")!.execute!("partial", {
        session_id: "session-partial",
        request: "Do not expose partial identity"
      }),
      /partial session_id\/turn_id identity/u
    );
    const rawStatus = await tools.get("agent_knock_knock_status")?.execute?.(
      "raw-status",
      { conversation_id: "terminal:v2:tmux:codex:work:0.0:123" }
    );
    assert.equal(rawStatus?.details?.conversation_id,
      "terminal:v2:tmux:codex:work:0.0:123");
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "session_id"), false);
    assert.equal(Object.hasOwn(rawStatus?.details ?? {}, "turn_id"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("bundled OpenClaw skills exist and are included in the npm artifact", () => {
  const manifest = readManifest();
  const skillPaths = requiredStringArray(manifest.skills, "skills");

  for (const skillPath of skillPaths) {
    assert.equal(path.isAbsolute(skillPath), false, `${skillPath} must be relative`);
    const skillRoot = path.resolve(packageRoot, skillPath);
    assert.equal(
      path.relative(packageRoot, skillRoot).startsWith(".."),
      false,
      `${skillPath} must stay inside the package`
    );
    assert.equal(
      fs.existsSync(path.join(skillRoot, "SKILL.md")),
      true,
      `${skillPath} must contain SKILL.md`
    );
  }

  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    }
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const result = JSON.parse(packed.stdout) as Array<{
    files?: Array<{
      path?: string;
    }>;
  }>;
  const packedFiles = new Set(
    (result[0]?.files ?? [])
      .map((file) => file.path)
      .filter((file): file is string => typeof file === "string")
  );

  for (const skillPath of skillPaths) {
    assert.equal(
      packedFiles.has(path.posix.join(skillPath, "SKILL.md")),
      true,
      `${skillPath}/SKILL.md must be included by npm pack`
    );
  }
  for (const documentationPath of [
    "README.md",
    "docs/quickstart-herdr.md",
    "docs/quickstart-tmux.md"
  ]) {
    assert.equal(
      packedFiles.has(documentationPath),
      true,
      `${documentationPath} must be included for ClawHub rendering and first-run help`
    );
  }
});

test("callback delivery uses the grouped OpenClaw session workflow API", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let capturedInjection: Record<string, unknown> | undefined;
  let response:
    | {
        ok: boolean;
        result?: Record<string, unknown>;
        error?: {
          code?: string;
          message?: string;
        };
      }
    | undefined;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: {
      info() {},
      warn() {}
    },
    session: {
      workflow: {
        async enqueueNextTurnInjection(
          injection: Record<string, unknown>
        ) {
          capturedInjection = injection;
          return {
            enqueued: true,
            id: "injection-1",
            sessionKey: injection.sessionKey
          };
        }
      }
    },
    registerGatewayMethod(
      method: string,
      handler: GatewayMethodHandler
    ) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      conversation: {
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        gateway_session: "agent:main:compat",
        openclaw_session: "agent:main:origin"
      },
      message: {
        id: "message-1",
        conversation_id: "turn-1",
        session_id: "session-1",
        turn_id: "turn-1",
        type: "progress",
        requires_response: false,
        round: 1,
        body: "Compatibility callback",
        metadata: {
          conversation_id: "turn-1",
          session_id: "session-1",
          turn_id: "turn-1"
        }
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });

  assert.equal(response?.ok, true);
  assert.equal(response?.error, undefined);
  assert.equal(response?.result?.enqueued, true);
  assert.equal(response?.result?.delivery_required, false);
  assert.equal(response?.result?.session_key, "agent:main:compat");
  assert.equal(response?.result?.session_id, "session-1");
  assert.equal(response?.result?.turn_id, "turn-1");
  assert.deepEqual(capturedInjection, {
    sessionKey: "agent:main:compat",
    text: [
      "[Agent Knock Knock callback]",
      "Session: session-1",
      "Turn: turn-1",
      "Message type: progress",
      "Requires OpenClaw response: no",
      "Round: 1",
      "Compatibility callback"
    ].join("\n"),
    idempotencyKey: "agent-knock-knock:session-1:turn-1:message-1",
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      message_type: "progress",
      state_path: undefined,
      log_path: undefined
    }
  });

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2"
      },
      message: {
        id: "message-done",
        conversation_id: "turn-2",
        session_id: "session-1",
        turn_id: "turn-2",
        type: "done",
        requires_response: false,
        round: 1,
        body: "All focused tests passed"
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });
  const doneText = String(capturedInjection?.text ?? "");
  const doneResult = (
    response as { result?: Record<string, unknown> } | undefined
  )?.result;
  assert.equal(doneResult?.session_id, "session-1");
  assert.equal(doneResult?.turn_id, "turn-2");
  assert.equal(doneResult?.delivery_required, true);
  assert.match(doneText, /Session: session-1/u);
  assert.match(doneText, /Turn: turn-2/u);
  assert.match(doneText, /agent_knock_knock_send/u);
  assert.match(doneText, /Session "session-1" remains the context label/u);
  assert.match(doneText, /exact `available_actions\.send`/u);
  assert.match(doneText, /Do not assume the returned Session is directly sendable/u);
  assert.match(doneText, /agent_knock_knock_status/u);
  assert.match(doneText, /turn_id: "turn-2"/u);
  assert.doesNotMatch(doneText, /follow_up/u);
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:session-1:turn-2:message-done"
  );
  const chatSend = isRecord(doneResult?.chat_send)
    ? doneResult.chat_send
    : undefined;
  assert.equal(
    chatSend?.idempotencyKey,
    "agent-knock-knock-callback:session-1:turn-2:message-done"
  );

  response = undefined;
  await callbackHandler?.({
    params: {
      sessionKey: "agent:main:compat",
      conversation: {
        conversation_id: "legacy-callback-3"
      },
      message: {
        id: "message-legacy",
        conversation_id: "legacy-callback-3",
        type: "done",
        requires_response: false,
        round: 1,
        body: "Legacy callback identity"
      }
    },
    respond(ok, result, error) {
      response = {
        ok,
        ...(isRecord(result) ? { result } : {}),
        ...(error ? { error } : {})
      };
    }
  });
  const legacyResponse = response as
    | { ok: boolean; result?: Record<string, unknown> }
    | undefined;
  assert.equal(legacyResponse?.ok, true);
  assert.equal(legacyResponse?.result?.conversation_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.session_id, "legacy-callback-3");
  assert.equal(legacyResponse?.result?.turn_id, "legacy-callback-3");
  assert.equal(
    capturedInjection?.idempotencyKey,
    "agent-knock-knock:legacy-callback-3:message-legacy"
  );
  assert.equal(
    (legacyResponse?.result?.chat_send as Record<string, unknown> | undefined)
      ?.idempotencyKey,
    "agent-knock-knock-callback:legacy-callback-3:message-legacy"
  );
});

test("callback rejects conflicting identities before injection or dedupe", async () => {
  let callbackHandler: GatewayMethodHandler | undefined;
  let injectionCalls = 0;

  (
    plugin as unknown as {
      register(api: Record<string, any>): void;
    }
  ).register({
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection() {
          injectionCalls += 1;
          return { enqueued: true };
        }
      }
    },
    registerGatewayMethod(method: string, handler: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") {
        callbackHandler = handler;
      }
    },
    registerService() {},
    registerCommand() {},
    registerTool() {}
  });

  assert.equal(typeof callbackHandler, "function");
  const validParams = () => ({
    sessionKey: "agent:main:identity-check",
    conversation_id: "turn-safe",
    session_id: "session-safe",
    turn_id: "turn-safe",
    conversation: {
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      openclaw_session: "agent:main:identity-check"
    },
    message: {
      id: "message-safe",
      conversation_id: "turn-safe",
      session_id: "session-safe",
      turn_id: "turn-safe",
      type: "done",
      requires_response: false,
      round: 1,
      body: "Identity-safe callback",
      metadata: {
        conversation_id: "turn-safe",
        session_id: "session-safe",
        turn_id: "turn-safe",
        openclaw_session: "agent:main:identity-check"
      }
    }
  });
  const cases: Array<{
    name: string;
    mutate(params: ReturnType<typeof validParams>): void;
    error: RegExp;
  }> = [
    {
      name: "conflicting top-level session",
      mutate(params) {
        params.session_id = "session-other";
      },
      error: /session_id mismatch/u
    },
    {
      name: "conflicting metadata turn",
      mutate(params) {
        params.message.metadata.turn_id = "turn-other";
      },
      error: /turn_id mismatch/u
    },
    {
      name: "conflicting message conversation",
      mutate(params) {
        params.message.conversation_id = "turn-other";
      },
      error: /conversation_id mismatch/u
    },
    {
      name: "modern conversation id differs from turn id",
      mutate(params) {
        params.conversation_id = "compat-other";
        params.conversation.conversation_id = "compat-other";
        params.message.conversation_id = "compat-other";
        params.message.metadata.conversation_id = "compat-other";
      },
      error: /conversation_id must equal turn_id/u
    },
    {
      name: "modern identity is missing session id",
      mutate(params) {
        delete (params as any).session_id;
        delete (params.conversation as any).session_id;
        delete (params.message as any).session_id;
        delete (params.message.metadata as any).session_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing turn id",
      mutate(params) {
        delete (params as any).turn_id;
        delete (params.conversation as any).turn_id;
        delete (params.message as any).turn_id;
        delete (params.message.metadata as any).turn_id;
      },
      error: /require both session_id and turn_id/u
    },
    {
      name: "modern identity is missing the conversation alias",
      mutate(params) {
        delete (params as any).conversation_id;
        delete (params.conversation as any).conversation_id;
        delete (params.message as any).conversation_id;
        delete (params.message.metadata as any).conversation_id;
      },
      error: /require conversation_id/u
    },
    {
      name: "callback has no identity",
      mutate(params) {
        for (const field of ["conversation_id", "session_id", "turn_id"]) {
          delete (params as any)[field];
          delete (params.conversation as any)[field];
          delete (params.message as any)[field];
          delete (params.message.metadata as any)[field];
        }
      },
      error: /callback identity requires/u
    },
    {
      name: "OpenClaw session targets conflict",
      mutate(params) {
        params.conversation.openclaw_session = "agent:other:session";
      },
      error: /session mismatch/u
    },
    {
      name: "OpenClaw identity sources conflict",
      mutate(params) {
        params.message.metadata.openclaw_session = "agent:other:session";
      },
      error: /OpenClaw session mismatch/u
    },
    {
      name: "callback message id is missing",
      mutate(params) {
        delete (params.message as any).id;
      },
      error: /message.id is required/u
    }
  ];

  for (const mismatch of cases) {
    let callbackResponse:
      | {
          ok: boolean;
          error?: { code?: string; message?: string };
        }
      | undefined;
    await callbackHandler?.({
      params: (() => {
        const params = validParams();
        mismatch.mutate(params);
        return params;
      })(),
      respond(ok, _result, error) {
        callbackResponse = { ok, ...(error ? { error } : {}) };
      }
    });
    assert.equal(callbackResponse?.ok, false, mismatch.name);
    assert.equal(
      callbackResponse?.error?.code,
      "AGENT_KNOCK_KNOCK_CALLBACK_FAILED",
      mismatch.name
    );
    assert.match(callbackResponse?.error?.message ?? "", mismatch.error, mismatch.name);
    assert.equal(injectionCalls, 0, mismatch.name);
  }
});

test("callback auto approval keeps its rule workspace boundary without global workspace config", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-autoapprove-workspace-"));
  const allowedWorkspace = path.join(tempDir, "allowed");
  const outsideWorkspace = path.join(tempDir, "outside");
  const fakeCli = path.join(tempDir, "approve.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const statePath = path.join(tempDir, "state.json");
  const policy = {
    enabled: true,
    rules: [{
      id: "allowed-status",
      agents: ["codex"],
      workspaces: [allowedWorkspace],
      commands: [["git", "status"]]
    }]
  };
  let callbackHandler: GatewayMethodHandler | undefined;
  const injections: Record<string, unknown>[] = [];

  try {
    fs.mkdirSync(allowedWorkspace, { recursive: true });
    fs.mkdirSync(outsideWorkspace, { recursive: true });
    fs.writeFileSync(
      fakeCli,
      [
        `require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        `process.stdout.write(${JSON.stringify(JSON.stringify({
          approved: true,
          policy_rule_id: "allowed-status",
          monitor_pid: 71
        }))});`
      ].join("\n"),
      "utf8"
    );

    (
      createOpenClawPluginForTest(fakeCli) as unknown as {
        register(api: Record<string, any>): void;
      }
    ).register({
      pluginConfig: {
        autoApprove: policy
      },
      logger: {
        info() {},
        warn() {}
      },
      session: {
        workflow: {
          async enqueueNextTurnInjection(
            injection: Record<string, unknown>
          ) {
            injections.push(injection);
            return {
              enqueued: true,
              id: `injection-${injections.length}`,
              sessionKey: injection.sessionKey
            };
          }
        }
      },
      registerGatewayMethod(
        method: string,
        handler: GatewayMethodHandler
      ) {
        if (method === "agent-knock-knock.callback") {
          callbackHandler = handler;
        }
      },
      registerService() {},
      registerCommand() {},
      registerTool() {}
    });

    assert.equal(typeof callbackHandler, "function");
    const invokeApprovalCallback = async (
      messageId: string,
      cwd: string,
      options: {
        legacy?: boolean;
        splitFingerprint?: boolean;
      } = {}
    ) => {
      const turnId = "turn-autoapprove-workspace";
      const sessionId = "session-autoapprove-workspace";
      const approvalFingerprint = createHash("sha256")
        .update(messageId)
        .digest("hex");
      let callbackResponse:
        | {
            ok: boolean;
            result?: Record<string, any>;
            error?: { code?: string; message?: string };
          }
        | undefined;
      const callbackConversation: Record<string, unknown> = {
        conversation_id: turnId,
        session_id: sessionId,
        turn_id: turnId,
        openclaw_session: "agent:test:autoapprove",
        state_path: statePath
      };
      const callbackMessage: Record<string, any> = {
        id: messageId,
        conversation_id: turnId,
        session_id: sessionId,
        turn_id: turnId,
        type: "question",
        requires_response: true,
        body: "Codex needs approval",
        metadata: {
          source: "terminal_bridge",
          reason: "approval_required",
          approval_candidate: {
            agent: "codex",
            kind: "run_command",
            command: "git status",
            cwd,
            fingerprint: approvalFingerprint,
            terminal_target: "codex-work:0.0"
          },
          approval_fingerprint: approvalFingerprint,
          terminal_status: {
            approval_state: {
              fingerprint: options.splitFingerprint
                ? "0".repeat(64)
                : approvalFingerprint
            }
          }
        }
      };
      if (options.legacy) {
        delete callbackConversation.session_id;
        delete callbackConversation.turn_id;
        delete callbackMessage.session_id;
        delete callbackMessage.turn_id;
      }
      await callbackHandler?.({
        params: {
          sessionKey: "agent:test:autoapprove",
          statePath,
          conversation: callbackConversation,
          message: callbackMessage
        },
        respond(ok, result, error) {
          callbackResponse = {
            ok,
            ...(isRecord(result) ? { result } : {}),
            ...(error ? { error } : {})
          };
        }
      });
      assert.notEqual(callbackResponse, undefined);
      return callbackResponse!;
    };

    const approved = await invokeApprovalCallback(
      "approval-allowed",
      allowedWorkspace
    );
    assert.equal(approved.ok, true);
    assert.equal(approved.result?.auto_approved, true);
    assert.equal(approved.result?.enqueued, false);
    assert.equal(injections.length, 0);

    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.[0], "approve");
    assert.equal(calls[0]?.includes("--workspace"), false);
    assert.deepEqual(
      calls[0]?.slice(-10),
      [
        "--expected-callback-conversation-id",
        "turn-autoapprove-workspace",
        "--expected-callback-session-id",
        "session-autoapprove-workspace",
        "--expected-callback-turn-id",
        "turn-autoapprove-workspace",
        "--expected-callback-message-id",
        "approval-allowed",
        "--expected-callback-openclaw-session",
        "agent:test:autoapprove"
      ]
    );
    const policyIndex = calls[0]?.indexOf("--auto-approval-policy-json") ?? -1;
    assert.notEqual(policyIndex, -1);
    assert.deepEqual(
      JSON.parse(calls[0]?.[policyIndex + 1] ?? "{}"),
      policy
    );

    const splitFingerprint = await invokeApprovalCallback(
      "approval-split-fingerprint",
      allowedWorkspace,
      { splitFingerprint: true }
    );
    assert.equal(splitFingerprint.ok, true);
    assert.equal(splitFingerprint.result?.auto_approved, undefined);
    assert.equal(splitFingerprint.result?.enqueued, true);

    const legacy = await invokeApprovalCallback(
      "approval-legacy",
      allowedWorkspace,
      { legacy: true }
    );
    assert.equal(legacy.ok, true);
    assert.equal(legacy.result?.auto_approved, undefined);
    assert.equal(legacy.result?.enqueued, true);

    const outside = await invokeApprovalCallback(
      "approval-outside",
      outsideWorkspace
    );
    assert.equal(outside.ok, true);
    assert.equal(outside.result?.auto_approved, undefined);
    assert.equal(outside.result?.enqueued, true);
    assert.equal(injections.length, 3);
    assert.equal(
      fs.readFileSync(callsPath, "utf8").trim().split("\n").length,
      1,
      "an out-of-rule workspace must not execute the approval CLI"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("/akk doctor leaves the Gateway event loop free for its health check", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-plugin-doctor-"));
  const fakeCli = path.join(tempDir, "doctor.cjs");
  const codexVersion = "0.149.1";
  const codexNativeProfile = "codex-tui-0.149.1";
  let command:
    | { handler?: (context: { args: string; sessionKey: string }) => Promise<any> }
    | undefined;
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify({
      ok: true,
      checks: [{
        command: "codex",
        available: true,
        version: codexVersion,
        native_profile_supported: true,
        native_profile: codexNativeProfile
      }, {
        command: "claude",
        available: true,
        version: "2.1.237",
        native_profile_supported: true,
        native_profile: "claude-code-2.1.237-native-status"
      }],
      capabilities: {
        tmux: { checked: true, status: "ready" }
      },
      openclaw: {
        package_ready: true,
        gateway_ready: true,
        checks: []
      }
    }));
  });

  try {
    fs.writeFileSync(
      fakeCli,
      `const http = require("node:http");
const request = http.get(process.env.AKK_TEST_DOCTOR_URL, (response) => {
  response.pipe(process.stdout);
  response.on("end", () => process.exit(0));
});
request.setTimeout(1000, () => {
  request.destroy();
  process.exit(3);
});
request.on("error", () => process.exit(4));
`,
      "utf8"
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    const previousUrl = process.env.AKK_TEST_DOCTOR_URL;
    process.env.AKK_TEST_DOCTOR_URL =
      `http://127.0.0.1:${(address as { port: number }).port}/health`;

    try {
      (
        createOpenClawPluginForTest(fakeCli) as unknown as {
          register(api: Record<string, any>): void;
        }
      ).register({
        pluginConfig: {},
        logger: {
          info() {},
          warn() {}
        },
        registerGatewayMethod() {},
        registerService() {},
        registerCommand(value: typeof command) {
          command = value;
        },
        registerTool() {}
      });

      assert.equal(typeof command?.handler, "function");
      const result = await command?.handler?.({
        args: "doctor",
        sessionKey: "agent:main:main"
      });
      assert.match(result?.text ?? "", /AKK doctor: ready/u);
      assert.equal(
        (result?.text ?? "").split("\n").includes(
          `Codex: ${codexVersion} (native profile ${codexNativeProfile})`
        ),
        true,
        result?.text
      );
      assert.match(
        result?.text ?? "",
        /Claude Code: 2\.1\.237 \(native profile claude-code-2\.1\.237-native-status\)/u
      );
      assert.notEqual(result?.isError, true);
    } finally {
      if (previousUrl === undefined) {
        delete process.env.AKK_TEST_DOCTOR_URL;
      } else {
        process.env.AKK_TEST_DOCTOR_URL = previousUrl;
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

function requiredName(value: unknown, label: string): string {
  assert.equal(typeof value, "string", `${label} must have a name`);
  assert.notEqual(value, "", `${label} name must not be empty`);
  return value as string;
}

function readSupervisorCalls(
  callsPath: string
): Array<{ phase: string; args: string[] }> {
  if (!fs.existsSync(callsPath)) {
    return [];
  }
  return fs.readFileSync(callsPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function optionAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredStringArray(value: unknown, label: string): string[] {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
  assert.notEqual((value as unknown[]).length, 0, `${label} must not be empty`);
  for (const item of value as unknown[]) {
    assert.equal(typeof item, "string", `${label} entries must be strings`);
    assert.notEqual(item, "", `${label} entries must not be empty`);
  }
  return value as string[];
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
