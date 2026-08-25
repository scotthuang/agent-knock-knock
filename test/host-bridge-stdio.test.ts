import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import test from "node:test";

import { LATEST_PROTOCOL_VERSION } from
  "@modelcontextprotocol/sdk/types.js";
import {
  createCallbackEnvelope,
  type CallbackEnvelopeV1,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import {
  HOST_PROFILE_JSON_SCHEMA,
  HOST_PROFILE_SCHEMA,
  HOST_PROFILE_VERSION
} from "../src/host-profile.js";
import {
  createTrustedHostProfileRuntime
} from "../src/host-profile-runtime.js";
import {
  applyMessageToConversation,
  createConversation,
  createMessage
} from "../src/protocol.js";
import {
  appendEvent,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";
import { spawnAgentCliCaptured } from "./agent-cli-fixtures.js";

const EXPECTED_TOOLS = [
  "agent_knock_knock_approve",
  "agent_knock_knock_cancel",
  "agent_knock_knock_close",
  "agent_knock_knock_list",
  "agent_knock_knock_list_resumable_threads",
  "agent_knock_knock_native_inspect",
  "agent_knock_knock_new_thread",
  "agent_knock_knock_reconcile_binding",
  "agent_knock_knock_renew",
  "agent_knock_knock_respond",
  "agent_knock_knock_resume_thread",
  "agent_knock_knock_retry_callback",
  "agent_knock_knock_send",
  "agent_knock_knock_status",
  "agent_knock_knock_unwatch",
  "agent_knock_knock_watch"
] as const;

test(
  "real Host Bridge stdio advertises 16 tools and exits on Host EOF; " +
  "fixture Host settles a command_json_v1 callback through a real MCP tool",
  async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-host-bridge-conformance-")
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "fixture-host.json");
  const callbackScript = path.join(root, "fixture-callback.cjs");
  const callbackCallsPath = path.join(root, "callback-calls.ndjson");
  const callbackReadyPath = path.join(root, "callback-ready");
  const storeDir = path.join(root, "store");
  fs.mkdirSync(storeDir);
  writeFixtureCallback(
    callbackScript,
    callbackCallsPath,
    callbackReadyPath
  );
  writeProfile(profilePath, callbackScript);

  const environment = childEnvironment(root);
  const runtime = createTrustedHostProfileRuntime({
    selection: profilePath,
    host: "my-agent",
    hostVersion: "1.8.7",
    environment,
    cwd: root
  });
  const created = createCallbackFixture(
    root,
    storeDir,
    runtime.callbackRoute
  );
  const originalEnvelope = created.envelope;

  const spawned = spawnAgentCliCaptured([
    "host-bridge",
    "--profile",
    profilePath,
    "--host",
    "my-agent",
    "--host-version",
    "1.8.7",
    "--store-dir",
    storeDir
  ], environment, {
    cwd: root,
    entrypoint: path.resolve("dist/src/cli.js")
  });
  const { child } = spawned;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const lines = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity
  });
  const iterator = lines[Symbol.asyncIterator]();
  const observed: unknown[] = [];
  const stderrValue = (): string => stderr;

  writeMessage(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fixture-host", version: "1.8.7" }
    }
  });
  const initialized = await readResponse(iterator, observed, 1, stderrValue);
  assert.equal(initialized.result?.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.equal(
    initialized.result?.serverInfo?.name,
    "agent-knock-knock-host-bridge"
  );
  assert.deepEqual(initialized.result?.capabilities, { tools: {} });
  writeMessage(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  });

  writeMessage(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const listed = await readResponse(iterator, observed, 2, stderrValue);
  const tools = listed.result?.tools;
  assert.ok(Array.isArray(tools));
  assert.equal(tools.length, 16);
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name).sort(),
    [...EXPECTED_TOOLS]
  );
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema?.type, "object");
  }

  fs.writeFileSync(callbackReadyPath, "accepted\n", "utf8");
  writeMessage(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "agent_knock_knock_retry_callback",
      arguments: { turn_id: created.turnId }
    }
  });
  const retried = await readResponse(iterator, observed, 3, stderrValue);
  assert.notEqual(retried.result?.isError, true);
  assert.equal(retried.result?.structuredContent?.delivered, true);

  const settled = readState(created.statePath);
  const delivery = settled.callback_delivery;
  assert.equal(delivery?.status, "delivered");
  assert.equal(delivery?.attempts, 2);
  assert.equal(delivery?.attempt_outcome?.disposition, "accepted");
  assert.equal(
    delivery?.attempt_outcome?.acceptance_id,
    `fixture-accepted:${String(originalEnvelope.delivery_id)}`
  );
  assert.equal(typeof delivery?.accepted_at, "string");
  assert.equal(typeof delivery?.delivered_at, "string");
  assert.deepEqual(delivery?.callback_route, runtime.callbackRoute);
  assert.deepEqual(delivery?.callback_envelope, originalEnvelope);

  const calls = fs.readFileSync(callbackCallsPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    accepted: true,
    controller: "private-controller-session",
    delivery: originalEnvelope.delivery_id,
    message: originalEnvelope.event.id,
    idempotency: originalEnvelope.idempotency_key,
    body: created.callbackMessage.body
  });

  const events = fs.readFileSync(created.logPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) =>
    event.event === "callback_delivery_succeeded" &&
    event.message_id === created.callbackMessage.id &&
    event.attempt === 2
  ).length, 1);

  child.stdin.end();
  const [exitCode, signal] = await within(
    once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>,
    20_000,
    () => `fixture Host Bridge did not exit after EOF. stderr:\n${stderr}`
  );
  assert.equal(exitCode, 0, stderr);
  assert.equal(signal, null, stderr);
  assert.equal((await spawned.result).status, 0, stderr);
  for await (const line of iterator) {
    observed.push(parseProtocolLine(line));
  }
  assert.ok(observed.every((message) =>
    isRecord(message) && message.jsonrpc === "2.0"
  ));
  assert.doesNotMatch(stderr, /private-controller-session/u);
  }
);

