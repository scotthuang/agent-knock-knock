import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { terminalControlEvidence } from "@scotthuang/agent-knock-knock/dist/src/terminal-control-ref.js";
import { createTerminalActivityWatchAnchor, initialTerminalWatchObservationCheckpoint,
  pathsForTerminalWatch, saveTerminalWatch, TERMINAL_WATCH_SCHEMA, TERMINAL_WATCH_VERSION,
  type TerminalWatch } from "@scotthuang/agent-knock-knock/dist/src/terminal-watch-store.js";
import { openCallbackAuthority } from "../src/callback-authority.js";
import { adoptLegacyCallbackWatches } from "../src/legacy-callback-adoption.js";
import { createConnectorProfileResources, connectorCallbackRoute } from "../src/profile.js";
import type { DshRecoveryHost } from "../src/host-ports.js";

test("explicit historical Watch adoption preserves the original route and Watch bytes across restart", async (t) => {
  const fixture = adoptionFixture(t);
  const before = fs.readFileSync(fixture.watchPath);
  await adoptLegacyCallbackWatches({ ...fixture.options, adoptions: [] });
  assert.equal(fixture.authority.getRoute(fixture.controllerId), undefined, "no discovery-based implicit adoption");
  await adoptLegacyCallbackWatches(fixture.options);
  assert.deepEqual(fixture.authority.getRoute(fixture.controllerId), {
    controllerId: fixture.controllerId, sessionId: "original-session", headerFingerprint: "a".repeat(64),
  });
  assert.deepEqual(fixture.authority.callbackRoutes(), [fixture.route]);
  assert.deepEqual(fs.readFileSync(fixture.watchPath), before);
  assert.equal(fixture.observations(), 1);
  // Historical package artifacts and temporary profiles may disappear after
  // import; the new owner must keep using its durable imported authority.
  fs.unlinkSync(fixture.historicalProfilePath);
  fixture.authority.close();
  const reopened = openCallbackAuthority(fixture.authorityOptions);
  try {
    await adoptLegacyCallbackWatches({ ...fixture.options, authority: reopened });
    assert.equal(fixture.observations(), 1);
    assert.deepEqual(reopened.callbackRoutes(), [fixture.route]);
    assert.deepEqual(fs.readFileSync(fixture.watchPath), before);
  } finally { reopened.close(); }
});

test("historical adoption rejects changed contracts, foreign package scope, and non-private artifacts", async (t) => {
  for (const mutation of ["revision", "host", "environment", "helper-profile", "acknowledgement", "permissions", "symlink"] as const) {
    await t.test(mutation, async (nested) => {
      const fixture = adoptionFixture(nested);
      const artifact = JSON.parse(fs.readFileSync(fixture.historicalProfilePath, "utf8"));
      if (mutation === "revision") artifact.revision = "0.1.0-" + "f".repeat(24);
      if (mutation === "host") artifact.compatibility.range = ">=0.1.1-rc.2";
      if (mutation === "environment") artifact.callback.environment.allow.push("PATH");
      if (mutation === "helper-profile") artifact.callback.arguments[0] =
        "/another-profile/node_modules/@scotthuang/agent-knock-knock-deepseek-harness/lib/callback-helper.js";
      if (mutation === "acknowledgement") artifact.callback.acknowledgement.acknowledgedMessageId.jsonPointer = "/request/delivery_id";
      fs.writeFileSync(fixture.historicalProfilePath, JSON.stringify(artifact));
      if (mutation === "permissions") fs.chmodSync(fixture.historicalProfilePath, 0o644);
      if (mutation === "symlink") {
        const actual = fixture.historicalProfilePath + ".saved";
        fs.renameSync(fixture.historicalProfilePath, actual);
        fs.symlinkSync(actual, fixture.historicalProfilePath);
      }
      const before = fs.readFileSync(fixture.watchPath);
      await assert.rejects(() => adoptLegacyCallbackWatches(fixture.options), /Cannot adopt DSH callback Watch/u);
      assert.equal(fixture.authority.getRoute(fixture.controllerId), undefined);
      assert.equal(fixture.observations(), 0, "invalid historical authority must not resolve a Session");
      assert.deepEqual(fs.readFileSync(fixture.watchPath), before);
    });
  }
});

