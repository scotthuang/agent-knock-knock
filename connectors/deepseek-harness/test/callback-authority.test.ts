import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openCallbackAuthority, type CallbackAuthority, type DshCallbackRoute } from "../src/callback-authority.js";

const generation = { sessionId: "session", headerFingerprint: "a".repeat(64) };
const delivery = { requestFingerprint: "b".repeat(64), messageId: "dsh-message-1" };

test("durable authority resumes the same generation and preserves incomplete delivery receipts", () => {
  const fixture = temporaryAuthority();
  try {
    const first = fixture.open();
    const owner = first.ownerId;
    first.bindRoute(generation, "controller-original");
    first.registerCallbackRoute("controller-original", callbackRoute("controller-original", "old"));
    first.prepareDelivery("controller-original", "delivery", delivery);
    first.close();

    const resumed = fixture.open();
    assert.equal(resumed.ownerId, owner);
    assert.equal(resumed.bindRoute(generation, "controller-new").controllerId, "controller-original");
    assert.equal(resumed.readDelivery("controller-original", "delivery")?.state, "prepared");
    assert.throws(() => resumed.prepareDelivery("controller-original", "delivery", { ...delivery, requestFingerprint: "c".repeat(64) }), /collision/u);
    assert.throws(() => resumed.acceptDelivery("controller-original", "missing", delivery), /prepared/u);
    resumed.registerCallbackRoute("controller-original", callbackRoute("controller-original", "new"));
    resumed.acceptDelivery("controller-original", "delivery", delivery);
    const replacement = resumed.bindRoute({ ...generation, headerFingerprint: "d".repeat(64) }, "controller-replacement");
    assert.equal(replacement.controllerId, "controller-replacement");
    assert.equal(resumed.getRoute("controller-original")?.headerFingerprint, generation.headerFingerprint);
    resumed.bindFreshRoute(generation, "controller-new-lifetime");
    resumed.close();

    const final = fixture.open();
    assert.equal(final.readDelivery("controller-original", "delivery")?.state, "accepted");
    assert.equal(final.bindRoute(generation, "ignored-candidate").controllerId, "controller-new-lifetime");
    assert.deepEqual(final.callbackRoutes().map((route) => route.profile_revision), ["old", "new"]);
    final.close();
  } finally { fixture.remove(); }
});

test("legacy adoption requires explicit current scope and cannot change an existing controller generation", () => {
  const fixture = temporaryAuthority();
  try {
    const authority = fixture.open();
    const input = {
      controllerId: "old-controller", session: generation, callbackRoute: callbackRoute("old-controller", "legacy"),
      authorization: { explicit: true as const, scope: authority.scope, watchId: "watch-one", historicalProfileFingerprint: "e".repeat(64) },
    };
    assert.throws(() => authority.adoptRoute({ ...input, authorization: { ...input.authorization, scope: "another-owner" } }), /scope/u);
    assert.equal(authority.isWatchAdopted("watch-one"), false);
    authority.adoptRoute(input);
    assert.throws(() => authority.adoptRoute({ ...input, session: { ...generation, headerFingerprint: "f".repeat(64) } }), /generation/u);
    authority.close();
    const resumed = fixture.open();
    assert.equal(resumed.isWatchAdopted("watch-one"), true);
    assert.equal(resumed.isWatchAdopted("watch-other"), false);
    assert.equal(resumed.getRoute("old-controller")?.sessionId, "session");
    resumed.close();
  } finally { fixture.remove(); }
});

test("authority refuses a live owner across Host timezones and reclaims only a verified dead process lock", () => {
  const fixture = temporaryAuthority();
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = "Pacific/Honolulu";
    const first = fixture.open();
    const directory = first.directory;
    process.env.TZ = "Asia/Tokyo";
    assert.throws(() => fixture.open(), /live owner/u);
    first.close();
    fs.mkdirSync(path.join(directory, "owner.lock"), { mode: 0o700 });
    const lockPath = path.join(directory, "owner.lock", "owner.json");
    // Outside the OS pid range; ESRCH proves this recorded incarnation is gone.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, processStart: "old-start", nonce: "dead-owner" }), { mode: 0o600 });
    const recovered = fixture.open();
    assert.notEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).nonce, "dead-owner");
    recovered.close();
    fs.mkdirSync(path.join(directory, "owner.lock"), { mode: 0o700 });
    fs.writeFileSync(lockPath, "{}", { mode: 0o600 });
    assert.throws(() => fixture.open(), /lock is invalid/u);
    assert.equal(fs.readFileSync(lockPath, "utf8"), "{}");
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
    fixture.remove();
  }
});

test("a copied owner document or torn receipt never silently creates fresh callback authority", () => {
  const fixture = temporaryAuthority();
  try {
    const authority = fixture.open();
    authority.bindRoute(generation, "controller");
    authority.prepareDelivery("controller", "pending", delivery);
    const file = path.join(authority.directory, "authority.json");
    authority.close();
    const original = fs.readFileSync(file, "utf8");
    const document = JSON.parse(original);
    document.storeDirectory = path.join(fixture.root, "other-store");
    fs.writeFileSync(file, JSON.stringify(document));
    assert.throws(() => fixture.open(), /scope/u);
    fs.writeFileSync(file, original.slice(0, -10));
    assert.throws(() => fixture.open(), SyntaxError);
    fs.writeFileSync(file, original);
    const recovered = fixture.open();
    assert.equal(recovered.readDelivery("controller", "pending")?.state, "prepared");
    recovered.close();
  } finally { fixture.remove(); }
});

function temporaryAuthority(): { root: string; open(): CallbackAuthority; remove(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-authority-test-"));
  const profileDirectory = path.join(root, "profile");
  fs.mkdirSync(profileDirectory);
  return { root, open: () => openCallbackAuthority({ profileDirectory, storeDirectory: path.join(root, "store") }),
    remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function callbackRoute(controller: string, revision: string): DshCallbackRoute {
  return { schema: "agent-knock-knock/callback-route", version: 1, transport: "command_json_v1",
    profile_id: "deepseek-harness-native", profile_revision: revision, controller_session_id: controller,
    capabilities: { wake: true, respond: true } };
}
