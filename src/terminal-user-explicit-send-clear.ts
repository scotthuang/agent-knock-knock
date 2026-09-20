import type { ExecutorKind } from "./executors.js";
import {
  sameTerminalControlIncarnation,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import {
  TerminalControlInputNotSentError,
  type TerminalControlProvider
} from
  "./terminal-control-provider.js";

export const CLAUDE_DRAFT_REPLACEMENT_SENTINEL =
  " [AKK replacing current draft]";
const CLAUDE_STASH_CLEAR_SETTLE_ATTEMPTS = 8;
const CLAUDE_STASH_CLEAR_SETTLE_POLL_MS = 30;

export interface TerminalUserExplicitComposerClearPlan {
  /** Makes Claude's native stash action unambiguously clear, never restore. */
  readonly beforeClearText?: string;
  readonly keys: readonly string[];
}

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

/** Native Composer replacement plan for one user-explicit Send. */
export function terminalUserExplicitComposerClearPlan(
  agent: ExecutorKind
): TerminalUserExplicitComposerClearPlan {
  if (agent === "codex") return { keys: ["C-u"] };
  return {
    beforeClearText: CLAUDE_DRAFT_REPLACEMENT_SENTINEL,
    keys: ["C-s"]
  };
}

/** Execute the sole native clear transaction and classify its retry boundary. */
export async function dispatchTerminalUserExplicitComposerClear(input: {
  readonly agent: ExecutorKind;
  readonly terminalControl: TerminalControlRef;
  readonly provider: TerminalControlProvider;
  readonly verifyIdentity: () => Promise<TerminalControlRef>;
  readonly terminalInputOwnerBlocked: (
    terminalControl: TerminalControlRef
  ) => boolean;
  readonly verifyClaudeComposerCleared: () => Promise<TerminalControlRef>;
  readonly sleep: (milliseconds: number) => Promise<void>;
}): Promise<TerminalControlRef> {
  const plan = terminalUserExplicitComposerClearPlan(input.agent);
  let endpoint;
  try {
    endpoint = input.provider.endpoint(input.terminalControl);
  } catch (error) {
    throw new TerminalUserExplicitClearNotStartedError(
      error instanceof Error ? error.message : String(error),
      { cause: error }
    );
  }
  let preliminaryTextInjected = false;
  if (plan.beforeClearText !== undefined) {
    try {
      await input.provider.sendText(endpoint, plan.beforeClearText);
      preliminaryTextInjected = true;
      const verified = await input.verifyIdentity();
      if (!sameTerminalControlIncarnation(input.terminalControl, verified)) {
        throw new Error("terminal identity changed during Claude draft replacement");
      }
      if (input.terminalInputOwnerBlocked(verified)) {
        throw new Error(
          "terminal foreground changed to an editor or viewer during Claude draft replacement"
        );
      }
    } catch (error) {
      if (error instanceof TerminalControlInputNotSentError &&
        !preliminaryTextInjected) {
        throw new TerminalUserExplicitClearNotStartedError(error.message, {
          cause: error
        });
      }
      throw new TerminalUserExplicitClearUncertainError(
        "Claude draft-clear preparation is uncertain",
        { cause: error }
      );
    }
  }
  try {
    await input.provider.sendKeys(endpoint, plan.keys);
  } catch (error) {
    if (error instanceof TerminalControlInputNotSentError &&
      !preliminaryTextInjected) {
      throw new TerminalUserExplicitClearNotStartedError(error.message, {
        cause: error
      });
    }
    throw new TerminalUserExplicitClearUncertainError(
      "draft-clear outcome is uncertain",
      { cause: error }
    );
  }
  if (input.agent === "claude") {
    let lastError: unknown;
    try {
      for (let attempt = 0;
        attempt < CLAUDE_STASH_CLEAR_SETTLE_ATTEMPTS;
        attempt += 1) {
        try {
          return await input.verifyClaudeComposerCleared();
        } catch (error) {
          lastError = error;
        }
        if (attempt + 1 < CLAUDE_STASH_CLEAR_SETTLE_ATTEMPTS) {
          await input.sleep(CLAUDE_STASH_CLEAR_SETTLE_POLL_MS);
        }
      }
      throw lastError;
    } catch (error) {
      throw new TerminalUserExplicitClearUncertainError(
        "Claude native stash-clear postcondition is unproven",
        { cause: error }
      );
    }
  }
  return input.terminalControl;
}
