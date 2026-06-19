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
  executorForConversation,
  extractStructuredMessage,
  parseMessageJson,
  resolveExecutor
} from "./protocol.js";
import { executorBootstrapPrompt } from "./bootstrap.js";
import { writeRuntimeLog } from "./runtime-log.js";
import { formatTranscript, readNdjsonLog } from "./transcript.js";
import {
  appendEvent,
  defaultStoreDir,
  listConversations,
  logPathForStatePath,
  loadConversationById,
  loadState,
  messageEvent,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  statePathForConversationId
} from "./store.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

runtimeLog("info", "cli_start", {
  command: command ?? "help",
  cwd: process.cwd(),
  option_keys: Object.keys(args).sort()
});

try {
  runCommand(command, args);
  runtimeLog("info", "cli_finish", {
    command: command ?? "help",
    exit_code: process.exitCode ?? 0
  });
} catch (error) {
  runtimeLog("error", "cli_error", {
    command: command ?? "help",
    message: error.message,
    stack: error.stack
  });
  console.error(error.message);
  process.exit(1);
}

function runCommand(commandName, options) {
  if (commandName === "new") {
    runNew(options);
  } else if (commandName === "record") {
    runRecord(options);
  } else if (commandName === "bootstrap-prompt") {
    runBootstrapPrompt(options);
  } else if (commandName === "delegate") {
    runDelegate(options);
  } else if (commandName === "list") {
    runList(options);
  } else if (commandName === "status") {
    runStatus(options);
  } else if (commandName === "send") {
    runSend(options);
  } else if (commandName === "cancel") {
    runCancel(options);
  } else if (commandName === "close") {
    runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "callback") {
    runCallback(options);
  } else {
    usage();
    process.exitCode = commandName ? 1 : 0;
  }
}

function runNew(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace ?? process.cwd();
  cleanupIdleConversations(expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace)), options);
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: options.session ?? options.executorSession ?? options.claudeSession
  });
  const conversation = createConversation({
    userRequest: request,
    workspace,
    openclawSession: options.openclawSession ?? "agent:main:main",
    claudeSession: options.claudeSession ?? "bidirectional",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });

  const taskMessage = createMessage({
    conversation,
    from: "openclaw",
    to: executor.actor,
    type: "task",
    body: request,
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session
    }
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
  runtimeLog("info", "conversation_created", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    workspace,
    store_dir: storeDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    request: textSummary(request)
  });

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
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: options.session ?? options.claudeSession
  });
  process.stdout.write(
    executorBootstrapPrompt({
      callbackCommand,
      executorName: executor.display_name,
      softLimit: Number(options.softLimit ?? 50),
      hardLimit: Number(options.hardLimit ?? 100)
    })
  );
}

