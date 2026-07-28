#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const options = parseArgs(process.argv.slice(2));
if (
  process.env.AKK_RUN_LIVE_ACPX_SMOKE !== "1" ||
  options.confirmLive !== true
) {
  fail(
    "Refusing to run a credentialed ACPX turn. Set AKK_RUN_LIVE_ACPX_SMOKE=1 and pass --confirm-live."
  );
}

const agent = String(options.agent ?? "codex").toLowerCase();
if (!["codex", "claude", "cursor"].includes(agent)) {
  fail("--agent must be codex, claude, or cursor");
}
const workspace = fs.realpathSync(path.resolve(String(options.workspace ?? process.cwd())));
if (!fs.statSync(workspace).isDirectory()) {
  fail("--workspace must be a directory");
}

const acpxBin = String(options.acpxBin ?? "acpx");
const nonce = randomUUID();
const session = `akk-smoke-${agent}-${nonce.slice(0, 8)}`;
const selector = agent === "codex"
  ? [
      "--agent",
      process.env.AKK_CODEX_ACPX_AGENT_COMMAND?.trim() ||
        "npx -y @agentclientprotocol/codex-acp@1.1.7"
    ]
  : [agent];
const prompt = [
  "This is an Agent Knock Knock live ACPX smoke test.",
  "Do not use tools and do not modify files.",
  `Reply with this nonce and nothing else: ${nonce}`
].join(" ");

process.stderr.write(
  `LIVE ACPX SMOKE: this sends one real ${agent} turn and may use credentials or incur cost. Session: ${session}\n`
);

try {
  run(acpxBin, [...selector, "sessions", "new", "--name", session], workspace);
  const response = run(
    acpxBin,
    [
      "--deny-all",
      "--allowed-tools",
      "",
      "--max-turns",
      "1",
      "--ttl",
      "30",
      ...selector,
      ...(agent === "codex" ? ["prompt"] : []),
      "-s",
      session,
      prompt
    ],
    workspace,
    Number(options.timeoutSeconds ?? 180) * 1000
  );
  if (!response.includes(nonce)) {
    fail("ACPX smoke response did not contain the nonce");
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    agent,
    session,
    nonce_verified: true
  }, null, 2)}\n`);
} finally {
  const closed = spawnSync(
    acpxBin,
    [...selector, "sessions", "close", session],
    {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000
    }
  );
  if (closed.status !== 0) {
    process.stderr.write(
      `Warning: disposable ACPX session ${session} could not be closed automatically.\n`
    );
  }
}

function run(command, args, cwd, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: 1024 * 1024
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      String(result.stderr || result.stdout || `${command} exited with status ${result.status}`)
        .trim()
        .slice(0, 1000)
    );
  }
  return String(result.stdout || result.stderr || "");
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      fail(`unexpected argument: ${argument}`);
    }
    const key = argument
      .slice(2)
      .replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function fail(message) {
  throw new Error(message);
}
