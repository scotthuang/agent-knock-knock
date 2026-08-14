import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { isRecord } from "./value-guards.js";
import {
  TerminalControlInputNotSentError,
  TerminalControlUnavailableError,
  type CommandResult,
  type TerminalControlProvider,
  type TerminalViewport
} from "./terminal-control-provider.js";
import {
  createTerminalEndpointRef,
  herdrTerminalRouteKey,
  sameTerminalControlIncarnation,
  sameTerminalEndpointIdentity,
  terminalControlWithCapabilities,
  terminalEndpointFromControlRef,
  type HerdrTerminalControlRef,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalEndpointRef,
  type TerminalProviderCapability
} from "./terminal-control-ref.js";
import type { TerminalProcessSnapshot } from "./terminal-agent-adapter.js";

export const HERDR_EXACT_VERSION = "0.8.0";
export const HERDR_EXACT_PROTOCOL = 19;

const HERDR_MAX_REQUEST_BYTES = 1024 * 1024;
const HERDR_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const HERDR_DEFAULT_TIMEOUT_MS = 5_000;
const HERDR_MAX_READ_LINES = 1_000;
const HERDR_MAX_TTY_PATH_BYTES = 1_024;
const HERDR_MAX_TTY_VIEWPORT_DIMENSION = 65_535;

type JsonRecord = Record<string, unknown>;

export interface HerdrWireRequest {
  id: string;
  method: string;
  params: JsonRecord;
}

export interface HerdrSocketIdentity {
  device: string;
  inode: string;
  ctimeNs: string;
  ownerUid?: number;
}

export interface HerdrTtyDeviceIdentity {
  device: string;
  inode: string;
  rdev: string;
  ctimeNs: string;
  ownerUid: number;
  symbolicLink: boolean;
  characterDevice: boolean;
}

export interface HerdrTtyViewportInspectionOptions {
  platform?: NodeJS.Platform;
  runCommand?: (command: string, args: string[]) => CommandResult;
  statTty?: (ttyPath: string) => HerdrTtyDeviceIdentity;
  currentUid?: number;
}

export type HerdrTtyViewportInspector = (
  shellPid: number
) =>
  | TerminalViewport
  | undefined
  | Promise<TerminalViewport | undefined>;

interface HerdrProcessTtyEvidence {
  pid: number;
  ttyPath: string;
  processBirth: string;
}

export interface HerdrRequestOptions {
  expectedSocketIdentity?: HerdrSocketIdentity;
}

export type HerdrRequestFunction = (
  socketPath: string,
  request: HerdrWireRequest,
  options?: HerdrRequestOptions
) => Promise<unknown>;

export interface HerdrSessionInfo {
  name: string;
  default: boolean;
  running: boolean;
  socketPath: string;
  sessionDir: string;
}

interface HerdrPaneInfo {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  cwd?: string;
  foregroundCwd?: string;
}

interface HerdrForegroundProcess {
  pid: number;
  name: string;
  argv0?: string;
  argv?: string[];
  cmdline?: string;
  cwd?: string;
}

interface HerdrPaneProcessInfo {
  paneId: string;
  shellPid?: number;
  foregroundProcessGroupId?: number;
  foregroundProcesses: HerdrForegroundProcess[];
}

interface HerdrSessionInspection {
  session: HerdrSessionInfo;
  endpoints: TerminalEndpointRef[];
  skippedWithoutShellPid: string[];
}

interface ResolvedHerdrControl {
  control: HerdrTerminalControlRef;
  socketIdentity: HerdrSocketIdentity;
}

export interface HerdrTerminalControlDiagnostics {
  commands: string[];
  selectedCommand?: string;
  expectedVersion: string;
  expectedProtocol: number;
  sessions: HerdrSessionInfo[];
  attempts: Array<{
    session: string;
    socketPath: string;
    status: "ok" | "error";
    paneCount?: number;
    skippedWithoutShellPid?: string[];
    error?: string;
  }>;
  terminalCount: number;
}

/** A structured Herdr API rejection received after a complete request. */
export class HerdrApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string
  ) {
    super(message);
    this.name = "HerdrApiError";
  }
}

/**
 * Raw socket failure with an explicit dispatch boundary.
 *
 * `definitelyNotSent` is true only when the Unix socket never connected or
 * the request was rejected locally before any socket write was attempted.
 */
export class HerdrTransportError extends Error {
  constructor(
    message: string,
    readonly definitelyNotSent: boolean,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "HerdrTransportError";
  }
}

class HerdrProviderUnavailableError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "HerdrProviderUnavailableError";
  }
}

class HerdrCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrCompatibilityError";
  }
}

/**
 * Send one newline-delimited JSON request over a Herdr Unix-domain socket.
 * Normal Herdr requests receive exactly one newline-delimited JSON response.
 */
export function requestHerdrUnixSocket(
  socketPath: string,
  request: HerdrWireRequest,
  options: {
    timeoutMs?: number;
    maxResponseBytes?: number;
    expectedSocketIdentity?: HerdrSocketIdentity;
  } = {}
): Promise<unknown> {
  let encoded: string;
  try {
    encoded = `${JSON.stringify(request)}\n`;
  } catch (error) {
    return Promise.reject(new HerdrTransportError(
      `failed to encode Herdr request: ${describeError(error)}`,
      true,
      { cause: error }
    ));
  }
  if (Buffer.byteLength(encoded) > HERDR_MAX_REQUEST_BYTES) {
    return Promise.reject(new HerdrTransportError(
      `Herdr request exceeds ${HERDR_MAX_REQUEST_BYTES} bytes`,
      true
    ));
  }

  const timeoutMs = positiveInteger(options.timeoutMs) ?? HERDR_DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = positiveInteger(options.maxResponseBytes) ??
    HERDR_MAX_RESPONSE_BYTES;

  return new Promise((resolve, reject) => {
    let connected = false;
    let settled = false;
    let response = "";
    const socket = createConnection({ path: socketPath });
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);

    const fail = (message: string, definitelyNotSent: boolean, cause?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      reject(new HerdrTransportError(message, definitelyNotSent, { cause }));
    };

    socket.once("connect", () => {
      if (settled) {
        return;
      }
      connected = true;
      if (options.expectedSocketIdentity) {
        let liveSocketIdentity: HerdrSocketIdentity;
        try {
          liveSocketIdentity = readHerdrSocketIdentity(socketPath);
        } catch (error) {
          fail(
            `failed to revalidate Herdr socket ${socketPath}: ${describeError(error)}`,
            true,
            error
          );
          return;
        }
        if (!sameHerdrSocketIdentity(
          options.expectedSocketIdentity,
          liveSocketIdentity
        )) {
          fail(
            `Herdr socket ${socketPath} changed before request dispatch`,
            true
          );
          return;
        }
      }
      try {
        socket.write(encoded, (error?: Error | null) => {
          if (error) {
            // A connected stream may have accepted a prefix before reporting
            // an error, so this boundary is deliberately uncertain.
            fail(`failed to write Herdr request: ${error.message}`, false, error);
          }
        });
      } catch (error) {
        // The socket connected, so even a synchronous write failure is kept
        // conservative: implementations may have accepted a prefix first.
        fail(`failed to write Herdr request: ${describeError(error)}`, false, error);
      }
    });
    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }
      response += String(chunk);
      if (Buffer.byteLength(response) > maxResponseBytes) {
        fail(`Herdr response exceeds ${maxResponseBytes} bytes`, false);
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = response.slice(0, newline).trim();
      if (!line) {
        fail("Herdr returned an empty response", false);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        fail(
          `Herdr returned invalid JSON: ${describeError(error)}`,
          false,
          error
        );
        return;
      }
      settled = true;
      socket.destroy();
      resolve(parsed);
    });
    socket.once("timeout", () => {
      fail(
        `timed out waiting for Herdr socket ${socketPath}`,
        !connected
      );
    });
    socket.once("error", (error) => {
      fail(
        `Herdr socket ${socketPath} failed: ${error.message}`,
        !connected,
        error
      );
    });
    socket.once("end", () => {
      if (!settled) {
        fail("Herdr closed the socket without a response", false);
      }
    });
    socket.once("close", () => {
      if (!settled) {
        fail("Herdr closed the socket without a response", !connected);
      }
    });
  });
}