test("historical adoption refuses unavailable Sessions and corrupted Watch authority", async (t) => {
  const fixture = adoptionFixture(t);
  await assert.rejects(() => adoptLegacyCallbackWatches({ ...fixture.options,
    host: { ...fixture.options.host, async observeSessionIdentity() { throw new Error("Session missing"); } },
  }), /Session missing/u);
  assert.equal(fixture.authority.getRoute(fixture.controllerId), undefined);
  const watch = JSON.parse(fs.readFileSync(fixture.watchPath, "utf8"));
  watch.anchor.anchor_fingerprint = "f".repeat(64);
  fs.writeFileSync(fixture.watchPath, JSON.stringify(watch));
  await assert.rejects(() => adoptLegacyCallbackWatches(fixture.options));
  assert.equal(fixture.authority.getRoute(fixture.controllerId), undefined);
});

function adoptionFixture(t: test.TestContext) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-adoption-")));
  const storeDirectory = path.join(directory, "store");
  const resources = createConnectorProfileResources("0.2.1-rc.2", {});
  const controllerId = `akk-dsh:${resources.instanceNonce}:1:${Buffer.from("original-session").toString("base64url")}`;
  const route = { ...connectorCallbackRoute(resources, controllerId), capabilities: { wake: true, respond: false } };
  const artifact = structuredClone(resources.profile) as Record<string, any>;
  artifact.callback.arguments[0] = path.join(directory, "node_modules", ".pnpm", "historical-package", "node_modules",
    "@scotthuang", "agent-knock-knock-deepseek-harness", "lib", "callback-helper.js");
  const historicalProfilePath = path.join(directory, "historical-profile.json");
  fs.writeFileSync(historicalProfilePath, JSON.stringify(artifact), { mode: 0o600 });
  resources.remove();
  const authorityOptions = { profileDirectory: directory, storeDirectory };
  const authority = openCallbackAuthority(authorityOptions);
  const now = "2026-10-27T00:00:00.000Z";
  const anchor = createTerminalActivityWatchAnchor({ capturedAt: new Date(now), terminalId: "terminal:v2:adoption",
    pid: 4242, initialActivityState: "working" });
  const watch: TerminalWatch = {
    schema: TERMINAL_WATCH_SCHEMA, version: TERMINAL_WATCH_VERSION, watch_id: "terminal-watch-adoption",
    agent: "codex", terminal: { terminal_id: "terminal:v2:adoption", workspace: directory, binding_token: "b".repeat(64),
      terminal_endpoint: terminalControlEvidence({ kind: "tmux", session: "adoption", target: "adoption:0.0",
        window: 0, pane: 0, panePid: 4200, capabilities: ["screen_status"] }) },
    anchor, observation_checkpoint: initialTerminalWatchObservationCheckpoint(anchor), interaction_policy: "notify_only",
    callback_route: route, openclaw_session: controllerId, openclaw_bin: "openclaw", status: "active",
    created_at: now, updated_at: now, deadline_at: "2026-10-27T12:00:00.000Z", last_activity_at: now,
    notification_outbox: [],
  };
  saveTerminalWatch(storeDirectory, watch, { expectedRevision: null });
  let observations = 0;
  const host: DshRecoveryHost = {
    profileDirectory: directory, storeDirectory,
    async observeSessionIdentity(id) { observations += 1; assert.equal(id, "original-session");
      return { sessionId: id, headerFingerprint: "a".repeat(64) }; },
    sessionIdentity() { throw new Error("adoption must not load a live Agent"); },
    async restoreAgent() { throw new Error("adoption must not wake an Agent"); },
    async flush() { throw new Error("adoption must not mutate the Session"); },
    async findOwnMessage() { throw new Error("adoption must not deliver a message"); },
  };
  t.after(() => { authority.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { authority, authorityOptions, route, controllerId, historicalProfilePath,
    watchPath: pathsForTerminalWatch(watch.watch_id, storeDirectory).statePath,
    observations: () => observations,
    options: { adoptions: [{ watchId: watch.watch_id, historicalProfilePath }], storeDirectory, authority, host },
  };
}