function runDelegate(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace ?? process.cwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: options.session ?? options.executorSession ?? options.claudeSession
  });
  const newResult = captureJson([
    "new",
    "--request",
    request,
    "--workspace",
    workspace,
    "--openclaw-session",
    options.openclawSession ?? "agent:main:main",
    "--agent",
    executor.kind,
    "--session",
    executor.session,
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
  const openclawBin = options.openclawBin ?? resolveOptionalExecutable("openclaw");
  const executorEnv = environmentForExecutor(executor, options);
  const executorAllProxy = proxyForExecutor(executor, options);
  const executorModel = modelForExecutor(executor, options);
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: newResult.paths.statePath })
    : buildCallbackCommand({
        statePath: newResult.paths.statePath,
        gatewayUrl,
        token: options.token,
        openclawSession,
        gatewayMethod: options.gatewayMethod,
        gatewaySession: options.gatewaySession,
        openclawBin
      });
  const conversationWithCallback = {
    ...newResult.conversation,
    gateway_url: gatewayUrl,
    callback_command: callbackCommand,
    executor_all_proxy: executorAllProxy,
    executor_model: executorModel
  };
  saveState(newResult.paths.statePath, conversationWithCallback);
  newResult.conversation = conversationWithCallback;
  runtimeLog("info", "delegate_created", {
    conversation_id: newResult.conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    workspace,
    store_dir: storeDir,
    state_path: newResult.paths.statePath,
    gateway_method: options.gatewayMethod,
    background: Boolean(options.background),
    request: textSummary(request)
  });

  const bootstrap = executorBootstrapPrompt({
    callbackCommand,
    executorName: executor.display_name,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });
  const payload = `${bootstrap}\n\nInitial task message:\n${JSON.stringify(newResult.task_message)}`;

  const acpxArgs = buildAcpxPromptArgs({ executor, payload, model: executorModel });

  if (options.background) {
    const acpxPath = resolveExecutable("acpx");
    const ensureSession = ensureExecutorSession({
      acpxPath,
      executor,
      cwd: workspace,
      env: executorEnv
    });
    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "executor_session_ensure",
      status: ensureSession.status ?? null,
      executor,
      stdout: cleanProcessText(ensureSession.stdout),
      stderr: cleanProcessText(ensureSession.stderr)
    });
    runtimeLog("info", "executor_session_ensure", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      status: ensureSession.status ?? null,
      failure_kind: classifyProcessFailure(ensureSession),
      stdout: textSummary(cleanProcessText(ensureSession.stdout)),
      stderr: textSummary(cleanProcessText(ensureSession.stderr))
    });
    if (executor.kind === "claude") {
      appendEvent(newResult.paths.logPath, {
        ts: new Date().toISOString(),
        conversation_id: newResult.conversation.conversation_id,
        event: "claude_session_ensure",
        status: ensureSession.status ?? null,
        claude_session: executor.session,
        stdout: cleanProcessText(ensureSession.stdout),
        stderr: cleanProcessText(ensureSession.stderr)
      });
    }
    if (ensureSession.error) {
      throw new Error(`acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`);
    }
    if (ensureSession.status !== 0) {
      throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`));
    }

    const outputPath = path.join(newResult.paths.conversationDir, `${executor.kind}-output.log`);
    const outputFd = fs.openSync(outputPath, "a");
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      env: executorEnv,
      cwd: workspace
    });
    child.unref();
    fs.closeSync(outputFd);

    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "executor_launch",
      mode: "background",
      pid: child.pid ?? null,
      executor,
      output_path: outputPath
    });
    runtimeLog("info", "executor_launch", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      mode: "background",
      pid: child.pid ?? null,
      output_path: outputPath
    });
    if (executor.kind === "claude") {
      appendEvent(newResult.paths.logPath, {
        ts: new Date().toISOString(),
        conversation_id: newResult.conversation.conversation_id,
        event: "claude_launch",
        mode: "background",
        pid: child.pid ?? null,
        claude_session: executor.session,
        output_path: outputPath
      });
    }

    printJson({
      ...newResult,
      launched: true,
      background: true,
      pid: child.pid ?? null,
      output_path: outputPath
    });
    return;
  }

  if (options.send) {
    const acpxPath = resolveExecutable("acpx");
    const ensureSession = ensureExecutorSession({
      acpxPath,
      executor,
      cwd: workspace,
      env: executorEnv
    });
    if (ensureSession.error) {
      throw new Error(`acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`);
    }
    if (ensureSession.status !== 0) {
      throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`));
    }
    const result = spawnSync(acpxPath, acpxArgs, {
      stdio: "inherit",
      cwd: workspace,
      env: executorEnv
    });
    runtimeLog("info", "executor_send", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      status: result.status ?? null,
      failure_kind: classifyProcessFailure(result)
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  runtimeLog("info", "delegate_dry_run", {
    conversation_id: newResult.conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session
  });
  printJson({
    ...newResult,
    dry_run: true,
    acpx_command: ["acpx", ...acpxArgs],
    note: "Run again with --send to send this task through acpx."
  });
}

function ensureExecutorSession({ acpxPath, executor, cwd, env }) {
  return spawnSync(acpxPath, [executor.kind, "sessions", "ensure", "--name", executor.session], {
    encoding: "utf8",
    cwd,
    env
  });
}

function buildAcpxPromptArgs({ executor, payload, model }) {
  const args = ["--approve-all"];
  if (model) {
    args.push("--model", model);
  }
  args.push(executor.kind, "-s", executor.session, payload);
  return args;
}

