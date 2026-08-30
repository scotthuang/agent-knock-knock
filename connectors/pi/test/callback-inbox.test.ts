import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CallbackInbox } from "../src/callback-inbox.js";
import type { CallbackRequest } from "../src/routes.js";

test("durably admits, deduplicates, and reloads callback records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-inbox-test-"));
  const filePath = path.join(directory, "callbacks.json");
  try {
    const inbox = new CallbackInbox({ filePath });
    const original = request("same");
    const first = await inbox.admit(original);
    const duplicate = await inbox.admit(original);
    const collision = await inbox.admit({ ...original, body: "different" });

    assert.equal(first.disposition, "admitted");
    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(collision.disposition, "collision");
    assert.equal(duplicate.entry.acceptanceId, first.entry.acceptanceId);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    await inbox.close();

    const reloaded = new CallbackInbox({ filePath });
    const pending = await reloaded.listPending("controller-one");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.acceptanceId, first.entry.acceptanceId);
    await reloaded.markDelivered(pending[0]!);
    assert.equal((await reloaded.listPending()).length, 0);
    await reloaded.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a corrupt persisted inbox instead of dropping it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-pi-inbox-test-"));
  const filePath = path.join(directory, "callbacks.json");
  try {
    fs.writeFileSync(filePath, "not-json", { mode: 0o600 });
    assert.throws(() => new CallbackInbox({ filePath }), /inbox is invalid/u);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function request(suffix: string): CallbackRequest {
  return {
    controllerId: "controller-one",
    deliveryId: `delivery-${suffix}`,
    messageId: `message-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    body: `body-${suffix}`,
  };
}