export class HerdrTerminalControlProvider implements TerminalControlProvider {
  readonly kind = "herdr";
  readonly supportedCapabilities: readonly TerminalControlCapability[] = [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ];
  readonly providerCapabilities: readonly TerminalProviderCapability[] = [
    "screen_capture",
    "ansi_capture",
    "text_delivery",
    "key_delivery",
    "process_inspection",
    "stable_resource_resolution"
  ];

  private readonly commands: string[];
  private selectedCommand?: string;
  private readonly runCommand: (command: string, args: string[]) => CommandResult;
  private readonly request: HerdrRequestFunction;
  private readonly statSocket: (socketPath: string) => HerdrSocketIdentity;
  private readonly inspectTtyViewport: HerdrTtyViewportInspector;
  private readonly endpointSocketIdentities =
    new WeakMap<TerminalEndpointRef, HerdrSocketIdentity>();
  private requestSequence = 0;

  constructor(options: {
    command?: string;
    runCommand?: (command: string, args: string[]) => CommandResult;
    request?: HerdrRequestFunction;
    requestTimeoutMs?: number;
    statSocket?: (socketPath: string) => HerdrSocketIdentity;
    inspectTtyViewport?: HerdrTtyViewportInspector;
  } = {}) {
    this.commands = options.command
      ? [options.command]
      : ["herdr", "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"];
    this.runCommand = options.runCommand ?? runHerdrCommand;
    this.statSocket = options.statSocket ?? readHerdrSocketIdentity;
    this.inspectTtyViewport = options.inspectTtyViewport ??
      inspectHerdrTtyViewport;
    const requestTimeoutMs = options.requestTimeoutMs;
    this.request = options.request ?? ((socketPath, request, requestOptions) =>
      requestHerdrUnixSocket(socketPath, request, {
        timeoutMs: requestTimeoutMs,
        expectedSocketIdentity: requestOptions?.expectedSocketIdentity
      }));
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    const diagnostics: HerdrTerminalControlDiagnostics = {
      commands: [...this.commands],
      selectedCommand: this.selectedCommand,
      expectedVersion: HERDR_EXACT_VERSION,
      expectedProtocol: HERDR_EXACT_PROTOCOL,
      sessions: [],
      attempts: [],
      terminalCount: 0
    };
    let sessions: HerdrSessionInfo[];
    try {
      sessions = this.discoverSessions();
      diagnostics.selectedCommand = this.selectedCommand;
      diagnostics.sessions = sessions;
    } catch (error) {
      diagnostics.selectedCommand = this.selectedCommand;
      diagnostics.attempts.push({
        session: "<discovery>",
        socketPath: "",
        status: "error",
        error: describeError(error)
      });
      return diagnostics as unknown as Record<string, unknown>;
    }

    for (const session of sessions.filter((candidate) => candidate.running)) {
      try {
        const inspection = await this.inspectSession(session);
        diagnostics.terminalCount += inspection.endpoints.length;
        diagnostics.attempts.push({
          session: session.name,
          socketPath: session.socketPath,
          status: "ok",
          paneCount: inspection.endpoints.length,
          skippedWithoutShellPid: inspection.skippedWithoutShellPid
        });
      } catch (error) {
        diagnostics.attempts.push({
          session: session.name,
          socketPath: session.socketPath,
          status: "error",
          error: describeError(error)
        });
      }
    }
    return diagnostics as unknown as Record<string, unknown>;
  }