function proxyForExecutor(executor, options: Record<string, any> = {}) {
  const explicit = options.allProxy ?? options.proxy;
  if (explicit) {
    return explicit;
  }
  if (executor.kind === "codex") {
    return process.env.CODEX_ALL_PROXY ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  }
  return undefined;
}

function modelForExecutor(executor, options: Record<string, any> = {}) {
  const explicit = options.model ?? options.codexModel;
  if (explicit) {
    return explicit;
  }
  if (executor.kind === "codex") {
    return process.env.CODEX_ACPX_MODEL;
  }
  return undefined;
}

function environmentForExecutor(executor, options = {}) {
  const proxy = proxyForExecutor(executor, options);
  if (!proxy) {
    return process.env;
  }

  return {
    ...process.env,
    ALL_PROXY: proxy,
    all_proxy: proxy
  };
}

function runList(options) {
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(process.cwd()));
  const cleanup = cleanupIdleConversations(storeDir, options);
  const includeAll = Boolean(options.all);
  const agentFilter = options.agent ? resolveExecutor({ kind: options.agent }).kind : undefined;
  const statusFilter = options.status;
  const conversations = listConversations(storeDir)
    .map((conversation) => summarizeConversation(conversation))
    .filter((conversation) => includeAll || isActiveStatus(conversation.status))
    .filter((conversation) => !agentFilter || conversation.agent === agentFilter)
    .filter((conversation) => !statusFilter || conversation.status === statusFilter);

  printJson({
    store_dir: storeDir,
    cleanup,
    tasks: conversations
  });
  runtimeLog("info", "tasks_listed", {
    store_dir: storeDir,
    returned_count: conversations.length,
    include_all: includeAll,
    agent_filter: agentFilter,
    status_filter: statusFilter,
    cleanup
  });
}

function runStatus(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  const events = readExistingEvents(logPath);
  printJson({
    conversation,
    summary: summarizeConversation(conversation),
    state_path: statePath,
    event_log_path: logPath,
    budget: budgetAction(conversation),
    recent_events: events.slice(-10).map(summarizeEvent)
  });
  runtimeLog("info", "task_status_read", {
    conversation_id: conversation.conversation_id,
    status: conversation.status,
    state_path: statePath,
    event_log_path: logPath,
    recent_event_count: Math.min(events.length, 10)
  });
}

