import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "StopFailure",
  "Notification"
] as const;

export type InstalledClaudeHookEventName = typeof CLAUDE_HOOK_EVENT_NAMES[number];

export interface InstallClaudeHooksOptions {
  /** Absolute path to the agent-knock-knock executable. */
  executablePath: string;
  /** Defaults to ~/.claude/settings.json. */
  settingsPath?: string;
  /** Computes and returns a summary without creating or changing any files. */
  dryRun?: boolean;
  /** Injectable for deterministic backup names in tests. */
  now?: () => Date;
}

export interface ClaudeHookInstallSummary {
  addedCount: number;
  existingCount: number;
  warningCount: number;
}

export interface InstallClaudeHooksResult {
  settingsPath: string;
  changed: boolean;
  written: boolean;
  dryRun: boolean;
  created: boolean;
  backupPath?: string;
  addedEvents: InstalledClaudeHookEventName[];
  existingEvents: InstalledClaudeHookEventName[];
  warnings: string[];
  summary: ClaudeHookInstallSummary;
}

export interface MergeClaudeHookSettingsResult {
  settings: Record<string, unknown>;
  changed: boolean;
  addedEvents: InstalledClaudeHookEventName[];
  existingEvents: InstalledClaudeHookEventName[];
  warnings: string[];
}

export interface TrustedClaudeTokenjuiceLauncher {
  /** Exact absolute path configured by the trusted Claude PreToolUse hook. */
  configuredPath: string;
  /** Canonical target observed while loading that configuration. */
  canonicalPath: string;
}

interface HookDefinition {
  event: InstalledClaudeHookEventName;
  matcher?: string;
  timeout: number;
  statusMessage?: string;
}

const HOOK_ARGUMENTS = ["claude-hook"] as const;
const PERMISSION_STATUS_MESSAGE = "Waiting for Agent Knock Knock approval...";

const HOOK_DEFINITIONS: readonly HookDefinition[] = [
  {
    event: "SessionStart",
    matcher: "startup|resume|clear|compact|fork",
    timeout: 10
  },
  { event: "UserPromptSubmit", timeout: 10 },
  { event: "PermissionRequest", matcher: "*", timeout: 600, statusMessage: PERMISSION_STATUS_MESSAGE },
  { event: "Stop", timeout: 10 },
  {
    event: "StopFailure",
    matcher: "rate_limit|authentication_failed|oauth_org_not_allowed|billing_error|invalid_request|model_not_found|server_error|max_output_tokens|unknown",
    timeout: 10
  },
  {
    event: "Notification",
    matcher: "permission_prompt|idle_prompt|agent_needs_input|agent_completed",
    timeout: 10
  }
];

/** Returns Claude Code's user settings path without reading it. */
export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * Reads only Tokenjuice launcher provenance from Claude's trusted user settings.
 * Invalid, missing, non-executable, or relative launchers are ignored so approval
 * normalization fails closed without exposing settings contents.
 */
export function loadTrustedClaudeTokenjuiceLaunchers(
  settingsPath = defaultClaudeSettingsPath()
): TrustedClaudeTokenjuiceLauncher[] {
  let settings: unknown;
  try {
    settings = readSettings(path.resolve(settingsPath));
  } catch {
    return [];
  }
  return extractClaudeTokenjuiceLaunchers(settings).flatMap((launcher) => {
    try {
      fs.accessSync(launcher, fs.constants.X_OK);
      return [{
        configuredPath: launcher,
        canonicalPath: fs.realpathSync(launcher)
      }];
    } catch {
      return [];
    }
  }).filter((launcher, index, values) => values.findIndex((candidate) =>
    candidate.configuredPath === launcher.configuredPath &&
    candidate.canonicalPath === launcher.canonicalPath
  ) === index);
}

