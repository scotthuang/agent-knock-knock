import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_RETENTION_DAYS = 14;
const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY
};
const SENSITIVE_KEY_PATTERN = /(authorization|api[_-]?key|token|secret|password|passwd|gatewayToken|proxy|allProxy)/i;
const cleanupPerformed = new Set();

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface RuntimeLogRecord {
  level?: RuntimeLogLevel;
  event: string;
  [key: string]: unknown;
}

export interface RuntimeLogOptions {
  logDir?: string;
  now?: Date;
  retentionDays?: number;
  level?: RuntimeLogLevel;
}

export interface RuntimeLogWriteResult {
  written: boolean;
  path?: string;
  entry?: unknown;
}

export interface RuntimeLogCleanupResult {
  checked: number;
  deleted: number;
  retention_days: number;
}

export function defaultRuntimeLogDir(): string {
  return path.join(os.homedir(), ".agent-knock-knock", "logs");
}

export function localDateStamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-");
}

export function localTimestamp(date = new Date()): string {
  return `${localDateStamp(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${timezoneOffset(date)}`;
}

export function runtimeLogPath({ now = new Date(), logDir = defaultRuntimeLogDir() }: { now?: Date; logDir?: string } = {}): string {
  return path.join(expandHome(logDir), `runtime-${localDateStamp(now)}.ndjson`);
}

export function writeRuntimeLog(record: RuntimeLogRecord, options: RuntimeLogOptions = {}): RuntimeLogWriteResult {
  const level = normalizeLevel(record.level ?? "info");
  const configuredLevel = normalizeLevel(options.level ?? process.env.AKK_LOG_LEVEL ?? "info");
  if (!shouldLog(level, configuredLevel)) {
    return { written: false };
  }

  const now = options.now ?? new Date();
  const logDir = expandHome(options.logDir ?? process.env.AKK_LOG_DIR ?? defaultRuntimeLogDir());
  const retentionDays = retentionDaysFromOptions(options);
  maybeCleanupRuntimeLogs({ logDir, retentionDays, now });

  fs.mkdirSync(logDir, { recursive: true });
  const logPath = runtimeLogPath({ now, logDir });
  const entry = redactRecord({
    ts: localTimestamp(now),
    ts_utc: now.toISOString(),
    level,
    ...record
  });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return { written: true, path: logPath, entry };
}

export function cleanupRuntimeLogs({
  logDir = defaultRuntimeLogDir(),
  retentionDays = DEFAULT_RETENTION_DAYS,
  now = new Date()
}: {
  logDir?: string;
  retentionDays?: number;
  now?: Date;
} = {}): RuntimeLogCleanupResult {
  const expandedLogDir = expandHome(logDir);
  const retention = Number(retentionDays);
  if (!Number.isFinite(retention) || retention <= 0 || !fs.existsSync(expandedLogDir)) {
    return { checked: 0, deleted: 0, retention_days: retention };
  }

  const cutoffMs = startOfLocalDay(now).getTime() - (retention * 24 * 60 * 60 * 1000);
  let checked = 0;
  let deleted = 0;
  for (const entry of fs.readdirSync(expandedLogDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    const match = /^runtime-(\d{4})-(\d{2})-(\d{2})\.ndjson$/.exec(entry.name);
    if (!match) {
      continue;
    }

    checked += 1;
    const fileDay = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileDay.getTime() < cutoffMs) {
      fs.rmSync(path.join(expandedLogDir, entry.name), { force: true });
      deleted += 1;
    }
  }

  return { checked, deleted, retention_days: retention };
}

export function redactRecord(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRecord(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        return [key, "[REDACTED]"];
      }
      return [key, redactRecord(item)];
    }));
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  return value;
}

export function redactString(value: string): string {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(--(?:gateway-)?token(?:=|\s+))("[^"]+"|'[^']+'|\S+)/gi, "$1[REDACTED]")
    .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "gh[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[REDACTED]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA[REDACTED]")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1[REDACTED]@");
}

function maybeCleanupRuntimeLogs({ logDir, retentionDays, now }: { logDir: string; retentionDays: number; now: Date }): void {
  const key = `${path.resolve(logDir)}:${retentionDays}`;
  if (cleanupPerformed.has(key)) {
    return;
  }

  cleanupPerformed.add(key);
  cleanupRuntimeLogs({ logDir, retentionDays, now });
}

function retentionDaysFromOptions(options: RuntimeLogOptions): number {
  if (options.retentionDays !== undefined) {
    return Number(options.retentionDays);
  }
  if (process.env.AKK_LOG_RETENTION_DAYS !== undefined) {
    return Number(process.env.AKK_LOG_RETENTION_DAYS);
  }
  return DEFAULT_RETENTION_DAYS;
}

function normalizeLevel(level: unknown): RuntimeLogLevel {
  return typeof level === "string" && Object.hasOwn(LOG_LEVELS, level) ? level as RuntimeLogLevel : "info";
}

function shouldLog(level: RuntimeLogLevel, configuredLevel: RuntimeLogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[configuredLevel];
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function timezoneOffset(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }

  if (filePath?.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }

  return filePath;
}
