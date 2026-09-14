import type { ExecutorKind } from "./executors.js";
import type {
  TerminalAgentAdapter,
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import { inspectNativeQuestionnaire } from
  "./terminal-questionnaire-adapter.js";
import {
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  isTerminalModelControlPlanForAgent,
  terminalModelControlSlashCompletionRows,
  type TerminalModelControlPlan,
  type TerminalModelControlPorts
} from "./terminal-model-control.js";

type CodexComposerCapture = {
  state: "exact_draft" | "exact_empty" | "different_draft";
  digest: string;
  profiledSlashPopup?: true;
  bareCommand?: true;
};

export interface TerminalModelControlBridgeRuntimePorts {
  verifyTerminalIdentity(
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime: TerminalRuntimeIdentity | undefined
  ): Promise<TerminalControlRef>;
  captureStyled(terminalControl: TerminalControlRef): Promise<string>;
  sendText(terminalControl: TerminalControlRef, text: string): Promise<void>;
  sendKeys(
    terminalControl: TerminalControlRef,
    keys: readonly string[]
  ): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

export interface TerminalModelControlClassifierPorts {
  stripEscapes(value: string): string;
  sameIdentity(
    left: TerminalControlRef,
    right: TerminalControlRef
  ): boolean;
  currentCodexComposer(
    styledScreen: string,
    expectedText: string,
    allowOpaqueLargePastePlaceholder: boolean,
    classifyOpaqueLargePasteAsDifferent: boolean,
    exactSlashPopupRows?: readonly string[]
  ): CodexComposerCapture | undefined;
  inspectCodexAsyncQuestionInputMode(
    styledScreen: string
  ): "absent" | "collapsed" | "expanded" | "ambiguous";
  codexActiveWriterViewerVisible(styledScreen: string): boolean;
  isExactClaudeIdleComposer(screen: string): boolean;
  exactClaudeModelControlComposer(
    screen: string,
    plan: TerminalModelControlPlan,
    expectedText: string
  ): { digest: string } | undefined;
  exactTerminalComposer(
    agent: ExecutorKind,
    screen: string,
    expectedText: string
  ): { digest: string } | undefined;
}

export interface CreateTerminalModelControlPortsInput {
  adapter: TerminalAgentAdapter;
  plan: TerminalModelControlPlan;
  runtime?: TerminalRuntimeIdentity;
  beforeInput: () => void | Promise<void>;
  loadCodexCatalog?: TerminalModelControlPorts["loadCodexCatalog"];
  runtimePorts: TerminalModelControlBridgeRuntimePorts;
  classifiers: TerminalModelControlClassifierPorts;
}

/**
 * Bind model-control's semantic transaction to the terminal transport.
 *
 * Every input permit below is deliberately operation-local and one-shot. The
 * factory neither owns terminal locks nor writes Store state: callers retain
 * those boundaries and the domain state machine retains `beforeInput` timing.
 */
export function createTerminalModelControlPorts(
  input: CreateTerminalModelControlPortsInput
): TerminalModelControlPorts {
  const {
    adapter,
    plan,
    runtime,
    beforeInput,
    loadCodexCatalog,
    runtimePorts,
    classifiers
  } = input;
  let claudeModelDialogInputPermit: {
    terminalControl: TerminalControlRef;
    fingerprint: string;
  } | undefined;
  type CodexModelInputPermit = {
    terminalControl: TerminalControlRef;
    expectedComposer?: string;
    kind: "composer_empty" | "composer_command" | "model_surface";
    fingerprint: string;
  };
  let codexModelInputPermit: CodexModelInputPermit | undefined;
  const consumeCodexModelInputPermit =
    (): CodexModelInputPermit | undefined => {
      const permit = codexModelInputPermit;
      codexModelInputPermit = undefined;
      return permit;
    };

  const verifyModelControlTerminalIdentity = async (
    terminalControl: TerminalControlRef,
    options: {
      claudeModelDialog: "forbid" | "allow" | "require";
    }
  ): Promise<TerminalControlRef> => {
    const canUseClaudeModelDialog =
      adapter.agent === "claude" &&
      isTerminalModelControlPlanForAgent(plan, "claude") &&
      runtime?.requireExactClaudeAgentRow === true &&
      runtime.exactClaudeAgentState === "idle";
    if (options.claudeModelDialog === "require") {
      if (!canUseClaudeModelDialog) {
        throw new Error(
          "Claude model-dialog identity cannot be required outside its exact profile"
        );
      }
      return runtimePorts.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        { ...runtime, exactClaudeAgentState: "status_dialog" }
      );
    }
    try {
      return await runtimePorts.verifyTerminalIdentity(
        adapter.agent,
        terminalControl,
        runtime
      );
    } catch (idleError) {
      if (
        options.claudeModelDialog !== "allow" ||
        !canUseClaudeModelDialog
      ) {
        throw idleError;
      }
      try {
        return await runtimePorts.verifyTerminalIdentity(
          adapter.agent,
          terminalControl,
          { ...runtime, exactClaudeAgentState: "status_dialog" }
        );
      } catch {
        // Preserve the original current-snapshot failure. Both attempts use
        // the same PID, process incarnation, native Session, cwd, and terminal
        // control fence; the second changes only the exact allowed agents row
        // state from idle to `waiting` / `dialog open`.
        throw idleError;
      }
    }
  };

  const capture: TerminalModelControlPorts["capture"] = async (captureInput) => {
    claudeModelDialogInputPermit = undefined;
    codexModelInputPermit = undefined;
    const original = captureInput.terminalControl as TerminalControlRef;
    const verified = await verifyModelControlTerminalIdentity(original, {
      claudeModelDialog: "allow"
    });
    const styledScreen = await runtimePorts.captureStyled(verified);
    const screen = classifiers.stripEscapes(styledScreen);
    const inspection = adapter.inspectScreen({ screen, runtime });
    const modelObservation = adapter.observeModelControl?.(plan, screen);
    const exactCodexModelSurface = adapter.agent === "codex" &&
      modelObservation !== undefined &&
      modelObservation.state !== "none" &&
      modelObservation.state !== "ambiguous";
    const exactClaudeModelDialog = adapter.agent === "claude" &&
      modelObservation?.state === "claude_model_picker";
    const reverified = await verifyModelControlTerminalIdentity(verified, {
      claudeModelDialog: exactClaudeModelDialog ? "require" : "forbid"
    });
    if (!classifiers.sameIdentity(verified, reverified)) {
      throw new Error(
        "terminal control identity changed across model-control capture"
      );
    }
    if (exactClaudeModelDialog) {
      claudeModelDialogInputPermit = {
        terminalControl: reverified,
        fingerprint: modelObservation.fingerprint
      };
    }
    const codexComposer = adapter.agent === "codex"
      ? classifiers.currentCodexComposer(
          styledScreen,
          captureInput.expectedComposer ?? "",
          false,
          false,
          captureInput.expectedComposer === plan.command
            ? terminalModelControlSlashCompletionRows(plan)
            : undefined
        )
      : undefined;
    let codexInputBlocked = false;
    if (adapter.agent === "codex") {
      try {
        const questionnaire = inspectNativeQuestionnaire({
          agent: "codex",
          version: CODEX_MODEL_CONTROL_AGENT_VERSION,
          screen: styledScreen
        });
        const asyncQuestionMode =
          classifiers.inspectCodexAsyncQuestionInputMode(styledScreen);
        codexInputBlocked = !exactCodexModelSurface && (
          questionnaire.status !== "none" ||
          classifiers.codexActiveWriterViewerVisible(styledScreen) ||
          asyncQuestionMode === "expanded" ||
          asyncQuestionMode === "ambiguous"
        );
      } catch {
        codexInputBlocked = !exactCodexModelSurface;
      }
    }
    const exactEmptyComposer = adapter.agent === "codex"
      ? codexComposer?.state === "exact_empty"
      : classifiers.isExactClaudeIdleComposer(screen);
    const claudeProfiledCommand = adapter.agent === "claude" &&
      captureInput.expectedComposer === plan.command &&
      classifiers.exactClaudeModelControlComposer(
        screen,
        plan,
        captureInput.expectedComposer
      ) !== undefined;
    const claudeBareCommand = adapter.agent === "claude" &&
      captureInput.expectedComposer !== undefined &&
      classifiers.exactTerminalComposer(
        "claude",
        screen,
        captureInput.expectedComposer
      ) !== undefined;
    const exactCommandComposer = captureInput.expectedComposer !== undefined && (
      adapter.agent === "codex"
        ? codexComposer?.state === "exact_draft"
        : claudeProfiledCommand || claudeBareCommand
    );
    const exactCommandReady = adapter.agent === "codex"
      ? codexComposer?.state === "exact_draft" &&
        codexComposer.profiledSlashPopup === true
      : claudeProfiledCommand;
    const exactBareCommand = adapter.agent === "codex"
      ? codexComposer?.state === "exact_draft" &&
        codexComposer.bareCommand === true
      : claudeBareCommand && !claudeProfiledCommand;
    if (adapter.agent === "codex") {
      const exactModelSurface = modelObservation &&
        modelObservation.state !== "none" &&
        modelObservation.state !== "ambiguous"
        ? {
            kind: "model_surface" as const,
            fingerprint: modelObservation.fingerprint
          }
        : undefined;
      const exactComposerSurface = codexComposer?.state === "exact_empty"
        ? {
            kind: "composer_empty" as const,
            fingerprint: codexComposer.digest
          }
        : codexComposer?.state === "exact_draft"
          ? {
              kind: "composer_command" as const,
              fingerprint: codexComposer.digest
            }
          : undefined;
      const proof = exactModelSurface ?? exactComposerSurface;
      if (proof) {
        codexModelInputPermit = {
          terminalControl: reverified,
          expectedComposer: captureInput.expectedComposer,
          ...proof
        };
      }
    }
    return {
      terminalControl: reverified,
      screen,
      // The exact profiled picker is the current input owner. Generic
      // lifecycle/questionnaire detectors may still see stale transcript
      // markers behind that overlay, so keep their result from vetoing the
      // model-control state machine. Unknown or partial pickers receive no
      // such override and remain fail-closed.
      activityState: exactCodexModelSurface
        ? "unknown"
        : inspection.activity.state,
      approvalBlocked: exactCodexModelSurface
        ? false
        : inspection.approval.blocked,
      exactEmptyComposer,
      exactCommandReady,
      exactCommandComposer,
      exactBareCommand,
      ...(codexComposer?.state === "exact_draft"
        ? { exactCommandFingerprint: codexComposer.digest }
        : {}),
      inputBlocked: codexInputBlocked
    };
  };

  return {
    beforeInput,
    loadCodexCatalog,
    capture,
    sendText: async (control: unknown, text: "/model") => {
      claudeModelDialogInputPermit = undefined;
      if (adapter.agent === "codex") {
        const permit = consumeCodexModelInputPermit();
        if (!permit || permit.kind !== "composer_empty") {
          throw new Error(
            "Codex /model text requires one fresh exact empty-composer permit"
          );
        }
        const fresh = await capture({
          terminalControl: control,
          expectedComposer: permit.expectedComposer
        });
        const freshPermit = consumeCodexModelInputPermit();
        if (
          !freshPermit ||
          freshPermit.kind !== permit.kind ||
          freshPermit.fingerprint !== permit.fingerprint ||
          !classifiers.sameIdentity(
            permit.terminalControl,
            freshPermit.terminalControl
          ) ||
          fresh.inputBlocked === true ||
          fresh.approvalBlocked ||
          fresh.activityState === "working" ||
          fresh.activityState === "awaiting_approval" ||
          !fresh.exactEmptyComposer
        ) {
          throw new Error(
            "the exact Codex empty composer changed before /model text delivery"
          );
        }
        await runtimePorts.sendText(freshPermit.terminalControl, text);
        return;
      }
      const verified = await runtimePorts.verifyTerminalIdentity(
        adapter.agent,
        control as TerminalControlRef,
        runtime
      );
      await runtimePorts.sendText(verified, text);
    },
    sendKeys: async (control: unknown, keys: readonly string[]) => {
      const requestedControl = control as TerminalControlRef;
      if (adapter.agent === "codex") {
        const permit = consumeCodexModelInputPermit();
        claudeModelDialogInputPermit = undefined;
        if (
          !permit ||
          !classifiers.sameIdentity(
            permit.terminalControl,
            requestedControl
          )
        ) {
          throw new Error(
            "Codex model-control key requires one fresh exact input-surface permit"
          );
        }
        const fresh = await capture({
          terminalControl: requestedControl,
          expectedComposer: permit.expectedComposer
        });
        const freshPermit = consumeCodexModelInputPermit();
        if (
          !freshPermit ||
          freshPermit.kind !== permit.kind ||
          freshPermit.fingerprint !== permit.fingerprint ||
          !classifiers.sameIdentity(
            permit.terminalControl,
            freshPermit.terminalControl
          ) ||
          fresh.inputBlocked === true ||
          fresh.approvalBlocked ||
          fresh.activityState === "working" ||
          fresh.activityState === "awaiting_approval"
        ) {
          throw new Error(
            "the exact Codex model-control input surface changed before key dispatch"
          );
        }
        await runtimePorts.sendKeys(freshPermit.terminalControl, keys);
        return;
      }
      const permit = claudeModelDialogInputPermit;
      claudeModelDialogInputPermit = undefined;
      const requireClaudeModelDialog = permit !== undefined &&
        classifiers.sameIdentity(permit.terminalControl, requestedControl);
      const verified = await verifyModelControlTerminalIdentity(
        requestedControl,
        {
          claudeModelDialog: requireClaudeModelDialog ? "require" : "forbid"
        }
      );
      if (requireClaudeModelDialog) {
        const styledScreen = await runtimePorts.captureStyled(verified);
        const screen = classifiers.stripEscapes(styledScreen);
        const inspection = adapter.inspectScreen({ screen, runtime });
        const observation = adapter.observeModelControl?.(plan, screen);
        if (
          inspection.approval.blocked ||
          inspection.activity.state === "working" ||
          observation?.state !== "claude_model_picker" ||
          observation.fingerprint !== permit?.fingerprint
        ) {
          throw new Error(
            "the exact Claude model picker changed before key dispatch"
          );
        }
      }
      await runtimePorts.sendKeys(verified, keys);
    },
    sleep: runtimePorts.sleep
  };
}
