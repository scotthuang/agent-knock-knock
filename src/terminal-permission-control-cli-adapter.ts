import type { FileLockAcquisitionOptions } from "./file-lock-cli-adapter.js";
import type {
  TerminalNativeControlCliOptions as NativeLifecycleCliOptions,
  TerminalNativeControlCliBoundary
} from "./terminal-native-control-cli-contract.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "./terminal-agent-bridge.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import type { TerminalRuntimeCliAdapter } from "./terminal-runtime-cli-adapter.js";
import {
  terminalPermissionControlBindingToken,
  terminalPermissionControlProfileFor,
  type TerminalPermissionControlProfile
} from "./terminal-permission-control.js";
import { nonBlankString } from "./value-guards.js";

export interface TerminalPermissionControlCliPorts {
  readonly runtime: {
    forOptions(options: NativeLifecycleCliOptions): TerminalRuntimeCliAdapter;
    physicalProcessIncarnation(pid: number): {
      processUuid: string;
      processBirth: string;
    };
    physicalRuntime(terminal: ResolvedTerminalConversation): TerminalRuntimeIdentity;
  };
  readonly lifecycle: TerminalNativeControlCliBoundary;
  readonly state: {
    storeDir(options: NativeLifecycleCliOptions): string;
    inspectStore(storeDir: string): { writable: boolean };
    acquireTerminal(
      storeDir: string,
      terminalControl: TerminalControlRef,
      options?: FileLockAcquisitionOptions
    ): () => void;
  };
  readonly output: { print(value: unknown): void };
}

interface PermissionControlContext {
  readonly options: NativeLifecycleCliOptions;
  readonly terminal: ResolvedTerminalConversation;
  readonly bridge: TerminalAgentBridge;
  readonly runtime: TerminalRuntimeIdentity;
  readonly profile: TerminalPermissionControlProfile;
  readonly expectedBindingToken: string;
}

/** Closed native permission operations; no task, Session, or Watch is created. */
export function createTerminalPermissionControlCliAdapter(
  ports: TerminalPermissionControlCliPorts
): {
  runPermissionOptions(options: NativeLifecycleCliOptions): Promise<void>;
  runSetPermissions(options: NativeLifecycleCliOptions): Promise<void>;
} {
  const app = new TerminalPermissionControlCliApplication(ports);
  return Object.freeze({
    runPermissionOptions: (options) => app.runPermissionOptions(options),
    runSetPermissions: (options) => app.runSetPermissions(options)
  });
}

class TerminalPermissionControlCliApplication {
  constructor(private readonly ports: TerminalPermissionControlCliPorts) {}

