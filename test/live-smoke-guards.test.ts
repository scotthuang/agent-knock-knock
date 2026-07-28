import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(
  path.dirname(new URL("../src/cli.js", import.meta.url).pathname),
  "../.."
);

test("live tmux smoke refuses to run without both opt-ins", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "scripts", "smoke-tmux.js"), "--confirm-live"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_RUN_LIVE_TMUX_SMOKE: ""
      }
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to/u);
});

test("tmux smoke requires verified idle state and exact pane identity before send", () => {
  const source = fs.readFileSync(
    path.join(packageRoot, "scripts", "smoke-tmux.js"),
    "utf8"
  );

  assert.match(source, /selected\.activity_state !== "idle"/u);
  assert.match(source, /expectedPanePid/u);
  assert.match(source, /terminal_control\?\.panePid/u);
  assert.match(source, /LIVE TMUX SMOKE: sending one real turn/u);
  assert.match(source, /"--background"/u);
});
