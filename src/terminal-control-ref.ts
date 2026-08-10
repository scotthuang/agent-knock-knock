/**
 * Provider-neutral terminal identity and routing primitives.
 *
 * Persisted/public terminal control records intentionally keep their current
 * provider-owned shape. Generic lifecycle code must project those records
 * through the helpers in this module instead of rebuilding identity from
 * route fields such as a selector or socket path.
 */

export type TerminalControlCapability =
  | "screen_status"
  | "send_keys"
  | "terminal_approval"
  | "screen_completion"
  | "durable_completion"
  | "terminal_cancel";

/** Transport capabilities owned by a terminal provider, not an agent TUI. */
export type TerminalProviderCapability =
  | "screen_capture"
  | "ansi_capture"
  | "text_delivery"
  | "key_delivery"
  | "process_inspection"
  | "stable_resource_resolution";

interface TerminalControlRefBase {
  target: string;
  socketPath?: string;
  session: string;
  panePid: number;
  currentCommand?: string;
  currentPath?: string;
  capabilities: TerminalControlCapability[];
}

export interface TmuxTerminalControlRef extends TerminalControlRefBase {
  kind: "tmux";
  window: number;
  pane: number;
}

/** Persisted routing and identity owned by a Herdr server session. */
export interface HerdrTerminalControlRef extends TerminalControlRefBase {
  kind: "herdr";
  /** Canonical Herdr session directory, when reported by session discovery. */
  sessionDir?: string;
  workspaceId: string;
  tabId: string;
  /** Current public route. A cross-workspace move may replace this value. */
  paneId: string;
  /** Stable resource identity for the lifetime of the underlying PTY. */
  terminalId: string;
}

/**
 * Versioned union for provider-owned persisted/public control records.
 * New providers add a member here; generic callers consume
 * TerminalEndpointRef instead of narrowing this union themselves.
 */
export type TerminalControlRef =
  | TmuxTerminalControlRef
  | HerdrTerminalControlRef;

export interface TerminalEndpointIdentity {
  providerKind: string;
  endpointKey: string;
  resourceKey: string;
}

export interface TerminalRouteIdentity {
  routeKey: string;
  label: string;
  currentCommand?: string;
  currentPath?: string;
}

/**
 * Authoritative internal reference passed across the provider boundary.
 * `identity` is stable for binding/locking while `route` may be refreshed.
 * `providerRef` is opaque to generic lifecycle code.
 */
export interface TerminalEndpointRef {
  identity: TerminalEndpointIdentity;
  route: TerminalRouteIdentity;
  /** Process-incarnation evidence, deliberately separate from stable identity. */
  processAnchorPid?: number;
  capabilities: readonly TerminalControlCapability[];
  /** Opaque provider-owned routing payload. Generic code must never inspect it. */
  providerRef: unknown;
}

/**
 * Durable evidence shape used by ledgers and snapshot compatibility readers.
 * Legacy route fields remain additive for diagnostics and old readers.
 */
export interface TerminalControlEvidence {
  schema: "agent-knock-knock/terminal-endpoint";
  version: 1;
  kind: string;
  endpoint_key: string;
  resource_key: string;
  route_key: string;
  process_anchor_pid: number | null;
  /** Provider-owned compatibility fields; generic code must not derive identity from them. */
  target?: string;
  socket_path?: string | null;
  pane_pid?: number | null;
  server_socket_path?: string | null;
  pane_id?: string | null;
  session_name?: string | null;
  session_dir?: string | null;
  workspace_id?: string | null;
  tab_id?: string | null;
  terminal_id?: string | null;
  current_path?: string | null;
}

const associatedEndpoints = new WeakMap<object, TerminalEndpointRef>();

export function createTerminalEndpointRef(value: {
  identity: TerminalEndpointIdentity;
  route: TerminalRouteIdentity;
  processAnchorPid?: number;
  capabilities: readonly TerminalControlCapability[];
  providerRef: unknown;
}): TerminalEndpointRef {
  const terminal: TerminalEndpointRef = {
    identity: { ...value.identity },
    route: { ...value.route },
    processAnchorPid: value.processAnchorPid,
    capabilities: [...value.capabilities],
    providerRef: value.providerRef
  };
  if (isObject(value.providerRef)) {
    associatedEndpoints.set(value.providerRef, terminal);
  }
  return terminal;
}