  async listTerminals(): Promise<TerminalEndpointRef[]> {
    let sessions: HerdrSessionInfo[];
    try {
      sessions = this.discoverSessions().filter((session) => session.running);
    } catch (error) {
      if (error instanceof HerdrProviderUnavailableError) {
        return [];
      }
      throw error;
    }
    const inspections = await Promise.all(sessions.map(async (session) => {
      try {
        return await this.inspectSession(session);
      } catch (error) {
        // A session running an incompatible Herdr release is unavailable to
        // this exact-gated provider, but must not break discovery by another
        // provider in the registry. Other live API failures remain fail-closed.
        if (error instanceof HerdrCompatibilityError) {
          return undefined;
        }
        throw error;
      }
    }));
    const endpoints = inspections.flatMap((inspection) =>
      inspection?.endpoints ?? []);
    const seen = new Set<string>();
    for (const endpoint of endpoints) {
      const key = `${endpoint.identity.endpointKey}\0${endpoint.identity.resourceKey}`;
      if (seen.has(key)) {
        throw new Error(
          `Herdr returned duplicate stable terminal identity ${endpoint.identity.resourceKey} ` +
          `from ${endpoint.identity.endpointKey}`
        );
      }
      seen.add(key);
    }
    return endpoints;
  }

  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef {
    if (terminalControl.kind !== this.kind) {
      throw new Error(
        `terminal control provider ${this.kind} cannot resolve ${terminalControl.kind}`
      );
    }
    return terminalEndpointFromControlRef(terminalControl);
  }

  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities: readonly TerminalControlCapability[] = terminal.capabilities
  ): TerminalControlRef {
    const control = herdrControlFromEndpoint(terminal);
    return terminalControlWithCapabilities(
      control,
      intersectCapabilities(
        intersectCapabilities(capabilities, terminal.capabilities),
        this.supportedCapabilities
      )
    );
  }

  async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
    assertProviderCapability(
      this.providerCapabilities,
      "stable_resource_resolution"
    );
    assertEndpointKind(terminal, this.kind);
    const matches = (await this.listTerminals()).filter((candidate) =>
      sameTerminalEndpointIdentity(candidate, terminal)
    );
    if (matches.length === 0) {
      throw new TerminalControlUnavailableError(
        `Herdr terminal resource ${terminal.route.label} is no longer available`
      );
    }
    if (matches.length !== 1) {
      throw new Error(
        `Herdr terminal resource ${terminal.route.label} is ambiguous`
      );
    }
    const expectedSocketIdentity = this.endpointSocketIdentities.get(terminal);
    const candidateSocketIdentity = this.endpointSocketIdentities.get(matches[0]);
    if (
      expectedSocketIdentity &&
      (!candidateSocketIdentity || !sameHerdrSocketIdentity(
        expectedSocketIdentity,
        candidateSocketIdentity
      ))
    ) {
      throw new Error(
        `Herdr server socket changed while resolving ${terminal.route.label}`
      );
    }
    const resolved = endpointWithCapabilities(
      matches[0],
      intersectCapabilities(terminal.capabilities, this.supportedCapabilities)
    );
    const socketIdentity = candidateSocketIdentity;
    if (!socketIdentity) {
      throw new Error(
        `Herdr terminal resource ${terminal.route.label} is missing socket-incarnation evidence`
      );
    }
    this.endpointSocketIdentities.set(resolved, socketIdentity);
    return resolved;
  }

  containsProcess(
    terminal: TerminalEndpointRef,
    process: Pick<TerminalProcessSnapshot, "pid" | "ppid">,
    processes: readonly Pick<TerminalProcessSnapshot, "pid" | "ppid">[]
  ): boolean {
    assertEndpointKind(terminal, this.kind);
    assertProviderCapability(this.providerCapabilities, "process_inspection");
    const shellPid = positiveInteger(terminal.processAnchorPid);
    if (shellPid === undefined) {
      return false;
    }
    if (process.pid === shellPid) {
      return true;
    }
    const byPid = new Map(processes.map((candidate) => [candidate.pid, candidate]));
    let parentPid = process.ppid;
    const visited = new Set<number>([process.pid]);
    while (true) {
      const currentParentPid = positiveInteger(parentPid);
      if (currentParentPid === undefined || visited.has(currentParentPid)) {
        break;
      }
      if (currentParentPid === shellPid) {
        return true;
      }
      visited.add(currentParentPid);
      parentPid = byPid.get(currentParentPid)?.ppid;
    }
    return false;
  }

  async inspectViewport(
    terminal: TerminalEndpointRef
  ): Promise<TerminalViewport | undefined> {
    assertEndpointKind(terminal, this.kind);
    const resolved = await this.resolve(terminal);
    if (!sameTerminalControlIncarnation(terminal, resolved)) {
      throw new Error(
        "Herdr terminal stable resource or process anchor changed before viewport inspection"
      );
    }
    const control = herdrControlFromEndpoint(resolved);
    const socketIdentity = this.requireEndpointSocketIdentity(resolved);
    const result = await this.invoke(
      control.socketPath!,
      "session.snapshot",
      {},
      { expectedSocketIdentity: socketIdentity }
    );
    if (result.type !== "session_snapshot" || !isRecord(result.snapshot)) {
      throw new Error(
        `Herdr session ${control.session} returned an unexpected viewport snapshot`
      );
    }
    if (
      result.snapshot.version !== HERDR_EXACT_VERSION ||
      result.snapshot.protocol !== HERDR_EXACT_PROTOCOL
    ) {
      throw new HerdrCompatibilityError(
        `Herdr session ${control.session} viewport snapshot is not exact ` +
        `${HERDR_EXACT_VERSION}/protocol ${HERDR_EXACT_PROTOCOL}`
      );
    }
    if (!Array.isArray(result.snapshot.panes)) {
      throw new Error(
        `Herdr session ${control.session} viewport snapshot panes are invalid`
      );
    }
    const matchingPanes = result.snapshot.panes
      .map((value, index) =>
        parsePaneInfo(value, `${control.session} viewport pane ${index}`))
      .filter((pane) => pane.paneId === control.paneId);
    if (matchingPanes.length !== 1) {
      throw new Error(
        `Herdr terminal ${control.target} changed during viewport inspection`
      );
    }
    const [pane] = matchingPanes;
    if (
      pane.terminalId !== control.terminalId ||
      pane.workspaceId !== control.workspaceId ||
      pane.tabId !== control.tabId
    ) {
      throw new Error(
        `Herdr terminal ${control.target} identity or route changed during viewport inspection`
      );
    }

    if (result.snapshot.layouts === undefined) {
      return undefined;
    }
    if (!Array.isArray(result.snapshot.layouts)) {
      throw new Error(
        `Herdr session ${control.session} viewport snapshot layouts are invalid`
      );
    }
    const matchingLayouts = result.snapshot.layouts.filter((value, index) => {
      if (!isRecord(value)) {
        throw new Error(
          `invalid Herdr ${control.session} viewport layout ${index}`
        );
      }
      const workspaceId = nonEmptyString(value.workspace_id);
      const tabId = nonEmptyString(value.tab_id);
      if (!workspaceId || !tabId) {
        throw new Error(
          `invalid Herdr ${control.session} viewport layout ${index} route`
        );
      }
      return workspaceId === control.workspaceId && tabId === control.tabId;
    });
    if (matchingLayouts.length === 0) {
      return undefined;
    }
    if (matchingLayouts.length !== 1) {
      throw new Error(
        `Herdr terminal ${control.target} has an ambiguous viewport layout`
      );
    }
    const layout = matchingLayouts[0];
    if (typeof layout.zoomed !== "boolean") {
      throw new Error(
        `Herdr terminal ${control.target} viewport layout zoom state is invalid`
      );
    }
    const layoutPanes = layout.panes;
    if (layoutPanes === undefined) {
      return undefined;
    }
    if (!Array.isArray(layoutPanes)) {
      throw new Error(
        `Herdr terminal ${control.target} viewport layout panes are invalid`
      );
    }
    const matchingLayoutPanes = layoutPanes.filter((value, index) => {
      if (!isRecord(value)) {
        throw new Error(
          `invalid Herdr ${control.target} viewport layout pane ${index}`
        );
      }
      const paneId = nonEmptyString(value.pane_id);
      if (!paneId) {
        throw new Error(
          `invalid Herdr ${control.target} viewport layout pane ${index} identity`
        );
      }
      return paneId === control.paneId;
    });
    if (matchingLayoutPanes.length === 0) {
      return undefined;
    }
    if (matchingLayoutPanes.length !== 1) {
      throw new Error(
        `Herdr terminal ${control.target} has an ambiguous viewport rectangle`
      );
    }
    const layoutPane = matchingLayoutPanes[0];
    const paneFocused = layoutPane.focused;
    if (typeof paneFocused !== "boolean") {
      throw new Error(
        `Herdr terminal ${control.target} viewport layout pane focus is invalid`
      );
    }
    const focusedPaneId = nonEmptyString(layout.focused_pane_id);
    if (
      layout.focused_pane_id !== undefined &&
      focusedPaneId === undefined
    ) {
      throw new Error(
        `Herdr terminal ${control.target} viewport layout focused pane identity is invalid`
      );
    }

    if (layout.zoomed === true) {
      if (!focusedPaneId) {
        throw new Error(
          `Herdr terminal ${control.target} zoomed viewport requires an exact focused pane identity`
        );
      }
      if (focusedPaneId !== control.paneId) {
        if (paneFocused === true) {
          throw new Error(
            `Herdr terminal ${control.target} zoomed viewport focus metadata is inconsistent`
          );
        }
        return undefined;
      }
      if (paneFocused !== true) {
        throw new Error(
          `Herdr terminal ${control.target} zoomed viewport focus metadata is inconsistent or missing`
        );
      }
    } else if (
      focusedPaneId !== undefined &&
      (
        (focusedPaneId === control.paneId && paneFocused === false) ||
        (focusedPaneId !== control.paneId && paneFocused === true)
      )
    ) {
      throw new Error(
        `Herdr terminal ${control.target} viewport focus metadata is inconsistent`
      );
    }

    const shellPid = positiveInteger(resolved.processAnchorPid);
    if (!shellPid) {
      return undefined;
    }
    const viewport = await this.inspectTtyViewport(shellPid);
    if (viewport === undefined) {
      return undefined;
    }
    const columns = positiveInteger(viewport.columns);
    const rows = positiveInteger(viewport.rows);
    if (
      !columns ||
      !rows ||
      columns > HERDR_MAX_TTY_VIEWPORT_DIMENSION ||
      rows > HERDR_MAX_TTY_VIEWPORT_DIMENSION
    ) {
      throw new Error(
        `Herdr terminal ${control.target} returned invalid exact PTY viewport dimensions`
      );
    }
    const finalResolved = await this.resolve(resolved);
    if (!sameTerminalControlIncarnation(resolved, finalResolved)) {
      throw new Error(
        `Herdr terminal ${control.target} changed after exact PTY viewport inspection`
      );
    }
    return { columns, rows };
  }

  async capture(
    terminal: TerminalEndpointRef,
    options: { scrollbackLines?: number; preserveEscapes?: boolean } = {}
  ): Promise<string> {
    assertEndpointCapability(terminal, "screen_status");
    assertProviderCapability(
      this.providerCapabilities,
      options.preserveEscapes ? "ansi_capture" : "screen_capture"
    );
    const resolved = await this.resolve(terminal);
    if (!sameTerminalControlIncarnation(terminal, resolved)) {
      throw new Error(
        "Herdr terminal stable resource or process anchor changed before capture"
      );
    }
    const control = herdrControlFromEndpoint(resolved);
    const socketIdentity = this.requireEndpointSocketIdentity(resolved);
    const requestedLines = Number.isFinite(options.scrollbackLines)
      ? Math.max(0, Math.floor(options.scrollbackLines ?? 200))
      : 200;
    // Herdr 0.8.0's detection buffer is the right agent-aware source for
    // plain status reads, but it normalizes away SGR styling even when
    // format=ansi. Codex uses dim styling to distinguish an empty composer
    // placeholder from real draft text, so ANSI captures must come from the
    // visible terminal buffer where those escapes are preserved.
    const source = options.preserveEscapes ? "visible" : "detection";
    const format = options.preserveEscapes ? "ansi" : "text";
    const result = await this.invoke(
      control.socketPath!,
      "pane.read",
      {
        pane_id: control.paneId,
        // Herdr's recent scrollback may be empty for a live Claude alternate
        // screen. Plain reads therefore use its populated agent-detection
        // buffer; ANSI reads use the visible buffer to retain composer style.
        source,
        lines: Math.min(requestedLines, HERDR_MAX_READ_LINES),
        format
      },
      { expectedSocketIdentity: socketIdentity }
    );
    if (result.type !== "pane_read" || !isRecord(result.read)) {
      throw new Error("Herdr pane.read returned an unexpected result");
    }
    if (
      result.read.pane_id !== control.paneId ||
      result.read.workspace_id !== control.workspaceId ||
      result.read.tab_id !== control.tabId ||
      result.read.source !== source ||
      result.read.format !== format ||
      typeof result.read.text !== "string"
    ) {
      throw new Error("Herdr pane.read returned mismatched pane data");
    }
    return result.read.text;
  }

  async sendText(terminal: TerminalEndpointRef, text: string): Promise<void> {
    assertInputEndpointCapability(
      terminal,
      this.providerCapabilities,
      "text_delivery"
    );
    if (text.length === 0) {
      return;
    }
    const resolved = await this.resolveForInput(terminal);
    await this.sendInput(resolved, { text });
  }

  async sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    assertInputEndpointCapability(
      terminal,
      this.providerCapabilities,
      "key_delivery"
    );
    let translated: string[];
    try {
      translated = keys.map(translateHerdrKey);
    } catch (error) {
      throw new TerminalControlInputNotSentError(describeError(error));
    }
    if (translated.length === 0) {
      return;
    }
    const resolved = await this.resolveForInput(terminal);
    await this.sendInput(resolved, { keys: translated });
  }

  private discoverSessions(): HerdrSessionInfo[] {
    try {
      const { command, version } = this.probeCommand();
      if (version.status !== 0) {
        throw new HerdrProviderUnavailableError(
          version.stderr || version.error?.message ||
          `failed to run ${command} --version`
        );
      }
      const reportedVersion = version.stdout.trim();
      if (reportedVersion !== `herdr ${HERDR_EXACT_VERSION}`) {
        throw new HerdrProviderUnavailableError(
          `Herdr provider requires exact CLI ${HERDR_EXACT_VERSION}; ` +
          `found ${reportedVersion || "unknown"}`
        );
      }

      const result = this.runCommand(command, ["session", "list", "--json"]);
      if (result.status !== 0) {
        throw new HerdrProviderUnavailableError(
          result.stderr || result.error?.message || "herdr session list failed"
        );
      }
      return parseHerdrSessionList(result.stdout);
    } catch (error) {
      if (error instanceof HerdrProviderUnavailableError) {
        throw error;
      }
      throw new HerdrProviderUnavailableError(
        `Herdr provider is unavailable: ${describeError(error)}`,
        { cause: error }
      );
    }
  }

  private probeCommand(): { command: string; version: CommandResult } {
    if (this.selectedCommand) {
      return {
        command: this.selectedCommand,
        version: this.runCommand(this.selectedCommand, ["--version"])
      };
    }
    let lastError: Error | undefined;
    for (const command of this.commands) {
      const result = this.runCommand(command, ["--version"]);
      if (
        result.status === null &&
        commandDefinitelyDidNotStart(result.error)
      ) {
        lastError = result.error;
        continue;
      }
      // Once a candidate starts, pin it. A version mismatch or any later
      // failure must not silently switch to a different installation.
      this.selectedCommand = command;
      return { command, version: result };
    }
    throw new HerdrProviderUnavailableError(
      lastError?.message || "no Herdr executable candidate could be started",
      { cause: lastError }
    );
  }

  private async inspectSession(
    session: HerdrSessionInfo
  ): Promise<HerdrSessionInspection> {
    const socketIdentity = this.statSocket(session.socketPath);
    await this.assertCompatibleServer(session, socketIdentity);
    const result = await this.invoke(
      session.socketPath,
      "session.snapshot",
      {},
      { expectedSocketIdentity: socketIdentity }
    );
    if (result.type !== "session_snapshot" || !isRecord(result.snapshot)) {
      throw new Error(
        `Herdr session ${session.name} returned an unexpected session.snapshot result`
      );
    }
    if (
      result.snapshot.version !== HERDR_EXACT_VERSION ||
      result.snapshot.protocol !== HERDR_EXACT_PROTOCOL
    ) {
      throw new HerdrCompatibilityError(
        `Herdr session ${session.name} snapshot is not exact ` +
        `${HERDR_EXACT_VERSION}/protocol ${HERDR_EXACT_PROTOCOL}`
      );
    }
    if (!Array.isArray(result.snapshot.panes)) {
      throw new Error(`Herdr session ${session.name} snapshot panes are invalid`);
    }
    const panes = result.snapshot.panes.map((value, index) =>
      parsePaneInfo(value, `${session.name} pane ${index}`));
    const processInfos = await Promise.all(panes.map(async (pane) => {
      try {
          const processResult = await this.invoke(
            session.socketPath,
            "pane.process_info",
            { pane_id: pane.paneId },
            { expectedSocketIdentity: socketIdentity }
          );
        if (
          processResult.type !== "pane_process_info" ||
          !isRecord(processResult.process_info)
        ) {
          throw new Error(
            `Herdr pane.process_info returned an unexpected result for ${pane.paneId}`
          );
        }
        return parsePaneProcessInfo(processResult.process_info, pane.paneId);
      } catch (error) {
        // A pane may close between snapshot and inspection. It must not be
        // rebound to another resource; simply omit the vanished pane.
        if (error instanceof HerdrApiError && error.code === "pane_not_found") {
          return undefined;
        }
        throw error;
      }
    }));

    // A server restart can reuse a public pane route while representing a new
    // PTY. Re-read the authoritative snapshot after process inspection and
    // only join process data to a pane whose stable terminal identity and
    // route metadata are unchanged on the same socket incarnation.
    const verifiedSnapshotResult = await this.invoke(
      session.socketPath,
      "session.snapshot",
      {},
      { expectedSocketIdentity: socketIdentity }
    );
    if (
      verifiedSnapshotResult.type !== "session_snapshot" ||
      !isRecord(verifiedSnapshotResult.snapshot) ||
      verifiedSnapshotResult.snapshot.version !== HERDR_EXACT_VERSION ||
      verifiedSnapshotResult.snapshot.protocol !== HERDR_EXACT_PROTOCOL ||
      !Array.isArray(verifiedSnapshotResult.snapshot.panes)
    ) {
      throw new Error(
        `Herdr session ${session.name} changed during terminal discovery`
      );
    }
    const verifiedPanesByRoute = new Map(
      verifiedSnapshotResult.snapshot.panes.map((value, index) => {
        const pane = parsePaneInfo(value, `${session.name} verified pane ${index}`);
        return [pane.paneId, pane] as const;
      })
    );

    const skippedWithoutShellPid: string[] = [];
    const endpoints: TerminalEndpointRef[] = [];
    for (let index = 0; index < panes.length; index += 1) {
      const pane = panes[index];
      const processInfo = processInfos[index];
      if (!processInfo) {
        continue;
      }
      const verifiedPane = verifiedPanesByRoute.get(pane.paneId);
      if (
        !verifiedPane ||
        verifiedPane.terminalId !== pane.terminalId ||
        verifiedPane.workspaceId !== pane.workspaceId ||
        verifiedPane.tabId !== pane.tabId
      ) {
        continue;
      }
      if (!positiveInteger(processInfo.shellPid)) {
        // The current bridge requires a positive process anchor to prove PID
        // containment before mutations. Never substitute cwd or display data.
        skippedWithoutShellPid.push(pane.paneId);
        continue;
      }
      const endpoint = endpointFromPane(
        session,
        verifiedPane,
        processInfo,
        this.supportedCapabilities
      );
      this.endpointSocketIdentities.set(endpoint, socketIdentity);
      endpoints.push(endpoint);
    }
    return { session, endpoints, skippedWithoutShellPid };
  }

  private async assertCompatibleServer(
    session: HerdrSessionInfo,
    socketIdentity: HerdrSocketIdentity
  ): Promise<void> {
    let result: JsonRecord;
    try {
      result = await this.invoke(
        session.socketPath,
        "ping",
        {},
        { expectedSocketIdentity: socketIdentity }
      );
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "protocol_mismatch") {
        throw new HerdrCompatibilityError(
          `Herdr session ${session.name} rejected protocol ${HERDR_EXACT_PROTOCOL}`
        );
      }
      throw error;
    }
    if (
      result.type !== "pong" ||
      result.version !== HERDR_EXACT_VERSION ||
      result.protocol !== HERDR_EXACT_PROTOCOL
    ) {
      throw new HerdrCompatibilityError(
        `Herdr session ${session.name} requires exact server ` +
        `${HERDR_EXACT_VERSION}/protocol ${HERDR_EXACT_PROTOCOL}; found ` +
        `${String(result.version ?? "unknown")}/protocol ` +
        `${String(result.protocol ?? "unknown")}`
      );
    }
  }

  private async invoke(
    socketPath: string,
    method: string,
    params: JsonRecord,
    options: HerdrRequestOptions = {}
  ): Promise<JsonRecord> {
    const request: HerdrWireRequest = {
      id: `akk:herdr:${++this.requestSequence}`,
      method,
      params
    };
    const value = await this.request(socketPath, request, options);
    if (!isRecord(value)) {
      throw new Error(`Herdr ${method} returned a non-object response`);
    }
    const responseId = typeof value.id === "string" ? value.id : undefined;
    if (isRecord(value.error)) {
      const code = nonEmptyString(value.error.code) ?? "unknown_error";
      const message = nonEmptyString(value.error.message) ?? `Herdr ${method} failed`;
      if (responseId !== request.id && !(code === "invalid_request" && responseId === "")) {
        throw new Error(
          `Herdr ${method} returned mismatched response id ${responseId ?? "<missing>"}`
        );
      }
      throw new HerdrApiError(code, message, responseId ?? "");
    }
    if (responseId !== request.id || !isRecord(value.result)) {
      throw new Error(`Herdr ${method} returned an invalid response envelope`);
    }
    return value.result;
  }

  private async resolveForInput(
    terminal: TerminalEndpointRef
  ): Promise<ResolvedHerdrControl> {
    try {
      const resolved = await this.resolve(terminal);
      if (!sameTerminalControlIncarnation(terminal, resolved)) {
        throw new Error(
          "Herdr terminal stable resource or process anchor changed before input"
        );
      }
      return {
        control: herdrControlFromEndpoint(resolved),
        socketIdentity: this.requireEndpointSocketIdentity(resolved)
      };
    } catch (error) {
      // No terminal input method has been attempted at this point, including
      // when a read-only freshness probe timed out.
      throw new TerminalControlInputNotSentError(
        `Herdr input was not sent: ${describeError(error)}`
      );
    }
  }

  private async sendInput(
    resolved: ResolvedHerdrControl,
    params: { text: string } | { keys: string[] }
  ): Promise<void> {
    const { control, socketIdentity } = resolved;
    try {
      const result = await this.invoke(
        control.socketPath!,
        "pane.send_input",
        {
          pane_id: control.paneId,
          ...params
        },
        { expectedSocketIdentity: socketIdentity }
      );
      if (result.type !== "ok") {
        // A syntactically valid success response arrived after dispatch but did
        // not acknowledge the expected operation. Its effect is uncertain.
        throw new Error("Herdr pane.send_input returned an unexpected result");
      }
    } catch (error) {
      if (inputDefinitelyNotSent(error)) {
        throw new TerminalControlInputNotSentError(
          `Herdr input was not sent: ${describeError(error)}`
        );
      }
      // Request ids are correlation only. Herdr 0.8.0 has no idempotency key,
      // so a post-connect timeout, EOF, malformed response, or lost ACK must
      // remain uncertain and must never be retried here.
      throw error;
    }
  }

  private requireEndpointSocketIdentity(
    terminal: TerminalEndpointRef
  ): HerdrSocketIdentity {
    const identity = this.endpointSocketIdentities.get(terminal);
    if (!identity) {
      throw new Error(
        `Herdr terminal resource ${terminal.route.label} is missing socket-incarnation evidence`
      );
    }
    return identity;
  }
}

