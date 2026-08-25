import fs from "node:fs";

import {
  assertHostProfileCompatibility,
  assertHostProfileCallbackExecutableReady,
  resolveHostProfileControllerContext
} from "./host-profile.js";
import {
  cliCwd,
  cliEnv,
  setCliExitCode,
  writeCliStdout
} from "./cli-runtime-context.js";
import { writeCliJson } from "./cli-command-runtime.js";
import {
  defaultHostProfileRegistry,
  selectHostProfileV1
} from "./host-profile-runtime.js";

export interface HostProfileCliOptions extends Record<string, unknown> {
  action?: unknown;
  profile?: unknown;
  host?: unknown;
  hostVersion?: unknown;
}

const HOST_PROFILE_STARTER_URL = new URL(
  "../../examples/host-profiles/command-json-starter.json",
  import.meta.url
);

export function runHostProfileCommand(
  options: HostProfileCliOptions
): void {
  const action = requiredString(options.action, "host-profile action");
  if (action === "example") {
    if (options.profile !== undefined) {
      throw new Error("host-profile example does not accept a Profile path");
    }
    writeCliStdout(fs.readFileSync(HOST_PROFILE_STARTER_URL, "utf8"));
    return;
  }
  if (action === "list") {
    if (options.profile !== undefined) {
      throw new Error("host-profile list does not accept a Profile path");
    }
    writeCliJson({
      schema: "agent-knock-knock/host-profile-list",
      version: 1,
      profiles: defaultHostProfileRegistry.list()
    });
    return;
  }
  if (action !== "validate") {
    throw new Error("host-profile action must be example, list, or validate");
  }

  const selected = selectHostProfileV1(
    requiredString(options.profile, "host-profile validate path or built-in id"),
    { cwd: cliCwd(), registry: defaultHostProfileRegistry }
  );
  const compatibility = optionalCompatibility(options);
  if (compatibility) {
    assertHostProfileCompatibility(selected.profile, compatibility);
  }
  writeCliJson({
    ok: true,
    schema: selected.profile.schema,
    version: selected.profile.version,
    source: selected.source,
    selection: selected.selection,
    id: selected.profile.id,
    revision: selected.profile.revision,
    fingerprint: selected.fingerprint,
    compatibility: selected.profile.compatibility,
    compatibility_checked: compatibility !== undefined,
    controller_context_driver: selected.profile.controllerContext.driver,
    callback_driver: selected.profile.callback.driver
  });
}

export function runHostProfileDoctor(options: HostProfileCliOptions): void {
  const checks: Array<Record<string, unknown>> = [];
  let selected;
  try {
    selected = selectHostProfileV1(
      requiredString(options.profile, "--host-profile"),
      { cwd: cliCwd(), registry: defaultHostProfileRegistry }
    );
    checks.push({ name: "profile", status: "ok" });
  } catch (error) {
    checks.push({
      name: "profile",
      status: "error",
      detail: errorMessage(error)
    });
    finishDoctor(checks);
    return;
  }

  try {
    const compatibility = requiredCompatibility(options);
    assertHostProfileCompatibility(selected.profile, compatibility);
    checks.push({
      name: "host_compatibility",
      status: "ok",
      host: compatibility.host,
      version: compatibility.version,
      range: selected.profile.compatibility.range
    });
  } catch (error) {
    checks.push({
      name: "host_compatibility",
      status: "error",
      detail: errorMessage(error)
    });
  }

  try {
    resolveHostProfileControllerContext(selected.profile, cliEnv());
    checks.push({
      name: "controller_context",
      status: "ok",
      variable: selected.profile.controllerContext.sessionIdVariable
    });
  } catch (error) {
    checks.push({
      name: "controller_context",
      status: "error",
      variable: selected.profile.controllerContext.sessionIdVariable,
      detail: errorMessage(error)
    });
  }

  try {
    assertHostProfileCallbackExecutableReady(
      selected.profile.callback.executable,
      selected.profile.callback.environment.allow
    );
    checks.push({
      name: "callback_executable",
      status: "ok",
      path: selected.profile.callback.executable
    });
  } catch (error) {
    checks.push({
      name: "callback_executable",
      status: "error",
      path: selected.profile.callback.executable,
      detail: errorMessage(error)
    });
  }

  finishDoctor(checks, {
    profile_id: selected.profile.id,
    profile_revision: selected.profile.revision,
    profile_fingerprint: selected.fingerprint
  });
}

function finishDoctor(
  checks: Array<Record<string, unknown>>,
  detail: Record<string, unknown> = {}
): void {
  const ok = checks.every((check) => check.status === "ok");
  writeCliJson({
    ok,
    mode: "host_bridge",
    ...detail,
    checks
  });
  if (!ok) setCliExitCode(1);
}

function optionalCompatibility(
  options: HostProfileCliOptions
): { host: string; version: string } | undefined {
  if (options.host === undefined && options.hostVersion === undefined) {
    return undefined;
  }
  return requiredCompatibility(options);
}

function requiredCompatibility(
  options: HostProfileCliOptions
): { host: string; version: string } {
  return {
    host: requiredString(options.host, "--host"),
    version: requiredString(options.hostVersion, "--host-version")
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