export function terminalEndpointFromControlRef(
  terminalControl: TerminalControlRef
): TerminalEndpointRef {
  const associated = associatedEndpoints.get(terminalControl);
  if (associated) {
    return associated;
  }
  switch (terminalControl.kind) {
    case "tmux": {
      assertTmuxControlIdentity(terminalControl);
      const endpointKey = terminalControl.socketPath
        ? `socket:${terminalControl.socketPath}`
        : "default-server-route";
      const routeKey = tmuxTerminalRouteKey(
        endpointKey,
        terminalControl.target,
        terminalControl.socketPath
      );
      return {
        identity: {
          providerKind: "tmux",
          endpointKey,
          // Modern discovery reports tmux's stable pane id. Legacy persisted
          // refs deliberately retain their complete route+PID identity; a PID
          // alone is never sufficient because it can be reused.
          resourceKey: `legacy:${routeKey}:pane-pid:${terminalControl.panePid}`
        },
        route: {
          routeKey,
          label: terminalControl.target,
          currentCommand: terminalControl.currentCommand,
          currentPath: terminalControl.currentPath
        },
        processAnchorPid: terminalControl.panePid,
        capabilities: [...terminalControl.capabilities],
        providerRef: terminalControl
      };
    }
    case "herdr": {
      assertHerdrControlIdentity(terminalControl);
      const endpointKey = `socket:${terminalControl.socketPath}`;
      return {
        identity: {
          providerKind: "herdr",
          endpointKey,
          resourceKey: `terminal-id:${terminalControl.terminalId}`
        },
        route: {
          routeKey: herdrTerminalRouteKey(
            endpointKey,
            terminalControl.session,
            terminalControl.paneId
          ),
          label: terminalControl.target,
          currentCommand: terminalControl.currentCommand,
          currentPath: terminalControl.currentPath
        },
        processAnchorPid: terminalControl.panePid,
        capabilities: [...terminalControl.capabilities],
        providerRef: terminalControl
      };
    }
  }
}

export function hasCanonicalTerminalEndpoint(
  terminalControl: TerminalControlRef
): boolean {
  if (associatedEndpoints.has(terminalControl)) {
    return true;
  }
  if (terminalControl.kind !== "herdr") {
    return false;
  }
  try {
    terminalEndpointFromControlRef(terminalControl);
    return true;
  } catch {
    return false;
  }
}

export function terminalEndpointIdentityKey(
  value: TerminalEndpointRef | TerminalEndpointIdentity | TerminalControlRef
): string {
  const identity = isTerminalEndpointRef(value)
    ? value.identity
    : isTerminalEndpointIdentity(value)
      ? value
      : terminalEndpointFromControlRef(value).identity;
  return JSON.stringify({
    version: 1,
    provider_kind: identity.providerKind,
    endpoint_key: identity.endpointKey,
    resource_key: identity.resourceKey
  });
}

export function sameTerminalEndpointIdentity(
  left: TerminalEndpointRef | TerminalEndpointIdentity | TerminalControlRef,
  right: TerminalEndpointRef | TerminalEndpointIdentity | TerminalControlRef
): boolean {
  return terminalEndpointIdentityKey(left) === terminalEndpointIdentityKey(right);
}

export function sameTerminalControlRoute(
  left: TerminalEndpointRef | TerminalControlRef,
  right: TerminalEndpointRef | TerminalControlRef
): boolean {
  if (
    !isTerminalEndpointRef(left) &&
    !isTerminalEndpointRef(right) &&
    (!hasCanonicalTerminalEndpoint(left) || !hasCanonicalTerminalEndpoint(right))
  ) {
    return sameLegacyTerminalRoute(left, right);
  }
  if (!sameTerminalEndpointIdentity(left, right)) {
    return false;
  }
  const leftRoute = isTerminalEndpointRef(left)
    ? left.route.routeKey
    : terminalEndpointFromControlRef(left).route.routeKey;
  const rightRoute = isTerminalEndpointRef(right)
    ? right.route.routeKey
    : terminalEndpointFromControlRef(right).route.routeKey;
  return leftRoute === rightRoute;
}

