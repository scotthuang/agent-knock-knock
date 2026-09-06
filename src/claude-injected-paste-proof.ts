import type {
  TerminalScreenInspection,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  sameTerminalControlIncarnation,
  type TerminalControlRef
} from "./terminal-control-ref.js";

const SETTLE_POLL_MS = 30;
const SETTLE_TIMEOUT_MS = 5_000;
const STABLE_CAPTURES = 2;
const CANDIDATE_GRACE_CAPTURES = 8;
// This identifies the closed composer/frame grammar proved by the parser. It
// is deliberately independent of Claude's broader lifecycle version profile.
export const CLAUDE_INJECTED_PASTE_FRAME_PROFILE =
  "claude-code-injected-paste-v1";

export type ClaudeComposerBeforeEnterProof =
  | {
      state: "exact_draft";
      terminalControl: TerminalControlRef;
      digest: string;
    }
  | {
      state: "exact_injected_paste_placeholder";
      terminalControl: TerminalControlRef;
      digest: string;
      pasteId: number;
      newlineCount: number;
      frameProfile: string;
      stableCaptures: number;
    };

export interface ClaudeInjectedPasteCapture {
  state: "exact_injected_paste_placeholder";
  digest: string;
  pasteId: number;
  newlineCount: number;
  frameProfile: string;
}

interface ClaudeComposerCapture {
  terminalControl: TerminalControlRef;
  screen: string;
  inspection: TerminalScreenInspection;
}

export interface ClaudeInjectedPasteProofPorts {
  nowMs(): number;
  sleep(milliseconds: number): Promise<void>;
  capture(
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity | undefined
  ): Promise<ClaudeComposerCapture>;
  verifyIdentity(
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity | undefined
  ): Promise<TerminalControlRef>;
  exactDraft(screen: string, expectedText: string):
    | { digest: string }
    | undefined;
  exactInjectedPastePlaceholder(
    screen: string,
    expectedText: string
  ): ClaudeInjectedPasteCapture | undefined;
}

export function claudeInjectedPasteProofEligible(input: {
  agent: string;
  multiline: boolean;
  composerVerifiedImmediatelyBeforeText: boolean;
  terminalControl: TerminalControlRef;
}): boolean {
  return input.agent === "claude" &&
    input.multiline &&
    input.composerVerifiedImmediatelyBeforeText &&
    input.terminalControl.kind === "tmux";
}

export async function settleClaudeInjectedPasteComposer(input: {
  terminalControl: TerminalControlRef;
  expectedText: string;
  runtime?: TerminalRuntimeIdentity;
  allowWorkingComposer?: boolean;
  ports: ClaudeInjectedPasteProofPorts;
}): Promise<ClaudeComposerBeforeEnterProof> {
  if (
    input.terminalControl.kind !== "tmux" ||
    !/[\r\n]/u.test(input.expectedText)
  ) {
    throw new Error(
      "Claude injected-paste proof requires one multiline tmux delivery"
    );
  }
  const startedAt = input.ports.nowMs();
  let candidate: Extract<
    ClaudeComposerBeforeEnterProof,
    { state: "exact_injected_paste_placeholder" }
  > | undefined;
  let stableCaptures = 0;
  let exactCandidateObserved = false;
  let capturesBeyondDeadline = 0;
  let control: TerminalControlRef = input.terminalControl;

  while (true) {
    const snapshot = await captureClaudePostInjectionComposerProof({
      ...input,
      terminalControl: control,
      injectionTerminalControl: input.terminalControl
    });
    if (snapshot?.state === "exact_draft") {
      return snapshot;
    }
    if (snapshot?.state === "exact_injected_paste_placeholder") {
      exactCandidateObserved = true;
      const sameCandidate = candidate !== undefined &&
        sameClaudePlaceholder(candidate, snapshot);
      stableCaptures = sameCandidate ? stableCaptures + 1 : 1;
      candidate = snapshot;
      control = snapshot.terminalControl;

      if (stableCaptures >= STABLE_CAPTURES) {
        const finalSnapshot =
          await captureClaudePostInjectionComposerProof({
            ...input,
            terminalControl: snapshot.terminalControl,
            injectionTerminalControl: input.terminalControl
          });
        if (
          finalSnapshot?.state ===
            "exact_injected_paste_placeholder" &&
          sameClaudePlaceholder(snapshot, finalSnapshot)
        ) {
          return {
            ...finalSnapshot,
            stableCaptures: stableCaptures + 1
          };
        }
        candidate = finalSnapshot?.state ===
            "exact_injected_paste_placeholder"
          ? finalSnapshot
          : undefined;
        stableCaptures = candidate ? 1 : 0;
        if (candidate) {
          control = candidate.terminalControl;
        }
      }
    } else {
      candidate = undefined;
      stableCaptures = 0;
    }

    if (input.ports.nowMs() - startedAt > SETTLE_TIMEOUT_MS) {
      capturesBeyondDeadline += 1;
      if (
        !exactCandidateObserved ||
        capturesBeyondDeadline > CANDIDATE_GRACE_CAPTURES
      ) {
        throw new Error(
          "Claude Code composer did not become an exact draft or a stable exact_injected_paste_placeholder before the bounded submit deadline"
        );
      }
    }
    await input.ports.sleep(SETTLE_POLL_MS);
  }
}