export function parseHerdrSessionList(output: string): HerdrSessionInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`invalid herdr session list JSON: ${describeError(error)}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
    throw new Error("invalid herdr session list response");
  }
  const sessions = parsed.sessions.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`invalid herdr session record ${index}`);
    }
    const name = nonEmptyString(value.name);
    const socketPath = nonEmptyString(value.socket_path);
    const sessionDir = nonEmptyString(value.session_dir);
    if (
      !name ||
      !socketPath ||
      !sessionDir ||
      !path.isAbsolute(socketPath) ||
      !path.isAbsolute(sessionDir) ||
      typeof value.default !== "boolean" ||
      typeof value.running !== "boolean"
    ) {
      throw new Error(`invalid herdr session record ${index}`);
    }
    return {
      name,
      default: value.default,
      running: value.running,
      socketPath: path.normalize(socketPath),
      sessionDir: path.normalize(sessionDir)
    };
  });
  const seen = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.socketPath)) {
      throw new Error(`duplicate Herdr session socket ${session.socketPath}`);
    }
    seen.add(session.socketPath);
  }
  return sessions;
}

/** Translate the tmux-oriented bridge key vocabulary to Herdr key combos. */
export function translateHerdrKey(value: string): string {
  const key = value.trim();
  if (!key || /^prefix\+/iu.test(key)) {
    throw new Error(`unsupported Herdr key ${value || "<empty>"}`);
  }
  const lower = key.toLowerCase();
  const aliases: Record<string, string> = {
    "c-m": "enter",
    enter: "enter",
    return: "enter",
    escape: "esc",
    esc: "esc",
    "s-tab": "shift+tab",
    btab: "shift+tab",
    bspace: "backspace",
    backspace: "backspace",
    space: "space",
    tab: "tab",
    left: "left",
    right: "right",
    up: "up",
    down: "down",
    home: "home",
    end: "end",
    insert: "insert",
    delete: "delete",
    dc: "delete",
    pageup: "pageup",
    pagedown: "pagedown",
    pgup: "pageup",
    pgdn: "pagedown",
    "+": "plus",
    "-": "minus",
    "`": "backtick"
  };
  if (aliases[lower]) {
    return aliases[lower];
  }
  if (/^f(?:[1-9]|1[0-2])$/u.test(lower)) {
    return lower;
  }
  const tmuxModifier = /^(c|m|s)-(.+)$/iu.exec(key);
  if (tmuxModifier) {
    const modifier = tmuxModifier[1].toLowerCase() === "c"
      ? "ctrl"
      : tmuxModifier[1].toLowerCase() === "m"
        ? "alt"
        : "shift";
    const nested = translateHerdrKey(tmuxModifier[2]);
    return `${modifier}+${nested}`;
  }
  if (/^(?:ctrl|control|alt|shift)\+[^+]+$/iu.test(key)) {
    const [modifier, nested] = key.split("+", 2);
    return `${modifier.toLowerCase() === "control" ? "ctrl" : modifier.toLowerCase()}+` +
      translateHerdrKey(nested);
  }
  if ([...key].length === 1 && !/[\u0000-\u001f\u007f]/u.test(key)) {
    return key;
  }
  throw new Error(`unsupported Herdr key ${value}`);
}

