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
} from "../../src/openclaw-plugin.js";
import * as openclawPluginRuntime from "../../src/openclaw-plugin.js";
import {
  approveParameters,
  closeParameters,
  identifyAndSendParameters,
  identifyForegroundParameters,
  modelOptionsParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  repairModelControlParameters,
  respondInteractionParameters,
  resumeThreadParameters,
  sendParameters,
  setModelParameters,
  unwatchParameters,
  watchParameters
} from "../../src/openclaw-plugin-schemas.js";
import { registerOpenClawCallbackGateway } from
  "../../src/openclaw-plugin-callback-adapter.js";
import {
  bindOpenClawRelayPath,
  registerOpenClawCommands
} from "../../src/openclaw-plugin-command-adapter.js";
import { isAkkModelFacingPrivateAuthorityField } from
  "../../src/openclaw-plugin-helpers.js";
import {
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS,
  consumeOpenClawPrivateAuthorityOffer,
  invalidateOpenClawInteractionAuthorityOffersForSubject,
  openClawApprovalAuthorityOfferKey,
  openClawInteractionAuthorityOfferKey,
  openClawManagedTurnInteractionAuthorityOfferKey,
  openClawTerminalWatchInteractionAuthorityOfferKey,
  peekOpenClawPrivateAuthorityOffer,
  rememberOpenClawPrivateAuthorityOffer
} from "../../src/openclaw-private-authority-offers.js";
import { createConversation, createMessage } from "../../src/protocol.js";

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


const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const manifestPath = path.join(packageRoot, "openclaw.plugin.json");
const skillSource = path.join(
  packageRoot,
  "templates",
  "openclaw-skills",
  "agent-knock-knock",
  "SKILL.md"
);

function readManifest(): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
}

type InteractionToolContext = {
  readonly sessionKey?: string;
  readonly sessionId?: string;
};

type InteractionToolFactory = (
  context: InteractionToolContext
) => ToolDefinition;

function requiredInteractionTool(
  factories: Map<string, InteractionToolFactory>,
  name: string,
  context: InteractionToolContext
): ToolDefinition {
  const factory = factories.get(name);
  assert.ok(factory, `${name} must be registered`);
  const tool = factory(context);
  assert.equal(typeof tool.execute, "function");
  return tool;
}

function interactionOptionValue(
  argv: readonly string[],
  option: string
): string | undefined {
  const index = argv.indexOf(option);
  return index === -1 ? undefined : argv[index + 1];
}

function requiredInteractionOptionValue(
  argv: readonly string[],
  option: string
): string {
  const value = interactionOptionValue(argv, option);
  if (value === undefined) {
    throw new Error(`${option} must have a value`);
  }
  return value;
}

function interactionRelayFixture(input: {
  readonly callsPath: string;
  readonly turnId: string;
  readonly interactionId: string;
  readonly questionId: string;
  readonly optionId: string;
  readonly fingerprint: string;
  readonly expiresAt: string;
}): string {
  const interactionState = {
    schema: "agent-knock-knock/terminal-interaction",
    version: 1,
    interaction_id: input.interactionId,
    turn_id: input.turnId,
    agent: "claude",
    kind: "questionnaire",
    state: "pending",
    step: { index: 1, total: 1 },
    questions: [{
      question_id: input.questionId,
      prompt: "Choose the safe option",
      required: true,
      response_kind: "single_select",
      options: [
        { option_id: input.optionId, label: "Safe" },
        { option_id: "option_manual", label: "Manual" }
      ]
    }],
    expires_at: input.expiresAt,
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: false,
      multi_select: false
    }
  };
  const subjectInteractionState = {
    ...interactionState,
    version: 2,
    subject: {
      kind: "managed_turn",
      turn_id: input.turnId,
      message_id: "message_interaction_1"
    },
    surface_id: "surface_managed_interaction_1",
    prompt_fingerprint: input.fingerprint,
    response_authority: "executable"
  };
  return `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(input.callsPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "status") {
  process.stdout.write(JSON.stringify({
    conversation_id: ${JSON.stringify(input.turnId)},
    session_id: "session_interaction_1",
    turn_id: ${JSON.stringify(input.turnId)},
    terminal_status: {
      interaction_state: argv.includes("--trace")
        ? ${JSON.stringify(subjectInteractionState)}
        : ${JSON.stringify(interactionState)},
      interaction_prompt_fingerprint: ${JSON.stringify(input.fingerprint)},
      interaction_authority: { private: true },
      owner_session: "private-owner",
      process_incarnation: "private-process"
    }
  }));
} else if (argv[0] === "respond-interaction") {
  process.stdout.write(JSON.stringify({
    responded: true,
    conversation_id: ${JSON.stringify(input.turnId)},
    session_id: "session_interaction_1",
    turn_id: ${JSON.stringify(input.turnId)},
    interaction_prompt_fingerprint: ${JSON.stringify(input.fingerprint)},
    expected_interaction_fingerprint: ${JSON.stringify(input.fingerprint)}
  }));
} else {
  process.stderr.write("unexpected command");
  process.exitCode = 2;
}
`;
}

