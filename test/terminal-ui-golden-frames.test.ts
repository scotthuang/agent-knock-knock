import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyTerminalModelControlSurface,
  observeTerminalModelControl,
  planTerminalModelControl,
  probeTerminalModelControl
} from "../src/terminal-model-control.js";
import { TERMINAL_UI_GOLDENS } from
  "./support/terminal-ui-golden-frames.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const codexPlan = planTerminalModelControl(
  probeTerminalModelControl("codex", "0.154.0")
);
const claudePlan = planTerminalModelControl(
  probeTerminalModelControl("claude", "2.1.266")
);

test("terminal UI goldens remain typed, redacted, and parser-independent", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "test", "support", "terminal-ui-golden-frames.ts"),
    "utf8"
  );
  assert.equal(source.includes("../src/"), false);
  assert.equal(source.includes("/Users/"), false);
  assert.equal(source.includes("/home/"), false);
  assert.deepEqual(
    [...new Set(Object.values(TERMINAL_UI_GOLDENS).map((frame) => frame.agent))]
      .sort(),
    ["claude", "codex"]
  );
  assert.ok(Object.values(TERMINAL_UI_GOLDENS).some((frame) => frame.ansi));
  assert.ok(Object.values(TERMINAL_UI_GOLDENS).some((frame) =>
    frame.viewport === "narrow"
  ));
  assert.ok(Object.values(TERMINAL_UI_GOLDENS).some((frame) =>
    frame.complete === false
  ));
  assert.deepEqual(
    Object.fromEntries(Object.entries(TERMINAL_UI_GOLDENS).map(
      ([name, frame]) => [
        name,
        createHash("sha256").update(frame.screen).digest("hex")
      ]
    )),
    {
      codexWidePicker:
        "cbce04388d2aa9d33a019de9d667bd59e44afc74faf7bc6b1dc107b21141551b",
      codexAnsiPicker:
        "8357aa853c0f2649d464955edb73b7759b03a00e3862aedb5768ddec4db603b0",
      codexNarrowMoreReasoning:
        "4e94e80bab8511e45334cd8f43f23a24ea01308a687a1202ed4de4566ba962a0",
      codexPopup:
        "d766f18e92e8b446330cd35862e504d41d62720bf8953c54d8f71bf7cbccebc2",
      codexPartialPicker:
        "c3c4b856457b5d608c09f0d8d0867231371993ffd7993834424efcb3ba9b262b",
      codexTruncatedReasoning:
        "cd35ca85006e946044741668028b6250e165f02d0a8cb6ebee1d8299afb78572",
      claudeWidePicker:
        "96e35c31e8d6c0050802e4779a0dc7a75e1ad4e2b3c539f4390f34364e61b0c4",
      claudeAnsiPicker:
        "4c21759fb058e6daa4d5d9a35b2f7239059ccb42eb646335234918d9f7d810f7",
      claudeNarrowAnsiPicker:
        "ddf1d9f0f95ab4d388407acf16f169e89ca4d6f9ec4bf015866a1a338c53d028"
    }
  );
});

test("Codex 0.154 wide and ANSI model-picker goldens preserve exact rows", () => {
  for (const fixture of [
    TERMINAL_UI_GOLDENS.codexWidePicker,
    TERMINAL_UI_GOLDENS.codexAnsiPicker
  ]) {
    const observed = observeTerminalModelControl(codexPlan, fixture.screen);
    assert.equal(observed.state, "codex_model_picker", fixture.screen);
    if (observed.state !== "codex_model_picker") continue;
    assert.equal(observed.currentModel, "gpt-5.6-sol");
    assert.equal(observed.selectedIndex, 1);
    assert.deepEqual(observed.rows.map((row) => row.id), [
      "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"
    ]);
  }
});

test("Codex narrow soft-wrap keeps More reasoning while partial frames fail closed", () => {
  const narrow = observeTerminalModelControl(
    codexPlan,
    TERMINAL_UI_GOLDENS.codexNarrowMoreReasoning.screen
  );
  assert.equal(narrow.state, "codex_reasoning_picker");
  if (narrow.state === "codex_reasoning_picker") {
    assert.equal(narrow.rows.at(-1)?.kind, "advanced");
    assert.equal(narrow.selectedIndex, 5);
    assert.equal(narrow.currentEffort, undefined);
  }

  for (const fixture of [
    TERMINAL_UI_GOLDENS.codexPartialPicker,
    TERMINAL_UI_GOLDENS.codexTruncatedReasoning
  ]) {
    const observed = observeTerminalModelControl(codexPlan, fixture.screen);
    assert.equal(observed.state, "ambiguous", fixture.screen);
  }
});

test("the profiled Codex command popup is reversible authority, not a picker", () => {
  const classified = classifyTerminalModelControlSurface(codexPlan, {
    terminalControl: "control",
    screen: TERMINAL_UI_GOLDENS.codexPopup.screen,
    activityState: "idle",
    approvalBlocked: false,
    exactEmptyComposer: false,
    exactCommandReady: true,
    exactCommandComposer: true,
    exactBareCommand: false,
    exactCommandFingerprint: "fixture-popup"
  });
  assert.deepEqual(classified, {
    state: "command_popup",
    fingerprint: "fixture-popup"
  });
});

test("Claude 2.1.266 wide and ANSI goldens retain semantic families", () => {
  for (const fixture of [
    TERMINAL_UI_GOLDENS.claudeWidePicker,
    TERMINAL_UI_GOLDENS.claudeAnsiPicker
  ]) {
    const observed = observeTerminalModelControl(claudePlan, fixture.screen);
    assert.equal(observed.state, "claude_model_picker", fixture.screen);
    if (observed.state !== "claude_model_picker") continue;
    assert.equal(observed.currentModel, "opus");
    assert.equal(observed.currentEffort, "high");
    assert.deepEqual(observed.rows.map((row) => row.id), [
      "opus", "sonnet", "haiku"
    ]);
  }

  assert.equal(
    observeTerminalModelControl(
      claudePlan,
      TERMINAL_UI_GOLDENS.claudeNarrowAnsiPicker.screen
    ).state,
    "ambiguous",
    "a soft-wrapped Claude row remains fail-closed until its layout is profiled"
  );
});
