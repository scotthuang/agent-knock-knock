import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CallbackInbox } from "../src/callback-inbox.js";
import {
  parseCallbackHelperArguments,
  runCallbackHelper,
} from "../src/callback-helper.js";
import {
  CALLBACK_SOCKET_ENV,
  CALLBACK_TOKEN_ENV,
  createCallbackIpcServer,
} from "../src/ipc.js";
import { PiRouteTable, type CallbackRequest, type PiCallbackTarget } from "../src/routes.js";

test("helper receives an exact ACK through the authenticated Unix socket", async () => {
  const fixture = await callbackFixture();
  try {
    const acknowledgement = await runCallbackHelper({
      arguments: fixture.arguments,
      body: "callback body",
      environment: fixture.environment,
    });
    assert.equal(acknowledgement.request.delivery_id, "delivery-one");
    assert.equal(acknowledgement.request.message_id, "message-one");
    assert.equal(acknowledgement.result.status, "accepted");
    assert.equal(typeof acknowledgement.result.acceptance_id, "string");
    assert.equal(fixture.delivered.length, 1);
  } finally {
    await fixture.close();
  }
});

test("compiled callback helper emits the Host Profile JSON ACK", async () => {
  const fixture = await callbackFixture();
  try {
    const helperPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src/callback-helper.js",
    );
    const result = await spawnHelper(helperPath, fixture);
    assert.equal(result.code, 0, result.stderr);
    const acknowledgement = JSON.parse(result.stdout);
    assert.equal(acknowledgement.request.delivery_id, "delivery-one");
    assert.equal(acknowledgement.request.message_id, "message-one");
    assert.equal(acknowledgement.result.status, "accepted");
  } finally {
    await fixture.close();
  }
});

test("rejects a wrong token without admitting a Pi message", async () => {
  const fixture = await callbackFixture();
  try {
    const acknowledgement = await runCallbackHelper({
      arguments: fixture.arguments,
      body: "callback body",
      environment: {
        ...fixture.environment,
        [CALLBACK_TOKEN_ENV]: "wrong-token",
      },
    });
    assert.deepEqual(acknowledgement.result, {
      status: "rejected",
      error_code: "callback_authentication_failed",
    });
    assert.equal(fixture.delivered.length, 0);
  } finally {
    await fixture.close();
  }
});

test("parses each callback identity argument exactly once", () => {
  assert.deepEqual(parseCallbackHelperArguments([
    "--controller-id", "controller",
    "--delivery-id", "delivery",
    "--message-id", "message",
    "--idempotency-key", "key",
  ]), {
    controllerId: "controller",
    deliveryId: "delivery",
    messageId: "message",
    idempotencyKey: "key",
  });
  assert.throws(
    () => parseCallbackHelperArguments(["--controller-id", "controller"]),
    /missing --delivery-id/u,
  );
});

async function callbackFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-ipc-test-"));
  const socketPath = path.join(directory, "callback.sock");
  const inbox = new CallbackInbox({ filePath: path.join(directory, "callbacks.json") });
  const routes = new PiRouteTable(inbox, "test-instance");
  const delivered: CallbackRequest[] = [];
  let live = true;
  const target: PiCallbackTarget = {
    authority: {},
    sessionId: "pi-session-one",
    runtimeGeneration: "runtime-one",
    anchorLeafId: null,
    isLive: () => live,
    deliver(_body, callback) {
      delivered.push(callback);
    },
  };
  const route = routes.bind(target);
  const server = createCallbackIpcServer({
    socketPath,
    token: "correct-token",
    routes,
  });
  await server.start();
  return {
    delivered,
    arguments: {
      controllerId: route.controllerId,
      deliveryId: "delivery-one",
      messageId: "message-one",
      idempotencyKey: "key-one",
    },
    environment: {
      [CALLBACK_SOCKET_ENV]: socketPath,
      [CALLBACK_TOKEN_ENV]: "correct-token",
    },
    async close() {
      live = false;
      await server.stop();
      routes.dispose(target);
      await routes.close();
      await inbox.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function spawnHelper(
  helperPath: string,
  fixture: Awaited<ReturnType<typeof callbackFixture>>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      helperPath,
      "--controller-id", fixture.arguments.controllerId,
      "--delivery-id", fixture.arguments.deliveryId,
      "--message-id", fixture.arguments.messageId,
      "--idempotency-key", fixture.arguments.idempotencyKey,
    ], {
      env: fixture.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
    child.stdin.end("callback body");
  });
}
