#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  parseMessageJson
} from "../src/protocol.js";
import { claudeBootstrapPrompt } from "../src/bootstrap.js";
import {
  appendEvent,
  defaultLogDir,
  loadState,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

try {
  if (command === "new") {
    runNew(args);
  } else if (command === "record") {
    runRecord(args);
  } else if (command === "bootstrap-prompt") {
    runBootstrapPrompt(args);
  } else if (command === "delegate") {
    runDelegate(args);
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function runNew(options) {
  const request = required(options.request, "--request is required");
  const conversation = createConversation({
    userRequest: request,
    workspace: options.workspace ?? process.cwd(),
    openclawSession: options.openclawSession ?? "agent:main:main",
    claudeSession: options.claudeSession ?? "bidirectional",
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });

  const taskMessage = createMessage({
    conversation,
    from: "openclaw",
    to: "claude-code",
    type: "task",
    body: request
  });

  const nextConversation = applyMessageToConversation(conversation, taskMessage);
  const paths = pathsForConversation(conversation.conversation_id, expandHome(options.logDir ?? defaultLogDir()));

  saveState(paths.statePath, nextConversation);
  appendEvent(paths.logPath, {
    ts: conversation.created_at,
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation: nextConversation
  });
  appendEvent(paths.logPath, messageEvent(taskMessage));

  printJson({
    conversation: nextConversation,
    paths,
    task_message: taskMessage,
    budget: budgetAction(nextConversation)
  });
}

function runRecord(options) {
  const statePath = required(options.state, "--state is required");
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = options.log ?? statePath.replace(/\.state\.json$/, ".ndjson");

  const conversation = loadState(expandHome(statePath));
  const message = parseMessageJson(messageInput);
  const nextConversation = applyMessageToConversation(conversation, message);

  appendEvent(expandHome(logPath), messageEvent(message));
  saveState(expandHome(statePath), nextConversation);

  printJson({
    conversation: nextConversation,
    budget: budgetAction(nextConversation)
  });
}

function runBootstrapPrompt(options) {
  const callbackCommand = required(options.callbackCommand, "--callback-command is required");
  process.stdout.write(
    claudeBootstrapPrompt({
      callbackCommand,
      softLimit: Number(options.softLimit ?? 50),
      hardLimit: Number(options.hardLimit ?? 100)
    })
  );
}

function runDelegate(options) {
  const request = required(options.request, "--request is required");
  const logDir = expandHome(options.logDir ?? defaultLogDir());
  const newResult = captureJson([
    "new",
    "--request",
    request,
    "--workspace",
    options.workspace ?? process.cwd(),
    "--openclaw-session",
    options.openclawSession ?? "agent:main:main",
    "--claude-session",
    options.claudeSession ?? "bidirectional",
    "--soft-limit",
    String(options.softLimit ?? 50),
    "--hard-limit",
    String(options.hardLimit ?? 100),
    "--log-dir",
    logDir
  ]);

  const gatewayUrl = options.gatewayUrl ?? "ws://127.0.0.1:18789";
  if (options.send && !options.token) {
    throw new Error("--token is required when using --send");
  }

  const token = options.token ?? "<token>";
  const openclawSession = options.openclawSession ?? "agent:main:main";
  const claudeSession = options.claudeSession ?? "bidirectional";
  const callbackCommand = `acpx --agent 'openclaw acp --url ${gatewayUrl} --token ${token} --session ${openclawSession}' '<structured-message-json>'`;
  const bootstrap = claudeBootstrapPrompt({
    callbackCommand,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });
  const payload = `${bootstrap}\n\nInitial task message:\n${JSON.stringify(newResult.task_message)}`;

  const acpxArgs = ["--approve-all", "claude", "-s", claudeSession, payload];

  if (options.send) {
    const result = spawnSync("acpx", acpxArgs, { stdio: "inherit" });
    process.exitCode = result.status ?? 1;
    return;
  }

  printJson({
    ...newResult,
    dry_run: true,
    acpx_command: ["acpx", ...acpxArgs],
    note: "Run again with --send to send this task through acpx."
  });
}

function captureJson(argv) {
  const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, ...argv], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `subcommand failed: ${argv[0]}`);
  }

  return JSON.parse(result.stdout);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }

    const key = toCamelCase(arg.slice(2));
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

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function required(value, message) {
  if (value === undefined || value === "") {
    throw new Error(message);
  }

  return value;
}

function expandHome(filePath) {
  if (filePath === "~") {
    return process.env.HOME;
  }

  if (filePath?.startsWith("~/")) {
    return `${process.env.HOME}${filePath.slice(1)}`;
  }

  return filePath;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  process.stdout.write(`Usage:
  agent-knock-knock new --request <text> [--workspace <path>]
  agent-knock-knock record --state <file> --message-json <json>
  agent-knock-knock bootstrap-prompt --callback-command <command>
  agent-knock-knock delegate --request <text> [--token <gateway-token>] [--send]
`);
}
