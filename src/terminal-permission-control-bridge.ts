import { createHash } from "node:crypto";
import { observeCodexPermissionSurface } from "./codex-permission-surface.js";
import {
  exactCodexFullscreenBareCommandCapture,
  exactCodexFullscreenSlashComposerCapture
} from "./codex-fullscreen-composer-proof.js";
import {
  exactCodexReadyStyledComposerCapture,
  stripTerminalEscapeSequences
} from "./terminal-native-inspection-proof.js";
import {
  codexActiveWriterViewerVisible,
  codexBlockingModalVisible,
  inspectCodexAsyncQuestionInputMode
} from "./terminal-composer-classifier.js";
import { inspectNativeQuestionnaire } from "./terminal-questionnaire-adapter.js";
import type { TerminalAgentAdapter, TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import {
  TerminalPermissionInputUncertainError,
  terminalPermissionControlProfileFor,
  type PermissionCapture,
  type TerminalPermissionControlPorts,
  type TerminalPermissionStatus
} from "./terminal-permission-control.js";

export interface PermissionBridgeRuntime {
  readonly agentVersion: string;
  readonly runtime: TerminalRuntimeIdentity;
  readonly adapter: TerminalAgentAdapter;
  verifyIdentity(): Promise<void>;
  captureStyled(): Promise<string>;
  beforeInput(): void | Promise<void>;
  inspectStatus(): Promise<TerminalPermissionStatus>;
  sendText(text: string): Promise<void>;
  sendKeys(keys: readonly string[]): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

/** The caller holds the terminal lock; every input consumes a fresh exact frame. */
export function createTerminalPermissionControlPorts(
  ports: PermissionBridgeRuntime
): TerminalPermissionControlPorts {
  if (ports.adapter.agent !== "codex" ||
      !terminalPermissionControlProfileFor(ports.agentVersion) ||
      ports.runtime.agentVersion !== ports.agentVersion) {
    throw new Error("permission control requires an exact matching Codex behavior profile");
  }
  let inputPermit: PermissionCapture | undefined;
  const captureFrame = async (): Promise<PermissionCapture> => {
    await ports.verifyIdentity();
    const styled = await ports.captureStyled();
    await ports.verifyIdentity();
    const owned = observeCodexPermissionSurface(styled, ports.agentVersion);
    if (owned.state === "picker" || owned.state === "full_access_confirmation") return owned;
    const fingerprint = createHash("sha256").update(styled).digest("hex");
    if (owned.state === "ambiguous") return { state: "blocked", fingerprint };
    const plain = stripTerminalEscapeSequences(styled);
    const inspected = ports.adapter.inspectScreen({ screen: plain, runtime: ports.runtime });
    const question = inspectNativeQuestionnaire({ agent: "codex", version: ports.agentVersion, screen: styled });
    const asyncMode = inspectCodexAsyncQuestionInputMode(styled);
    if (inspected.approval.blocked || inspected.activity.state === "working" ||
        inspected.activity.state === "awaiting_approval" || codexBlockingModalVisible(styled) ||
        question.status !== "none" || codexActiveWriterViewerVisible(styled) ||
        asyncMode !== "absent") return { state: "blocked", fingerprint };
    // Native slash completions intentionally replace the idle shortcut footer,
    // so the general activity classifier reports unknown. Their exact styled
    // command grammar is the input proof; positive activity still blocks above.
    const command = exactCodexFullscreenSlashComposerCapture(styled, "/permissions",
      ["› /permissions  choose what Codex is allowed to do"], true, ports.agentVersion);
    if (command) return { state: "command", fingerprint: command.digest };
    const bare = exactCodexFullscreenBareCommandCapture(styled, "/permissions", ports.agentVersion);
    if (bare) return { state: "bare_command", fingerprint: bare.digest };
    const empty = exactCodexReadyStyledComposerCapture(styled, ports.agentVersion);
    return empty && inspected.activity.state === "idle"
      ? { state: "idle", fingerprint: empty.digest } : { state: "blocked", fingerprint };
  };
  const capture = async (): Promise<PermissionCapture> => {
    inputPermit = undefined;
    const observed = await captureFrame();
    inputPermit = observed;
    return observed;
  };
  return {
    capture, inspectStatus: ports.inspectStatus, sleep: ports.sleep,
    input: async (action, expected) => {
      const permitted = inputPermit === expected;
      inputPermit = undefined;
      if (!permitted) throw new Error("permission input requires one fresh operation-local surface permit");
      if (!inputAllowed(action, expected)) throw new Error("permission input is not authorized by the observed native surface");
      await ports.beforeInput();
      const fresh = await captureFrame();
      if (fresh.state !== expected.state || fresh.fingerprint !== expected.fingerprint ||
          !inputAllowed(action, fresh)) {
        throw new Error("native permission surface changed immediately before terminal input");
      }
      await ports.verifyIdentity();
      try {
        if (action === "command") await ports.sendText("/permissions");
        else await ports.sendKeys([action]);
      } catch (error) {
        throw new TerminalPermissionInputUncertainError(
          "native permission input outcome is uncertain; do not retry automatically", { cause: error }
        );
      }
    }
  };
}

function inputAllowed(
  action: Parameters<TerminalPermissionControlPorts["input"]>[0], frame: PermissionCapture
): boolean {
  switch (action) {
    case "command": return frame.state === "idle";
    case "Up": case "Down": return frame.state === "picker" || frame.state === "full_access_confirmation";
    case "Escape": return frame.state === "picker" || frame.state === "command";
    case "C-u": return frame.state === "bare_command";
    case "C-m": return frame.state === "command" || frame.state === "picker" ||
      frame.state === "full_access_confirmation" && frame.selectedIndex === 0;
  }
}
