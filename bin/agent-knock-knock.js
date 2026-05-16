#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  extractStructuredMessage,
  parseMessageJson
} from "../src/protocol.js";
import { claudeBootstrapPrompt } from "../src/bootstrap.js";
import { formatTranscript, readNdjsonLog } from "../src/transcript.js";
import {
  appendEvent,
  defaultStoreDir,
  logPathForStatePath,
  loadState,
  messageEvent,
  pathsForConversation,
  pathsForConversationDir,
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
  } else if (command === "transcript") {
    runTranscript(args);
  } else if (command === "callback") {
    runCallback(args);
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
  const workspace = options.workspace ?? process.cwd();
  const conversation = createConversation({
    userRequest: request,
    workspace,
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
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const storedConversation = withStoragePaths(nextConversation, paths);

  saveState(paths.statePath, storedConversation);
  appendEvent(paths.logPath, {
    ts: conversation.created_at,
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation: storedConversation
  });
  appendEvent(paths.logPath, messageEvent(taskMessage));

  printJson({
    conversation: storedConversation,
    paths,
    task_message: taskMessage,
    budget: budgetAction(storedConversation)
  });
}

function runRecord(options) {
  const statePath = required(options.state, "--state is required");
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = options.log ?? logPathForStatePath(statePath);

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
  const workspace = options.workspace ?? process.cwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  const newResult = captureJson([
    "new",
    "--request",
    request,
    "--workspace",
    workspace,
    "--openclaw-session",
    options.openclawSession ?? "agent:main:main",
    "--claude-session",
    options.claudeSession ?? "bidirectional",
    "--soft-limit",
    String(options.softLimit ?? 50),
    "--hard-limit",
    String(options.hardLimit ?? 100),
    "--store-dir",
    storeDir
  ]);

  const gatewayUrl = options.gatewayUrl ?? "ws://127.0.0.1:18789";
  if (options.send && !options.token) {
    throw new Error("--token is required when using --send");
  }

  const openclawSession = options.openclawSession ?? "agent:main:main";
  const claudeSession = options.claudeSession ?? "bidirectional";
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: newResult.paths.statePath })
    : buildCallbackCommand({
        statePath: newResult.paths.statePath,
        gatewayUrl,
        token: options.token,
        openclawSession
      });
  const conversationWithCallback = {
    ...newResult.conversation,
    gateway_url: gatewayUrl,
    callback_command: callbackCommand
  };
  saveState(newResult.paths.statePath, conversationWithCallback);
  newResult.conversation = conversationWithCallback;

  const bootstrap = claudeBootstrapPrompt({
    callbackCommand,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });
  const payload = `${bootstrap}\n\nInitial task message:\n${JSON.stringify(newResult.task_message)}`;

  const acpxArgs = ["--approve-all", "claude", "-s", claudeSession, payload];

  if (options.background) {
    const acpxPath = resolveExecutable("acpx");
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();

    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "claude_launch",
      mode: "background",
      pid: child.pid ?? null,
      claude_session: claudeSession
    });

    printJson({
      ...newResult,
      launched: true,
      background: true,
      pid: child.pid ?? null
    });
    return;
  }

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

function resolveExecutable(command) {
  if (command.includes(path.sep)) {
    return command;
  }

  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of paths) {
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

function buildCallbackCommand({ statePath, gatewayUrl, token, openclawSession }) {
  const parts = [
    shellQuote(process.execPath),
    shellQuote(new URL(import.meta.url).pathname),
    "callback",
    "--state",
    shellQuote(statePath)
  ];

  if (token) {
    parts.push(
      "--gateway-url",
      shellQuote(gatewayUrl),
      "--token",
      shellQuote(token),
      "--openclaw-session",
      shellQuote(openclawSession)
    );
  } else {
    parts.push("--record-only");
  }

  parts.push("--message-json", "'<structured-message-json>'");
  return parts.join(" ");
}

function expandCallbackCommandTemplate(template, { statePath }) {
  return template
    .replaceAll("{statePath}", shellQuote(statePath))
    .replaceAll("{state_path}", shellQuote(statePath));
}

function runTranscript(options) {
  const conversationDir = options.conversation ? expandHome(options.conversation) : null;
  const logPath = conversationDir
    ? pathsForConversationDir(conversationDir).logPath
    : required(options.log ?? options.path, "--log or --conversation is required");
  const events = readNdjsonLog(expandHome(logPath));
  process.stdout.write(formatTranscript(events, {
    includeRaw: Boolean(options.includeRaw)
  }));
}

function runCallback(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    runLockedCallback({ ...options, statePath });
  } finally {
    releaseLock();
  }
}

