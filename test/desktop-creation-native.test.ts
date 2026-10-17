import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopCreationNative, DesktopCreationNativeError, VERIFIED_DESKTOP_CREATION_BUILD,
  VERIFIED_DESKTOP_CREATION_BUILDS, type DesktopCreationNativeOptions } from "../src/desktop-creation-native.js";
import { DesktopCreationRpcError, type DesktopCreationRpc } from "../src/desktop-creation-rpc.js";

const THREAD = "00000000-0000-4000-8000-000000000001", PROJECT = "00000000-0000-4000-8000-000000000002";
function fixture(t: { after(fn: () => void): void },
  build: (typeof VERIFIED_DESKTOP_CREATION_BUILDS)[number] = VERIFIED_DESKTOP_CREATION_BUILD) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-create-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const canonicalCwd = fs.realpathSync(cwd);
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let title: string | null = null, selectedProject: string | null = null;
  const state = { closed: false, initialized: false,
    project: { id: PROJECT, name: "Fixture project", roots: [{ path: canonicalCwd }] },
    intercept: undefined as ((method: string, params: Record<string, unknown>) => unknown) | undefined };
  const resultThread = () => ({ thread: { id: THREAD, cwd: canonicalCwd, projectId: selectedProject, name: title, ephemeral: false } });
  const rpc: DesktopCreationRpc = {
    async request(method, params, options) {
      try { await options?.beforeDispatch?.(); }
      catch { throw new DesktopCreationRpcError("dispatch_barrier_failed", "barrier failed", false, method); }
      requests.push({ method, params });
      if (state.intercept) { const response = state.intercept(method, params); if (response !== undefined) return response; }
      if (method === "initialize") return { userAgent: `agent-knock-knock-desktop-create/${build.backendVersion} (Mac OS)`, codexHome: canonicalCwd };
      if (method === "project/list") return { data: [state.project], nextCursor: null };
      if (method === "project/read") return { project: state.project };
      if (method === "thread/start") { selectedProject = params.projectId as string | null; return resultThread(); }
      if (method === "thread/name/set") { title = params.name as string; return {}; }
      if (method === "thread/read") return resultThread();
      throw new Error(`Unexpected method: ${method}`);
    },
    notifyInitialized() { state.initialized = true; },
    async close() { state.closed = true; }
  };
  const options: DesktopCreationNativeOptions = { codexHome: cwd, compatibility: build,
    inspectApplication: appPath => ({ appPath, binaryPath: `${appPath}/bundled/codex`,
      appVersion: build.version, appBuild: build.build,
      backendVersion: build.backendVersion }), rpcFactory: () => rpc };
  return { cwd: canonicalCwd, state, requests, options };
}

for (const build of VERIFIED_DESKTOP_CREATION_BUILDS) test(`Desktop ${build.build} creates a projectless zero-turn thread once with identity barriers`, async t => {
  const f = fixture(t, build), client = await createDesktopCreationNative(f.options);
  const phases: string[] = [];
  const result = await client.create({ cwd: f.cwd, title: "New fixture",
    beforeDispatch: () => { assert.equal(f.requests.some(r => r.method === "thread/start"), false); phases.push("before"); },
    onCreated: receipt => { assert.equal(receipt.threadId, THREAD); assert.equal(f.requests.some(r => r.method === "thread/name/set"), false); phases.push("created"); } });
  assert.deepEqual(phases, ["before", "created"]);
  assert.deepEqual(result, { threadId: THREAD, cwd: f.cwd, projectId: null, title: "New fixture" });
  assert.deepEqual(f.requests.find(r => r.method === "thread/start")?.params,
    { cwd: f.cwd, projectId: null, threadSource: "user", ephemeral: false });
  assert.equal(f.requests.some(r => r.method === "turn/start"), false);
  await assert.rejects(client.create({ cwd: f.cwd }), /already attempted/u);
  await client.close(); assert.equal(f.state.closed, true);
});

test("creation requires one coherent application/build/backend tuple before starting the RPC process", async t => {
  for (const build of VERIFIED_DESKTOP_CREATION_BUILDS) {
    const f = fixture(t, build);
    let starts = 0;
    const original = f.options.inspectApplication!("/fixture.app");
    const other = VERIFIED_DESKTOP_CREATION_BUILDS.find(candidate => candidate.build !== build.build)!;
    for (const mismatch of [
      { appVersion: "future" }, { appBuild: "future" }, { backendVersion: "0.162.0-alpha.17.3" },
      { appVersion: other.version, appBuild: other.build }
    ]) {
      await assert.rejects(createDesktopCreationNative({ ...f.options,
        inspectApplication: () => ({ ...original, ...mismatch }),
        rpcFactory: () => { starts++; throw new Error("Must reject before RPC launch"); }
      }), (error: unknown) => error instanceof DesktopCreationNativeError
        && error.code === "incompatible_desktop" && error.dispatchState === "not_sent");
    }
    assert.equal(starts, 0);
  }
});

