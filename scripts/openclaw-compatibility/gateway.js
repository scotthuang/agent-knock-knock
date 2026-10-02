import assert from "node:assert/strict";
import {
  spawn
} from "node:child_process";
import net from "node:net";
import {
  run,
  parseJsonOutput,
  appendBounded,
  stripAnsi
} from "./command-runtime.js";

export function gatewayCall({
  env,
  host,
  method,
  params,
  port,
  token,
  workspace
}) {
  const result = run(host.openclawBin, [
    "gateway",
    "call",
    method,
    "--url",
    `ws://127.0.0.1:${port}`,
    "--token",
    token,
    "--params",
    JSON.stringify(params),
    "--timeout",
    "20000",
    "--json"
  ], {
    cwd: workspace,
    env,
    timeoutMs: 30_000
  });
  return parseJsonOutput(result.stdout, `gateway call ${method}`);
}

export function startGateway({ env, host, port, token, workspace }) {
  const child = spawn(host.openclawBin, [
    "gateway",
    "run",
    "--allow-unconfigured",
    "--auth",
    "token",
    "--token",
    token,
    "--bind",
    "loopback",
    "--port",
    String(port),
    "--ws-log",
    "compact"
  ], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectReady(
        new Error(`OpenClaw Gateway did not become ready:\n${output}`)
      );
    }
  }, 60_000);
  timeout.unref();

  const capture = (chunk) => {
    output = appendBounded(output, String(chunk), 80_000);
    if (!settled && /\[gateway\] ready/u.test(stripAnsi(output))) {
      settled = true;
      clearTimeout(timeout);
      resolveReady();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(error);
    }
  });
  child.once("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `OpenClaw Gateway exited before ready (${code ?? signal}):\n${output}`
        )
      );
    }
  });
  return {
    child,
    get output() {
      return output;
    },
    ready
  };
}

export async function stopGateway(gateway) {
  const child = gateway.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const stopped = await waitForExit(child, 10_000);
  if (!stopped) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

export function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function waitForGatewayOutput(gateway, pattern) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pattern.test(stripAnsi(gateway.output))) {
      return;
    }
    await delay(250);
  }
  assert.match(
    stripAnsi(gateway.output),
    pattern,
    "the registered AKK service must start inside the candidate Gateway"
  );
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address
        ? address.port
        : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port) {
          resolve(port);
        } else {
          reject(new Error("Unable to reserve a Gateway port"));
        }
      });
    });
  });
}
