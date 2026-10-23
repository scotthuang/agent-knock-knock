import os from "node:os";
import path from "node:path";
import { cliCwd, cliEnv } from "./cli-runtime-context.js";

export interface ClaudeReaderDiagnostic {
  executable: string;
  source: "option" | "environment" | "default";
  path_omitted: boolean;
}

/** Shared reader selection; a launcher and its session directory are separate inputs. */
export function claudeReaderConfiguration(options: Readonly<Record<string, unknown>> = {}): {
  reader: string; configDirs: string[]; readerSource: ClaudeReaderDiagnostic["source"];
} {
  const env = cliEnv(), home = env.HOME ?? os.homedir();
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const resolve = (value: string) => path.resolve(cliCwd(), value === "~" ? home
    : value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  const exactHome = text(options.claudeHome);
  let dirs = [text(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude")];
  if (!exactHome && env.AKK_NATIVE_CLAUDE_CONFIG_DIRS) {
    const configured: unknown = JSON.parse(env.AKK_NATIVE_CLAUDE_CONFIG_DIRS);
    if (!Array.isArray(configured) || !configured.length || configured.length > 16 ||
      configured.some(dir => typeof dir !== "string" || !path.isAbsolute(dir))) {
      throw new Error("Invalid Claude native config directories");
    }
    dirs = configured;
  }
  if (exactHome) dirs = [exactHome];
  if (dirs.some(dir => /[\u0000-\u001f\u007f]/u.test(dir))) throw new Error("Invalid Claude native config directories");
  const reader = text(options.claudeBin) ?? text(env.AKK_NATIVE_CLAUDE_BIN) ?? "claude";
  const readerSource = text(options.claudeBin) ? "option"
    : text(env.AKK_NATIVE_CLAUDE_BIN) ? "environment" : "default";
  if (/[\u0000-\u001f\u007f]/u.test(reader)) throw new Error("Invalid Claude reader executable");
  return { reader: reader.includes(path.sep) ? resolve(reader) : reader,
    readerSource, configDirs: [...new Set(dirs.map(resolve))] };
}

/** Share only a bounded executable name, never private installation paths or the environment. */
export function claudeReaderDiagnostic(config: ReturnType<typeof claudeReaderConfiguration>): ClaudeReaderDiagnostic {
  return { executable: Array.from(path.basename(config.reader)).slice(0, 128).join(""),
    source: config.readerSource, path_omitted: config.reader.includes(path.sep) };
}

export function claudeReaderNextAction(codes: readonly string[]): string | undefined {
  return codes.includes("claude_reader_unavailable")
    ? "check_claude_reader_in_host_environment" : undefined;
}