export function sameTerminalControlIncarnation(
  left: TerminalEndpointRef | TerminalControlRef,
  right: TerminalEndpointRef | TerminalControlRef
): boolean {
  if (
    !isTerminalEndpointRef(left) &&
    !isTerminalEndpointRef(right) &&
    (!hasCanonicalTerminalEndpoint(left) || !hasCanonicalTerminalEndpoint(right))
  ) {
    return sameLegacyTerminalIncarnation(left, right);
  }
  const leftEndpoint = isTerminalEndpointRef(left)
    ? left
    : terminalEndpointFromControlRef(left);
  const rightEndpoint = isTerminalEndpointRef(right)
    ? right
    : terminalEndpointFromControlRef(right);
  return sameTerminalEndpointIdentity(leftEndpoint, rightEndpoint) &&
    leftEndpoint.processAnchorPid === rightEndpoint.processAnchorPid;
}

export function terminalControlEvidence(
  terminalControl: TerminalControlRef
): TerminalControlEvidence {
  const endpoint = terminalEndpointFromControlRef(terminalControl);
  switch (terminalControl.kind) {
    case "tmux":
      return {
        schema: "agent-knock-knock/terminal-endpoint",
        version: 1,
        kind: endpoint.identity.providerKind,
        endpoint_key: endpoint.identity.endpointKey,
        resource_key: endpoint.identity.resourceKey,
        route_key: endpoint.route.routeKey,
        process_anchor_pid: endpoint.processAnchorPid ?? null,
        target: terminalControl.target,
        socket_path: terminalControl.socketPath ?? null,
        pane_pid: terminalControl.panePid ?? null,
        server_socket_path: endpoint.identity.endpointKey.startsWith("socket:")
          ? endpoint.identity.endpointKey.slice("socket:".length)
          : null,
        pane_id: endpoint.identity.resourceKey.startsWith("pane-id:")
          ? endpoint.identity.resourceKey.slice("pane-id:".length)
          : null,
        current_path: terminalControl.currentPath ?? null
      };
    case "herdr":
      return {
        schema: "agent-knock-knock/terminal-endpoint",
        version: 1,
        kind: endpoint.identity.providerKind,
        endpoint_key: endpoint.identity.endpointKey,
        resource_key: endpoint.identity.resourceKey,
        route_key: endpoint.route.routeKey,
        process_anchor_pid: endpoint.processAnchorPid ?? null,
        target: terminalControl.target,
        socket_path: terminalControl.socketPath ?? null,
        pane_pid: terminalControl.panePid,
        server_socket_path: terminalControl.socketPath ?? null,
        pane_id: terminalControl.paneId,
        session_name: terminalControl.session,
        session_dir: terminalControl.sessionDir ?? null,
        workspace_id: terminalControl.workspaceId,
        tab_id: terminalControl.tabId,
        terminal_id: terminalControl.terminalId,
        current_path: terminalControl.currentPath ?? null
      };
  }
}

/**
 * Read canonical identity from a new evidence record or derive it from the
 * exact v0.11.x tmux fields. Unknown/malformed evidence fails closed.
 */
export function terminalEndpointIdentityFromEvidence(
  value: unknown
): TerminalEndpointIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerKind = nonEmptyString(value.kind);
  const endpointKey = nonEmptyString(value.endpoint_key);
  const resourceKey = nonEmptyString(value.resource_key);
  if (providerKind && endpointKey && resourceKey) {
    if (providerKind === "tmux") {
      const legacy = tmuxIdentityFromEvidence(value);
      if (
        !legacy ||
        legacy.identity.endpointKey !== endpointKey ||
        legacy.identity.resourceKey !== resourceKey ||
        (
          nonEmptyString(value.route_key) !== undefined &&
          nonEmptyString(value.route_key) !== legacy.routeKey
        )
      ) {
        return undefined;
      }
    } else if (providerKind === "herdr") {
      const herdr = herdrIdentityFromEvidence(value);
      if (
        !herdr ||
        herdr.identity.endpointKey !== endpointKey ||
        herdr.identity.resourceKey !== resourceKey ||
        (
          nonEmptyString(value.route_key) !== undefined &&
          nonEmptyString(value.route_key) !== herdr.routeKey
        )
      ) {
        return undefined;
      }
    } else {
      return undefined;
    }
    return { providerKind, endpointKey, resourceKey };
  }
  const legacy = tmuxIdentityFromEvidence(value);
  const legacyKind = providerKind ?? (legacy ? "tmux" : undefined);
  if (legacyKind !== "tmux" || !legacy) {
    return undefined;
  }
  return legacy.identity;
}