function runSend(options) {
  const messageBody = required(options.message ?? options.request, "--message is required");
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  if (["done", "failed", "closed", "cancelled"].includes(conversation.status)) {
    throw new Error(`cannot send to ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const executor = executorForConversation(conversation);
  const type = options.type ?? (conversation.status === "waiting_for_openclaw" ? "answer" : "task");
  const message = createMessage({
    conversation,
    from: "openclaw",
    to: executor.actor,
    type,
    body: messageBody,
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session
    }
  });
  const nextConversation = {
    ...applyMessageToConversation(conversation, message),
    executor,
    claude_session: executor.kind === "claude" ? executor.session : conversation.claude_session
  };
  saveState(statePath, nextConversation);
  appendEvent(logPath, messageEvent(message));
  runtimeLog("info", "message_created", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    message_type: type,
    state_path: statePath,
    event_log_path: logPath,
    message: textSummary(messageBody)
  });

  const acpxPath = resolveExecutable("acpx");
  const executorEnv = environmentForExecutor(executor, {
    allProxy: options.allProxy ?? conversation.executor_all_proxy
  });
  const executorModel = modelForExecutor(executor, {
    model: options.model ?? conversation.executor_model
  });
  const ensureSession = ensureExecutorSession({
    acpxPath,
    executor,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_session_ensure",
    status: ensureSession.status ?? null,
    executor,
    stdout: cleanProcessText(ensureSession.stdout),
    stderr: cleanProcessText(ensureSession.stderr)
  });
  runtimeLog("info", "executor_session_ensure", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: ensureSession.status ?? null,
    failure_kind: classifyProcessFailure(ensureSession),
    stdout: textSummary(cleanProcessText(ensureSession.stdout)),
    stderr: textSummary(cleanProcessText(ensureSession.stderr))
  });
  if (ensureSession.error) {
    throw new Error(`acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`);
  }
  if (ensureSession.status !== 0) {
    throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`));
  }

  const payload = [
    "Continue the existing Agent Knock Knock delegation using this structured OpenClaw message.",
    "If this message answers a question or blocker, follow it as the product decision.",
    "Continue to report back only through the callback command already provided for this conversation.",
    "",
    JSON.stringify(message)
  ].join("\n");
  const acpxArgs = buildAcpxPromptArgs({ executor, payload, model: executorModel });

  if (options.background) {
    const outputPath = path.join(path.dirname(logPath), `${executor.kind}-followup-output.log`);
    const outputFd = fs.openSync(outputPath, "a");
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      cwd: conversation.workspace ?? process.cwd(),
      env: executorEnv
    });
    child.unref();
    fs.closeSync(outputFd);

    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "executor_message_launch",
      mode: "background",
      pid: child.pid ?? null,
      executor,
      output_path: outputPath
    });
    runtimeLog("info", "executor_message_launch", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      mode: "background",
      pid: child.pid ?? null,
      output_path: outputPath
    });

    printJson({
      conversation: nextConversation,
      message,
      delivered: true,
      background: true,
      pid: child.pid ?? null,
      output_path: outputPath,
      executor,
      budget: budgetAction(nextConversation)
    });
    return;
  }

  const sendResult = spawnSync(acpxPath, acpxArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_message_send",
    status: sendResult.status ?? null,
    executor,
    stdout: cleanProcessText(sendResult.stdout),
    stderr: cleanProcessText(sendResult.stderr)
  });
  runtimeLog("info", "executor_message_send", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: sendResult.status ?? null,
    failure_kind: classifyProcessFailure(sendResult),
    stdout: textSummary(cleanProcessText(sendResult.stdout)),
    stderr: textSummary(cleanProcessText(sendResult.stderr))
  });
  if (sendResult.error) {
    throw new Error(`acpx ${executor.kind} send failed to start: ${sendResult.error.message}`);
  }
  if (sendResult.status !== 0) {
    throw new Error(cleanProcessText(sendResult.stderr || sendResult.stdout || `acpx ${executor.kind} send exited with status ${sendResult.status}`));
  }

  printJson({
    conversation: nextConversation,
    message,
    delivered: true,
    executor,
    budget: budgetAction(nextConversation)
  });
}

