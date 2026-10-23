import { ClaudeNativeError } from "./claude-native-identity.js";

/** An explicit operator assertion about the sender, never inferred from the receiver. */
export type ClaudeNativeSenderPermissionClass = "prompting" | "bypass";

export function parseClaudeNativeSenderPermissionClass(value: unknown): ClaudeNativeSenderPermissionClass | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized === "prompting" || normalized === "bypass") return normalized;
  }
  throw new ClaudeNativeError("invalid_sender_permission_class",
    "AKK_NATIVE_CLAUDE_SENDER_PERMISSION_CLASS must be prompting or bypass when explicitly configured");
}
