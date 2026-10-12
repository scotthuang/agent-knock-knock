import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createDesktopCreationRpc, DesktopCreationRpcError, type DesktopCreationRpc } from "./desktop-creation-rpc.js";
import type { DesktopCompatibility } from "./desktop-types.js";

export const VERIFIED_DESKTOP_CREATION_BUILD = Object.freeze({
  version: "26.1007.30912", build: "20156", backendVersion: "0.162.0-alpha.17.2"
});
export type DesktopCreationDispatchState = "not_sent" | "unknown" | "created";
export class DesktopCreationNativeError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly dispatchState: DesktopCreationDispatchState = "not_sent",
    public readonly threadId?: string, public readonly requestId?: number, public readonly method?: string) {
    super(message); this.name = "DesktopCreationNativeError";
  }
}
export interface DesktopCreationProject { id: string; name: string; roots: string[] }
export interface DesktopCreatedThread { threadId: string; cwd: string; projectId: string | null; title: string | null }
export interface DesktopCreationMetadata {
  appPath: string; binaryPath: string; codexHome: string; backendVersion: string; appVersion: string; appBuild: string;
}
export interface DesktopCreationNativeOptions {
  codexHome: string;
  compatibility: DesktopCompatibility;
  appPath?: string;
  timeoutMs?: number;
  /** Dependency seams for isolated protocol tests; production uses the actual bundle and process. */
  inspectApplication?: (appPath: string) => Omit<DesktopCreationMetadata, "codexHome">;
  rpcFactory?: typeof createDesktopCreationRpc;
}
export interface DesktopCreationInput {
  cwd: string;
  projectId?: string;
  title?: string;
  beforeDispatch?: () => void | Promise<void>;
  onCreated?: (receipt: DesktopCreatedThread) => void | Promise<void>;
  approvalPolicy?: "on-request" | "untrusted";
  sandbox?: "read-only" | "workspace-write";
}
export interface DesktopCreationNative {
  metadata: DesktopCreationMetadata;
  projects(): Promise<DesktopCreationProject[]>;
  resolveProject(selector: { projectId?: string; projectName?: string; cwd?: string }):
    Promise<{ project: DesktopCreationProject; cwd: string }>;
  create(input: DesktopCreationInput): Promise<DesktopCreatedThread>;
  read(threadId: string): Promise<DesktopCreatedThread>;
  close(): Promise<void>;
}
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function fail(code: string, message: string): never { throw new DesktopCreationNativeError(code, message); }
function directory(value: string, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("invalid_argument", `${label} must be an absolute existing directory`);
  try { if (fs.statSync(value).isDirectory()) return fs.realpathSync(value); } catch { /* fail closed below */ }
  return fail("invalid_argument", `${label} must be an absolute existing directory`);
}
function within(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function inspectApplication(appPath: string): Omit<DesktopCreationMetadata, "codexHome"> {
  if (process.platform !== "darwin") fail("incompatible_desktop", "Desktop creation requires the verified macOS application");
  appPath = directory(appPath, "Desktop application");
  const plist = path.join(appPath, "Contents", "Info.plist");
  const read = (key: string) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist],
    { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    if (read("CFBundleIdentifier") !== "com.openai.codex") fail("incompatible_desktop", "Desktop application identity is not Codex");
    const appVersion = read("CFBundleShortVersionString"), appBuild = read("CFBundleVersion");
    const binaryPath = fs.realpathSync(path.join(appPath, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
    if (!within(appPath, binaryPath)) fail("incompatible_desktop", "Desktop bundled binary escapes its application");
    const output = execFileSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"] }).trim();
    const backendVersion = /^codex-cli (\S+)$/u.exec(output)?.[1];
    if (!backendVersion) fail("incompatible_desktop", "Desktop bundled version is unavailable");
    return { appPath, binaryPath, appVersion, appBuild, backendVersion };
  } catch (error) {
    if (error instanceof DesktopCreationNativeError) throw error;
    return fail("incompatible_desktop", "Could not verify the installed Desktop application and bundled binary");
  }
}
function project(value: unknown): DesktopCreationProject {
  if (!record(value) || !uuid(value.id) || typeof value.name !== "string" || !value.name.trim()
    || !Array.isArray(value.roots)) fail("invalid_response", "Invalid Desktop project identity or roots");
  const roots = (value.roots as unknown[]).map(root => {
    if (!record(root) || typeof root.path !== "string" || !path.isAbsolute(root.path)) {
      return fail("invalid_response", "Invalid Desktop project root");
    }
    return root.path;
  });
  return { id: value.id as string, name: value.name as string, roots };
}
function thread(value: unknown, expectedId?: string): DesktopCreatedThread {
  if (!record(value) || !record(value.thread)) fail("invalid_response", "Desktop creation has no thread receipt");
  const t = value.thread as Record<string, unknown>;
  if (!uuid(t.id) || (expectedId && t.id !== expectedId) || typeof t.cwd !== "string" || !path.isAbsolute(t.cwd)
    || !(t.projectId === null || uuid(t.projectId)) || t.ephemeral !== false
    || !(t.name == null || typeof t.name === "string")) fail("invalid_response", "Desktop thread identity is invalid or changed");
  return { threadId: t.id as string, cwd: t.cwd as string, projectId: t.projectId as string | null,
    title: typeof t.name === "string" ? t.name : null };
}

/** Creates metadata only. A user task must be sent through the original Desktop owner after handoff. */
export async function createDesktopCreationNative(options: DesktopCreationNativeOptions): Promise<DesktopCreationNative> {
  const codexHome = directory(options.codexHome, "Codex home");
  const inspected = (options.inspectApplication ?? inspectApplication)(options.appPath ?? "/Applications/ChatGPT.app");
  const verified = VERIFIED_DESKTOP_CREATION_BUILD;
  if (options.compatibility.version !== verified.version || options.compatibility.build !== verified.build
    || inspected.appVersion !== verified.version || inspected.appBuild !== verified.build
    || inspected.backendVersion !== verified.backendVersion) {
    fail("incompatible_desktop", "Desktop creation requires the verified application build and bundled backend");
  }
  const metadata = { ...inspected, codexHome };
  let rpc: DesktopCreationRpc;
  try { rpc = (options.rpcFactory ?? createDesktopCreationRpc)({ binaryPath: metadata.binaryPath, codexHome, timeoutMs: options.timeoutMs }); }
  catch { return fail("connection_failed", "Could not start the dedicated Desktop creation process"); }
  try {
    const initialized = await rpc.request("initialize", { clientInfo: {
      name: "agent-knock-knock-desktop-create", title: "AKK Desktop creation", version: "1"
    }, capabilities: { experimentalApi: true } });
    if (!record(initialized) || typeof initialized.codexHome !== "string"
      || directory(initialized.codexHome, "Backend Codex home") !== codexHome
      || typeof initialized.userAgent !== "string"
      || !initialized.userAgent.startsWith(`agent-knock-knock-desktop-create/${metadata.backendVersion} `)) {
      fail("incompatible_desktop", "Desktop creation backend identity or Codex home does not match");
    }
    rpc.notifyInitialized();
  } catch (error) { await rpc.close(); throw error; }
  return new DesktopCreationConnection(metadata, rpc);
}

class DesktopCreationConnection implements DesktopCreationNative {
  private attempted = false;
  private creating = false;
  constructor(readonly metadata: DesktopCreationMetadata, private readonly rpc: DesktopCreationRpc) {}
  async projects(): Promise<DesktopCreationProject[]> {
    const all: DesktopCreationProject[] = [], cursors = new Set<string>(), ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.rpc.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!record(result) || !Array.isArray(result.data)
        || !(result.nextCursor == null || typeof result.nextCursor === "string" && !!result.nextCursor)) {
        fail("invalid_response", "Invalid Desktop project page");
      }
      for (const raw of result.data as unknown[]) {
        const entry = project(raw);
        if (ids.has(entry.id)) fail("invalid_response", "Desktop project pages contain duplicate identities");
        ids.add(entry.id); all.push(entry);
      }
      if (result.nextCursor == null) return all;
      cursor = result.nextCursor as string;
      if (cursors.has(cursor)) fail("invalid_response", "Desktop project pagination did not advance");
      cursors.add(cursor);
    }
    return fail("project_list_incomplete", "Desktop project discovery exceeded its bounded page limit");
  }
  async resolveProject(selector: { projectId?: string; projectName?: string; cwd?: string }) {
    if ((!selector.projectId && !selector.projectName) || (selector.projectId && !uuid(selector.projectId))) {
      fail("invalid_argument", "An exact Desktop project ID or name is required");
    }
    const matches = (await this.projects()).filter(entry => (!selector.projectId || entry.id === selector.projectId)
      && (!selector.projectName || entry.name === selector.projectName));
    if (matches.length !== 1) fail(matches.length ? "ambiguous_project" : "project_not_found", "Desktop project must match exactly one result");
    const listed = matches[0], response = await this.rpc.request("project/read", { projectId: listed.id });
    const exact = project(record(response) ? response.project : undefined);
    if (exact.id !== listed.id || exact.name !== listed.name
      || JSON.stringify([...exact.roots].sort()) !== JSON.stringify([...listed.roots].sort())) {
      fail("project_changed", "Desktop project changed during exact discovery");
    }
    const roots = [...new Set(exact.roots.map(root => directory(root, "Desktop project root")))];
    if (!roots.length) fail("project_cwd_mismatch", "Desktop project has no local working directory");
    if (!selector.cwd && roots.length !== 1) fail("ambiguous_project_root", "A Desktop project with multiple roots requires an explicit working directory");
    const cwd = directory(selector.cwd ?? roots[0], "Working directory");
    if (!roots.some(root => within(root, cwd))) fail("project_cwd_mismatch", "Working directory is outside the selected Desktop project roots");
    return { project: exact, cwd };
  }
  async read(threadId: string) {
    if (!uuid(threadId)) fail("invalid_argument", "A precise Desktop thread UUID is required");
    return thread(await this.rpc.request("thread/read", { threadId, includeTurns: false }), threadId);
  }
  close(): Promise<void> { return this.rpc.close(); }
  async create(input: DesktopCreationInput): Promise<DesktopCreatedThread> {
    if (this.creating || this.attempted) fail("duplicate_creation", "Desktop creation was already attempted; it will not be repeated");
    this.creating = true;
    let createdId: string | undefined;
    try {
      const cwd = directory(input.cwd, "Working directory");
      validateCreationInput(input);
      if (input.projectId !== undefined) await this.resolveProject({ projectId: input.projectId, cwd });
      const result = await this.rpc.request("thread/start", { cwd, projectId: input.projectId ?? null,
        threadSource: "user", ephemeral: false,
        ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        ...(input.sandbox ? { sandbox: input.sandbox } : {})
      }, { beforeDispatch: async () => { await input.beforeDispatch?.(); this.attempted = true; } });
      if (record(result) && record(result.thread) && uuid(result.thread.id)) createdId = result.thread.id;
      const created = thread(result);
      // Persist the acknowledged identity before naming/readback can fail or this process exits.
      await input.onCreated?.(created);
      if (created.cwd !== cwd || created.projectId !== (input.projectId ?? null)) fail("thread_target_mismatch", "Created Desktop thread has an unexpected project or working directory");
      if (input.title) await this.rpc.request("thread/name/set", { threadId: created.threadId, name: input.title });
      const confirmed = await this.read(created.threadId);
      verifyReadback(confirmed, cwd, created.projectId, input.title);
      return confirmed;
    } catch (error) {
      throw creationError(error, this.attempted, createdId);
    } finally { this.creating = false; }
  }
}

