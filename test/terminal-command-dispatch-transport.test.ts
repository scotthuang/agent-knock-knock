import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  runTerminalControlSend,
  type TerminalDispatchTransportDependencies
} from "../src/terminal-command-dispatch-transport.js";
import type { TerminalControlSendRequest } from
  "../src/terminal-dispatch-composition.js";

function moduleSource(): string {
  return fs.readFileSync(
    new URL("../src/terminal-command-dispatch-transport.js", import.meta.url),
    "utf8"
  );
}

function functionSource(name: string, nextName?: string): string {
  const source = moduleSource();
  const start = source.indexOf(`function ${name}`);
  const end = nextName
    ? source.indexOf(`function ${nextName}`, start + 1)
    : source.length;
  assert.notEqual(start, -1, `${name} must remain in dispatch transport`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered transport token: ${token}`);
    cursor = found + token.length;
  }
}

test("dispatch transport owns one explicit CLI port view", () => {
  const source = fs.readFileSync(
    new URL("../../src/terminal-command-dispatch-transport.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    source,
    /export type TerminalDispatchTransportCliPorts = TerminalCommandPortView</u
  );
  assert.doesNotMatch(
    source,
    /from "\.\/terminal-command-cli-adapter\.js"/u
  );
  assert.match(source, /new AsyncLocalStorage<TerminalDispatchTransportDependencies>/u);
});

test("dispatch transport preserves preparation replay as a zero-I/O short circuit", async () => {
  let prepared = 0;
  const dependencies = {
    ports: {},
    prepare: async () => {
      prepared += 1;
      return undefined;
    },
    preparationPorts: {},
    defaults: {
      agentTimeoutMinutes: 60,
      agentHardTimeoutMinutes: 720,
      ordinaryScrollbackLines: 120,
      foregroundScrollbackLines: 240,
      acceptanceTimeoutMs: 5000,
      acceptancePollIntervalMs: 50
    },
    foregroundProofs: {},
    runtime: {}
  } as unknown as TerminalDispatchTransportDependencies;
  const result = await runTerminalControlSend(
    {} as TerminalControlSendRequest,
    dependencies
  );
  assert.deepEqual(result, { outcome: "replayed" });
  assert.equal(prepared, 1);
});

test("dispatch transport preserves durable-before-input and uncertain boundaries", () => {
  const runtime = functionSource(
    "createTerminalDispatchRuntime",
    "terminalDispatchTransportLifecycle"
  );
  assertOrdered(runtime, [
    "bindTerminalDispatchCapabilities",
    "new dispatchApplication.TerminalDispatchApplication",
    "application.persistPrepared()"
  ]);

  const transport = functionSource(
    "runTerminalDispatchTransport",
    "runTerminalControlSendWithinContext"
  );
  assertOrdered(transport, [
    "terminalDispatchTransportLifecycle",
    "terminalBridge.send",
    "enter_dispatched receipt",
    "resolveTerminalDispatchSubmissionOwner",
    "terminalDispatchAcceptance",
    "application.applyAcceptance",
    "launchAcceptedTerminalMonitor"
  ]);
  assertOrdered(transport, [
    "catch (error)",
    "presentTerminalDispatchTransportFailure",
    "terminalInput",
    "failure: error"
  ]);

  const failure = functionSource(
    "presentTerminalDispatchTransportFailure",
    "runTerminalDispatchTransport"
  );
  assertOrdered(failure, [
    "!progress.textInjectedAt",
    "error instanceof TerminalInputNotStartedError",
    "application.recordZeroInputAbort",
    "return \"zero_input\"",
    "application.applyUncertain",
    "do_not_retry: true",
    "presentTerminalUncertain",
    "return \"input_started\""
  ]);
});

test("command facade delegates the semantic transaction without reordering it", () => {
  const source = fs.readFileSync(
    new URL("../src/terminal-command-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("async function runTerminalControlSend(");
  const end = source.indexOf("export function createTerminalCommandCliFacade", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const facade = source.slice(start, end);
  assert.match(facade, /executeTerminalControlSend/u);
  assert.match(facade, /terminalDispatchTransportDependencies/u);
  assert.doesNotMatch(facade, /terminalBridge\.send|applyUncertain|pollAcceptance/u);
});
