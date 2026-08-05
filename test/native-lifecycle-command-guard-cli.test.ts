import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

for (const scenario of [
  {
    name: "raw terminal ordinary send",
    args: [
      "send",
      "--conversation",
      "terminal:v2:tmux:codex:guard:0.0:1234",
      "--message",
      "/clear",
      "--background"
    ],
    command: "/clear"
  },
  {
    name: "managed Session ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "\n  /resume 11111111-1111-4111-8111-111111111111"
    ],
    command: "/resume"
  },
  {
    name: "in-flight Turn response",
    args: [
      "respond",
      "--turn",
      "turn-does-not-exist",
      "--message",
      "/status"
    ],
    command: "/status"
  },
  {
    name: "new-session alias ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/new"
    ],
    command: "/new"
  },
  {
    name: "native fork ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/fork"
    ],
    command: "/fork"
  },
  {
    name: "inline side-thread ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/side inspect this in a child thread"
    ],
    command: "/side"
  },
  {
    name: "inline btw-thread response",
    args: [
      "respond",
      "--turn",
      "turn-does-not-exist",
      "--message",
      "/btw inspect this in a child thread"
    ],
    command: "/btw"
  },
  {
    name: "Claude conversation branch ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/branch review-path"
    ],
    command: "/branch"
  },
  {
    name: "Claude reset alias ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/reset clean-context"
    ],
    command: "/reset"
  },
  {
    name: "Claude continue alias response",
    args: [
      "respond",
      "--turn",
      "turn-does-not-exist",
      "--message",
      "/continue 11111111-1111-4111-8111-111111111111"
    ],
    command: "/continue"
  },
  {
    name: "future native slash command ordinary send",
    args: [
      "send",
      "--session",
      "session-does-not-exist",
      "--message",
      "/future-native-command argument"
    ],
    command: "/future-native-command"
  }
] as const) {
  test(`${scenario.name} cannot bypass the native lifecycle ledger`, () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "akk-native-command-guard-")
    );
    const storeDir = path.join(root, "store");
    try {
      const result = spawnSync(process.execPath, [
        binPath,
        ...scenario.args,
        "--store-dir",
        storeDir
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          AKK_RUNTIME_DIR: path.join(root, "runtime")
        }
      });
      assert.equal(result.status, 1, result.stdout);
      assert.match(
        result.stderr,
        new RegExp(
          `ordinary send/respond cannot invoke native slash command \\${scenario.command}`,
          "u"
        )
      );
      assert.equal(
        fs.existsSync(storeDir),
        false,
        "the guard must run before Session or Turn state is created"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
