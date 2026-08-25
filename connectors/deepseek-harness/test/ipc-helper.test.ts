import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Agent } from "@deepseek-ai/dsh-agent";

import {
  CALLBACK_SOCKET_ENV,
  CALLBACK_TOKEN_ENV,
} from "../src/constants.js";
import {
  parseCallbackHelperArguments,
  runCallbackHelper,
} from "../src/callback-helper.js";
import { createCallbackIpcServer } from "../src/ipc.js";
import { createConnectorProfileResources } from "../src/profile.js";
import { AgentRouteTable } from "../src/routes.js";

test("helper returns an exact ACK through the authenticated Unix socket", async () => {
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
    assert.equal(fixture.followed.length, 1);
  } finally {
    await fixture.close();
  }
});

test("compiled callback helper executable emits the Profile JSON ACK", async () => {
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

test("rejects a wrong token without admitting a message", async () => {
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
    assert.equal(acknowledgement.result.status, "rejected");
    assert.equal(acknowledgement.result.error_code, "callback_authentication_failed");
    assert.equal(fixture.followed.length, 0);
  } finally {
    await fixture.close();
  }
});

test("parses each required helper argument exactly once", () => {
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
  const resources = createConnectorProfileResources({});
  const followed: unknown[] = [];
  const agent = {
    id: "session-one",
    status: "idle",
    followup: (message: unknown) => followed.push(message),
    inject: () => undefined,
  } as unknown as Agent;
  const routes = new AgentRouteTable({ get: (id) => id === agent.id ? agent : undefined }, "host");
  const route = routes.bind(agent);
  const server = createCallbackIpcServer({
    socketPath: resources.socketPath,
    token: resources.token,
    routes,
  });
  await server.start();
  return {
    followed,
    arguments: {
      controllerId: route.controllerId,
      deliveryId: "delivery-one",
      messageId: "message-one",
      idempotencyKey: "key-one",
    },
    environment: {
      [CALLBACK_SOCKET_ENV]: resources.socketPath,
      [CALLBACK_TOKEN_ENV]: resources.token,
    },
    async close() {
      routes.close();
      await server.stop();
      resources.remove();
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
