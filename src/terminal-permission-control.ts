import { createHash } from "node:crypto";
import { terminalPhysicalBindingToken, type TerminalControlRef } from "./terminal-control-ref.js";
import type { CodexPermissionSurface } from "./codex-permission-surface.js";

export interface TerminalPermissionControlProfile {
  readonly agentVersion: string;
  readonly behaviorProfile: string;
  readonly scope: "current_session";
}

/** Permission writes have their own reviewed UI contract, separate from reads/model control. */
export function terminalPermissionControlProfileFor(
  version: string
): TerminalPermissionControlProfile | undefined {
  return ["0.159.2", "0.159.3", "0.160.0"].includes(version)
    ? { agentVersion: version, behaviorProfile: "codex-permissions-fullscreen-v1", scope: "current_session" }
    : undefined;
}

export function terminalPermissionControlBindingToken(value: {
  terminalId: string; terminalControl: TerminalControlRef; pid: number;
  workspace: string; processUuid: string; processBirth: string;
  agentVersion: string; behaviorProfile: string;
}): string {
  const profile = terminalPermissionControlProfileFor(value.agentVersion);
  if (!profile || profile.behaviorProfile !== value.behaviorProfile) {
    throw new Error("unsupported native permission-control profile");
  }
  return digest({
    authority: "terminal_permission_control", version: 1,
    physical: terminalPhysicalBindingToken({ ...value, agent: "codex" }),
    agentVersion: value.agentVersion, behaviorProfile: value.behaviorProfile
  });
}

export interface TerminalPermissionChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}
export interface TerminalPermissionCatalog {
  readonly agent: "codex";
  readonly agentVersion: string;
  readonly behaviorProfile: string;
  readonly scope: "current_session";
  readonly current: string;
  readonly choices: readonly TerminalPermissionChoice[];
  readonly catalogFingerprint: string;
}
export interface TerminalPermissionSwitchResult {
  readonly outcome: "changed" | "already_effective" | "uncertain";
  readonly requested: { readonly mode: string };
  readonly effective?: { readonly mode: string };
  readonly scope: "current_session";
  readonly defaultsChanged: false;
  readonly doNotRetry: boolean;
  readonly reason?: string;
}
export interface TerminalPermissionStatus {
  readonly threadId: string;
  readonly mode: string;
}
export type PermissionCapture = {
  readonly state: "idle" | "command" | "bare_command" | "blocked";
  readonly fingerprint: string;
} | Extract<CodexPermissionSurface, { state: "picker" | "full_access_confirmation" }>;
export interface TerminalPermissionControlPorts {
  capture(): Promise<PermissionCapture>;
  inspectStatus(): Promise<TerminalPermissionStatus>;
  input(action: "command" | "Up" | "Down" | "C-m" | "Escape" | "C-u", expected: PermissionCapture): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

/** A transport failure may have delivered input; no cleanup or retry follows it. */
export class TerminalPermissionInputUncertainError extends Error {
  readonly doNotRetry = true;
}

export function permissionModeFromStatus(value: string): string | undefined {
  if (value === "Full Access") return "full_access";
  if (value === "Workspace (Ask for approval)") return "ask_for_approval";
  if (value === "Workspace (Approve for me)") return "approve_for_me";
  // 0.160 projectless defaults may use granular approvals. This current-only
  // state is not a selectable preset and must never imply Ask for approval.
  if (value === "Workspace (granular)") return "workspace_granular";
  if (value === "Read Only (Ask for approval)" || value === "Read Only") return "read_only";
  return undefined;
}

type Picker = Extract<PermissionCapture, { state: "picker" }>;
type OwnedSurface = PermissionCapture["state"];

async function waitFor(
  ports: TerminalPermissionControlPorts, state: OwnedSurface
): Promise<PermissionCapture> {
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const captured = await ports.capture();
    if (captured.state === state) return captured;
    await ports.sleep(100);
  }
  throw new Error(`Codex permission control did not prove its ${state} postcondition`);
}

