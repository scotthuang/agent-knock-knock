import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cliEnv, writeCliStdout } from "./cli-runtime-context.js";
import { redactString } from "./runtime-log.js";
import { isRecord } from "./value-guards.js";

export function resolveExecutable(command: string): string {
  if (command.includes(path.sep)) {
    return command;
  }

  for (const dir of executableSearchPaths()) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }

  throw new Error(`executable not found on PATH: ${command}`);
}

function executableSearchPaths(): string[] {
  const home = cliEnv().HOME;
  return [
    ...(cliEnv().PATH ?? "").split(path.delimiter).filter(Boolean),
    ...(home ? [
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin")
    ] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
}

export function resolveOptionalExecutable(command: string): string {
  try {
    return resolveExecutable(command);
  } catch {
    return command;
  }
}

export function packageRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function expandHome<Value>(filePath: Value): Value extends string ? string : Value {
  const candidate = filePath as string | null | undefined;
  return (candidate === "~" ? cliEnv().HOME
    : candidate?.startsWith("~/") ? `${cliEnv().HOME}${candidate.slice(1)}`
      : candidate) as Value extends string ? string : Value;
}

export function positiveMilliseconds(value: unknown, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return Math.ceil(parsed);
}

export function cleanProcessText(text: unknown): string | undefined {
  const value = String(text ?? "").trim();
  return value ? value.slice(0, 2000) : undefined;
}

export function writeCliJson(value: unknown): void {
  writeCliStdout(`${JSON.stringify(redactCliOutput(value), null, 2)}\n`);
}

export function redactCliOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCliOutput(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (key === "gateway_token" || key === "gatewayToken") {
          return [];
        }
        if (
          key === "claude_transcript_anchor" ||
          key === "claudeTranscriptAnchor" ||
          key === "codex_rollout_acceptance_anchor" ||
          key === "codexRolloutAcceptanceAnchor" ||
          key === "claude_home" ||
          key === "claudeHome"
        ) {
          return [];
        }
        if ((key === "callback_command" || key === "callbackCommand") && typeof item === "string") {
          return [[key, redactString(item)]];
        }
        return [[key, redactCliOutput(item)]];
      })
    );
  }
  return value;
}