function parsePaneInfo(value: unknown, label: string): HerdrPaneInfo {
  if (!isRecord(value)) {
    throw new Error(`invalid Herdr ${label}`);
  }
  const paneId = nonEmptyString(value.pane_id);
  const terminalId = nonEmptyString(value.terminal_id);
  const workspaceId = nonEmptyString(value.workspace_id);
  const tabId = nonEmptyString(value.tab_id);
  if (!paneId || !terminalId || !workspaceId || !tabId) {
    throw new Error(`invalid Herdr ${label} identity`);
  }
  return {
    paneId,
    terminalId,
    workspaceId,
    tabId,
    cwd: nonEmptyString(value.cwd),
    foregroundCwd: nonEmptyString(value.foreground_cwd)
  };
}

function parsePaneProcessInfo(
  value: JsonRecord,
  expectedPaneId: string
): HerdrPaneProcessInfo {
  const paneId = nonEmptyString(value.pane_id);
  if (paneId !== expectedPaneId) {
    throw new Error(`Herdr pane.process_info returned mismatched pane ${paneId ?? "<missing>"}`);
  }
  const rawProcesses = value.foreground_processes;
  if (rawProcesses !== undefined && !Array.isArray(rawProcesses)) {
    throw new Error(`Herdr pane.process_info processes are invalid for ${paneId}`);
  }
  const foregroundProcesses = (rawProcesses ?? []).map((process, index) => {
    if (!isRecord(process)) {
      throw new Error(`invalid Herdr foreground process ${index} for ${paneId}`);
    }
    const pid = positiveInteger(process.pid);
    const name = nonEmptyString(process.name);
    if (!pid || !name) {
      throw new Error(`invalid Herdr foreground process ${index} for ${paneId}`);
    }
    const argv = process.argv === undefined
      ? undefined
      : stringArray(process.argv);
    if (process.argv !== undefined && !argv) {
      throw new Error(`invalid Herdr foreground argv ${index} for ${paneId}`);
    }
    return {
      pid,
      name,
      argv0: nonEmptyString(process.argv0),
      argv,
      cmdline: nonEmptyString(process.cmdline),
      cwd: nonEmptyString(process.cwd)
    };
  });
  return {
    paneId,
    shellPid: positiveInteger(value.shell_pid),
    foregroundProcessGroupId: positiveInteger(value.foreground_process_group_id),
    foregroundProcesses
  };
}