export function extractClaudeTokenjuiceLaunchers(settingsValue: unknown): string[] {
  if (!isObject(settingsValue) || !isObject(settingsValue.hooks)) {
    return [];
  }
  const groups = settingsValue.hooks.PreToolUse;
  if (!Array.isArray(groups)) {
    return [];
  }
  const launchers: string[] = [];
  for (const group of groups) {
    if (!isObject(group) || group.matcher !== "Bash" || !Array.isArray(group.hooks)) {
      continue;
    }
    for (const handler of group.hooks) {
      if (!isObject(handler) || handler.type !== "command" || typeof handler.command !== "string") {
        continue;
      }
      const tokens = tokenizeShellWords(handler.command);
      if (!tokens) {
        continue;
      }
      const subcommandIndex = tokens.indexOf("claude-code-pre-tool-use");
      if (subcommandIndex < 1) {
        continue;
      }
      let launcher: string | undefined;
      for (let index = subcommandIndex + 1; index < tokens.length; index += 1) {
        if (tokens[index] === "--wrap-launcher") {
          launcher = tokens[index + 1];
          break;
        }
        if (tokens[index].startsWith("--wrap-launcher=")) {
          launcher = tokens[index].slice("--wrap-launcher=".length);
          break;
        }
      }
      if (launcher && path.isAbsolute(launcher)) {
        launchers.push(path.normalize(launcher));
      }
    }
  }
  return launchers.filter((launcher, index) => launchers.indexOf(launcher) === index);
}

/**
 * Adds AKK matcher groups without mutating the supplied settings object.
 * Existing groups and sibling handlers are retained byte-for-byte when the
 * result is serialized, apart from JSON's normal formatting.
 */
export function mergeClaudeHookSettings(
  settingsValue: unknown,
  executablePathValue: string
): MergeClaudeHookSettingsResult {
  const executablePath = requireAbsoluteExecutable(executablePathValue);
  const settings = requireObject(settingsValue, "Claude settings");
  const existingHooksValue = settings.hooks;
  const existingHooks = existingHooksValue === undefined
    ? {}
    : requireObject(existingHooksValue, "Claude settings hooks");
  const mergedSettings: Record<string, unknown> = { ...settings };
  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  const addedEvents: InstalledClaudeHookEventName[] = [];
  const existingEvents: InstalledClaudeHookEventName[] = [];
  const warnings: string[] = [];

  for (const definition of HOOK_DEFINITIONS) {
    const groupsValue = existingHooks[definition.event];
    if (groupsValue !== undefined && !Array.isArray(groupsValue)) {
      throw new Error(`Claude settings hooks.${definition.event} must be an array`);
    }
    const groups = groupsValue === undefined ? [] : groupsValue;
    const inspection = inspectEventGroups(groups, definition, executablePath);
    warnings.push(...inspection.warnings);
    if (inspection.hasExactHandler) {
      existingEvents.push(definition.event);
      continue;
    }

    mergedHooks[definition.event] = [
      ...groups,
      createMatcherGroup(definition, executablePath)
    ];
    addedEvents.push(definition.event);
  }

  mergedSettings.hooks = mergedHooks;
  return {
    settings: mergedSettings,
    changed: addedEvents.length > 0,
    addedEvents,
    existingEvents,
    warnings
  };
}

/**
 * Safely installs Claude Code user hooks. This function does not log settings
 * contents and its result contains only paths, event names, counts, and
 * non-sensitive warnings.
 */
export function installClaudeHooks(options: InstallClaudeHooksOptions): InstallClaudeHooksResult {
  const executablePath = requireAbsoluteExecutable(options.executablePath);
  const settingsPath = path.resolve(options.settingsPath ?? defaultClaudeSettingsPath());
  const dryRun = options.dryRun === true;
  const exists = fs.existsSync(settingsPath);
  const settings = exists ? readSettings(settingsPath) : {};
  const merged = mergeClaudeHookSettings(settings, executablePath);
  let backupPath: string | undefined;

  if (merged.changed && !dryRun) {
    const parentDirectory = path.dirname(settingsPath);
    fs.mkdirSync(parentDirectory, { recursive: true, mode: 0o700 });
    if (exists) {
      backupPath = createBackup(settingsPath, options.now ?? (() => new Date()));
    }
    atomicWriteJson(settingsPath, merged.settings);
  }

  return {
    settingsPath,
    changed: merged.changed,
    written: merged.changed && !dryRun,
    dryRun,
    created: !exists && merged.changed && !dryRun,
    ...(backupPath === undefined ? {} : { backupPath }),
    addedEvents: merged.addedEvents,
    existingEvents: merged.existingEvents,
    warnings: merged.warnings,
    summary: {
      addedCount: merged.addedEvents.length,
      existingCount: merged.existingEvents.length,
      warningCount: merged.warnings.length
    }
  };
}

