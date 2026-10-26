import { writeCliStdout } from "./cli-runtime-context.js";
import type { ResolvedTerminalConversation, TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { TerminalDispatchRepositoryCliAdapter } from "./terminal-dispatch-repository-cli-adapter.js";
import type { TerminalNativeIdentity } from "./terminal-binding-authority.js";
import { assertNativeStoreAuthorityCurrent, canonicalAuthorityStore, inspectNativeStoreAuthority, type NativeStoreAuthorityInspection } from "./native-store-authority.js";
import { completedNativeStoreAuthorityReceipt, recoverNativeStoreAuthorityWhileLocked, transferNativeStoreAuthorityWhileLocked } from "./native-store-authority-transfer.js";
import { sameTerminalControlIncarnation, type TerminalControlRef } from "./terminal-control-ref.js";
import { nonBlankString, recordValue } from "./value-guards.js";

interface NativeStoreAuthorityCliPorts {
  createBridge(options: Record<string, any>): TerminalAgentBridge;
  identity(input: Record<string, any>): Promise<TerminalNativeIdentity | undefined>;
  repository: TerminalDispatchRepositoryCliAdapter;
}

function assertLiveNativeIdentity(identity: TerminalNativeIdentity | undefined,
  inspected: NativeStoreAuthorityInspection): void {
  const binding = inspected.session?.binding;
  if (!nonBlankString(identity?.sessionId) || !nonBlankString(identity?.processUuid) ||
    identity!.sessionId !== binding?.native_thread_id ||
    identity!.processUuid !== binding?.native_process.process_uuid) {
    throw new Error("native thread process incarnation cannot be verified; transfer refused; no input sent");
  }
}

async function proveLiveTransferTerminal(options: Record<string, any>, current: ResolvedTerminalConversation,
  inspected: NativeStoreAuthorityInspection, bridge: TerminalAgentBridge, ports: NativeStoreAuthorityCliPorts): Promise<void> {
  if (current.agent !== inspected.session?.agent || current.pid !== inspected.session.binding?.native_process.pid) {
    throw new Error("native thread process incarnation changed; transfer refused; no input sent");
  }
  const request = { options, agent: current.agent, pid: current.pid, cwd: current.terminalControl.currentPath };
  assertLiveNativeIdentity(await ports.identity(request), inspected);
  const status = await bridge.status(current.agent, current.terminalControl, { runtime: { pid: current.pid } });
  if (!status.reachable || status.activity_state !== "idle" ||
    !status.approval_state.scanned || status.approval_state.blocked) {
    throw new Error("terminal must be reachable, idle and without a pending approval before authority transfer; no input sent");
  }
  // A human can change native context while the read-only screen capture awaits.
  assertLiveNativeIdentity(await ports.identity(request), inspected);
}

async function observeLiveStoreAuthority(input: { storeDir: string; terminalControl: TerminalControlRef },
  initial: NativeStoreAuthorityInspection, ports: NativeStoreAuthorityCliPorts) {
  if (!initial.session?.binding) {
    throw new Error(`Store authority cannot be verified: ${initial.reason ?? initial.state}; no input sent`);
  }
  const bridge = ports.createBridge({});
  const current = await bridge.resolveStoredTerminal(initial.session.agent,
    initial.session.binding.native_process.pid, input.terminalControl);
  if (current.agent !== initial.session.agent || current.pid !== initial.session.binding.native_process.pid ||
    !sameTerminalControlIncarnation(current.terminalControl, input.terminalControl)) {
    throw new Error("terminal incarnation changed before Store authority verification; no input sent");
  }
  const identity = await ports.identity({ options: {}, agent: current.agent, pid: current.pid,
    cwd: current.terminalControl.currentPath });
  if (!nonBlankString(identity?.sessionId) || !nonBlankString(identity?.processUuid)) {
    throw new Error("native thread process incarnation cannot be verified; no input sent");
  }
  const freshInput = { ...input, nativeThreadId: identity!.sessionId, ledger: ports.repository.load(input.terminalControl) };
  return { bridge, current, freshInput };
}

/** The caller holds the physical terminal lock; stale action tokens cannot bypass Store ownership. */
export async function recoverNativeStoreAuthorityForCli(input: { storeDir: string; terminalControl: TerminalControlRef },
  ports: NativeStoreAuthorityCliPorts): Promise<void> {
  const initial = inspectNativeStoreAuthority({ ...input, ledger: ports.repository.load(input.terminalControl) });
  if (initial.state === "none" || initial.state === "current") return;
  const { bridge, current, freshInput } = await observeLiveStoreAuthority(input, initial, ports);
  const inspected = inspectNativeStoreAuthority(freshInput);
  if (inspected.state === "none" || inspected.state === "current") return;
  const journal = recordValue(freshInput.ledger?.store_authority_transfer);
  const pendingAutomatic = journal?.automatic === true && journal.phase !== "committed" &&
    journal.target_store_dir === canonicalAuthorityStore(input.storeDir);
  if (!inspected.automaticEligible && !pendingAutomatic) assertNativeStoreAuthorityCurrent(freshInput);
  if (!inspected.transferEligible) {
    throw new Error(`automatic Store authority recovery refused: ${inspected.reason ?? inspected.state}; no input sent`);
  }
  await proveLiveTransferTerminal({}, current, inspected, bridge, ports);
  recoverNativeStoreAuthorityWhileLocked(input, ports.repository);
  assertNativeStoreAuthorityCurrent({ ...freshInput, ledger: ports.repository.load(input.terminalControl) });
}

export async function runNativeStoreAuthorityTransferCli(options: Record<string, any>, ports: NativeStoreAuthorityCliPorts & {
  storeDir(options: Record<string, any>): string;
}): Promise<void> {
  const terminalId = nonBlankString(options.terminal ?? options.conversation);
  const token = nonBlankString(options.expectedAuthorityToken);
  if (!terminalId || !token) throw new Error("transfer-store-authority requires --terminal and the fresh displayed --expected-authority-token");
  const bridge = ports.createBridge(options);
  const initial = await bridge.resolveConversationId(terminalId);
  if (!initial || initial.conversationId !== terminalId) throw new Error("use the exact terminal_id from AKK list");
  const storeDir = ports.storeDir(options);
  const release = ports.repository.acquire(storeDir, initial.terminalControl);
  try {
    const current = await bridge.resolveConversationId(terminalId);
    if (!current || current.pid !== initial.pid ||
      !sameTerminalControlIncarnation(current.terminalControl, initial.terminalControl)) {
      throw new Error("terminal incarnation changed; refresh AKK list");
    }
    const request = { storeDir, terminalControl: current.terminalControl,
      expectedAuthorityToken: token, maintenanceAcknowledgement: options.maintenanceAcknowledgement === true };
    const ledger = ports.repository.load(current.terminalControl);
    if (ledger && !ports.repository.matchesControl(ledger, current.terminalControl)) {
      throw new Error("Store authority terminal incarnation changed; refresh AKK list; no input sent");
    }
    const completed = completedNativeStoreAuthorityReceipt(request, ledger);
    if (completed) {
      writeCliStdout(JSON.stringify({ ...completed, terminal_id: terminalId, terminal_input_sent: false }, null, 2) + "\n");
      return;
    }
    const inspected = inspectNativeStoreAuthority({ ...request, ledger });
    await proveLiveTransferTerminal(options, current, inspected, bridge, ports);
    const result = transferNativeStoreAuthorityWhileLocked(request, ports.repository);
    writeCliStdout(JSON.stringify({ ...result, terminal_id: terminalId, terminal_input_sent: false }, null, 2) + "\n");
  } finally { release(); }
}