function interactionRefreshRelayFixture(input: {
  readonly callsPath: string;
  readonly turnId: string;
  readonly oldInteractionId: string;
  readonly newInteractionId: string;
  readonly oldQuestionId: string;
  readonly newQuestionId: string;
  readonly oldOptionId: string;
  readonly newOptionId: string;
}): string {
  const fingerprint = (value: string) => value.repeat(64);
  const projection = (
    interactionId: string,
    questionId: string,
    optionId: string,
    promptFingerprint: string,
    responseAuthority: "executable" | "notify_only",
    state: "pending" | "manual_required"
  ) => ({
    schema: "agent-knock-knock/terminal-interaction",
    version: 2,
    interaction_id: interactionId,
    subject: {
      kind: "managed_turn",
      turn_id: input.turnId,
      message_id: "message_interaction_refresh"
    },
    turn_id: input.turnId,
    agent: "codex",
    kind: "questionnaire",
    state,
    step: { index: 1, total: 1 },
    questions: [{
      question_id: questionId,
      prompt: "Choose the current option",
      required: true,
      response_kind: "single_select",
      options: [
        { option_id: optionId, label: "Current" },
        { option_id: `${optionId}_other`, label: "Other" }
      ]
    }],
    expires_at: "2030-09-08T00:00:00.000Z",
    surface_id: `surface_${interactionId}`,
    prompt_fingerprint: promptFingerprint,
    response_authority: responseAuthority,
    capabilities: {
      respond: responseAuthority === "executable",
      batch_response: false,
      free_text: false,
      multi_select: false
    }
  });
  const oldFingerprint = fingerprint("a");
  const manualFingerprint = fingerprint("b");
  const newFingerprint = fingerprint("c");
  const oldStatus = {
    interaction_state: projection(
      input.oldInteractionId,
      input.oldQuestionId,
      input.oldOptionId,
      oldFingerprint,
      "executable",
      "pending"
    ),
    interaction_prompt_fingerprint: oldFingerprint
  };
  const absentStatus = { activity_state: "idle" };
  const manualStatus = {
    interaction_state: projection(
      input.oldInteractionId,
      input.oldQuestionId,
      input.oldOptionId,
      manualFingerprint,
      "notify_only",
      "manual_required"
    ),
    interaction_prompt_fingerprint: manualFingerprint
  };
  const changedStatus = {
    interaction_state: projection(
      input.newInteractionId,
      input.newQuestionId,
      input.newOptionId,
      newFingerprint,
      "executable",
      "pending"
    ),
    interaction_prompt_fingerprint: newFingerprint
  };
  const statuses = [
    oldStatus,
    absentStatus,
    oldStatus,
    manualStatus,
    oldStatus,
    changedStatus
  ];
  return `
const fs = require("node:fs");
const argv = process.argv.slice(2);
const callsPath = ${JSON.stringify(input.callsPath)};
const previousCalls = fs.existsSync(callsPath)
  ? fs.readFileSync(callsPath, "utf8").split(/\\r?\\n/u).filter(Boolean).map(JSON.parse)
  : [];
const statusIndex = previousCalls.filter((call) => call[0] === "status").length;
fs.appendFileSync(callsPath, JSON.stringify(argv) + "\\n");
if (argv[0] === "status") {
  const statuses = ${JSON.stringify(statuses)};
  const terminalStatus = statuses[statusIndex] ?? statuses.at(-1);
  process.stdout.write(JSON.stringify({
    conversation_id: ${JSON.stringify(input.turnId)},
    session_id: "session_interaction_refresh",
    turn_id: ${JSON.stringify(input.turnId)},
    terminal_status: terminalStatus
  }));
} else if (argv[0] === "respond-interaction") {
  process.stdout.write(JSON.stringify({
    responded: true,
    conversation_id: ${JSON.stringify(input.turnId)},
    session_id: "session_interaction_refresh",
    turn_id: ${JSON.stringify(input.turnId)}
  }));
} else {
  process.stderr.write("unexpected command");
  process.exitCode = 2;
}
`;
}

