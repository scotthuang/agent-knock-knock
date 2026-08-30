import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CallbackInbox } from "../src/callback-inbox.js";
import {
  PiRouteTable,
  type CallbackRequest,
  type PiCallbackTarget,
} from "../src/routes.js";

test("routes a durable callback once and returns the same exact acceptance", async () => {
  const fixture = routeFixture();
  try {
    const route = fixture.routes.bind(fixture.target);
    const original = request(route.controllerId, "same");
    const first = await fixture.routes.deliver(original);
    const duplicate = await fixture.routes.deliver(original);
    const collision = await fixture.routes.deliver({ ...original, body: "different" });

    assert.equal(first.result.status, "accepted");
    assert.equal(duplicate.result.status, "accepted");
    assert.equal(duplicate.result.acceptance_id, first.result.acceptance_id);
    assert.equal(fixture.delivered.length, 1);
    assert.deepEqual(fixture.delivered[0], original);
    assert.deepEqual(collision.result, {
      status: "rejected",
      error_code: "idempotency_collision",
    });
  } finally {
    await fixture.close();
  }
});

test("fails closed after the exact Pi runtime authority is disposed", async () => {
  const fixture = routeFixture();
  try {
    const route = fixture.routes.bind(fixture.target);
    fixture.routes.dispose(fixture.target);
    const acknowledgement = await fixture.routes.deliver(request(route.controllerId, "old"));
    assert.deepEqual(acknowledgement.result, {
      status: "rejected",
      error_code: "pi_route_not_live",
    });
    assert.throws(() => fixture.routes.bind(fixture.target), /disposed/u);
  } finally {
    await fixture.close();
  }
});

test("acknowledges durable connector admission when Pi injection throws", async () => {
  const fixture = routeFixture();
  try {
    fixture.failDelivery = true;
    const route = fixture.routes.bind(fixture.target);
    const acknowledgement = await fixture.routes.deliver(request(route.controllerId, "pending"));

    assert.equal(acknowledgement.result.status, "accepted");
    assert.equal(typeof acknowledgement.result.acceptance_id, "string");
    assert.equal(fixture.delivered.length, 0);
    assert.equal((await fixture.inbox.listPending(route.controllerId)).length, 1);
  } finally {
    await fixture.close();
  }
});

function routeFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-route-test-"));
  const inbox = new CallbackInbox({ filePath: path.join(directory, "callbacks.json") });
  const routes = new PiRouteTable(inbox, "test-instance");
  const delivered: CallbackRequest[] = [];
  let live = true;
  const fixtureState = { failDelivery: false };
  const target: PiCallbackTarget = {
    authority: {},
    sessionId: "pi-session-one",
    runtimeGeneration: "runtime-one",
    anchorLeafId: "leaf-at-start",
    isLive: () => live,
    deliver(_body, callback) {
      if (fixtureState.failDelivery) throw new Error("Pi inbox unavailable");
      delivered.push(callback);
    },
  };
  return {
    routes,
    inbox,
    target,
    delivered,
    get failDelivery() {
      return fixtureState.failDelivery;
    },
    set failDelivery(value: boolean) {
      fixtureState.failDelivery = value;
    },
    async close() {
      live = false;
      routes.dispose(target);
      await routes.close();
      await inbox.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function request(controllerId: string, suffix: string): CallbackRequest {
  return {
    controllerId,
    deliveryId: `delivery-${suffix}`,
    messageId: `message-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    body: `body-${suffix}`,
  };
}
