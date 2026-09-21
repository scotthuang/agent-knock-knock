import type { TerminalAgentAdapterRegistry, TerminalRuntimeIdentity } from
  "./terminal-agent-adapter.js";
import type { TerminalControlProvider } from "./terminal-control-provider.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
import { codexAutomatedInputComposerReady } from "./terminal-composer-classifier.js";

interface CodexComposerReadinessRuntime<Options> {
  createControlProvider(options: Options): TerminalControlProvider;
  createAgentRegistry(options: Options): TerminalAgentAdapterRegistry;
}

/** Capture and fence the live Composer immediately before automated input. */
export async function assertCodexComposerReadyForAutomatedInput<Options>(
  runtime: CodexComposerReadinessRuntime<Options>,
  input: {
    options: Options;
    terminalControl: TerminalControlRef;
    runtime?: TerminalRuntimeIdentity;
  }
): Promise<void> {
  const provider = runtime.createControlProvider(input.options);
  const resolvedTerminal = await provider.resolve(
    provider.endpoint(input.terminalControl)
  );
  const resolvedControl = provider.toControlRef(
    resolvedTerminal,
    input.terminalControl.capabilities
  );
  if (!terminalControlsShareIncarnation(
    input.terminalControl,
    resolvedControl
  )) {
    throw new Error(
      "terminal process changed before the Codex composer safety check"
    );
  }
  const styledScreen = await provider.capture(
    resolvedTerminal,
    { scrollbackLines: 40, preserveEscapes: true }
  );
  if (!codexAutomatedInputComposerReady({
    screen: styledScreen,
    terminalControl: resolvedControl,
    runtime: input.runtime,
    adapter: () => runtime.createAgentRegistry(input.options).require("codex")
  })) {
    throw new Error(
      "Codex composer contains non-placeholder input; refusing automated terminal input"
    );
  }
}