async function openPicker(ports: TerminalPermissionControlPorts): Promise<Picker> {
  const empty = await ports.capture();
  if (empty.state !== "idle") throw new Error("permission control requires an idle, exactly empty Codex Composer");
  await ports.input("command", empty);
  await ports.input("C-m", await waitFor(ports, "command"));
  return await waitFor(ports, "picker") as Picker;
}

async function dismiss(ports: TerminalPermissionControlPorts, picker: Picker): Promise<void> {
  await ports.input("Escape", picker);
  await waitFor(ports, "idle");
}

function catalog(
  profile: TerminalPermissionControlProfile,
  status: TerminalPermissionStatus,
  picker: Picker
): TerminalPermissionCatalog {
  const current = picker.rows.filter((row) => row.current);
  if (current.length > 1 || current.length === 1 && current[0]!.id !== status.mode ||
      current.length === 0 && picker.rows.some((row) => row.id === status.mode)) {
    throw new Error("native permission menu and fresh /status disagree about current permissions");
  }
  const choices = picker.rows.map(({ id, label, description }) => ({
    id, label, description
  }));
  return {
    agent: "codex", ...profile, current: status.mode, choices,
    catalogFingerprint: digest({ ...profile, threadId: status.threadId, current: status.mode, choices })
  };
}

/** Only clean up a freshly re-proven surface owned by this operation. */
async function cleanup(ports: TerminalPermissionControlPorts): Promise<void> {
  const frame = await ports.capture();
  if (frame.state === "picker") return dismiss(ports, frame);
  if (frame.state === "command") {
    await ports.input("Escape", frame);
    const bare = await waitFor(ports, "bare_command");
    await ports.input("C-u", bare);
    await waitFor(ports, "idle");
  } else if (frame.state === "bare_command") {
    await ports.input("C-u", frame);
    await waitFor(ports, "idle");
  } else if (frame.state !== "idle") {
    throw new TerminalPermissionInputUncertainError("permission cleanup cannot prove an empty Composer; do not retry automatically");
  }
}

export async function discoverTerminalPermissionOptions(
  profile: TerminalPermissionControlProfile, ports: TerminalPermissionControlPorts
): Promise<TerminalPermissionCatalog> {
  // Fresh status binds the catalog to a native thread, including paginated sessions
  // with no open rollout. No app-server write or persistent AKK Session is needed.
  const status = await ports.inspectStatus();
  try {
    const picker = await openPicker(ports);
    const result = catalog(profile, status, picker);
    await dismiss(ports, picker);
    return result;
  } catch (error) {
    if (!(error instanceof TerminalPermissionInputUncertainError)) {
      try { await cleanup(ports); } catch (cause) {
        throw new TerminalPermissionInputUncertainError("native permission cleanup is uncertain; do not retry automatically", { cause });
      }
    }
    throw error;
  }
}

export async function switchTerminalPermissions(
  profile: TerminalPermissionControlProfile, mode: string,
  expectedCatalogFingerprint: string, ports: TerminalPermissionControlPorts
): Promise<TerminalPermissionSwitchResult> {
  if (!["ask_for_approval", "approve_for_me", "full_access", "read_only"].includes(mode)) {
    throw new Error("permission mode must come from the current native permission catalog");
  }
  let status: TerminalPermissionStatus;
  try { status = await ports.inspectStatus(); } catch (error) {
    if (error instanceof TerminalPermissionInputUncertainError) return uncertain(mode);
    throw error;
  }
  let selectionAttempted = false;
  try {
    let picker = await openPicker(ports);
    const offered = catalog(profile, status, picker);
    if (offered.catalogFingerprint !== expectedCatalogFingerprint) {
      throw new Error("native thread or permission catalog changed; refresh permission-options");
    }
    const target = picker.rows.find((row) => row.id === mode);
    if (!target) throw new Error("requested permission mode is not available in this native menu");
    if (mode === offered.current) {
      await dismiss(ports, picker);
      return success("already_effective", mode);
    }
    picker = await selectPermissionRow(profile, status, picker, target.index,
      offered.catalogFingerprint, ports);
    selectionAttempted = true;
    await ports.input("C-m", picker);
    if (mode === "full_access") await confirmFullAccess(ports);
    await verifyPermissionSelection(profile, status, mode, ports);
    return success("changed", mode);
  } catch (error) {
    if (selectionAttempted || error instanceof TerminalPermissionInputUncertainError) {
      return uncertain(mode);
    }
    try { await cleanup(ports); } catch { return uncertain(mode); }
    throw error;
  }
}