function endpointFromPane(
  session: HerdrSessionInfo,
  pane: HerdrPaneInfo,
  processInfo: HerdrPaneProcessInfo,
  capabilities: readonly TerminalControlCapability[]
): TerminalEndpointRef {
  const foreground = processInfo.foregroundProcesses.find((process) =>
    process.pid === processInfo.foregroundProcessGroupId) ??
    processInfo.foregroundProcesses[0];
  const currentCommand = foreground?.cmdline ??
    (foreground?.argv?.length ? foreground.argv.join(" ") : undefined) ??
    foreground?.argv0 ??
    foreground?.name;
  const currentPath = foreground?.cwd ?? pane.foregroundCwd ?? pane.cwd;
  const target = `${session.name}:${pane.paneId}`;
  const control: HerdrTerminalControlRef = {
    kind: "herdr",
    target,
    socketPath: session.socketPath,
    session: session.name,
    sessionDir: session.sessionDir,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    paneId: pane.paneId,
    terminalId: pane.terminalId,
    panePid: processInfo.shellPid!,
    currentCommand,
    currentPath,
    capabilities: [...capabilities]
  };
  const endpointKey = `socket:${session.socketPath}`;
  return createTerminalEndpointRef({
    identity: {
      providerKind: "herdr",
      endpointKey,
      resourceKey: `terminal-id:${pane.terminalId}`
    },
    route: {
      routeKey: herdrTerminalRouteKey(endpointKey, session.name, pane.paneId),
      label: target,
      currentCommand,
      currentPath
    },
    processAnchorPid: processInfo.shellPid,
    capabilities,
    providerRef: control
  });
}