function watchInteractionRelayFixture(input: {
  readonly callsPath: string;
  readonly watchId: string;
  readonly interactionId: string;
  readonly questionId: string;
  readonly optionId: string;
  readonly fingerprint: string;
  readonly anchorFingerprint: string;
  readonly expiresAt: string;
}): string {
  const interactionState = {
    schema: "agent-knock-knock/terminal-interaction",
    version: 2,
    interaction_id: input.interactionId,
    subject: {
      kind: "terminal_watch",
      watch_id: input.watchId,
      anchor_fingerprint: input.anchorFingerprint
    },
    agent: "codex",
    kind: "questionnaire",
    state: "pending",
    step: { index: 1, total: 2 },
    questions: [{
      question_id: input.questionId,
      prompt: "Choose the safe Watch option",
      required: true,
      response_kind: "single_select",
      options: [
        { option_id: input.optionId, label: "Safe" },
        { option_id: "option_watch_manual", label: "Manual" }
      ]
    }],
    expires_at: input.expiresAt,
    surface_id: "surface_watch_interaction_1",
    prompt_fingerprint: input.fingerprint,
    response_authority: "executable",
    capabilities: {
      respond: true,
      batch_response: false,
      free_text: false,
      multi_select: false
    }
  };
  return `
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(input.callsPath)}, JSON.stringify(argv) + "\\n");
if (argv[0] === "watch-status") {
  process.stdout.write(JSON.stringify({
    watch: {
      watch_id: ${JSON.stringify(input.watchId)},
      status: "active",
      interaction_state: ${JSON.stringify(interactionState)},
      interaction_prompt_fingerprint: ${JSON.stringify(input.fingerprint)}
    }
  }));
} else if (argv[0] === "respond-interaction") {
  process.stdout.write(JSON.stringify({
    responded: true,
    watch_id: ${JSON.stringify(input.watchId)},
    interaction_id: ${JSON.stringify(input.interactionId)}
  }));
} else {
  process.stderr.write("unexpected command");
  process.exitCode = 2;
}
`;
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

export {
  test,
  assert,
  createHash,
  spawnSync,
  fs,
  http,
  os,
  path,
  plugin,
  createOpenClawPluginForTest,
  openclawPluginRuntime,
  approveParameters,
  closeParameters,
  identifyAndSendParameters,
  identifyForegroundParameters,
  modelOptionsParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  repairModelControlParameters,
  respondInteractionParameters,
  resumeThreadParameters,
  sendParameters,
  setModelParameters,
  unwatchParameters,
  watchParameters,
  registerOpenClawCallbackGateway,
  bindOpenClawRelayPath,
  registerOpenClawCommands,
  isAkkModelFacingPrivateAuthorityField,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT,
  OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS,
  consumeOpenClawPrivateAuthorityOffer,
  invalidateOpenClawInteractionAuthorityOffersForSubject,
  openClawApprovalAuthorityOfferKey,
  openClawInteractionAuthorityOfferKey,
  openClawManagedTurnInteractionAuthorityOfferKey,
  openClawTerminalWatchInteractionAuthorityOfferKey,
  peekOpenClawPrivateAuthorityOffer,
  rememberOpenClawPrivateAuthorityOffer,
  createConversation,
  createMessage,
  assertNoModelOpaqueAuthority,
  assertModelToolResultHasNoOpaqueAuthority,
  packageRoot,
  manifestPath,
  skillSource,
  readManifest,
  requiredInteractionTool,
  interactionOptionValue,
  requiredInteractionOptionValue,
  interactionRelayFixture,
  interactionRefreshRelayFixture,
  watchInteractionRelayFixture,
  requiredName,
  readSupervisorCalls,
  optionAfter,
  requiredStringArray,
  sorted,
  isRecord
};
export type {
  ContractTestApi,
  GatewayMethodHandler,
  InteractionToolContext,
  InteractionToolFactory,
  Manifest,
  ToolDefinition,
  ToolFactory
};
