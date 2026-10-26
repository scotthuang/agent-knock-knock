import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { terminalBindingFrom, type ManagedSessionState } from "../src/managed-session.js";
import { recoverNativeStoreAuthorityForCli } from "../src/native-store-authority-cli-adapter.js";
import type { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
import { inspectNativeStoreAuthority } from "../src/native-store-authority.js";
import { transferNativeStoreAuthority } from "../src/native-store-authority-transfer.js";
import { withNativeRuntimeStoreAuthority } from "../src/native-store-authority-runtime.js";
import { loadManagedSession, listManagedSessions, saveManagedSession } from "../src/session-store.js";
import { ensureStoreWritable, listConversations, storeManifestPath, withStoreWriterLease } from "../src/store.js";
import { captureStoreOwnerIdentity, STORE_OWNER_HOST_ENV, type StoreOwnerIdentity } from "../src/store-owner-identity.js";
import { registerStoreOwnerIdentity } from "../src/store-owner-registry.js";
import { createTerminalDispatchRepositoryCliAdapter, type TerminalDispatchRepositoryCliAdapter } from "../src/terminal-dispatch-repository-cli-adapter.js";
import { terminalControlEvidence, type TerminalControlRef } from "../src/terminal-control-ref.js";
import { createTerminalActivityWatchAnchor } from "../src/terminal-watch-record.js";
import { createTerminalWatchStore } from "../src/terminal-watch-store.js";
import { createTerminalWatchService, terminalWatchObservationFence } from "../src/terminal-watch-service.js";
import { resolveTerminalWatchOpenClawCallback } from "../src/terminal-watch-callback-cli-adapter.js";

const THREAD = "44444444-4444-4444-8444-444444444444";
const SESSION = "session-owner-transfer";
const NOW = "2026-10-23T00:00:00.000Z";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "akk-authority-"));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  ensureStoreWritable(source);
  ensureStoreWritable(target);
  const control: TerminalControlRef = { kind: "tmux", target: "authority:0.0",
    socketPath: path.join(root, "unavailable-tmux.sock"), session: "authority", window: 0, pane: 0,
    panePid: 42300, currentPath: root, capabilities: [] };
  const binding = terminalBindingFrom({ terminalId: "terminal-owner-transfer", terminalControl: control,
    pid: 42301, nativeThreadId: THREAD, processUuid: "fixture-process", processBirth: NOW,
    evidence: "fixture", generation: 1, now: new Date(NOW) });
  const session: ManagedSessionState = { schema: "agent-knock-knock/session", version: 1,
    session_id: SESSION, agent: "claude", workspace: root, status: "bound", binding,
    lineage: { created_by: "attach" }, created_at: NOW, updated_at: NOW };
  saveManagedSession(source, session, { expectedRevision: null });
  const environment: NodeJS.ProcessEnv = { ...process.env, AKK_RUNTIME_DIR: path.join(root, "runtime") };
  delete environment[STORE_OWNER_HOST_ENV];
  delete environment.AKK_EPHEMERAL_STORE;
  const repository = createTerminalDispatchRepositoryCliAdapter();
  async function context<T>(action: () => T | Promise<T>): Promise<T> {
    let result!: T;
    await runCliCommandExecution("authority-transfer-fixture", {}, {
      env: environment, runtimeLog: () => undefined
    }, async () => { result = await action(); });
    return result;
  }
  function initialize(owner?: StoreOwnerIdentity): void {
    withStoreWriterLease(source, () => {
      if (owner) registerStoreOwnerIdentity(owner);
      repository.save(control, { status: "resolved", store_dir: source, session_id: SESSION,
        native_thread_id: THREAD, binding, resolved_at: NOW,
        ...(owner ? { store_authority: { version: 1, generation: 1, store_dir: source, owner } } : {})
      }, { authorityTransfer: true });
    });
  }
  function inspect(destination = target) {
    return inspectNativeStoreAuthority({ ledger: repository.load(control), terminalControl: control,
      nativeThreadId: THREAD, storeDir: destination });
  }
  return { root, source, target, control, repository, context, initialize, inspect, environment };
}