/** Compatibility-friendly explicit name for callers wiring an install command. */
export const installClaudeHookSettings = installClaudeHooks;

function createMatcherGroup(
  definition: HookDefinition,
  executablePath: string
): Record<string, unknown> {
  const handler: Record<string, unknown> = {
    type: "command",
    command: executablePath,
    args: [...HOOK_ARGUMENTS],
    timeout: definition.timeout,
    ...(definition.statusMessage === undefined ? {} : { statusMessage: definition.statusMessage })
  };
  return {
    ...(definition.matcher === undefined ? {} : { matcher: definition.matcher }),
    hooks: [handler]
  };
}

function inspectEventGroups(
  groups: unknown[],
  definition: HookDefinition,
  executablePath: string
): { hasExactHandler: boolean; warnings: string[] } {
  let hasExactHandler = false;
  let hasDifferentArguments = false;
  let exactHandlerNeedsReview = false;

  for (const groupValue of groups) {
    if (!isObject(groupValue) || !Array.isArray(groupValue.hooks)) {
      continue;
    }
    for (const handlerValue of groupValue.hooks) {
      if (!isObject(handlerValue) || handlerValue.command !== executablePath) {
        continue;
      }
      if (!isExactHookArguments(handlerValue.args)) {
        hasDifferentArguments = true;
        continue;
      }
      hasExactHandler = true;
      if (!handlerMatchesDefinition(handlerValue, groupValue, definition)) {
        exactHandlerNeedsReview = true;
      }
    }
  }

  const warnings: string[] = [];
  if (hasDifferentArguments) {
    warnings.push(
      `${definition.event} contains a handler for the AKK executable with different arguments; it was preserved.`
    );
  }
  if (exactHandlerNeedsReview) {
    warnings.push(
      `${definition.event} already contains the AKK claude-hook handler with non-recommended options; it was preserved.`
    );
  }
  return { hasExactHandler, warnings };
}

function handlerMatchesDefinition(
  handler: Record<string, unknown>,
  group: Record<string, unknown>,
  definition: HookDefinition
): boolean {
  const matcherMatches = definition.matcher === undefined
    ? group.matcher === undefined
    : group.matcher === definition.matcher;
  const statusMatches = definition.statusMessage === undefined
    ? true
    : handler.statusMessage === definition.statusMessage;
  return handler.type === "command" &&
    handler.timeout === definition.timeout &&
    matcherMatches &&
    statusMatches;
}

function isExactHookArguments(value: unknown): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === HOOK_ARGUMENTS[0];
}

function tokenizeShellWords(command: string): string[] | undefined {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (escaped || quote) {
    return undefined;
  }
  if (started) {
    tokens.push(token);
  }
  return tokens;
}

function readSettings(settingsPath: string): Record<string, unknown> {
  const stat = fs.lstatSync(settingsPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to replace symbolic-link Claude settings: ${settingsPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Claude settings path is not a regular file: ${settingsPath}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    throw new Error(`Claude settings JSON is invalid: ${settingsPath}`);
  }
  return requireObject(value, "Claude settings");
}

function createBackup(settingsPath: string, now: () => Date): string {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new Error("Claude hook installer clock returned an invalid date");
  }
  const timestamp = date.toISOString().replace(/[:.]/gu, "-");
  let suffix = 0;
  while (true) {
    const candidate = `${settingsPath}.bak.${timestamp}${suffix === 0 ? "" : `.${suffix}`}`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(candidate, "wx", 0o600);
      fs.writeFileSync(descriptor, fs.readFileSync(settingsPath));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return candidate;
    } catch (error) {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
        fs.rmSync(candidate, { force: true });
      }
      if (isFileExistsError(error)) {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

function atomicWriteJson(filePath: string, value: Record<string, unknown>): void {
  const parentDirectory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
    fsyncDirectory(parentDirectory);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directoryPath, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Some filesystems do not support syncing directories. The rename is
    // still atomic, and the original settings remain available as a backup.
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function requireAbsoluteExecutable(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error("Claude hook executable path must be a non-empty absolute path");
  }
  if (!path.isAbsolute(value)) {
    throw new Error("Claude hook executable path must be absolute");
  }
  return path.normalize(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileExistsError(error: unknown): boolean {
  return isObject(error) && error.code === "EEXIST";
}