export function terminalRouteKeyFromEvidence(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const canonical = nonEmptyString(value.route_key);
  if (canonical) {
    const derived = value.kind === "herdr"
      ? herdrIdentityFromEvidence(value)
      : tmuxIdentityFromEvidence(value);
    if (derived?.routeKey !== canonical) {
      return undefined;
    }
    return canonical;
  }
  return tmuxIdentityFromEvidence(value)?.routeKey;
}

export function terminalControlEvidenceMatches(
  evidence: unknown,
  terminalControl: TerminalControlRef,
  options: {
    requireCurrentRoute?: boolean;
    requireProcessAnchor?: boolean;
  } = {}
): boolean {
  if (!hasCanonicalEvidence(evidence)) {
    const legacy = legacyTerminalEvidence(evidence);
    if (
      !legacy ||
      (
        options.requireProcessAnchor === false
          ? !sameLegacyTerminalRoute(legacy, terminalControl)
          : !sameLegacyTerminalIncarnation(legacy, terminalControl)
      )
    ) {
      return false;
    }
    return options.requireCurrentRoute !== true ||
      sameLegacyTerminalRoute(legacy, terminalControl);
  }
  const evidenceIdentity = terminalEndpointIdentityFromEvidence(evidence);
  if (
    !evidenceIdentity ||
    !sameTerminalEndpointIdentity(evidenceIdentity, terminalControl)
  ) {
    return false;
  }
  const endpoint = terminalEndpointFromControlRef(terminalControl);
  const evidenceAnchor = isRecord(evidence)
    ? positiveInteger(
        evidence.process_anchor_pid ?? evidence.pane_pid ?? evidence.panePid
      )
    : undefined;
  if (
    options.requireProcessAnchor !== false &&
    evidenceAnchor !== undefined &&
    endpoint.processAnchorPid !== evidenceAnchor
  ) {
    return false;
  }
  if (options.requireCurrentRoute === true) {
    return terminalRouteKeyFromEvidence(evidence) ===
      endpoint.route.routeKey;
  }
  return true;
}

export function sameTerminalControlEvidenceIncarnation(
  left: unknown,
  right: unknown
): boolean {
  if (hasCanonicalEvidence(left) && hasCanonicalEvidence(right)) {
    const leftIdentity = terminalEndpointIdentityFromEvidence(left);
    const rightIdentity = terminalEndpointIdentityFromEvidence(right);
    const leftAnchor = isRecord(left)
      ? positiveInteger(
          left.process_anchor_pid ?? left.pane_pid ?? left.panePid
        )
      : undefined;
    const rightAnchor = isRecord(right)
      ? positiveInteger(
          right.process_anchor_pid ?? right.pane_pid ?? right.panePid
        )
      : undefined;
    return Boolean(
      leftIdentity &&
      rightIdentity &&
      leftAnchor !== undefined &&
      leftAnchor === rightAnchor &&
      sameTerminalEndpointIdentity(leftIdentity, rightIdentity)
    );
  }
  const leftLegacy = legacyTerminalEvidence(left);
  const rightLegacy = legacyTerminalEvidence(right);
  return Boolean(
    leftLegacy &&
    rightLegacy &&
    sameLegacyTerminalIncarnation(leftLegacy, rightLegacy)
  );
}

/**
 * Restore a persisted additive endpoint record onto its legacy public control
 * ref. The association is deliberately non-enumerable and never rewrites the
 * Store object. Conflicting canonical and legacy fields fail closed.
 */
