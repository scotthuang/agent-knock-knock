import { randomUUID } from "node:crypto";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type {
  JsonSchemaType,
  JsonSchemaValidator
} from "@modelcontextprotocol/sdk/validation";

import type {
  HostBridgeToolRegistry,
  HostBridgeToolResult
} from "./host-bridge-tools.js";

export const HOST_BRIDGE_MCP_SERVER_NAME = "agent-knock-knock-host-bridge";

const MAX_MODEL_ERROR_LENGTH = 1_024;
const activeCallsByServer = new WeakMap<Server, Set<Promise<CallToolResult>>>();

interface CompiledHostBridgeTool {
  readonly validate: JsonSchemaValidator<Readonly<Record<string, unknown>>>;
}

export interface CreateHostBridgeMcpServerOptions {
  readonly registry: HostBridgeToolRegistry;
  readonly version: string;
  /** Test seam; production callers receive a fresh identity per Bridge. */
  readonly instanceId?: string;
}

/**
 * Expose the established AKK semantic tool registry over MCP.
 *
 * The low-level SDK server intentionally does not infer validation from the
 * schemas returned by tools/list, so every schema is compiled once here and
 * enforced again before any semantic tool can execute.
 */
export function createHostBridgeMcpServer(
  options: CreateHostBridgeMcpServerOptions
): Server {
  const version = requiredString(options.version, "version");
  const instanceId = requiredString(
    options.instanceId ?? randomUUID(),
    "instanceId"
  );
  const descriptors = [...options.registry.list()];
  const validatorProvider = new AjvJsonSchemaValidator();
  const compiledByName = new Map<string, CompiledHostBridgeTool>();

  for (const descriptor of descriptors) {
    if (compiledByName.has(descriptor.name)) {
      throw new Error(`duplicate host bridge MCP tool ${descriptor.name}`);
    }
    const validate = validatorProvider.getValidator<
      Readonly<Record<string, unknown>>
    >(descriptor.inputSchema as unknown as JsonSchemaType);
    compiledByName.set(descriptor.name, { validate });
  }

  const advertisedTools = descriptors.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema
  }));

  const server = new Server(
    { name: HOST_BRIDGE_MCP_SERVER_NAME, version },
    { capabilities: { tools: {} } }
  );
  const activeCalls = new Set<Promise<CallToolResult>>();
  activeCallsByServer.set(server, activeCalls);

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    ({ tools: advertisedTools }) as ListToolsResult
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const compiled = compiledByName.get(name);
    if (!compiled) {
      throw invalidParams(`Unknown host bridge tool: ${name}`);
    }
    if (
      request.params.task !== undefined ||
      hasLegacyTaskRequest(request.params._meta)
    ) {
      throw invalidParams(`Task execution is not supported for tool: ${name}`);
    }

    const validation = compiled.validate(request.params.arguments ?? {});
    if (!validation.valid) {
      throw invalidParams(
        `Invalid arguments for ${name}: ${validation.errorMessage}`
      );
    }

    const execution = executeToolCall(
      options.registry,
      name,
      hostBridgeToolCallId(instanceId, extra.requestId),
      validation.data
    );
    activeCalls.add(execution);
    try {
      return await execution;
    } finally {
      activeCalls.delete(execution);
    }
  });

  return server;
}

export function getHostBridgeMcpActiveCallCount(server: Server): number {
  return activeCallsByServer.get(server)?.size ?? 0;
}

/** Preserve both JSON-RPC request-id type and value inside one Bridge. */
export function hostBridgeToolCallId(
  instanceId: string,
  requestId: string | number
): string {
  if (
    (typeof requestId !== "string" && typeof requestId !== "number") ||
    (typeof requestId === "number" && !Number.isFinite(requestId))
  ) {
    throw new Error("MCP request id must be a finite number or string");
  }
  return `host-bridge:${JSON.stringify([instanceId, requestId])}`;
}

/** Wait until every already accepted MCP tool call has produced a result. */
export async function drainHostBridgeMcpCalls(server: Server): Promise<void> {
  const activeCalls = activeCallsByServer.get(server);
  while (activeCalls && activeCalls.size > 0) {
    await Promise.allSettled([...activeCalls]);
  }
}

async function executeToolCall(
  registry: HostBridgeToolRegistry,
  name: string,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>
): Promise<CallToolResult> {
  try {
    const result = await registry.execute(name, toolCallId, args);
    return mapToolResult(result);
  } catch (error) {
    return {
      content: [{ type: "text", text: modelFacingErrorMessage(error) }],
      isError: true
    };
  }
}

function mapToolResult(result: HostBridgeToolResult): CallToolResult {
  const mapped: CallToolResult = {
    content: [...(result.content ?? [])] as CallToolResult["content"]
  };
  if (isRecord(result.details)) {
    mapped.structuredContent = result.details;
  }
  if (typeof result.isError === "boolean") {
    mapped.isError = result.isError;
  }
  return mapped;
}

function invalidParams(message: string): McpError {
  return new McpError(ErrorCode.InvalidParams, boundedSingleLine(message));
}

function modelFacingErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Tool execution failed.";
  return boundedSingleLine(message) || "Tool execution failed.";
}

function boundedSingleLine(value: string): string {
  const sanitized = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (sanitized.length <= MAX_MODEL_ERROR_LENGTH) {
    return sanitized;
  }

  let prefix = "";
  for (const character of sanitized) {
    if (prefix.length + character.length > MAX_MODEL_ERROR_LENGTH - 3) {
      break;
    }
    prefix += character;
  }
  return `${prefix}...`;
}

function hasLegacyTaskRequest(meta: unknown): boolean {
  return isRecord(meta) && meta.task !== undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
