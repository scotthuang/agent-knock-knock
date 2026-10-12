import { createHash } from "node:crypto";
import { requiredString, pushOptional, numberString } from "./semantic-tool-arguments.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";
import { isRecord } from "./value-guards.js";
import type { SemanticToolCatalogEntry } from "./semantic-tool-catalog.js";
import { semanticToolDescriptions } from "./semantic-tool-descriptions.js";
import { desktopCreateParameters } from "./semantic-tool-schemas.js";
import { runHostAwareCli, withHostBridgeInvocationSignal } from "./semantic-tool-relay.js";
import { modelFacingErrorMessage, toolResult } from "./semantic-tool-presentation.js";

const OPERATION_PATTERN = /^desktop-create:[0-9a-f]{64}$/u;
const CREATION_FIELDS = ["project", "cwd", "title", "request", "agentHardTimeoutMinutes"];

/** Creation identity belongs to a controller invocation, never a project/cwd guess. */
export function desktopCreationOperationId(params: Record<string, unknown>,
  context: { sessionKey?: unknown; sessionId?: unknown }, toolCallId: unknown): string {
  const sessionKey = requiredString(context.sessionKey, "controller session");
  if (Object.hasOwn(params, "operation_id")) {
    const id = requiredString(params.operation_id, "operation_id");
    if (!OPERATION_PATTERN.test(id)) throw new Error("Invalid Desktop creation operation_id");
    return id;
  }
  const callId = requiredString(toolCallId, "stable Desktop creation tool call identity");
  const sessionId = typeof context.sessionId === "string" && context.sessionId.trim() ? context.sessionId : null;
  return "desktop-create:" + createHash("sha256").update(JSON.stringify([
    sessionKey, sessionId, "agent_knock_knock_desktop_create", callId
  ])).digest("hex");
}

export function desktopCreationToolArgs(params: Record<string, unknown>, config: Record<string, unknown>,
  context: { sessionKey?: unknown; sessionId?: unknown }, toolCallId: unknown): string[] {
  if (Object.keys(params).some(key => ![...CREATION_FIELDS, "operation_id"].includes(key))) {
    throw new Error("Desktop creation accepts only project, cwd, title, request and monitor lifetime, or operation_id to continue");
  }
  const resume = Object.hasOwn(params, "operation_id");
  if (resume && CREATION_FIELDS.some(key => Object.hasOwn(params, key))) {
    throw new Error("Continuing Desktop creation accepts only operation_id; its original payload cannot change");
  }
  const args = ["desktop-create", "--operation-id", desktopCreationOperationId(params, context, toolCallId),
    "--openclaw-session", requiredString(context.sessionKey, "controller session")];
  if (resume) args.push("--resume-creation");
  else {
    for (const [key, flag] of [["project", "--project"], ["cwd", "--cwd"], ["title", "--title"], ["request", "--message"]]) {
      if (Object.hasOwn(params, key)) args.push(flag, requiredString(params[key], key));
    }
    if (Object.hasOwn(params, "agentHardTimeoutMinutes") && (typeof params.agentHardTimeoutMinutes !== "number"
      || !Number.isFinite(params.agentHardTimeoutMinutes) || params.agentHardTimeoutMinutes <= 0)) {
      throw new Error("agentHardTimeoutMinutes must be a positive finite number");
    }
    pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));
  }
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", config.codexHome);
  pushOptional(args, "--openclaw-bin", config.openclawBin);
  return args;
}

export function desktopCreationResultIsError(result: unknown): boolean {
  return !isRecord(result) || result.source !== "codex_desktop"
    || !["ready", "opening"].includes(String(result.status))
    || (Object.hasOwn(result, "request_state") && result.request_state !== "accepted");
}

/** Keep Desktop resource creation separate from the terminal lifecycle catalog. */
export function createDesktopCreationSemanticTool(api: object & Record<string, unknown>): SemanticToolCatalogEntry {
  return {
    label: "AKK Desktop Create",
    name: "agent_knock_knock_desktop_create",
    description: semanticToolDescriptions.desktop_create,
    inputSchema: desktopCreateParameters,
    async execute(toolContext, toolCallId, rawParams, signal) {
      return withHostBridgeInvocationSignal(signal, async () => {
        if (!isRecord(rawParams)) throw new Error("Desktop creation parameters must be an object");
        const params = rawParams;
        const args = desktopCreationToolArgs(params, isRecord(api.pluginConfig) ? api.pluginConfig : {}, toolContext, toolCallId);
        const operationId = desktopCreationOperationId(params, toolContext, toolCallId);
        try {
          const result = await runHostAwareCli(api, args, { allowNonzeroJson: true });
          return toolResult(result, { normalizeTurnIdentity: false, forceError: desktopCreationResultIsError(result) });
        } catch (error) {
          // The child may already have persisted a thread or sent the first task.
          // Keep its exact identity even when the relay loses the receipt.
          return toolResult({ source: "codex_desktop", operation_id: operationId, status: "uncertain", created: null,
            error_code: "desktop_creation_receipt_unavailable", reason: modelFacingErrorMessage(error),
            next_action: { tool: "agent_knock_knock_desktop_create", input: { operation_id: operationId } },
            warning: "Continue this exact operation only; do not create a replacement or resend the task." },
          { normalizeTurnIdentity: false, forceError: true });
        }
      });
    }
  };
}