function runLockedCallback(options) {
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = expandHome(options.log ?? logPathForStatePath(options.statePath));
  const conversation = loadState(options.statePath);
  const message = extractStructuredMessage({
    conversation,
    input: messageInput,
    defaultFrom: "claude-code",
    defaultTo: "openclaw"
  });

  const existingEvents = readExistingEvents(logPath);
  if (isDuplicateMessage(existingEvents, message)) {
    printJson({
      conversation,
      message,
      budget: budgetAction(conversation),
      delivered: false,
      duplicate: true
    });
    return;
  }

  const nextConversation = applyMessageToConversation(conversation, message);

  appendEvent(logPath, messageEvent(message));
  saveState(options.statePath, nextConversation);

  const result = {
    conversation: nextConversation,
    message,
    budget: budgetAction(nextConversation),
    delivered: false,
    duplicate: false
  };

  if (options.recordOnly) {
    printJson(result);
    return;
  }

  const gatewayUrl = options.gatewayUrl ?? conversation.gateway_url;
  const token = options.token ?? conversation.gateway_token;
  const openclawSession = options.openclawSession ?? conversation.openclaw_session;

  if (!gatewayUrl) {
    throw new Error("--gateway-url is required unless state has gateway_url");
  }
  if (!token || token === "<token>") {
    throw new Error("--token is required for callback delivery");
  }
  if (!openclawSession) {
    throw new Error("--openclaw-session is required unless state has openclaw_session");
  }

  const delivery = deliverToOpenClaw({ gatewayUrl, token, openclawSession, message });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "callback_delivery",
    from: "claude-code",
    to: "openclaw",
    round: message.round,
    status: delivery.status,
    stdout: delivery.stdout,
    stderr: delivery.stderr
  });

  if (delivery.status !== 0) {
    throw new Error(delivery.stderr || delivery.stdout || `callback delivery failed with status ${delivery.status}`);
  }

  printJson({
    ...result,
    delivered: true
  });
}

function acquireFileLock(lockPath, { timeoutMs = 5000, retryMs = 50 } = {}) {
  const started = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      return () => {
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`timed out waiting for callback lock: ${lockPath}`);
      }
      sleepSync(retryMs);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readExistingEvents(logPath) {
  try {
    return readNdjsonLog(logPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function isDuplicateMessage(events, message) {
  return events.some((event) => {
    if (event.event !== "message") {
      return false;
    }

    const existing = event.message ?? event;
    if (existing.id && existing.id === message.id) {
      return true;
    }

    return messageFingerprint(existing) === messageFingerprint(message);
  });
}

function messageFingerprint(message) {
  return JSON.stringify({
    conversation_id: message.conversation_id,
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    body: message.body
  });
}

function deliverToOpenClaw({ gatewayUrl, token, openclawSession, message }) {
  const agent = `openclaw acp --url ${gatewayUrl} --token ${token} --session ${openclawSession}`;
  const result = spawnSync("acpx", ["--agent", agent, JSON.stringify(message)], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function withStoragePaths(conversation, paths) {
  return {
    ...conversation,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
}

function usage() {
  process.stdout.write(`Usage:
  agent-knock-knock new --request <text> [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock record --state <file> --message-json <json>
  agent-knock-knock bootstrap-prompt --callback-command <command>
  agent-knock-knock delegate --request <text> [--store-dir <dir>] [--token <gateway-token>] [--send|--background]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}