export function associateTerminalEndpointEvidence(
  terminalControl: TerminalControlRef,
  evidence: unknown
): TerminalControlRef {
  if (!hasCanonicalEvidence(evidence) || !isRecord(evidence)) {
    throw new Error("terminal endpoint evidence is not canonical");
  }
  const identity = terminalEndpointIdentityFromEvidence(evidence);
  const routeKey = terminalRouteKeyFromEvidence(evidence);
  if (terminalControl.kind === "herdr") {
    const endpoint = terminalEndpointFromControlRef(terminalControl);
    if (
      !identity ||
      !routeKey ||
      !sameTerminalEndpointIdentity(identity, endpoint) ||
      routeKey !== endpoint.route.routeKey ||
      positiveInteger(evidence.process_anchor_pid ?? evidence.pane_pid) !==
        endpoint.processAnchorPid
    ) {
      throw new Error(
        "terminal endpoint evidence conflicts with its Herdr control reference"
      );
    }
    createTerminalEndpointRef({
      identity,
      route: {
        routeKey,
        label: terminalControl.target,
        currentCommand: terminalControl.currentCommand,
        currentPath: nonEmptyString(evidence.current_path) ??
          terminalControl.currentPath
      },
      processAnchorPid: endpoint.processAnchorPid,
      capabilities: terminalControl.capabilities,
      providerRef: terminalControl
    });
    return terminalControl;
  }
  const legacy = legacyTerminalEvidence(evidence);
  if (
    !identity ||
    !routeKey ||
    !legacy ||
    !sameLegacyTerminalIncarnation(legacy, terminalControl)
  ) {
    throw new Error(
      "terminal endpoint evidence conflicts with its legacy control reference"
    );
  }
  createTerminalEndpointRef({
    identity,
    route: {
      routeKey,
      label: terminalControl.target,
      currentCommand: terminalControl.currentCommand,
      currentPath: nonEmptyString(evidence.current_path) ??
        terminalControl.currentPath
    },
    processAnchorPid: positiveInteger(
      evidence.process_anchor_pid ?? evidence.pane_pid
    ),
    capabilities: terminalControl.capabilities,
    providerRef: terminalControl
  });
  return terminalControl;
}

/** Exact v0.11.x selector/incarnation tuple for compatibility artifacts. */
export function terminalLegacyControlEvidence(
  terminalControl: TerminalControlRef
): {
  kind: TerminalControlRef["kind"];
  target: string;
  socket_path: string | null;
  pane_pid: number;
} {
  return {
    kind: terminalControl.kind,
    target: terminalControl.target,
    socket_path: terminalControl.socketPath ?? null,
    pane_pid: terminalControl.panePid
  };
}

/** Exact legacy runtime route serialized by v0.11.x ledgers and locks. */
export function terminalLegacyRuntimeRoute(
  terminalControl: TerminalControlRef
): { target: string; socket_path: string | null; kind?: "herdr" } {
  if (terminalControl.kind === "herdr") {
    return {
      kind: "herdr",
      target: terminalControl.target,
      socket_path: terminalControl.socketPath ?? null
    };
  }
  return {
    target: terminalControl.target,
    socket_path: terminalControl.socketPath ?? null
  };
}

export function terminalControlWithCapabilities(
  terminalControl: TerminalControlRef,
  capabilities: readonly TerminalControlCapability[]
): TerminalControlRef {
  const next: TerminalControlRef = {
    ...terminalControl,
    capabilities: [...capabilities]
  };
  const endpoint = associatedEndpoints.get(terminalControl);
  if (endpoint) {
    createTerminalEndpointRef({
      ...endpoint,
      capabilities,
      providerRef: next
    });
  }
  return next;
}

export function tmuxTerminalRouteKey(
  endpointKey: string,
  target: string,
  socketPath?: string
): string {
  return JSON.stringify({
    provider_kind: "tmux",
    endpoint_key: endpointKey,
    target,
    socket_path: socketPath ?? null
  });
}

export function herdrTerminalRouteKey(
  endpointKey: string,
  session: string,
  paneId: string
): string {
  return JSON.stringify({
    provider_kind: "herdr",
    endpoint_key: endpointKey,
    session,
    pane_id: paneId
  });
}

function tmuxIdentityFromEvidence(value: Record<string, any>): {
  identity: TerminalEndpointIdentity;
  routeKey: string;
} | undefined {
  const target = nonEmptyString(value.target);
  const panePid = positiveInteger(value.pane_pid ?? value.panePid);
  const processAnchorPid = positiveInteger(value.process_anchor_pid);
  if (
    !target ||
    panePid === undefined ||
    (processAnchorPid !== undefined && processAnchorPid !== panePid)
  ) {
    return undefined;
  }
  const socketPath = nonEmptyString(value.socket_path ?? value.socketPath);
  const serverSocketPath = nonEmptyString(
    value.server_socket_path ?? value.serverSocketPath
  );
  const paneId = nonEmptyString(value.pane_id ?? value.paneId);
  const endpointKey = serverSocketPath
    ? `socket:${serverSocketPath}`
    : socketPath
      ? `socket:${socketPath}`
      : "default-server-route";
  const routeKey = tmuxTerminalRouteKey(endpointKey, target, socketPath);
  return {
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey: paneId
        ? `pane-id:${paneId}`
        : `legacy:${routeKey}:pane-pid:${panePid}`
    },
    routeKey
  };
}