test("resolves exact projects across pages, verifies roots, and rejects ambiguity or outside directories before creation", async t => {
  const f = fixture(t), client = await createDesktopCreationNative(f.options);
  f.state.intercept = (method, params) => method === "project/list"
    ? params.cursor ? { data: [f.state.project], nextCursor: null } : { data: [], nextCursor: "second" } : undefined;
  const resolved = await client.resolveProject({ projectName: "Fixture project" });
  assert.equal(resolved.project.id, PROJECT); assert.equal(resolved.cwd, f.cwd);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-other-"));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  await assert.rejects(client.create({ cwd: other, projectId: PROJECT }), (error: unknown) =>
    error instanceof DesktopCreationNativeError && error.code === "project_cwd_mismatch" && error.dispatchState === "not_sent");
  f.state.intercept = method => method === "project/list" ? { data: [f.state.project,
    { ...f.state.project, id: "00000000-0000-4000-8000-000000000003" }], nextCursor: null } : undefined;
  await assert.rejects(client.resolveProject({ projectName: "Fixture project" }), /exactly one/u);
  assert.equal(f.requests.some(r => r.method === "thread/start"), false);
  f.state.intercept = undefined;
  const created = await client.create({ cwd: f.cwd, projectId: PROJECT });
  assert.equal(created.projectId, PROJECT);
});

test("multiple project roots require explicit cwd and symlink escapes do not qualify as a project child", async t => {
  const f = fixture(t), client = await createDesktopCreationNative(f.options);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akk-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  f.state.project.roots.push({ path: outside });
  await assert.rejects(client.resolveProject({ projectId: PROJECT }), /multiple roots/u);
  f.state.project.roots.pop();
  fs.symlinkSync(outside, path.join(f.cwd, "escape"));
  await assert.rejects(client.resolveProject({ projectId: PROJECT, cwd: path.join(f.cwd, "escape") }), /outside/u);
  fs.mkdirSync(path.join(f.cwd, "child"));
  assert.equal((await client.resolveProject({ projectId: PROJECT, cwd: path.join(f.cwd, "child") })).cwd, path.join(f.cwd, "child"));
});

test("creation timeout remains unknown and is not repeated; known UUID survives a naming failure", async t => {
  for (const phase of ["thread/start", "thread/name/set"]) {
    const f = fixture(t), client = await createDesktopCreationNative(f.options);
    f.state.intercept = method => { if (method === phase) throw new DesktopCreationRpcError("timeout", "Timeout", true, phase, 4); };
    await assert.rejects(client.create({ cwd: f.cwd, title: "Test" }), (error: unknown) =>
      error instanceof DesktopCreationNativeError && error.dispatchState === (phase === "thread/start" ? "unknown" : "created")
      && error.threadId === (phase === "thread/start" ? undefined : THREAD) && error.requestId === 4);
    await assert.rejects(client.create({ cwd: f.cwd }), /already attempted/u);
    assert.equal(f.requests.filter(r => r.method === "thread/start").length, 1);
  }
});

test("failed durable barrier proves not sent and malformed target readback retains the created identity", async t => {
  const f = fixture(t), client = await createDesktopCreationNative(f.options);
  await assert.rejects(client.create({ cwd: f.cwd, beforeDispatch: () => { throw new Error("disk full"); } }),
    (error: unknown) => error instanceof DesktopCreationNativeError && error.dispatchState === "not_sent");
  assert.equal(f.requests.some(r => r.method === "thread/start"), false);
  f.state.intercept = method => method === "thread/read" ? { thread: { id: PROJECT, cwd: f.cwd, projectId: null, ephemeral: false } } : undefined;
  await assert.rejects(client.create({ cwd: f.cwd }), (error: unknown) =>
    error instanceof DesktopCreationNativeError && error.dispatchState === "created" && error.threadId === THREAD);
});

test("refuses mismatched application/backend/home identities and nonadvancing project pagination", async t => {
  const f = fixture(t);
  await assert.rejects(createDesktopCreationNative({ ...f.options, compatibility: { version: "other", build: "20156" } }), /verified application/u);
  assert.equal(f.requests.length, 0);
  f.state.intercept = method => method === "initialize" ? { userAgent: "other/0.162.1 (Mac OS)", codexHome: f.cwd } : undefined;
  await assert.rejects(createDesktopCreationNative(f.options), /identity or Codex home/u);
  assert.equal(f.state.closed, true);
  f.state.intercept = undefined;
  const client = await createDesktopCreationNative(f.options);
  f.state.intercept = method => method === "project/list" ? { data: [], nextCursor: "stuck" } : undefined;
  await assert.rejects(client.projects(), /did not advance/u);
});