test("standalone Host Bridge rejects a route-bound Host Profile", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-route-bound-bridge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profilePath = path.join(root, "route-bound.json");
  writeProfile(profilePath, undefined, "route_bound_v1");

  const spawned = spawnAgentCliCaptured([
    "host-bridge",
    "--profile",
    profilePath,
    "--host",
    "my-agent",
    "--host-version",
    "1.8.7"
  ], childEnvironment(root), {
    cwd: root,
    entrypoint: path.resolve("dist/src/cli.js")
  });
  const result = await spawned.result;
  assert.equal(result.status, 1);
  assert.match(result.stderr, /route_bound_v1 is not supported/u);
  assert.match(result.stderr, /Host-native connector/u);
});

interface JsonRpcResponse extends Record<string, unknown> {
  readonly id?: unknown;
  readonly result?: Record<string, any>;
  readonly error?: unknown;
}

async function readResponse(
  iterator: AsyncIterator<string>,
  observed: unknown[],
  expectedId: number,
  stderr: () => string
): Promise<JsonRpcResponse> {
  while (true) {
    const next = await within(
      iterator.next(),
      10_000,
      () => `timed out waiting for MCP response ${expectedId}. stderr:\n${stderr()}`
    );
    if (next.done) {
      throw new Error(
        `Host Bridge stdout closed before MCP response ${expectedId}. ` +
        `stderr:\n${stderr()}`
      );
    }
    const message = parseProtocolLine(next.value);
    observed.push(message);
    if (message.id === expectedId) {
      assert.equal(message.error, undefined);
      return message;
    }
  }
}