function validateCreationInput(input: DesktopCreationInput): void {
  if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim() || [...input.title].length > 200)) {
    fail("invalid_argument", "Desktop thread title must contain 1 to 200 characters");
  }
  if ((input.approvalPolicy !== undefined && !["on-request", "untrusted"].includes(input.approvalPolicy))
    || (input.sandbox !== undefined && !["read-only", "workspace-write"].includes(input.sandbox))) {
    fail("invalid_argument", "Desktop creation does not accept permission-bypass settings");
  }
}
function verifyReadback(confirmed: DesktopCreatedThread, cwd: string, projectId: string | null, title?: string): void {
  if (confirmed.cwd !== cwd || confirmed.projectId !== projectId || (title && confirmed.title !== title)) {
    fail("thread_target_mismatch", "Desktop thread readback does not match its creation receipt");
  }
}
function creationError(error: unknown, attempted: boolean, createdId?: string): DesktopCreationNativeError {
  const dispatched = error instanceof DesktopCreationRpcError ? error.requestDispatched : attempted;
  const state: DesktopCreationDispatchState = createdId ? "created" : dispatched ? "unknown" : "not_sent";
  if (error instanceof DesktopCreationNativeError) {
    return new DesktopCreationNativeError(error.code, error.message, state, createdId);
  }
  return new DesktopCreationNativeError(error instanceof DesktopCreationRpcError ? error.code : "creation_failed",
    "Desktop creation did not complete; inspect the dispatch state before taking any further action", state, createdId,
    error instanceof DesktopCreationRpcError ? error.requestId : undefined,
    error instanceof DesktopCreationRpcError ? error.method : undefined);
}