function herdrControlFromEndpoint(
  terminal: TerminalEndpointRef
): HerdrTerminalControlRef {
  assertEndpointKind(terminal, "herdr");
  const control = terminal.providerRef;
  if (!isRecord(control) || control.kind !== "herdr") {
    throw new Error("Herdr terminal endpoint is missing its provider routing reference");
  }
  return control as unknown as HerdrTerminalControlRef;
}

function endpointWithCapabilities(
  terminal: TerminalEndpointRef,
  capabilities: readonly TerminalControlCapability[]
): TerminalEndpointRef {
  const control = herdrControlFromEndpoint(terminal);
  const nextControl: HerdrTerminalControlRef = {
    ...control,
    capabilities: [...capabilities]
  };
  return createTerminalEndpointRef({
    identity: terminal.identity,
    route: terminal.route,
    processAnchorPid: terminal.processAnchorPid,
    capabilities,
    providerRef: nextControl
  });
}

function assertEndpointKind(terminal: TerminalEndpointRef, kind: string): void {
  if (terminal.identity.providerKind !== kind) {
    throw new Error(
      `terminal control provider ${kind} cannot use ${terminal.identity.providerKind}`
    );
  }
}

function assertEndpointCapability(
  terminal: TerminalEndpointRef,
  capability: TerminalControlCapability
): void {
  assertEndpointKind(terminal, "herdr");
  if (!terminal.capabilities.includes(capability)) {
    throw new Error(`Herdr terminal does not permit ${capability}`);
  }
}

function assertInputEndpointCapability(
  terminal: TerminalEndpointRef,
  providerCapabilities: readonly TerminalProviderCapability[],
  providerCapability: "text_delivery" | "key_delivery"
): void {
  try {
    assertEndpointCapability(terminal, "send_keys");
  } catch (error) {
    throw new TerminalControlInputNotSentError(describeError(error));
  }
  if (!providerCapabilities.includes(providerCapability)) {
    throw new TerminalControlInputNotSentError(
      `Herdr provider does not support ${providerCapability}`
    );
  }
}

function assertProviderCapability(
  capabilities: readonly TerminalProviderCapability[],
  capability: TerminalProviderCapability
): void {
  if (!capabilities.includes(capability)) {
    throw new Error(`Herdr provider does not support ${capability}`);
  }
}

function inputDefinitelyNotSent(error: unknown): boolean {
  if (error instanceof HerdrTransportError) {
    return error.definitelyNotSent;
  }
  return error instanceof HerdrApiError && new Set([
    "invalid_request",
    "invalid_key",
    "pane_not_found",
    "pane_send_failed",
    "protocol_mismatch"
  ]).has(error.code);
}

function intersectCapabilities(
  requested: readonly TerminalControlCapability[],
  supported: readonly TerminalControlCapability[]
): TerminalControlCapability[] {
  const supportedSet = new Set(supported);
  return [...new Set(requested)].filter((capability) => supportedSet.has(capability));
}

function runHerdrCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    timeout: HERDR_DEFAULT_TIMEOUT_MS
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error
  };
}

/**
 * Read the exact inner PTY viewport owned by a verified Herdr shell process.
 * Herdr layout geometry is deliberately not used here: direct attaches may
 * resize the PTY without updating the layout rectangle that owns the pane.
 */
export function inspectHerdrTtyViewport(
  shellPid: number,
  options: HerdrTtyViewportInspectionOptions = {}
): TerminalViewport | undefined {
  const pid = positiveInteger(shellPid);
  if (!pid) {
    throw new Error("Herdr exact PTY viewport requires a positive shell PID");
  }
  const commands = herdrTtyCommands(options.platform ?? process.platform);
  if (!commands) {
    return undefined;
  }
  const runCommand = options.runCommand ?? runHerdrTtyCommand;
  const statTty = options.statTty ?? readHerdrTtyDeviceIdentity;
  const currentUid = options.currentUid ?? (
    typeof process.getuid === "function" ? process.getuid() : undefined
  );
  if (currentUid === undefined) {
    return undefined;
  }

  const before = readHerdrProcessTtyEvidence(
    commands.ps,
    pid,
    runCommand,
    "before stty"
  );
  if (!before) {
    return undefined;
  }
  const beforeDevice = statTty(before.ttyPath);
  assertSafeHerdrTtyDevice(before.ttyPath, beforeDevice, currentUid);

  const sizeResult = runCommand(commands.stty, [
    commands.sttyDeviceFlag,
    before.ttyPath,
    "size"
  ]);
  if (sizeResult.status !== 0) {
    return undefined;
  }
  const size = parseHerdrSttySize(sizeResult.stdout);
  if (!size) {
    throw new Error(
      `Herdr stty returned malformed PTY viewport dimensions for ${before.ttyPath}`
    );
  }

  const after = readHerdrProcessTtyEvidence(
    commands.ps,
    pid,
    runCommand,
    "after stty"
  );
  if (!after) {
    return undefined;
  }
  if (
    after.pid !== before.pid ||
    after.ttyPath !== before.ttyPath ||
    after.processBirth !== before.processBirth
  ) {
    throw new Error(
      `Herdr shell ${pid} TTY process identity changed during viewport inspection`
    );
  }
  const afterDevice = statTty(after.ttyPath);
  assertSafeHerdrTtyDevice(after.ttyPath, afterDevice, currentUid);
  if (!sameHerdrTtyDeviceIdentity(beforeDevice, afterDevice)) {
    throw new Error(
      `Herdr TTY device ${after.ttyPath} changed during viewport inspection`
    );
  }
  return size;
}