async function selectPermissionRow(
  profile: TerminalPermissionControlProfile,
  status: TerminalPermissionStatus,
  initial: Picker,
  targetIndex: number,
  fingerprint: string,
  ports: TerminalPermissionControlPorts
): Promise<Picker> {
  let picker = initial;
  for (let moves = 0; picker.selectedIndex !== targetIndex; moves += 1) {
    if (moves >= picker.rows.length) throw new Error("native permission selection did not converge");
    const expectedIndex = picker.selectedIndex + (picker.selectedIndex < targetIndex ? 1 : -1);
    await ports.input(picker.selectedIndex < targetIndex ? "Down" : "Up", picker);
    picker = await waitForSelection(ports, "picker", expectedIndex) as Picker;
    if (catalog(profile, status, picker).catalogFingerprint !== fingerprint) {
      throw new Error("native permission catalog changed during selection");
    }
  }
  return picker;
}

async function confirmFullAccess(ports: TerminalPermissionControlPorts): Promise<void> {
  let confirmation = await waitFor(ports, "full_access_confirmation");
  if (confirmation.state !== "full_access_confirmation") throw new Error("full-access confirmation is unavailable");
  if (confirmation.selectedIndex !== 0) {
    await ports.input("Up", confirmation);
    confirmation = await waitForSelection(ports, "full_access_confirmation", 0);
  }
  await ports.input("C-m", confirmation);
}

async function verifyPermissionSelection(
  profile: TerminalPermissionControlProfile,
  previous: TerminalPermissionStatus,
  mode: string,
  ports: TerminalPermissionControlPorts
): Promise<void> {
  await waitFor(ports, "idle");
  // A request echo is not completion. Fresh /status plus a reopened current
  // menu marker must independently agree about this same native thread.
  const effective = await ports.inspectStatus();
  if (effective.threadId !== previous.threadId || effective.mode !== mode) {
    throw new Error("native permission update was not proven on the original thread");
  }
  const verified = await openPicker(ports);
  if (catalog(profile, effective, verified).current !== mode ||
      !verified.rows.some((row) => row.id === mode && row.current)) {
    throw new Error("native permission menu did not confirm the requested current mode");
  }
  await dismiss(ports, verified);
}

async function waitForSelection(
  ports: TerminalPermissionControlPorts, state: "picker" | "full_access_confirmation", index: number
): Promise<Extract<PermissionCapture, { state: "picker" | "full_access_confirmation" }>> {
  for (let attempt = 0; attempt < 35; attempt += 1) {
    const frame = await ports.capture();
    if (frame.state === state && frame.selectedIndex === index) return frame;
    await ports.sleep(100);
  }
  throw new Error("Codex permission selection did not match its expected row");
}

function success(outcome: "changed" | "already_effective", mode: string): TerminalPermissionSwitchResult {
  return { outcome, requested: { mode }, effective: { mode }, scope: "current_session", defaultsChanged: false, doNotRetry: false };
}
function uncertain(mode: string): TerminalPermissionSwitchResult {
  return { outcome: "uncertain", requested: { mode }, scope: "current_session", defaultsChanged: false,
    doNotRetry: true, reason: "Native permission input or its postcondition is uncertain; inspect the terminal and refresh permissions before another deliberate action." };
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
