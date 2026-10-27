import type { ExecutorKind } from "./executors.js";
import { sameTerminalControlIncarnation, type TerminalControlRef } from "./terminal-control-ref.js";
import { TerminalControlInputNotSentError, type TerminalControlProvider } from "./terminal-control-provider.js";

export class TerminalUserExplicitClearNotStartedError extends Error {}
export class TerminalUserExplicitClearUncertainError extends Error {
  readonly code = "AKK_TERMINAL_USER_EXPLICIT_CLEAR_UNCERTAIN";
  readonly stage = "composer_clear_uncertain";
  readonly doNotRetry = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "TerminalUserExplicitClearUncertainError";
  }
}

interface ClearInput {
  readonly agent: ExecutorKind;
  readonly terminalControl: TerminalControlRef;
  readonly provider: TerminalControlProvider;
  readonly verifyIdentity: () => Promise<TerminalControlRef>;
  readonly terminalInputOwnerBlocked: (terminalControl: TerminalControlRef) => boolean;
  readonly verifyClaudeComposerCleared: (requireEmptyStash?: boolean) => Promise<TerminalControlRef>;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** Codex replaces its draft. Claude only probes an already empty input; it never writes or erases a marker. */
export async function dispatchTerminalUserExplicitComposerClear(input: ClearInput): Promise<TerminalControlRef> {
  let endpoint: ReturnType<TerminalControlProvider["endpoint"]>;
  try {
    endpoint = input.provider.endpoint(input.terminalControl);
    if (input.agent === "claude") {
      await verifyClearIdentity(input);
      await input.verifyClaudeComposerCleared(true);
    }
  } catch (error) {
    throw new TerminalUserExplicitClearNotStartedError(errorMessage(error), { cause: error });
  }
  try { await input.provider.sendKeys(endpoint, input.agent === "codex" ? ["C-u"] : ["C-s"]); }
  catch (error) {
    if (error instanceof TerminalControlInputNotSentError) {
      throw new TerminalUserExplicitClearNotStartedError(error.message, { cause: error });
    }
    throw new TerminalUserExplicitClearUncertainError(input.agent === "claude"
      ? claudeProbeFailure(error) : "draft-clear outcome is uncertain", { cause: error });
  }
  if (input.agent === "codex") return input.terminalControl;
  // On an empty native Composer, C-s can only restore a hidden stash or do
  // nothing. Never repeat it: a second press could stash restored user data.
  // Wait for native rendering, but never interpret these delays as a native ACK.
  try {
    await input.sleep(100);
    await verifyClearIdentity(input);
    await input.verifyClaudeComposerCleared(true);
    await input.sleep(50);
    await verifyClearIdentity(input);
    return await input.verifyClaudeComposerCleared(true);
  } catch (error) {
    throw new TerminalUserExplicitClearUncertainError(claudeProbeFailure(error), { cause: error });
  }
}

async function verifyClearIdentity(input: ClearInput): Promise<void> {
  const verified = await input.verifyIdentity();
  if (!sameTerminalControlIncarnation(input.terminalControl, verified)) {
    throw new Error("terminal identity changed during Claude draft preflight");
  }
  if (input.terminalInputOwnerBlocked(verified)) {
    throw new Error("terminal foreground changed to an editor or viewer during Claude draft preflight");
  }
}

function claudeProbeFailure(error: unknown): string {
  return "Claude draft preflight could not be completed; task text was not sent. " +
    "One Ctrl+S restore probe may have restored a hidden draft; AKK did not write a cleanup marker or erase text. " +
    "Do not retry automatically or press Ctrl+S again blindly. Inspect the window, save any restored text, " +
    "and leave the input box empty with no stashed draft before refreshing List and retrying. " + errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