export async function revalidateClaudeComposerProof(input: {
  proof: ClaudeComposerBeforeEnterProof;
  expectedText: string;
  runtime?: TerminalRuntimeIdentity;
  allowWorkingComposer?: boolean;
  ports: ClaudeInjectedPasteProofPorts;
}): Promise<TerminalControlRef> {
  const finalProof = await captureClaudePostInjectionComposerProof({
    terminalControl: input.proof.terminalControl,
    injectionTerminalControl: input.proof.terminalControl,
    expectedText: input.expectedText,
    runtime: input.runtime,
    allowWorkingComposer: input.allowWorkingComposer,
    ports: input.ports
  });
  if (
    finalProof?.state !== input.proof.state ||
    !sameClaudeComposerProof(input.proof, finalProof)
  ) {
    throw new Error(
      `Claude Code ${input.proof.state} changed before Enter`
    );
  }
  return finalProof.terminalControl;
}

async function captureClaudePostInjectionComposerProof(input: {
  terminalControl: TerminalControlRef;
  injectionTerminalControl: TerminalControlRef;
  expectedText: string;
  runtime?: TerminalRuntimeIdentity;
  allowWorkingComposer?: boolean;
  ports: ClaudeInjectedPasteProofPorts;
}): Promise<ClaudeComposerBeforeEnterProof | undefined> {
  const captured = await input.ports.capture(
    input.terminalControl,
    input.runtime
  );
  if (!sameTerminalControlIncarnation(
    input.injectionTerminalControl,
    captured.terminalControl
  )) {
    throw new Error(
      "terminal control identity changed after Claude text injection"
    );
  }
  if (!composerActivityIsSafe(
    captured.inspection,
    input.allowWorkingComposer === true
  )) {
    throw new Error(
      "Claude Code became busy or blocked while proving its injected paste composer"
    );
  }
  const exactDraft = input.ports.exactDraft(
    captured.screen,
    input.expectedText
  );
  const injectedPlaceholder = exactDraft
    ? undefined
    : input.ports.exactInjectedPastePlaceholder(
        captured.screen,
        input.expectedText
      );
  if (!exactDraft && !injectedPlaceholder) {
    return undefined;
  }
  const verified = await input.ports.verifyIdentity(
    captured.terminalControl,
    input.runtime
  );
  if (!sameTerminalControlIncarnation(captured.terminalControl, verified)) {
    throw new Error(
      "terminal control identity changed after the final Claude composer capture"
    );
  }
  return exactDraft
    ? {
        state: "exact_draft",
        terminalControl: verified,
        digest: exactDraft.digest
      }
    : {
        ...injectedPlaceholder!,
        terminalControl: verified,
        stableCaptures: 1
      };
}

function composerActivityIsSafe(
  inspection: TerminalScreenInspection,
  allowWorkingComposer: boolean
): boolean {
  return !inspection.approval.blocked &&
    (
      inspection.activity.state === "idle" ||
      inspection.activity.state === "unknown" ||
      (allowWorkingComposer && inspection.activity.state === "working")
    );
}

function sameClaudePlaceholder(
  left: Extract<
    ClaudeComposerBeforeEnterProof,
    { state: "exact_injected_paste_placeholder" }
  >,
  right: Extract<
    ClaudeComposerBeforeEnterProof,
    { state: "exact_injected_paste_placeholder" }
  >
): boolean {
  return left.digest === right.digest &&
    left.pasteId === right.pasteId &&
    left.newlineCount === right.newlineCount &&
    left.frameProfile === right.frameProfile &&
    sameTerminalControlIncarnation(
      left.terminalControl,
      right.terminalControl
    );
}

function sameClaudeComposerProof(
  left: ClaudeComposerBeforeEnterProof,
  right: ClaudeComposerBeforeEnterProof
): boolean {
  if (left.state !== right.state) {
    return false;
  }
  if (
    left.digest !== right.digest ||
    !sameTerminalControlIncarnation(
      left.terminalControl,
      right.terminalControl
    )
  ) {
    return false;
  }
  return left.state === "exact_draft" ||
    (
      right.state === "exact_injected_paste_placeholder" &&
      left.pasteId === right.pasteId &&
      left.newlineCount === right.newlineCount &&
      left.frameProfile === right.frameProfile
    );
}
