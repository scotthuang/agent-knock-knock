import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = path.resolve(
  path.dirname(new URL("../src/cli.js", import.meta.url).pathname),
  "../.."
);

test("live ACPX and tmux smoke scripts refuse to run without two opt-ins", () => {
  for (const script of ["smoke-acpx.js", "smoke-tmux.js"]) {
    const result = spawnSync(
      process.execPath,
      [path.join(packageRoot, "scripts", script), "--confirm-live"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AKK_RUN_LIVE_ACPX_SMOKE: "",
          AKK_RUN_LIVE_TMUX_SMOKE: ""
        }
      }
    );
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /Refusing to/u, script);
  }
});

test("ACPX smoke uses a nonce and closes its disposable fake session", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-acpx-smoke-"));
  const fakeAcpx = path.join(tempDir, "acpx");
  const callsPath = path.join(tempDir, "calls.ndjson");

  try {
    fs.writeFileSync(
      fakeAcpx,
      `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args.includes("-s")) process.stdout.write(args.at(-1));
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);
    const result = spawnSync(
      process.execPath,
      [
        path.join(packageRoot, "scripts", "smoke-acpx.js"),
        "--confirm-live",
        "--agent",
        "claude",
        "--acpx-bin",
        fakeAcpx,
        "--workspace",
        fs.realpathSync(tempDir),
        "--timeout-seconds",
        "2"
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          AKK_RUN_LIVE_ACPX_SMOKE: "1"
        }
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.nonce_verified, true);
    const calls = fs.readFileSync(callsPath, "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(calls[0].slice(0, 3), ["claude", "sessions", "new"]);
    assert.equal(calls[1].includes("--deny-all"), true);
    assert.match(
      calls[1].at(-1) ?? "",
      /Reply with this nonce and nothing else: [0-9a-f-]{36}/u
    );
    assert.deepEqual(calls.at(-1)?.slice(0, 3), ["claude", "sessions", "close"]);
    assert.equal(calls.at(-1)?.at(-1), output.session);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
});
