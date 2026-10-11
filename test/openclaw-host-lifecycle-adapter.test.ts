import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bindOpenClawRelayPath
} from "../src/openclaw-plugin-command-adapter.js";
import {
  createMonitorReconciliationService
} from "../src/openclaw-plugin-supervisor.js";

const waitForCalls = async (
  callsPath: string,
  minimum: number
): Promise<string[][]> => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(callsPath)) {
      const calls = fs.readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]);
      if (calls.length >= minimum) {
        return calls;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${minimum} lifecycle calls`);
};

const optionAfter = (
  args: readonly string[],
  name: string
): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

test("OpenClaw adapts Host lifecycle phases without changing its contract", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-host-lifecycle-"));
  const fakeCli = path.join(tempDir, "lifecycle.cjs");
  const callsPath = path.join(tempDir, "calls.ndjson");
  const info: string[] = [];
  const warnings: string[] = [];
  const firstStoreDir = path.join(tempDir, "store-a");
  const secondStoreDir = path.join(tempDir, "store-b");
  const firstOpenClawBin = path.join(tempDir, "openclaw-a");
  const secondOpenClawBin = path.join(tempDir, "openclaw-b");
  const codexHome = path.join(tempDir, "codex-home");
  const api = {
    pluginConfig: { storeDir: firstStoreDir, openclawBin: firstOpenClawBin, codexHome },
    logger: {
      info(message: string) {
        info.push(message);
      },
      warn(message: string) {
        warnings.push(message);
      }
    }
  };
  let service: ReturnType<typeof createMonitorReconciliationService> | undefined;

  try {
    fs.writeFileSync(
      fakeCli,
      [
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
        "const result = args[0] === \"reconcile-monitors\"",
        "  ? { checked: 1, launched: 1, already_running: 0, skipped: 0, errors: 0 }",
        "  : { checked: 1, changed: 1, callbacks_delivered: 0, errors: 0 };",
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n"),
      "utf8"
    );
    bindOpenClawRelayPath(api, fakeCli);
    service = createMonitorReconciliationService(api, 50);

    assert.equal(service.id, "agent-knock-knock-monitor-reconciliation");
    service.start();
    await waitForCalls(callsPath, 5);
    api.pluginConfig = { storeDir: secondStoreDir, openclawBin: secondOpenClawBin, codexHome };
    const calls = await waitForCalls(callsPath, 10);
    await service.stop();

    assert.deepEqual(calls.slice(0, 10).map((args) => args[0]), [
      "reconcile-monitors",
      "reconcile-watches",
      "reconcile-desktop-watches",
      "reconcile-codex-native-watches", "reconcile-claude-native-watches",
      "reconcile-monitors",
      "reconcile-watches",
      "reconcile-desktop-watches",
      "reconcile-codex-native-watches", "reconcile-claude-native-watches"
    ]);
    assert.equal(optionAfter(calls[0], "--reason"), "startup_reconciliation");
    assert.equal(optionAfter(calls[5], "--reason"), "monitor_supervision");
    assert.equal(calls[0].includes("--terminal-monitors-only"), false);
    assert.equal(calls[5].includes("--terminal-monitors-only"), true);
    assert.equal(optionAfter(calls[0], "--store-dir"), firstStoreDir);
    assert.equal(optionAfter(calls[1], "--store-dir"), firstStoreDir);
    assert.equal(optionAfter(calls[2], "--store-dir"), firstStoreDir);
    assert.equal(optionAfter(calls[5], "--store-dir"), secondStoreDir);
    assert.equal(optionAfter(calls[6], "--store-dir"), secondStoreDir);
    assert.equal(optionAfter(calls[7], "--store-dir"), secondStoreDir);
    assert.equal(optionAfter(calls[2], "--openclaw-bin"), firstOpenClawBin);
    assert.equal(optionAfter(calls[7], "--openclaw-bin"), secondOpenClawBin);
    assert.equal(optionAfter(calls[2], "--codex-home"), codexHome);
    assert.equal(optionAfter(calls[7], "--codex-home"), codexHome);
    assert.equal(optionAfter(calls[3], "--openclaw-bin"), firstOpenClawBin);
    assert.equal(optionAfter(calls[8], "--openclaw-bin"), secondOpenClawBin);
    assert.equal(optionAfter(calls[8], "--codex-home"), codexHome);
    assert.equal(warnings.length, 0);
    assert.equal(
      info.some((message) => message.includes("monitor reconciliation")),
      true
    );
    assert.equal(
      info.some((message) =>
        message.includes("Terminal Watch watch_supervision")
      ),
      true
    );
    assert.equal(
      info.some((message) => message.includes("Desktop Watch watch_supervision")),
      true
    );

    const countAfterStop = (await waitForCalls(callsPath, 10)).length;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal((await waitForCalls(callsPath, 10)).length, countAfterStop);
  } finally {
    await service?.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Desktop recovery has an independent error boundary and reports failures", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-lifecycle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeCli = path.join(directory, "lifecycle.cjs");
  const callsPath = path.join(directory, "calls.ndjson");
  const warnings: string[] = [];
  const api = { pluginConfig: {}, logger: { info() {}, warn: (message: string) => warnings.push(message) } };
  fs.writeFileSync(fakeCli, [
    'const fs = require("node:fs");',
    "const args = process.argv.slice(2);",
    `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");`,
    'if (args[0] !== "reconcile-watches") { process.stderr.write(args[0] + " fixture failure"); process.exit(9); }',
    'process.stdout.write(JSON.stringify({ checked: 0, changed: 0, errors: 0 }));'
  ].join("\n"));
  bindOpenClawRelayPath(api, fakeCli);
  const service = createMonitorReconciliationService(api, 50);
  t.after(() => service.stop());
  service.start();
  await waitForCalls(callsPath, 10);
  await service.stop();
  const calls = await waitForCalls(callsPath, 10);
  assert.deepEqual(calls.slice(0, 10).map(args => args[0]), [
    "reconcile-monitors", "reconcile-watches", "reconcile-desktop-watches", "reconcile-codex-native-watches", "reconcile-claude-native-watches",
    "reconcile-monitors", "reconcile-watches", "reconcile-desktop-watches", "reconcile-codex-native-watches", "reconcile-claude-native-watches"
  ]);
  assert.ok(warnings.some(message => message.includes("monitor reconciliation skipped after startup error")));
  assert.ok(warnings.some(message => message.includes("Desktop Watch reconciliation skipped after startup error")
    && message.includes("reconcile-desktop-watches fixture failure")));
  assert.ok(warnings.some(message => message.includes("Desktop Watch supervision deferred after error")));
  assert.ok(warnings.some(message => message.includes("Codex CLI Watch reconciliation skipped after startup error")));
  assert.ok(warnings.some(message => message.includes("Codex CLI Watch supervision deferred after error")));
  assert.ok(warnings.some(message => message.includes("Claude CLI Watch reconciliation skipped after startup error")));
  assert.ok(warnings.some(message => message.includes("Claude CLI Watch supervision deferred after error")));
  assert.ok(!warnings.some(message => message.includes("Terminal Watch")));
});
