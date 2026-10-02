import { createHash } from "node:crypto";
import type { TerminalAgentAdapter, TerminalRuntimeIdentity, TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import { sameTerminalControlIncarnation } from "./terminal-control-ref.js";
import { assertTerminalMutationCapabilities, stripTerminalEscapeSequences, NativeInspectionSubmissionError,
  type TerminalCodexStatusProbeResult, type TerminalNativeInspectionOptions } from "./terminal-native-inspection-bridge.js";
import { createTerminalPermissionControlPorts } from "./terminal-permission-control-bridge.js";
import { discoverTerminalPermissionOptions, switchTerminalPermissions,
  terminalPermissionControlProfileFor, permissionModeFromStatus, TerminalPermissionInputUncertainError,
  type TerminalPermissionCatalog, type TerminalPermissionSwitchResult,
  type TerminalPermissionControlPorts, type TerminalPermissionStatus } from "./terminal-permission-control.js";

export interface TerminalPermissionControlBridgeOptions {
  runtime?: TerminalRuntimeIdentity;
  beforeInput?: () => void | Promise<void>;
}
interface PermissionRuntimePorts {
  provider: TerminalControlProvider;
  adapter: TerminalAgentAdapter;
  verifyIdentity(control: TerminalControlRef, runtime: TerminalRuntimeIdentity): Promise<TerminalControlRef>;
  submitStatus(control: TerminalControlRef, version: string, options: TerminalNativeInspectionOptions): Promise<TerminalCodexStatusProbeResult>;
  captureStatus(control: TerminalControlRef, runtime: TerminalRuntimeIdentity, submission: TerminalCodexStatusProbeResult): Promise<{screen: string; emptyComposer: boolean}>;
  sleep(milliseconds: number): Promise<void>;
}

/** Native permission UI composition, isolated from task execution and app-server writes. */
export class TerminalPermissionControlRuntime {
  constructor(private readonly ports: PermissionRuntimePorts) {}
  permissionOptions = async (
    control: TerminalControlRef, version: string, options: TerminalPermissionControlBridgeOptions
  ): Promise<TerminalPermissionCatalog> => {
    const profile = terminalPermissionControlProfileFor(version);
    if (!profile) throw new Error("Codex has no verified permission-control profile");
    return discoverTerminalPermissionOptions(profile, this.permissionControlPorts(control, version, options));
  }

  setPermissions = async (
    control: TerminalControlRef, version: string, mode: string,
    fingerprint: string, options: TerminalPermissionControlBridgeOptions
  ): Promise<TerminalPermissionSwitchResult> => {
    const profile = terminalPermissionControlProfileFor(version);
    if (!profile) throw new Error("Codex has no verified permission-control profile");
    return switchTerminalPermissions(profile, mode, fingerprint, this.permissionControlPorts(control, version, options));
  }

  private permissionControlPorts(
    control: TerminalControlRef, version: string, options: TerminalPermissionControlBridgeOptions
  ): TerminalPermissionControlPorts {
    if (!options.beforeInput || !options.runtime?.pid) {
      throw new Error("permission control requires exact physical identity and an in-lock input fence");
    }
    assertTerminalMutationCapabilities({
      provider: this.ports.provider, terminal: this.ports.provider.endpoint(control),
      semantic: ["send_keys", "screen_status"],
      transport: ["stable_resource_resolution", "screen_capture", "ansi_capture", "text_delivery", "key_delivery"]
    });
    const beforeInput = options.beforeInput;
    const runtime = { ...options.runtime, agentVersion: version };
    const adapter = this.ports.adapter;
    const verifyIdentity = async () => {
      const verified = await this.ports.verifyIdentity(control, runtime);
      if (!sameTerminalControlIncarnation(control, verified)) {
        throw new Error("permission-control terminal incarnation changed");
      }
    };
    return createTerminalPermissionControlPorts({
      agentVersion: version, runtime, adapter, verifyIdentity, beforeInput,
      captureStyled: () => this.ports.provider.capture(this.ports.provider.endpoint(control), {
        scrollbackLines: 160, preserveEscapes: true
      }),
      sendText: (text) => this.ports.provider.sendText(this.ports.provider.endpoint(control), text),
      sendKeys: (keys) => this.ports.provider.sendKeys(this.ports.provider.endpoint(control), keys),
      sleep: this.ports.sleep,
      inspectStatus: async (): Promise<TerminalPermissionStatus> => {
        await beforeInput();
        let submitted = false;
        try {
          const submission = await this.ports.submitStatus(control, version, {
            runtime, beforeEnter: beforeInput
          });
          submitted = true;
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const frame = await this.ports.captureStatus(control, runtime, submission);
            const observed = adapter.observeNativeInspection?.({
              operation: { kind: "status" }, expectedAgentVersion: version,
              screen: stripTerminalEscapeSequences(frame.screen),
              previousScreenFingerprint: submission.preEnterScreenDigest
            });
            if (frame.emptyComposer && observed?.status === "observed" && observed.nativeThreadId &&
                createHash("sha256").update(frame.screen).digest("hex") !== submission.observationBaselineDigest) {
              const permission = observed.result?.fields.filter((field) => field.name === "Permissions");
              const mode = permission?.length === 1 ? permissionModeFromStatus(permission[0]!.value) : undefined;
              if (!mode) throw new Error("Codex /status does not expose a supported exact permission mode");
              await verifyIdentity();
              return { threadId: observed.nativeThreadId, mode };
            }
            await this.ports.sleep(100);
          }
          throw new Error("Codex permission control could not prove a fresh native /status result; do not retry automatically");
        } catch (error) {
          if (submitted || error instanceof NativeInspectionSubmissionError && error.doNotRetry) {
            throw new TerminalPermissionInputUncertainError(
              "native permission status probe is uncertain; inspect the terminal and do not retry automatically", { cause: error }
            );
          }
          throw error;
        }
      }
    });
  }

}