function runCancel(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  if (["closed", "cancelled"].includes(conversation.status)) {
    throw new Error(`cannot cancel ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const executor = executorForConversation(conversation);
  const acpxPath = resolveExecutable("acpx");
  const executorEnv = environmentForExecutor(executor, {
    allProxy: options.allProxy ?? conversation.executor_all_proxy
  });
  const cancelResult = spawnSync(acpxPath, [executor.kind, "cancel", "-s", executor.session], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  const now = new Date().toISOString();
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "executor_cancel_requested",
    status: cancelResult.status ?? null,
    executor,
    stdout: cleanProcessText(cancelResult.stdout),
    stderr: cleanProcessText(cancelResult.stderr)
  });
  runtimeLog("info", "executor_cancel_requested", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: cancelResult.status ?? null,
    failure_kind: classifyProcessFailure(cancelResult),
    stdout: textSummary(cleanProcessText(cancelResult.stdout)),
    stderr: textSummary(cleanProcessText(cancelResult.stderr))
  });
  if (cancelResult.error) {
    throw new Error(`acpx ${executor.kind} cancel failed to start: ${cancelResult.error.message}`);
  }
  if (cancelResult.status !== 0) {
    throw new Error(cleanProcessText(cancelResult.stderr || cancelResult.stdout || `acpx ${executor.kind} cancel exited with status ${cancelResult.status}`));
  }

  const nextConversation = {
    ...conversation,
    status: "cancelling" as const,
    cancel_requested_at: now,
    updated_at: now
  };
  saveState(statePath, nextConversation);
  runtimeLog("info", "conversation_cancelling", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    state_path: statePath
  });

  printJson({
    conversation: nextConversation,
    cancel_requested: true,
    executor,
    acpx_command: ["acpx", executor.kind, "cancel", "-s", executor.session],
    budget: budgetAction(nextConversation)
  });
}

function runClose(options) {
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  const now = new Date().toISOString();
  const closed = {
    ...conversation,
    status: "closed" as const,
    closed_at: now,
    close_reason: options.reason ?? "closed by request",
    updated_at: now
  };
  saveState(statePath, closed);
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "conversation_closed",
    status: "closed",
    reason: closed.close_reason
  });
  runtimeLog("info", "conversation_closed", {
    conversation_id: conversation.conversation_id,
    status: "closed",
    reason: closed.close_reason,
    state_path: statePath,
    event_log_path: logPath
  });
  printJson({
    conversation: closed,
    closed: true
  });
}

function resolveExecutable(command) {
  if (command.includes(path.sep)) {
    return command;
  }

  const paths = executableSearchPaths();
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

function executableSearchPaths() {
  const home = process.env.HOME;
  return [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...(home ? [
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin")
    ] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
}

function resolveOptionalExecutable(command) {
  try {
    return resolveExecutable(command);
  } catch {
    return command;
  }
}

function buildCallbackCommand({
  statePath,
  gatewayUrl,
  token,
  openclawSession,
  gatewayMethod,
  gatewaySession,
  openclawBin
}) {
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
  } else if (!gatewayMethod) {
    parts.push("--record-only");
  }

  if (gatewayMethod) {
    parts.push(
      "--gateway-method",
      shellQuote(gatewayMethod),
      "--gateway-session",
      shellQuote(gatewaySession ?? openclawSession)
    );
    if (openclawBin) {
      parts.push("--openclaw-bin", shellQuote(openclawBin));
    }
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
  const executor = executorForConversation(conversation);
  const message = extractStructuredMessage({
    conversation,
    input: messageInput,
    defaultFrom: executor.actor,
    defaultTo: "openclaw"
  });

  const existingEvents = readExistingEvents(logPath);
  if (isDuplicateMessage(existingEvents, message)) {
    runtimeLog("info", "callback_duplicate", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      from: message.from,
      type: message.type,
      round: message.round,
      state_path: options.statePath,
      event_log_path: logPath
    });
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
  runtimeLog("info", "callback_received", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    from: message.from,
    type: message.type,
    round: message.round,
    status: nextConversation.status,
    requires_response: message.requires_response,
    state_path: options.statePath,
    event_log_path: logPath,
    message: textSummary(message.body)
  });

  const result = {
    conversation: nextConversation,
    message,
    budget: budgetAction(nextConversation),
    delivered: false,
    duplicate: false
  };

  if (options.gatewayMethod) {
    const delivery = deliverToGatewayMethod({
      method: options.gatewayMethod,
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      sessionKey: options.gatewaySession ?? options.openclawSession ?? conversation.openclaw_session,
      statePath: options.statePath,
      logPath,
      conversation: nextConversation,
      message
    });
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "callback_gateway_method_delivery",
      from: message.from,
      to: "openclaw",
      round: message.round,
      method: options.gatewayMethod,
      status: delivery.status,
      stdout: delivery.stdout,
      stderr: delivery.stderr
    });
    runtimeLog("info", "callback_gateway_method_delivery", {
      conversation_id: conversation.conversation_id,
      method: options.gatewayMethod,
      status: delivery.status,
      failure_kind: classifyProcessFailure(delivery),
      stdout: textSummary(delivery.stdout),
      stderr: textSummary(delivery.stderr)
    });

    if (delivery.status !== 0) {
      throw new Error(delivery.stderr || delivery.stdout || `gateway method delivery failed with status ${delivery.status}`);
    }

    const gatewayPayload = parseOptionalJson(delivery.stdout);
    const chatSendParams = isRecord(gatewayPayload?.chat_send) ? gatewayPayload.chat_send : undefined;
    const sessionSendParams = isRecord(gatewayPayload?.session_send) ? gatewayPayload.session_send : undefined;
    let chatSendDelivery;
    let sessionSendDelivery;
    if (chatSendParams) {
      chatSendDelivery = deliverToChatSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: chatSendParams
      });
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "callback_chat_send_delivery",
        from: message.from,
        to: "openclaw",
        round: message.round,
        status: chatSendDelivery.status,
        stdout: chatSendDelivery.stdout,
        stderr: chatSendDelivery.stderr
      });
      runtimeLog("info", "callback_chat_send_delivery", {
        conversation_id: conversation.conversation_id,
        status: chatSendDelivery.status,
        failure_kind: classifyProcessFailure(chatSendDelivery),
        stdout: textSummary(chatSendDelivery.stdout),
        stderr: textSummary(chatSendDelivery.stderr)
      });

      if (chatSendDelivery.status !== 0) {
        throw new Error(chatSendDelivery.stderr || chatSendDelivery.stdout || `chat callback delivery failed with status ${chatSendDelivery.status}`);
      }
    } else if (sessionSendParams) {
      sessionSendDelivery = deliverToSessionSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: sessionSendParams
      });
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "callback_session_send_delivery",
        from: message.from,
        to: "openclaw",
        round: message.round,
        status: sessionSendDelivery.status,
        stdout: sessionSendDelivery.stdout,
        stderr: sessionSendDelivery.stderr
      });
      runtimeLog("info", "callback_session_send_delivery", {
        conversation_id: conversation.conversation_id,
        status: sessionSendDelivery.status,
        failure_kind: classifyProcessFailure(sessionSendDelivery),
        stdout: textSummary(sessionSendDelivery.stdout),
        stderr: textSummary(sessionSendDelivery.stderr)
      });

      if (sessionSendDelivery.status !== 0) {
        throw new Error(sessionSendDelivery.stderr || sessionSendDelivery.stdout || `session callback delivery failed with status ${sessionSendDelivery.status}`);
      }
    }

    printJson({
      ...result,
      delivered: true,
      delivery: chatSendDelivery
        ? "gateway_method+chat_send"
        : sessionSendDelivery
          ? "gateway_method+sessions_send"
          : "gateway_method"
    });
    return;
  }

  if (options.recordOnly) {
    runtimeLog("info", "callback_recorded_only", {
      conversation_id: conversation.conversation_id,
      status: nextConversation.status
    });
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
    from: message.from,
    to: "openclaw",
    round: message.round,
    status: delivery.status,
    stdout: delivery.stdout,
    stderr: delivery.stderr
  });
  runtimeLog("info", "callback_delivery", {
    conversation_id: conversation.conversation_id,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
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

function loadConversationFromOptions(options) {
  const storeDir = storeDirFromOptions(options);
  const conversationId = options.conversation ?? options.conversationId;
  const statePath = expandHome(options.state ?? (conversationId ? statePathForConversationId(conversationId, storeDir) : undefined));
  if (!statePath) {
    throw new Error("--conversation or --state is required");
  }

  const conversation = options.state
    ? loadState(statePath)
    : loadConversationById(conversationId, storeDir);
  return {
    conversation,
    statePath,
    logPath: logPathForStatePath(statePath)
  };
}

function storeDirFromOptions(options) {
  return expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(process.cwd()));
}

function summarizeConversation(conversation) {
  const executor = executorForConversation(conversation);
  return {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor,
    session: executor.session,
    status: conversation.status,
    request: conversation.user_request,
    workspace: conversation.workspace,
    openclaw_session: conversation.openclaw_session,
    response_rounds_used: conversation.response_rounds_used,
    soft_limit: conversation.soft_limit,
    hard_limit: conversation.hard_limit,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    idle_since: conversation.idle_since,
    closed_at: conversation.closed_at,
    state_path: conversation.state_path,
    event_log_path: conversation.event_log_path
  };
}

function summarizeEvent(event) {
  return {
    ts: event.ts,
    event: event.event,
    from: event.from,
    to: event.to,
    type: event.type,
    status: event.status,
    round: event.round,
    body: typeof event.body === "string" ? event.body.slice(0, 500) : undefined
  };
}

function isActiveStatus(status) {
  return !["done", "failed", "closed", "cancelled"].includes(status);
}

function cleanupIdleConversations(storeDir, options: Record<string, any> = {}, now = new Date()) {
  const timeoutMinutes = Number(options.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return { checked: 0, closed: 0, idle_timeout_minutes: timeoutMinutes };
  }

  const conversations = listConversations(storeDir);
  let closed = 0;
  for (const conversation of conversations) {
    if (conversation.status !== "idle" || !conversation.idle_since) {
      continue;
    }

    const idleSinceMs = Date.parse(conversation.idle_since);
    if (!Number.isFinite(idleSinceMs)) {
      continue;
    }

    if (now.getTime() - idleSinceMs < timeoutMinutes * 60 * 1000) {
      continue;
    }

    const statePath = conversation.state_path ?? statePathForConversationId(conversation.conversation_id, storeDir);
    const logPath = conversation.event_log_path ?? logPathForStatePath(statePath);
    const closedConversation = {
      ...conversation,
      status: "closed" as const,
      closed_at: now.toISOString(),
      close_reason: `idle timeout after ${timeoutMinutes} minutes`,
      updated_at: now.toISOString()
    };
    delete closedConversation.idle_since;
    saveState(statePath, closedConversation);
    appendEvent(logPath, {
      ts: now.toISOString(),
      conversation_id: conversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: closedConversation.close_reason,
      idle_timeout_minutes: timeoutMinutes
    });
    runtimeLog("info", "idle_conversation_closed", {
      conversation_id: conversation.conversation_id,
      agent: executorForConversation(conversation).kind,
      executor_session: executorForConversation(conversation).session,
      state_path: statePath,
      event_log_path: logPath,
      idle_since: conversation.idle_since,
      idle_timeout_minutes: timeoutMinutes,
      reason: closedConversation.close_reason
    });
    closed += 1;
  }

  return {
    checked: conversations.length,
    closed,
    idle_timeout_minutes: timeoutMinutes
  };
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

function deliverToGatewayMethod({ method, openclawBin, gatewayUrl, token, sessionKey, statePath, logPath, conversation, message }) {
  const args = [
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify({
      sessionKey,
      statePath,
      logPath,
      conversation,
      message
    }),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
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

function deliverToSessionSend({ openclawBin, gatewayUrl, token, params }) {
  const args = [
    "gateway",
    "call",
    "sessions.send",
    "--params",
    JSON.stringify(params),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
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

function deliverToChatSend({ openclawBin, gatewayUrl, token, params }) {
  const args = [
    "gateway",
    "call",
    "chat.send",
    "--params",
    JSON.stringify(params),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
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

function cleanProcessText(text) {
  const value = String(text ?? "").trim();
  return value ? value.slice(0, 2000) : undefined;
}

function textSummary(text, maxLength = 240) {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function classifyProcessFailure(result) {
  const status = result?.status ?? 0;
  const combined = [
    result?.error?.message,
    result?.stderr,
    result?.stdout
  ].filter(Boolean).join("\n").toLowerCase();

  if (!combined && status === 0) {
    return undefined;
  }
  if (combined.includes("agent needs reconnect") || combined.includes("internal error")) {
    return "agent_reconnect_required";
  }
  if (combined.includes("permission denied") || combined.includes("operation not permitted")) {
    return "permission_denied";
  }
  if (combined.includes("sandbox") || combined.includes("outside workspace")) {
    return "sandbox_denied";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  if (status !== 0) {
    return "nonzero_exit";
  }
  return undefined;
}

function runtimeLog(level, event, fields = {}) {
  try {
    writeRuntimeLog({
      level,
      event,
      ...fields
    });
  } catch {
    // Runtime logging must never break the user-facing CLI command.
  }
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
  agent-knock-knock new --request <text> [--agent claude|codex] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock record --state <file> --message-json <json>
  agent-knock-knock bootstrap-prompt --callback-command <command> [--agent claude|codex]
  agent-knock-knock delegate --request <text> [--agent claude|codex] [--store-dir <dir>] [--all-proxy <url>] [--token <gateway-token>] [--send|--background]
  agent-knock-knock list [--store-dir <dir>] [--agent claude|codex] [--status <status>] [--all]
  agent-knock-knock status --conversation <id> [--store-dir <dir>]
  agent-knock-knock send --conversation <id> --message <text> [--type answer|task|control] [--all-proxy <url>]
  agent-knock-knock cancel --conversation <id> [--all-proxy <url>]
  agent-knock-knock close --conversation <id> [--reason <text>]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}
