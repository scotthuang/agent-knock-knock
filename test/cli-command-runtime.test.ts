import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expandHome,
  resolveExecutable,
  writeCliJson
} from "../src/cli-command-runtime.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";

test("CLI JSON output preserves bytes while recursively removing private fields", async () => {
  const result = await runCliCommandExecution(
    "json-proof",
    {},
    { runtimeLog: () => undefined },
    async () => writeCliJson({
      keep: "first",
      gateway_token: "drop-snake",
      nested: [{
        gatewayToken: "drop-camel",
        callback_command: "agent --gateway-token secret --state /tmp/state",
        claude_home: "/private/claude",
        claudeHome: "/private/claude-camel",
        claude_transcript_anchor: { secret: true },
        claudeTranscriptAnchor: { secret: true }
      }, {
        callbackCommand: "agent --token=secret",
        safe: "last",
        codex_rollout_acceptance_anchor: { secret: true },
        codexRolloutAcceptanceAnchor: { secret: true }
      }]
    })
  );

  assert.equal(result.stdout, `{
  "keep": "first",
  "nested": [
    {
      "callback_command": "agent --gateway-token [REDACTED] --state /tmp/state"
    },
    {
      "callbackCommand": "agent --token=[REDACTED]",
      "safe": "last"
    }
  ]
}
`);
});

test("PATH and HOME helpers read the active async-local CLI environment", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cli-command-runtime-"));
  const firstBin = path.join(tempDir, "first-bin");
  const secondBin = path.join(tempDir, "second-bin");
  const executable = "akk-runtime-probe";

  try {
    for (const binDir of [firstBin, secondBin]) {
      fs.mkdirSync(binDir, { recursive: true });
      const executablePath = path.join(binDir, executable);
      fs.writeFileSync(executablePath, "#!/bin/sh\nexit 0\n", "utf8");
      fs.chmodSync(executablePath, 0o755);
    }

    const run = (name: string, binDir: string) => runCliCommandExecution(
      name,
      {},
      {
        env: { PATH: binDir, HOME: path.join(tempDir, `${name}-home`) },
        runtimeLog: () => undefined
      },
      async () => {
        await Promise.resolve();
        writeCliJson({
          executable: resolveExecutable(executable),
          home_path: expandHome("~/skills")
        });
      }
    );
    const [first, second] = await Promise.all([
      run("first", firstBin),
      run("second", secondBin)
    ]);

    assert.deepEqual(JSON.parse(first.stdout), {
      executable: path.join(firstBin, executable),
      home_path: path.join(tempDir, "first-home", "skills")
    });
    assert.deepEqual(JSON.parse(second.stdout), {
      executable: path.join(secondBin, executable),
      home_path: path.join(tempDir, "second-home", "skills")
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