function retiredProcessOwner(store: string, ephemeral: boolean): StoreOwnerIdentity {
  const moduleUrl = new URL("../src/store-owner-identity.js", import.meta.url).href;
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[STORE_OWNER_HOST_ENV];
  delete env.AKK_EPHEMERAL_STORE;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {captureStoreOwnerIdentity} from ${JSON.stringify(moduleUrl)};
     process.stdout.write(JSON.stringify(captureStoreOwnerIdentity(process.argv[1], process.env)));`, store],
  { encoding: "utf8", env: { ...env, ...(ephemeral ? { AKK_EPHEMERAL_STORE: "1" } : {}) }, timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const owner = JSON.parse(result.stdout) as StoreOwnerIdentity;
  assert.ok(owner.process_start && owner.boot_id, "the retired child must have real OS generation evidence");
  assert.throws(() => process.kill(owner.pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
  return owner;
}

test("legacy authority needs acknowledgement, upgrades the writer fence and retires the source irreversibly", async (t) => {
  const f = fixture(t);
  await f.context(() => {
    f.initialize();
    const oldLedger = f.repository.load(f.control)!;
    const manifest = JSON.parse(fs.readFileSync(storeManifestPath(f.source), "utf8"));
    fs.writeFileSync(storeManifestPath(f.source), JSON.stringify({ ...manifest, writer_protocol: 10, owner_registration: undefined }));
    const inspection = f.inspect();
    assert.equal(inspection.ownerStatus, "legacy");
    assert.equal(inspection.automaticEligible, false);
    assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      expectedAuthorityToken: inspection.fingerprint }, f.repository), /maintenance_acknowledgement/u);
    assert.deepEqual(f.repository.load(f.control), oldLedger);
    const transferred = transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      expectedAuthorityToken: inspection.fingerprint, maintenanceAcknowledgement: true }, f.repository);
    const source = loadManagedSession(f.source, SESSION), target = loadManagedSession(f.target, SESSION);
    assert.equal(source.status, "quarantined");
    assert.equal(source.authority_transfer?.transfer_id, transferred.transfer_id);
    assert.equal(target.authority_received?.transfer_id, transferred.transfer_id);
    assert.equal(target.binding!.generation, source.binding!.generation + 1);
    assert.equal(JSON.parse(fs.readFileSync(storeManifestPath(f.source), "utf8")).writer_protocol, 11,
      "pre-retirement protocol 10 writers must see an unsupported newer writer fence");
    assert.equal(JSON.parse(fs.readFileSync(storeManifestPath(f.source), "utf8")).owner_registration, undefined,
      "upgrading an older Store must not invent complete historical Host registration");
    assert.throws(() => saveManagedSession(f.source, { ...source, status: "bound", authority_transfer: undefined },
      { expectedRevision: source.revision! }), /retired by Store authority transfer/u);
    assert.throws(() => f.repository.save(f.control, oldLedger), /stale writer|authority changed/u);
    assert.equal(f.inspect().state, "current");
    assert.equal(listConversations(f.source).length + listConversations(f.target).length, 0);
    assert.equal(fs.existsSync(f.control.socketPath!), false, "transfer succeeded without a reachable input transport");
  });
});

test("a live registered owner blocks transfer without changing the ledger or either Session inventory", async (t) => {
  const f = fixture(t);
  await f.context(() => {
    const owner = captureStoreOwnerIdentity(f.source, {});
    f.initialize(owner);
    const before = f.repository.load(f.control), source = loadManagedSession(f.source, SESSION);
    const inspection = f.inspect();
    assert.equal(inspection.ownerStatus, "alive");
    assert.equal(inspection.transferEligible, false);
    assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      expectedAuthorityToken: inspection.fingerprint, maintenanceAcknowledgement: true }, f.repository), /owner_alive/u);
    assert.deepEqual(f.repository.load(f.control), before);
    assert.deepEqual(loadManagedSession(f.source, SESSION), source);
    assert.deepEqual(listManagedSessions(f.target), []);
    assert.equal(listConversations(f.target).length, 0);
  });
});

test("a proven-dead persistent owner needs an explicit transfer while an opted-in ephemeral owner can transfer automatically", async (t) => {
  for (const ephemeral of [false, true]) {
    const f = fixture(t), owner = retiredProcessOwner(f.source, ephemeral);
    await f.context(() => {
      f.initialize(owner);
      const inspection = f.inspect();
      assert.equal(inspection.ownerStatus, "dead");
      assert.equal(inspection.transferEligible, true);
      assert.equal(inspection.automaticEligible, ephemeral);
      const before = f.repository.load(f.control);
      if (!ephemeral) {
        assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
          automatic: true }, f.repository), /not automatically reclaimable/u);
        assert.deepEqual(f.repository.load(f.control), before);
      }
      transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        ...(ephemeral ? { automatic: true } : { expectedAuthorityToken: inspection.fingerprint }) }, f.repository);
      assert.equal(f.inspect().state, "current");
      assert.equal(loadManagedSession(f.source, SESSION).status, "quarantined");
      assert.equal(listManagedSessions(f.target).filter(session => session.status === "bound").length, 1);
    });
  }
});

test("ledger owner evidence must belong to the complete inventory and cannot silently upgrade legacy coverage", async (t) => {
  for (const scenario of ["missing-owner", "malformed-owner", "legacy-ledger"] as const) {
    const f = fixture(t), dead = retiredProcessOwner(f.source, true);
    await f.context(() => {
      f.initialize(dead);
      const original = f.repository.load(f.control)!;
      const owner = scenario === "missing-owner" ? captureStoreOwnerIdentity(f.source, f.environment) : { pid: process.pid };
      f.repository.save(f.control, { ...original, store_authority: scenario === "legacy-ledger" ? undefined :
        { version: 1, generation: 1, store_dir: f.source, owner } }, { authorityTransfer: true });
      const before = f.repository.load(f.control), observed = f.inspect();
      assert.equal(observed.ownerStatus, scenario === "legacy-ledger" ? "legacy" : "unknown", scenario);
      assert.equal(observed.automaticEligible, false, scenario);
      assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken: observed.fingerprint }, f.repository), /refused|maintenance_acknowledgement/u);
      assert.deepEqual(f.repository.load(f.control), before);
      assert.equal(loadManagedSession(f.source, SESSION).status, "bound");
      assert.equal(listManagedSessions(f.target).length, 0);
    });
  }
});

test("registering a dead ephemeral owner cannot erase a legacy Store's unregistered Host history", async (t) => {
  const f = fixture(t), owner = retiredProcessOwner(f.source, true);
  const manifestPath = storeManifestPath(f.source);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest.owner_registration;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await f.context(() => {
    f.initialize(owner);
    const inspection = f.inspect();
    assert.equal(inspection.ownerStatus, "legacy");
    assert.equal(inspection.automaticEligible, false);
    assert.equal(inspection.transferEligible, true);
    const before = f.repository.load(f.control);
    assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      automatic: true }, f.repository), /not automatically reclaimable/u);
    assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      expectedAuthorityToken: inspection.fingerprint }, f.repository), /maintenance_acknowledgement/u);
    assert.deepEqual(f.repository.load(f.control), before);
    transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
      expectedAuthorityToken: inspection.fingerprint, maintenanceAcknowledgement: true }, f.repository);
    assert.equal(f.inspect().state, "current");
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf8")).owner_registration, undefined);
  });
});

test("related active Watches and pending notifications retain source authority while unrelated or settled Watches do not", async (t) => {
  for (const state of ["active", "notification-pending", "settled", "unrelated"] as const) {
    const f = fixture(t);
    await f.context(async () => {
      f.initialize();
      const repository = createTerminalWatchStore(f.source, { acquire: () => () => {} });
      const service = createTerminalWatchService({ repository, now: () => new Date(NOW),
        randomUUID: () => "watch-transfer-fixture",
        observe: async watch => ({ ...terminalWatchObservationFence(watch), kind: "pending", observed_at: NOW }),
        resolveCallback: resolveTerminalWatchOpenClawCallback,
        deliver: ({ envelope }) => ({ disposition: "accepted", accepted_at: NOW, acceptance_id: envelope.delivery_id }) });
      const control = state === "unrelated"
        ? { ...f.control, target: "unrelated:0.1", panePid: 42400 } : f.control;
      const watch = service.create({ watch_id: "terminal-watch-transfer-fixture", agent: "claude",
        terminal: { terminal_id: "terminal-owner-transfer", terminal_endpoint: terminalControlEvidence(control),
          workspace: f.root, binding_token: "a".repeat(64) },
        anchor: createTerminalActivityWatchAnchor({ capturedAt: new Date(NOW), terminalId: "terminal-owner-transfer",
          pid: control.panePid!, initialActivityState: "working" }),
        openclaw_session: "fixture-watch-owner", openclaw_bin: "/unavailable/openclaw", timeout_ms: 60_000 });
      if (state === "notification-pending" || state === "settled") service.cancel(watch.watch_id);
      if (state === "settled") await service.reconcileAll();
      const originalWatch = service.get(watch.watch_id);
      const inspection = f.inspect();
      const blocked = state === "active" || state === "notification-pending";
      assert.equal(inspection.transferEligible, !blocked, state);
      if (state === "notification-pending") assert.equal(originalWatch.notification_outbox[0]?.status, "pending");
      if (state === "settled") assert.equal(originalWatch.notification_outbox[0]?.status, "delivered");
      if (blocked) {
        const ledger = f.repository.load(f.control);
        assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
          expectedAuthorityToken: inspection.fingerprint, maintenanceAcknowledgement: true }, f.repository), /unresolved_work/u);
        assert.deepEqual(f.repository.load(f.control), ledger);
        assert.deepEqual(listManagedSessions(f.target), []);
      } else {
        transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
          expectedAuthorityToken: inspection.fingerprint, maintenanceAcknowledgement: true }, f.repository);
        assert.equal(f.inspect().state, "current");
      }
      assert.deepEqual(service.get(watch.watch_id), originalWatch, "transfer never migrates or replays the original Watch");
    });
  }
});

test("every interrupted transfer persistence resumes the same claim and rejects delayed source ledger writes", async (t) => {
  const points = [
    { phase: "prepared", when: "after" },
    { phase: "source_retired", when: "before" },
    { phase: "source_retired", when: "after" },
    { phase: "target_created", when: "before" },
    { phase: "target_created", when: "after" }
  ];
  for (const point of points) {
    const f = fixture(t);
    await f.context(() => {
      f.initialize();
      const before = f.repository.load(f.control)!;
      let interrupted = false;
      const repository: TerminalDispatchRepositoryCliAdapter = { ...f.repository, save(control, ledger, options) {
        const shouldInterrupt = !interrupted && (ledger.store_authority_transfer as { phase?: string } | undefined)?.phase === point.phase;
        if (shouldInterrupt && point.when === "before") { interrupted = true; throw new Error("persist interrupted"); }
        f.repository.save(control, ledger, options);
        if (shouldInterrupt && point.when === "after") { interrupted = true; throw new Error("persist interrupted"); }
      } };
      assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken: f.inspect().fingerprint, maintenanceAcknowledgement: true }, repository), /persist interrupted/u);
      assert.equal(interrupted, true);
      const journal = f.repository.load(f.control)!.store_authority_transfer as { transfer_id: string };
      const bound = [...listManagedSessions(f.source), ...listManagedSessions(f.target)]
        .filter(session => session.status === "bound");
      assert.ok(bound.length <= 1, `${point.when} ${point.phase} never leaves two claimable Sessions`);
      assert.throws(() => f.repository.save(f.control, before), /transfer is incomplete/u);
      const resumed = transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken: f.inspect().fingerprint }, f.repository);
      assert.equal(resumed.transfer_id, journal.transfer_id);
      assert.equal(loadManagedSession(f.source, SESSION).authority_transfer?.transfer_id, resumed.transfer_id);
      assert.equal(loadManagedSession(f.target, SESSION).authority_received?.transfer_id, resumed.transfer_id);
      assert.equal(listManagedSessions(f.target).length, 1);
      assert.equal(listConversations(f.source).length + listConversations(f.target).length, 0);
    });
  }
});

test("a lost committed receipt replays only the original transfer authority without another persistence", async (t) => {
  for (const automatic of [false, true]) {
    const f = fixture(t);
    const owner = automatic ? retiredProcessOwner(f.source, true) : undefined;
    await f.context(() => {
      f.initialize(owner);
      const token = f.inspect().fingerprint;
      let writes = 0;
      const interrupted: TerminalDispatchRepositoryCliAdapter = { ...f.repository, save(control, ledger, options) {
        f.repository.save(control, ledger, options);
        if ((ledger.store_authority_transfer as { phase?: string } | undefined)?.phase === "committed") {
          throw new Error("committed receipt lost");
        }
      } };
      const request = { storeDir: f.target, terminalControl: f.control,
        ...(automatic ? { automatic: true } : { expectedAuthorityToken: token, maintenanceAcknowledgement: true }) };
      assert.throws(() => transferNativeStoreAuthority(request, interrupted), /committed receipt lost/u);
      const committed = f.repository.load(f.control)!;
      const source = loadManagedSession(f.source, SESSION), target = loadManagedSession(f.target, SESSION);
      assert.equal((committed.store_authority_transfer as { phase: string }).phase, "committed");
      const observed: TerminalDispatchRepositoryCliAdapter = { ...f.repository, save(control, ledger, options) {
        writes += 1; f.repository.save(control, ledger, options);
      } };
      const receipt = transferNativeStoreAuthority(request, observed);
      assert.equal(receipt.transfer_id, target.authority_received?.transfer_id);
      assert.equal(writes, 0);
      assert.deepEqual(f.repository.load(f.control), committed);
      assert.deepEqual(loadManagedSession(f.source, SESSION), source);
      assert.deepEqual(loadManagedSession(f.target, SESSION), target);
      assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken: "invented-token" }, observed));
      assert.throws(() => transferNativeStoreAuthority({ ...request, storeDir: f.source }, observed));
      if (!automatic) assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target,
        terminalControl: f.control, automatic: true }, observed));
      assert.equal(writes, 0, "invalid receipt replays do not modify the committed authority");
    });
  }
});

test("native access without a visible terminal cannot bypass foreign authority and holds its terminal lock for an allowed action", async (t) => {
  const f = fixture(t);
  await f.context(async () => {
    f.initialize();
    const ledger = f.repository.load(f.control), source = loadManagedSession(f.source, SESSION);
    let dispatched = 0;
    const action = async () => { dispatched += 1; return "native action"; };
    const runtimeDir = f.repository.runtimeDir();
    await assert.rejects(withNativeRuntimeStoreAuthority({ nativeThreadId: THREAD, storeDir: f.target, runtimeDir }, action),
      /conflicting or transferring Store authority/u);
    assert.equal(dispatched, 0);
    assert.deepEqual(f.repository.load(f.control), ledger);
    assert.deepEqual(loadManagedSession(f.source, SESSION), source);
    const expectedAuthorityToken = f.inspect().fingerprint;
    const contender: TerminalDispatchRepositoryCliAdapter = { ...f.repository,
      acquire: (storeDir, control) => f.repository.acquire(storeDir, control, { timeoutMs: 5, retryMs: 1 }) };
    const result = await withNativeRuntimeStoreAuthority({ nativeThreadId: THREAD, storeDir: f.source, runtimeDir }, async () => {
      assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken, maintenanceAcknowledgement: true }, contender), /lock/iu);
      assert.deepEqual(f.repository.load(f.control), ledger);
      return action();
    });
    assert.equal(result, "native action");
    assert.equal(dispatched, 1);
    const release = f.repository.acquire(f.source, f.control, { timeoutMs: 5, retryMs: 1 });
    release();
  });
});

test("two competing destinations serialize on the physical terminal lock and only one receives authority", async (t) => {
  const f = fixture(t), other = path.join(f.root, "other-target");
  ensureStoreWritable(other);
  await f.context(() => f.initialize());
  const tokens = await f.context(() => [f.inspect(f.target).fingerprint, f.inspect(other).fingerprint]);
  const worker = path.join(f.root, "transfer-worker.mjs"), gate = path.join(f.root, "start");
  const moduleUrl = (name: string) => new URL(`../src/${name}.js`, import.meta.url).href;
  fs.writeFileSync(worker, `
import fs from "node:fs";
import {runCliCommandExecution} from ${JSON.stringify(moduleUrl("cli-runtime-context"))};
import {createTerminalDispatchRepositoryCliAdapter} from ${JSON.stringify(moduleUrl("terminal-dispatch-repository-cli-adapter"))};
import {transferNativeStoreAuthority} from ${JSON.stringify(moduleUrl("native-store-authority-transfer"))};
const [request, gate, ready] = process.argv.slice(2);
fs.writeFileSync(ready, "ready");
while (!fs.existsSync(gate)) await new Promise(resolve => setTimeout(resolve, 5));
try {
  let receipt;
  await runCliCommandExecution("transfer-competition", {}, {env:process.env,runtimeLog:()=>{}}, async()=>{
    receipt=transferNativeStoreAuthority(JSON.parse(request),createTerminalDispatchRepositoryCliAdapter());
  });
  process.stdout.write(JSON.stringify({ok:true,receipt}));
} catch(error) { process.stdout.write(JSON.stringify({ok:false,error:String(error.message)})); }
`, "utf8");
  const attempts = [f.target, other].map((storeDir, index) => {
    const ready = path.join(f.root, `ready-${index}`);
    const child = spawn(process.execPath, [worker, JSON.stringify({ storeDir, terminalControl: f.control,
      expectedAuthorityToken: tokens[index], maintenanceAcknowledgement: true }), gate, ready],
    { env: f.environment, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const result = new Promise<{ ok: boolean; receipt?: { store_dir: string }; error?: string }>((resolve, reject) => {
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => {
        if (code !== 0) reject(new Error(stderr || `worker exited ${code}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
    return { ready, result };
  });
  const deadline = Date.now() + 10_000;
  while (!attempts.every(attempt => fs.existsSync(attempt.ready)) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.ok(attempts.every(attempt => fs.existsSync(attempt.ready)), "both contenders reached the shared start gate");
  fs.writeFileSync(gate, "start");
  const results = await Promise.all(attempts.map(attempt => attempt.result));
  assert.equal(results.filter(result => result.ok).length, 1);
  const winner = results.find(result => result.ok)!.receipt!.store_dir;
  await f.context(() => {
    assert.equal(f.repository.load(f.control)!.store_dir, winner);
    assert.equal(loadManagedSession(f.source, SESSION).authority_transfer?.target_store_dir, winner);
    assert.equal([...listManagedSessions(f.target), ...listManagedSessions(other)].filter(session => session.status === "bound").length, 1);
  });
});


