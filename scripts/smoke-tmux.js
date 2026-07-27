#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const options = parseArgs(process.argv.slice(2));
if (
  process.env.AKK_RUN_LIVE_TMUX_SMOKE !== "1" ||
  options.confirmLive !== true
) {
  fail(
    "Refusing to send a real tmux turn. Set AKK_RUN_LIVE_TMUX_SMOKE=1 and pass --confirm-live."
  );
}

const target = requiredString(options.target, "--target is required");
const expectedPanePid = Number(requiredString(
  options.expectedPanePid,
  "--expected-pane-pid is required"
));
if (!Number.isSafeInteger(expectedPanePid) || expectedPanePid <= 1) {
  fail("--expected-pane-pid must be a positive integer");
}
const agent = String(options.agent ?? "codex").toLowerCase();
if (!["codex", "claude"].includes(agent)) {
  fail("--agent must be codex or claude");
}

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const cliPath = path.join(packageRoot, "dist", "src", "cli.js");
const list = runCli(cliPath, ["list", "--terminal-debug"]);
const candidates = Array.isArray(list.terminal_controlled)
  ? list.terminal_controlled
  : [];
const matches = candidates.filter((candidate) =>
  candidate?.agent === agent &&
  candidate?.terminal_control?.target === target &&
  Number(candidate?.terminal_control?.panePid) === expectedPanePid
);
if (matches.length !== 1) {
  fail(
    `Expected one ${agent} terminal at ${target} with pane PID ${expectedPanePid}; found ${matches.length}.`
  );
}
const selected = matches[0];
if (
  selected.activity_state !== "idle" ||
  selected.commands?.send !== true
) {
  fail(
    `Refusing to send: ${target} is not a verified idle, actionable ${agent} pane.`
  );
}

const nonce = randomUUID();
const message = String(
  options.message ??
    `AKK live tmux smoke ${nonce}: reply with the nonce only and do not modify files.`
);
process.stderr.write(
  `LIVE TMUX SMOKE: sending one real turn to ${target} (pane PID ${expectedPanePid}).\n`
);
const result = runCli(cliPath, [
  "send",
  "--conversation",
  String(selected.id),
  "--message",
  message
]);
process.stdout.write(`${JSON.stringify({
  ok: true,
  agent,
  target,
  pane_pid: expectedPanePid,
  conversation_id: result.conversation?.conversation_id ?? selected.id,
  nonce
}, null, 2)}\n`);

function runCli(cliPath, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    fail(`agent-knock-knock ${args[0]} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      String(
        result.stderr ||
          result.stdout ||
          `agent-knock-knock ${args[0]} exited with status ${result.status}`
      ).trim().slice(0, 2000)
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`agent-knock-knock ${args[0]} returned malformed JSON`);
  }
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

function requiredString(value, message) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(message);
  }
  return value;
}

function fail(message) {
  throw new Error(message);
}