function herdrTtyCommands(platform: NodeJS.Platform): {
  ps: string;
  stty: string;
  sttyDeviceFlag: "-f" | "-F";
} | undefined {
  if (platform === "darwin") {
    return { ps: "/bin/ps", stty: "/bin/stty", sttyDeviceFlag: "-f" };
  }
  if (platform === "linux") {
    return { ps: "/bin/ps", stty: "/bin/stty", sttyDeviceFlag: "-F" };
  }
  return undefined;
}

function runHerdrTtyCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: HERDR_DEFAULT_TIMEOUT_MS
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error
  };
}

function readHerdrProcessTtyEvidence(
  psCommand: string,
  pid: number,
  runCommand: (command: string, args: string[]) => CommandResult,
  stage: string
): HerdrProcessTtyEvidence | undefined {
  const result = runCommand(psCommand, [
    "-p",
    String(pid),
    "-o",
    "pid=,tty=,lstart="
  ]);
  if (result.status !== 0) {
    return undefined;
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.includes("\n") || raw.includes("\r")) {
    throw new Error(`Herdr ps returned ambiguous TTY ${stage}`);
  }
  const match = /^(\d+)\s+(\S+)\s+(.+)$/u.exec(raw);
  if (!match) {
    throw new Error(`Herdr ps returned malformed process TTY evidence ${stage}`);
  }
  const observedPid = positiveInteger(Number(match[1]));
  if (observedPid !== pid) {
    throw new Error(`Herdr ps returned mismatched shell PID ${stage}`);
  }
  const rawTty = match[2];
  if (rawTty === "?" || rawTty === "??" || rawTty === "-") {
    return undefined;
  }
  const processBirth = match[3].trim();
  if (!processBirth) {
    throw new Error(`Herdr ps returned missing shell process birth ${stage}`);
  }
  return {
    pid: observedPid,
    ttyPath: safeHerdrTtyPath(rawTty, stage),
    processBirth
  };
}

function safeHerdrTtyPath(raw: string, stage: string): string {
  if (Buffer.byteLength(raw) > HERDR_MAX_TTY_PATH_BYTES) {
    throw new Error(`Herdr ps returned overlong TTY path ${stage}`);
  }
  const relative = raw.startsWith("/dev/") ? raw.slice(5) : raw;
  const segments = relative.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) =>
      !segment ||
      segment === "." ||
      segment === ".." ||
      !/^[A-Za-z0-9._-]+$/u.test(segment))
  ) {
    throw new Error(`Herdr ps returned unsafe TTY path ${stage}`);
  }
  const ttyPath = `/dev/${segments.join("/")}`;
  if (
    Buffer.byteLength(ttyPath) > HERDR_MAX_TTY_PATH_BYTES ||
    path.posix.normalize(ttyPath) !== ttyPath
  ) {
    throw new Error(`Herdr ps returned unsafe TTY path ${stage}`);
  }
  return ttyPath;
}

function parseHerdrSttySize(output: string): TerminalViewport | undefined {
  const match = /^(\d+)\s+(\d+)$/u.exec(output.trim());
  if (!match) {
    return undefined;
  }
  const rows = positiveInteger(Number(match[1]));
  const columns = positiveInteger(Number(match[2]));
  if (
    !rows ||
    !columns ||
    rows > HERDR_MAX_TTY_VIEWPORT_DIMENSION ||
    columns > HERDR_MAX_TTY_VIEWPORT_DIMENSION
  ) {
    return undefined;
  }
  return { columns, rows };
}

function readHerdrTtyDeviceIdentity(
  ttyPath: string
): HerdrTtyDeviceIdentity {
  const stats = fs.lstatSync(ttyPath, { bigint: true });
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    rdev: stats.rdev.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    ownerUid: Number(stats.uid),
    symbolicLink: stats.isSymbolicLink(),
    characterDevice: stats.isCharacterDevice()
  };
}

function assertSafeHerdrTtyDevice(
  ttyPath: string,
  identity: HerdrTtyDeviceIdentity,
  currentUid: number
): void {
  if (identity.symbolicLink) {
    throw new Error(`Herdr TTY must not be a symbolic link: ${ttyPath}`);
  }
  if (!identity.characterDevice) {
    throw new Error(`Herdr TTY is not a character device: ${ttyPath}`);
  }
  if (identity.ownerUid !== currentUid) {
    throw new Error(
      `Herdr TTY ${ttyPath} is owned by uid ${identity.ownerUid}, expected ${currentUid}`
    );
  }
}

function sameHerdrTtyDeviceIdentity(
  left: HerdrTtyDeviceIdentity,
  right: HerdrTtyDeviceIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.rdev === right.rdev &&
    left.ctimeNs === right.ctimeNs &&
    left.ownerUid === right.ownerUid &&
    left.symbolicLink === right.symbolicLink &&
    left.characterDevice === right.characterDevice;
}

export function readHerdrSocketIdentity(
  socketPath: string
): HerdrSocketIdentity {
  const stats = fs.lstatSync(socketPath, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new Error(`Herdr endpoint must not be a symbolic link: ${socketPath}`);
  }
  if (!stats.isSocket()) {
    throw new Error(`Herdr endpoint is not a Unix socket: ${socketPath}`);
  }
  const ownerUid = Number(stats.uid);
  const currentUid = typeof process.getuid === "function"
    ? process.getuid()
    : undefined;
  if (currentUid !== undefined && ownerUid !== currentUid) {
    throw new Error(
      `Herdr socket ${socketPath} is owned by uid ${ownerUid}, expected ${currentUid}`
    );
  }
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    ctimeNs: stats.ctimeNs.toString(),
    ownerUid
  };
}

function sameHerdrSocketIdentity(
  left: HerdrSocketIdentity,
  right: HerdrSocketIdentity
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.ctimeNs === right.ctimeNs &&
    left.ownerUid === right.ownerUid;
}

function commandDefinitelyDidNotStart(error: Error | undefined): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