function herdrIdentityFromEvidence(value: Record<string, any>): {
  identity: TerminalEndpointIdentity;
  routeKey: string;
} | undefined {
  const socketPath = nonEmptyString(
    value.server_socket_path ?? value.socket_path ?? value.socketPath
  );
  const session = nonEmptyString(value.session_name ?? value.session);
  const paneId = nonEmptyString(value.pane_id ?? value.paneId);
  const terminalId = nonEmptyString(value.terminal_id ?? value.terminalId);
  const panePid = positiveInteger(value.pane_pid ?? value.panePid);
  const processAnchorPid = positiveInteger(value.process_anchor_pid);
  if (
    !socketPath ||
    !session ||
    !paneId ||
    !terminalId ||
    panePid === undefined ||
    (processAnchorPid !== undefined && processAnchorPid !== panePid)
  ) {
    return undefined;
  }
  const endpointKey = `socket:${socketPath}`;
  return {
    identity: {
      providerKind: "herdr",
      endpointKey,
      resourceKey: `terminal-id:${terminalId}`
    },
    routeKey: herdrTerminalRouteKey(endpointKey, session, paneId)
  };
}

function hasCanonicalEvidence(value: unknown): boolean {
  return isRecord(value) &&
    value.schema === "agent-knock-knock/terminal-endpoint" &&
    value.version === 1 &&
    Boolean(nonEmptyString(value.kind)) &&
    Boolean(nonEmptyString(value.endpoint_key)) &&
    Boolean(nonEmptyString(value.resource_key)) &&
    Boolean(nonEmptyString(value.route_key)) &&
    Object.prototype.hasOwnProperty.call(value, "process_anchor_pid") &&
    (
      value.process_anchor_pid === null ||
      positiveInteger(value.process_anchor_pid) !== undefined
    );
}

function legacyTerminalEvidence(value: unknown): TerminalControlRef | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const target = nonEmptyString(value.target);
  const panePid = positiveInteger(value.pane_pid ?? value.panePid);
  if (!target || panePid === undefined) {
    return undefined;
  }
  const [session = target, route = "0.0"] = target.split(":", 2);
  const [windowText = "0", paneText = "0"] = route.split(".", 2);
  return {
    kind: "tmux",
    target,
    socketPath: nonEmptyString(value.socket_path ?? value.socketPath),
    session,
    window: Number.parseInt(windowText, 10) || 0,
    pane: Number.parseInt(paneText, 10) || 0,
    panePid,
    capabilities: []
  };
}

function sameLegacyTerminalRoute(
  left: TerminalControlRef,
  right: TerminalControlRef
): boolean {
  return left.kind === right.kind &&
    left.target === right.target &&
    left.socketPath === right.socketPath;
}

function sameLegacyTerminalIncarnation(
  left: TerminalControlRef,
  right: TerminalControlRef
): boolean {
  return sameLegacyTerminalRoute(left, right) &&
    left.panePid === right.panePid;
}

function assertTmuxControlIdentity(value: TmuxTerminalControlRef): void {
  if (
    !value.target ||
    !Number.isSafeInteger(value.panePid) ||
    value.panePid <= 0
  ) {
    throw new Error("tmux terminal control requires a target and positive pane PID");
  }
}

function assertHerdrControlIdentity(value: HerdrTerminalControlRef): void {
  if (
    !value.target ||
    !value.socketPath ||
    !value.session ||
    !value.workspaceId ||
    !value.tabId ||
    !value.paneId ||
    !value.terminalId ||
    !Number.isSafeInteger(value.panePid) ||
    value.panePid <= 0
  ) {
    throw new Error(
      "Herdr terminal control requires a session socket, stable terminal ID, " +
      "current pane route, and positive shell PID"
    );
  }
}

function isTerminalEndpointRef(value: unknown): value is TerminalEndpointRef {
  return isRecord(value) &&
    isTerminalEndpointIdentity(value.identity) &&
    isRecord(value.route) &&
    typeof value.route.routeKey === "string";
}

function isTerminalEndpointIdentity(
  value: unknown
): value is TerminalEndpointIdentity {
  return isRecord(value) &&
    Boolean(nonEmptyString(value.providerKind)) &&
    Boolean(nonEmptyString(value.endpointKey)) &&
    Boolean(nonEmptyString(value.resourceKey));
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === "object";
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