function parseProtocolLine(line: string): JsonRpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `Host Bridge wrote non-protocol stdout ${JSON.stringify(line)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  assert.ok(isRecord(parsed), "MCP stdout message must be an object");
  assert.equal(parsed.jsonrpc, "2.0", "stdout must contain only MCP messages");
  return parsed as JsonRpcResponse;
}

function writeMessage(
  child: ReturnType<typeof spawnAgentCliCaptured>["child"],
  message: Readonly<Record<string, unknown>>
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function childEnvironment(root: string): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    HOME: root,
    MY_AGENT_SESSION_ID: "private-controller-session"
  };
}

async function within<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
  timeoutMessage: () => string
): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage())), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function writeProfile(
  filePath: string,
  callbackScript?: string,
  controllerScope?: "startup_v1" | "route_bound_v1"
): void {
  fs.writeFileSync(filePath, `${JSON.stringify({
    $schema: HOST_PROFILE_JSON_SCHEMA,
    schema: HOST_PROFILE_SCHEMA,
    version: HOST_PROFILE_VERSION,
    id: "my-agent-command",
    revision: "2026.08.25-1",
    compatibility: {
      host: "my-agent",
      range: ">=1.8.0 <2.0.0"
    },
    controllerContext: {
      driver: "environment_v1",
      sessionIdVariable: "MY_AGENT_SESSION_ID",
      ...(controllerScope === undefined ? {} : { scope: controllerScope })
    },
    callback: {
      driver: "command_json_v1",
      executable: process.execPath,
      arguments: [
        ...(callbackScript ? [callbackScript] : []),
        "--controller",
        "${controller.session_id}",
        "--delivery",
        "${envelope.delivery_id}",
        "--message",
        "${envelope.message_id}",
        "--idempotency",
        "${envelope.idempotency_key}"
      ],
      stdin: "${envelope.body}",
      environment: { allow: [] },
      timeoutMs: 2_000,
      maxOutputBytes: 65_536,
      acknowledgement: {
        disposition: {
          jsonPointer: "/status",
          mapping: {
            accepted: "accepted",
            retry: "retryable_failure"
          }
        },
        acceptanceId: { jsonPointer: "/acceptance_id" },
        acknowledgedDeliveryId: { jsonPointer: "/delivery_id" },
        acknowledgedMessageId: { jsonPointer: "/message_id" }
      }
    }
  }, null, 2)}\n`, "utf8");
}

function writeFixtureCallback(
  scriptPath: string,
  callsPath: string,
  readyPath: string
): void {
  fs.writeFileSync(scriptPath, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { body += chunk; });
process.stdin.on("end", () => {
  const accepted = fs.existsSync(${JSON.stringify(readyPath)});
  const delivery = value("--delivery");
  const message = value("--message");
  fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({
    accepted,
    controller: value("--controller"),
    delivery,
    message,
    idempotency: value("--idempotency"),
    body
  }) + "\\n", "utf8");
  process.stdout.write(JSON.stringify({
    status: accepted ? "accepted" : "retry",
    acceptance_id: accepted
      ? "fixture-accepted:" + delivery
      : "fixture-retry:" + delivery,
    delivery_id: delivery,
    message_id: message
  }));
});
`, "utf8");
}

function createCallbackFixture(
  workspace: string,
  storeDir: string,
  callbackRoute: CallbackRouteV1
): {
  readonly statePath: string;
  readonly logPath: string;
  readonly turnId: string;
  readonly callbackMessage: ReturnType<typeof createMessage>;
  readonly envelope: CallbackEnvelopeV1;
} {
  const conversation = createConversation({
    userRequest: "Exercise the generic Host callback",
    workspace,
    openclawSession: "private-controller-session",
    executorKind: "codex"
  });
  const task = createMessage({
    conversation,
    from: "openclaw",
    to: conversation.executor.actor,
    type: "task",
    body: "Exercise the generic Host callback"
  });
  const withTask = applyMessageToConversation(conversation, task);
  const callbackMessage = createMessage({
    conversation: withTask,
    from: conversation.executor.actor,
    to: "openclaw",
    type: "done",
    body: "Bridge conformance complete."
  });
  const completed = applyMessageToConversation(withTask, callbackMessage);
  const envelope = createCallbackEnvelope({
    route: callbackRoute,
    source: {
      kind: "managed_turn",
      session_id: completed.session_id,
      turn_id: completed.turn_id,
      conversation_id: completed.conversation_id
    },
    event: {
      id: callbackMessage.id,
      type: callbackMessage.type,
      body: callbackMessage.body,
      requires_response: callbackMessage.requires_response,
      metadata: callbackMessage.metadata
    }
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const now = new Date().toISOString();
  const stored = {
    ...completed,
    callback_route: callbackRoute,
    callback_delivery: {
      status: "failed",
      message: callbackMessage,
      attempts: 1,
      attempt_id: "fixture-attempt-1",
      created_at: now,
      last_attempt_at: now,
      failed_at: now,
      updated_at: now,
      close_terminal_bridge_on_done: false,
      track_delivery: true,
      final_status: "idle",
      preserve_conversation_status: true,
      callback_route: callbackRoute,
      callback_envelope: envelope,
      attempt_outcome: {
        disposition: "retryable_failure",
        error_code: "fixture_retryable_failure"
      },
      last_error: "fixture_retryable_failure"
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  saveState(paths.statePath, stored);
  appendEvent(paths.logPath, {
    ts: conversation.created_at,
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation
  });
  appendEvent(paths.logPath, messageEvent(task));
  appendEvent(paths.logPath, messageEvent(callbackMessage));
  appendEvent(paths.logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "callback_delivery_failed",
    message_id: callbackMessage.id,
    attempt: 1,
    error: "fixture_retryable_failure",
    attempt_disposition: "retryable_failure",
    state_preserved: true
  });
  return {
    statePath: paths.statePath,
    logPath: paths.logPath,
    turnId: conversation.turn_id,
    callbackMessage,
    envelope
  };
}

function readState(statePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
