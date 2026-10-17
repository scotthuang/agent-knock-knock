import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHostAdapter } from "@scotthuang/agent-knock-knock/host-adapter";

import { resolveConnectorPluginConfig } from "../src/profile.js";

test("HostAdapter sends both tool calls and lifecycle sweeps to the same DSH Store", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-store-test-"));
  const relay = path.join(temporary, "capture.mjs");
  const log = path.join(temporary, "calls.jsonl");
  fs.writeFileSync(relay, [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
    'process.stdout.write(JSON.stringify({ conversations: [], terminal_controls: [], checked: 0, errors: 0 }));',
  ].join("\n"));
  const config = resolveConnectorPluginConfig({}, temporary);
  const adapter = createHostAdapter({
    relayPath: relay,
    pluginConfig: config,
    environmentForContext: () => ({}),
    lifecycleEnvironment: {},
    lifecycleIntervalMs: 60_000,
    logger: { info() {}, warn() {} },
  });
  try {
    adapter.lifecycle.start();
    await adapter.executeTool({
      authority: {}, sessionKey: "store-test-controller", sessionId: "store-test-controller",
    }, "agent_knock_knock_list", "store-test-list", {});
    await adapter.lifecycle.stop();
    const calls: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.ok(calls.some(args => args[0] === "list"));
    for (const command of ["reconcile-monitors", "reconcile-watches", "reconcile-desktop-watches", "reconcile-codex-native-watches", "reconcile-claude-native-watches"]) {
      assert.ok(calls.some(args => args[0] === command), command);
    }
    for (const args of calls) {
      assert.equal(args[args.indexOf("--store-dir") + 1], config.storeDir, args[0]);
    }
  } finally {
    await adapter.lifecycle.stop();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
