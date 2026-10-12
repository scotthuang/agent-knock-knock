import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createDesktopCreationRpc, DesktopCreationRpcError, type DesktopCreationRpcOptions } from "../src/desktop-creation-rpc.js";

function fixture(timeoutMs = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill(signal: string): boolean { child.signalCode = signal; child.emit("exit", null, signal); return true; }
  });
  const sent: Record<string, any>[] = [];
  const spawned: unknown[][] = [];
  child.stdin.on("data", data => { for (const line of data.toString().trim().split("\n")) sent.push(JSON.parse(line)); });
  child.stdin.on("finish", () => { child.exitCode = 0; child.emit("exit", 0, null); });
  const spawnProcess = ((...args: unknown[]) => { spawned.push(args); return child; }) as unknown as DesktopCreationRpcOptions["spawnProcess"];
  const rpc = createDesktopCreationRpc({ binaryPath: "/bundle/codex", codexHome: "/configured-home", timeoutMs,
    environment: { CODEX_HOME: "/wrong-home", ALL_PROXY: "socks5://fixture" }, spawnProcess });
  const respond = (id: number, result: unknown) => child.stdout.write(`${JSON.stringify({ id, result })}\n`);
  return { rpc, child, sent, spawned, respond };
}

test("creation transport pins its bundled process/home, respects durable barrier, and closes only its own child", async () => {
  const f = fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const request = f.rpc.request("thread/start", { cwd: "/fixture" }, { beforeDispatch: () => barrier });
  assert.equal(f.sent.length, 0);
  release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.sent.length, 1);
  f.respond(f.sent[0].id, { thread: { id: "fixture" } });
  assert.deepEqual(await request, { thread: { id: "fixture" } });
  const [binary, args, options] = f.spawned[0] as [string, string[], Record<string, any>];
  assert.equal(binary, "/bundle/codex"); assert.deepEqual(args.slice(-3), ["app-server", "--listen", "stdio://"]);
  assert.equal(options.env.CODEX_HOME, "/configured-home"); assert.equal(options.env.ALL_PROXY, "socks5://fixture");
  await assert.rejects(f.rpc.request("turn/start", {}), /not permitted/u);
  await f.rpc.close(); await f.rpc.close();
  assert.equal(f.child.exitCode, 0); assert.equal(f.child.signalCode, null);
  await assert.rejects(f.rpc.request("thread/start", {}), (error: unknown) =>
    error instanceof DesktopCreationRpcError && error.requestDispatched === false);
});

test("failed barrier, closed-before-write and timed-out-after-write carry different dispatch evidence", async () => {
  const f = fixture(15);
  await assert.rejects(f.rpc.request("thread/start", {}, { beforeDispatch: () => { throw new Error("disk failed"); } }),
    (error: unknown) => error instanceof DesktopCreationRpcError && error.code === "dispatch_barrier_failed" && !error.requestDispatched);
  assert.equal(f.sent.length, 0);
  await assert.rejects(f.rpc.request("thread/start", {}), (error: unknown) =>
    error instanceof DesktopCreationRpcError && error.code === "timeout" && error.requestDispatched && error.method === "thread/start");
  assert.equal(f.sent.length, 1);
  f.respond(f.sent[0].id, { late: true });
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.rpc.request("thread/read", {}, { beforeDispatch: () => f.rpc.close() }),
    (error: unknown) => error instanceof DesktopCreationRpcError && !error.requestDispatched);
});

test("creation transport fails closed on malformed output and unexpected server approval, without answering", async () => {
  for (const output of ["not JSON\n", `${JSON.stringify({ id: "approve", method: "item/commandExecution/requestApproval" })}\n`]) {
    const f = fixture();
    const request = f.rpc.request("thread/start", {});
    await Promise.resolve(); await Promise.resolve();
    f.child.stdout.write(output);
    await assert.rejects(request, (error: unknown) => error instanceof DesktopCreationRpcError && error.requestDispatched);
    assert.equal(f.sent.length, 1);
    await f.rpc.close();
  }
});


test("creation close cannot mistake its cleanup deadline for a confirmed child exit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.child.stdin.removeAllListeners("finish");
  const signals: string[] = [];
  f.child.kill = signal => { signals.push(signal); return false; };
  const closing = f.rpc.close();
  const rejected = assert.rejects(closing, (error: unknown) => error instanceof DesktopCreationRpcError
    && error.code === "process_exit_unconfirmed");
  t.mock.timers.tick(1000); assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(2000); assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(f.child.exitCode, null); assert.equal(f.child.signalCode, null);
  t.mock.timers.tick(1000); await rejected;
  await assert.rejects(f.rpc.close(), /exit could not be confirmed/u);
  await assert.rejects(f.rpc.request("thread/start", {}), (error: unknown) => error instanceof DesktopCreationRpcError
    && error.code === "closed" && !error.requestDispatched);
  assert.equal(f.sent.length, 0);
});

test("creation close waits for observed exit and needs no kill after graceful termination", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.child.stdin.removeAllListeners("finish");
  const signals: string[] = [];
  const kill = f.child.kill;
  f.child.kill = signal => { signals.push(signal); return kill(signal); };
  const closing = f.rpc.close();
  t.mock.timers.tick(1000); await closing;
  t.mock.timers.tick(3000);
  assert.deepEqual(signals, ["SIGTERM"]); assert.equal(f.child.signalCode, "SIGTERM");
});