  async runPermissionOptions(options: NativeLifecycleCliOptions): Promise<void> {
    const token = validateOptions(options, false);
    const result = await this.withPrepared(options, token, async (context) => {
      const catalog = await context.bridge.permissionOptions(
        context.terminal.terminalControl,
        context.profile.agentVersion,
        {
          runtime: context.runtime,
          beforeInput: () => this.assertFreshBoundary(context)
        }
      );
      await this.assertFreshBoundary(context);
      return {
        terminal_id: context.terminal.conversationId,
        agent: catalog.agent,
        agent_version: catalog.agentVersion,
        behavior_profile: catalog.behaviorProfile,
        scope: catalog.scope,
        current: catalog.current,
        choices: catalog.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          description: choice.description,
          requires_confirmation: choice.requiresConfirmation
        })),
        catalog_fingerprint: catalog.catalogFingerprint,
        available_actions: {
          set_permissions: {
            tool: "agent_knock_knock_set_permissions",
            arguments: {
              terminal_id: context.terminal.conversationId,
              expected_binding_token: context.expectedBindingToken,
              expected_catalog_fingerprint: catalog.catalogFingerprint
            }
          }
        }
      };
    });
    this.ports.output.print(result);
  }

  async runSetPermissions(options: NativeLifecycleCliOptions): Promise<void> {
    const token = validateOptions(options, true);
    const mode = required(options.mode, "--mode is required");
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(mode)) {
      throw new Error("--mode must be one semantic id from permission-options");
    }
    const fingerprint = required(options.expectedCatalogFingerprint,
      "--expected-catalog-fingerprint is required");
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) {
      throw new Error("--expected-catalog-fingerprint must come from permission-options");
    }
    const result = await this.withPrepared(options, token, async (context) => {
      const switched = await context.bridge.setPermissions(
        context.terminal.terminalControl,
        context.profile.agentVersion,
        mode,
        fingerprint,
        {
          runtime: context.runtime,
          beforeInput: () => this.assertFreshBoundary(context)
        }
      );
      return {
        terminal_id: context.terminal.conversationId,
        agent: "codex",
        agent_version: context.profile.agentVersion,
        behavior_profile: context.profile.behaviorProfile,
        outcome: switched.outcome,
        requested: switched.requested,
        scope: switched.scope,
        defaults_changed: switched.defaultsChanged,
        ...(switched.effective ? { effective: switched.effective } : {}),
        do_not_retry: switched.doNotRetry,
        ...(switched.reason ? { reason: switched.reason } : {})
      };
    });
    this.ports.output.print(result);
  }

  async withPrepared<T>(
    options: NativeLifecycleCliOptions,
    expectedBindingToken: string,
    operation: (context: PermissionControlContext) => Promise<T>
  ): Promise<T> {
    const storeDir = this.ports.state.storeDir(options);
    if (!this.ports.state.inspectStore(storeDir).writable) {
      throw new Error("permission control requires a compatible AKK Store");
    }
    const initial = await this.ports.lifecycle.resolveLifecycleTerminal(options);
    if (initial.agent !== "codex") {
      throw new Error("native permission control is supported only for Codex");
    }
    const release = this.ports.state.acquireTerminal(
      storeDir, initial.terminalControl, { timeoutMs: 30_000 }
    );
    try {
      const facade = this.ports.runtime.forOptions(options);
      const bridge = facade.createBridge();
      const terminal = await bridge.resolveStoredTerminal(
        "codex", initial.pid, initial.terminalControl,
        this.ports.runtime.physicalRuntime(initial)
      );
      this.ports.lifecycle.assertSameInspectionTerminal(
        initial, terminal, "while waiting for permission-control ownership"
      );
      const version = facade.agentVersionForRunningProcess("codex", terminal.pid);
      const profile = version ? terminalPermissionControlProfileFor(version) : undefined;
      if (!profile) throw new Error("Codex has no verified native permission-control profile");
      const runtime = { ...this.ports.runtime.physicalRuntime(terminal), agentVersion: version };
      const context = { options, terminal, bridge, runtime, profile, expectedBindingToken };
      await this.assertFreshBoundary(context);
      const status = await bridge.status("codex", terminal.terminalControl, { runtime });
      if (status.approval_state.scanned !== true) {
        throw new Error("permission control requires a fresh approval scan");
      }
      this.ports.lifecycle.assertInspectionReady({ options, terminal, terminalStatus: status });
      return await operation(context);
    } finally {
      release();
    }
  }

  async assertFreshBoundary(context: PermissionControlContext): Promise<void> {
    const terminal = await context.bridge.resolveStoredTerminal(
      "codex", context.terminal.pid, context.terminal.terminalControl, context.runtime
    );
    this.ports.lifecycle.assertSameInspectionTerminal(
      context.terminal, terminal, "before permission-control input"
    );
    const version = this.ports.runtime.forOptions(context.options)
      .agentVersionForRunningProcess("codex", terminal.pid);
    const incarnation = this.ports.runtime.physicalProcessIncarnation(terminal.pid);
    if (version !== context.profile.agentVersion ||
        terminalPermissionControlBindingToken({
          terminalId: terminal.conversationId,
          terminalControl: terminal.terminalControl,
          pid: terminal.pid,
          workspace: required(terminal.terminalControl.currentPath, "terminal cwd is unavailable"),
          ...incarnation,
          agentVersion: context.profile.agentVersion,
          behaviorProfile: context.profile.behaviorProfile
        }) !== context.expectedBindingToken) {
      throw new Error("permission-control terminal binding or version changed; refresh AKK list");
    }
    this.ports.lifecycle.assertInspectionReady({ options: context.options, terminal });
    this.ports.lifecycle.assertForegroundHasNoLifecycleTransition(context.options, terminal);
  }
}

function validateOptions(options: NativeLifecycleCliOptions, set: boolean): string {
  const forbidden = ["command", "message", "request", "scope", "keys", "index", "model", "reasoningEffort"];
  if (!set) forbidden.push("mode", "expectedCatalogFingerprint");
  if (forbidden.some((name) => options[name] !== undefined)) {
    throw new Error("permission control accepts only typed permission fields, never raw commands, keys, indexes, or scope");
  }
  return required(options.expectedBindingToken, "--expected-binding-token is required");
}

function required(value: unknown, message: string): string {
  const text = nonBlankString(value);
  if (!text) throw new Error(message);
  return text;
}
