import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClaudeTranscriptAnchor {
  schema_version: 1;
  session_id: string;
  cwd: string;
  pid: number;
  agent_started_at_ms: number;
  captured_at: string;
  relative_path: string;
  offset_bytes: number;
  file_existed: boolean;
  device?: string;
  inode?: string;
  /** Verified reader root, private and immutable after capture. */
  config_dir?: string;
}

export function defaultClaudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(os.homedir(), ".claude");
}

/** A verified reader root is identity evidence, not a process-wide default. */
export function validatedClaudeConfigDir(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2048 ||
      /[\u0000-\u001f\u007f]/u.test(value) ||
      !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error("Claude transcript config directory is invalid");
  }
  return value;
}

export function resolveClaudeTranscriptHome(input: {
  claudeHome?: string;
  configDir?: string;
  anchoredConfigDir?: string;
}): string {
  const current = validatedClaudeConfigDir(input.configDir);
  const anchored = validatedClaudeConfigDir(input.anchoredConfigDir);
  const explicit = input.claudeHome === undefined ? undefined
    : existingDirectoryIdentity(validatedClaudeConfigDir(path.resolve(input.claudeHome))!);
  const roots = [explicit, current, anchored].filter((root) => root !== undefined);
  if (new Set(roots).size > 1) {
    throw new Error("Claude transcript config directory conflicts with the exact session identity");
  }
  return anchored ?? current ?? explicit ?? path.resolve(defaultClaudeHome());
}

function existingDirectoryIdentity(directory: string): string {
  try { return fs.realpathSync(directory); }
  catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(String((error as NodeJS.ErrnoException)?.code))) return directory;
    throw error;
  }
}

export function claudeTranscriptAnchorFingerprint(anchor: ClaudeTranscriptAnchor): string {
  return createHash("sha256").update(JSON.stringify({
    schema: "agent-knock-knock/claude-transcript-acceptance-anchor",
    version: 1,
    ...(anchor.config_dir ? { config_dir: anchor.config_dir } : {}),
    session_id: anchor.session_id,
    cwd: anchor.cwd,
    pid: anchor.pid,
    agent_started_at_ms: anchor.agent_started_at_ms,
    captured_at: anchor.captured_at,
    relative_path: anchor.relative_path,
    offset_bytes: anchor.offset_bytes,
    file_existed: anchor.file_existed,
    device: anchor.device ?? null,
    inode: anchor.inode ?? null
  })).digest("hex");
}

export function claudeTranscriptFileId(sessionId: string, fileIdentity: string): string {
  return createHash("sha256").update(`${sessionId}\0${fileIdentity}`).digest("hex").slice(0, 24);
}