test("automatic Store authority recovery proves the live native identity and idle approval surface before retiring a Session", async (t) => {
  const f = fixture(t), owner = retiredProcessOwner(f.source, true);
  const options = { claudeHome: path.join(f.root, "custom-claude"), codexHome: path.join(f.root, "custom-codex") };
  await f.context(async () => {
    f.initialize(owner);
    const source = loadManagedSession(f.source, SESSION), ledger = f.repository.load(f.control);
    const release = f.repository.acquire(f.target, f.control);
    try {
      for (const condition of ["uuid_missing", "working", "approval_unscanned", "approval_blocked", "identity_changed_after_capture"]) {
        let captures = 0;
        const bridge = {
          resolveStoredTerminal: async () => ({ agent: "claude", pid: 42301, terminalControl: f.control }),
          status: async () => ({ reachable: true, activity_state: condition === "working" ? "working" : "idle",
            approval_state: { scanned: condition !== "approval_unscanned", blocked: condition === "approval_blocked" } })
        } as unknown as TerminalAgentBridge;
        await assert.rejects(recoverNativeStoreAuthorityForCli({ storeDir: f.target, terminalControl: f.control, options }, {
          repository: f.repository, createBridge: actual => { assert.deepEqual(actual, options); return bridge; },
          identity: async request => {
            assert.deepEqual(request.options, options, "every fresh native identity check uses the selected homes");
            return { sessionId: condition === "identity_changed_after_capture" && ++captures > 2 ? "changed-thread" : THREAD,
              processUuid: condition === "uuid_missing" ? undefined : "fixture-process", evidence: "fixture" };
          }
        }), /cannot be verified|reachable, idle/u, condition);
        assert.deepEqual(loadManagedSession(f.source, SESSION), source, condition);
        assert.deepEqual(f.repository.load(f.control), ledger, condition);
        assert.deepEqual(listManagedSessions(f.target), [], condition);
      }
      const bridge = {
        resolveStoredTerminal: async () => ({ agent: "claude", pid: 42301, terminalControl: f.control }),
        status: async () => ({ reachable: true, activity_state: "idle", approval_state: { scanned: true, blocked: false } })
      } as unknown as TerminalAgentBridge;
      let identityChecks = 0;
      await recoverNativeStoreAuthorityForCli({ storeDir: f.target, terminalControl: f.control, options }, {
        repository: f.repository, createBridge: actual => { assert.deepEqual(actual, options); return bridge; },
        identity: async request => {
          assert.deepEqual(request.options, options);
          identityChecks += 1;
          return { sessionId: THREAD, processUuid: "fixture-process", evidence: "fixture" };
        }
      });
      assert.equal(identityChecks, 3, "discovery and both sides of the screen read retain exact identity verification");
      assert.equal(f.inspect().state, "current");
      assert.equal(loadManagedSession(f.source, SESSION).status, "quarantined");
      assert.equal(listManagedSessions(f.target).length, 1);
      assert.equal(listConversations(f.target).length, 0);
    } finally { release(); }
  });
});

