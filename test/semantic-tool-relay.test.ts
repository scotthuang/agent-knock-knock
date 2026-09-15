import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindSemanticToolAsyncRelay,
  bindSemanticToolRelayEnvironment,
  bindSemanticToolRelayPath,
  runCli,
  runHostAwareCli,
  withHostBridgeInvocationSignal
} from "../src/semantic-tool-relay.js";

test("semantic relay keeps executable and environment authority owner-local", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-semantic-relay-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstCli = path.join(tempDir, "first.cjs");
  const secondCli = path.join(tempDir, "second.cjs");
  writeFixtureCli(firstCli, "first");
  writeFixtureCli(secondCli, "second");

  const firstOwner = {};
  const secondOwner = {};
  bindSemanticToolRelayPath(firstOwner, firstCli);
  bindSemanticToolRelayEnvironment(firstOwner, relayEnvironment("alpha"));
  bindSemanticToolRelayPath(secondOwner, secondCli);
  bindSemanticToolRelayEnvironment(secondOwner, relayEnvironment("beta"));
  bindSemanticToolAsyncRelay(secondOwner);

  assert.deepEqual(runCli(firstOwner, ["probe"]), {
    script: "first",
    marker: "alpha",
    args: ["probe"]
  });
  assert.deepEqual(await runHostAwareCli(secondOwner, ["probe"]), {
    script: "second",
    marker: "beta",
    args: ["probe"]
  });
});

test("semantic relay preserves invocation-scoped AbortSignal semantics", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-semantic-abort-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const slowCli = path.join(tempDir, "slow.cjs");
  fs.writeFileSync(
    slowCli,
    'setTimeout(() => process.stdout.write("{}"), 10_000);\n',
    "utf8"
  );
  const owner = {};
  bindSemanticToolRelayPath(owner, slowCli);
  bindSemanticToolRelayEnvironment(owner, relayEnvironment("abort"));
  bindSemanticToolAsyncRelay(owner);
  const controller = new AbortController();

  const pending = withHostBridgeInvocationSignal(controller.signal, () =>
    runHostAwareCli(owner, ["probe"])
  );
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof Error && error.name === "AbortError" &&
      error.message === "agent-knock-knock Host invocation was aborted"
  );
});

function writeFixtureCli(filePath: string, script: string): void {
  fs.writeFileSync(
    filePath,
    `process.stdout.write(JSON.stringify({script:${JSON.stringify(script)},marker:process.env.AKK_RELAY_TEST_MARKER,args:process.argv.slice(2)}));\n`,
    "utf8"
  );
}

function relayEnvironment(marker: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AKK_RELAY_TEST_MARKER: marker
  };
}
