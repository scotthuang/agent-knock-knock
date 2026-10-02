import {
  spawnSync
} from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  runNpmWithRetries
} from "../npm-command-retry.js";
import {
  packageRoot
} from "./paths.js";

export function setConfig(openclaw, key, value) {
  openclaw([
    "config",
    "set",
    key,
    JSON.stringify(value),
    "--strict-json"
  ]);
}

export function openClawPluginInstallArgs(openclaw, source) {
  const help = openclaw(["plugins", "install", "--help"], {
    allowNonzero: true
  });
  const supportsCapabilityConsent = help.status === 0 &&
    `${help.stdout ?? ""}\n${help.stderr ?? ""}`.includes(
      "--accept-capabilities"
    );
  return [
    "plugins",
    "install",
    "--force",
    ...(supportsCapabilityConsent ? ["--accept-capabilities"] : []),
    source
  ];
}

export function run(command, args, {
  allowNonzero = false,
  cwd = packageRoot,
  env = isolatedEnv(),
  timeoutMs = 60_000
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed to run: ${result.error.message}`
    );
  }
  if (!allowNonzero && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited with ${result.status}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n").slice(-20_000));
  }
  return result;
}

export function runNpm(args, options) {
  return runNpmWithRetries({ args, options, run });
}

export function isolatedEnv(extra = {}) {
  const inheritedKeys = [
    "CI",
    "COMSPEC",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "http_proxy",
    "https_proxy",
    "no_proxy"
  ];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...extra
  };
}

export function parseJsonOutput(stdout, label) {
  const trimmed = String(stdout ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = trimmed.indexOf("{"); index >= 0;) {
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {
        index = trimmed.indexOf("{", index + 1);
      }
    }
    throw new Error(
      `${label} returned malformed JSON:\n${trimmed.slice(-4000)}`
    );
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function exactFloor(value, label) {
  const range = requiredString(value, label);
  const match = /^>=(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(range);
  if (!match) {
    throw new Error(`${label} must be an exact >= version floor`);
  }
  return match[1];
}

export function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function requiredStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

export function sorted(values) {
  return [...values].sort();
}

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "-");
}

export function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function appendBounded(current, addition, maxLength) {
  const combined = current + addition;
  return combined.length > maxLength
    ? combined.slice(-maxLength)
    : combined;
}

export function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}