test("unfinished Store authority recovery withdraws its offer when owner registrations change or become unverifiable", async (t) => {
  for (const corrupt of [false, true]) {
    const f = fixture(t);
    await f.context(() => {
      f.initialize();
      const interrupted: TerminalDispatchRepositoryCliAdapter = { ...f.repository, save(control, ledger, options) {
        f.repository.save(control, ledger, options);
        if ((ledger.store_authority_transfer as { phase?: string } | undefined)?.phase === "prepared") throw new Error("prepared interruption");
      } };
      assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
        expectedAuthorityToken: f.inspect().fingerprint, maintenanceAcknowledgement: true }, interrupted), /prepared interruption/u);
      assert.equal(f.inspect().transferEligible, true, "unchanged explicitly acknowledged legacy journal remains recoverable");
      withStoreWriterLease(f.source, () => registerStoreOwnerIdentity(captureStoreOwnerIdentity(f.source, {})));
      if (corrupt) fs.writeFileSync(path.join(f.source, ".akk-store-owners", "registry.json"), "{invalid");
      const observed = f.inspect();
      assert.equal(observed.transferEligible, false);
      assert.equal(observed.reason, corrupt ? "authority_owner_unknown" : "authority_owner_registrations_changed");
    });
  }
});


test("terminal mutations reject foreign or transferring authority for the live native thread but permit a proven new thread", async (t) => {
  for (const state of ["alive", "unknown", "transferring"] as const) {
    const f = fixture(t);
    await f.context(async () => {
      if (state === "transferring") {
        f.initialize();
        const interrupted: TerminalDispatchRepositoryCliAdapter = { ...f.repository, save(control, ledger, options) {
          f.repository.save(control, ledger, options);
          if ((ledger.store_authority_transfer as { phase?: string } | undefined)?.phase === "prepared") throw new Error("prepared interruption");
        } };
        assert.throws(() => transferNativeStoreAuthority({ storeDir: f.target, terminalControl: f.control,
          expectedAuthorityToken: f.inspect().fingerprint, maintenanceAcknowledgement: true }, interrupted), /prepared interruption/u);
      } else {
        f.initialize(captureStoreOwnerIdentity(f.source, {}));
        if (state === "unknown") fs.writeFileSync(path.join(f.source, ".akk-store-owners", "registry.json"), "{invalid");
      }
      const before = f.repository.load(f.control), source = loadManagedSession(f.source, SESSION);
      let nativeId: string | undefined = THREAD;
      const bridge = {
        resolveStoredTerminal: async () => ({ agent: "claude", pid: 42301, terminalControl: f.control }),
        status: async () => { throw new Error("a blocked foreign mutation cannot request an automatic transfer screen proof"); }
      } as unknown as TerminalAgentBridge;
      const ports = { repository: f.repository, createBridge: () => bridge,
        identity: async () => nativeId ? { sessionId: nativeId, processUuid: "fixture-process", evidence: "fixture" } : undefined };
      const release = f.repository.acquire(f.target, f.control);
      try {
        await assert.rejects(recoverNativeStoreAuthorityForCli({ storeDir: f.target, terminalControl: f.control }, ports),
          /authoritative in another Store/u, state);
        nativeId = undefined;
        await assert.rejects(recoverNativeStoreAuthorityForCli({ storeDir: f.target, terminalControl: f.control }, ports),
          /cannot be verified/u, state);
        nativeId = "55555555-5555-4555-8555-555555555555";
        await recoverNativeStoreAuthorityForCli({ storeDir: f.target, terminalControl: f.control }, ports);
        assert.deepEqual(f.repository.load(f.control), before);
        assert.deepEqual(loadManagedSession(f.source, SESSION), source);
        assert.deepEqual(listManagedSessions(f.target), []);
      } finally { release(); }
    });
  }
});
