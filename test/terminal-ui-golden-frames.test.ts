import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectCodexScreen } from
  "../src/codex-terminal-agent-adapter.js";
import { codexComposerEmpty } from
  "../src/native-thread-lifecycle-recovery-adapter.js";
import { exactCodexReadyStyledComposerCapture } from
  "../src/terminal-native-inspection-bridge.js";
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
      codexAstraSparkleIdlePhaseA:
        "b3bac88c7413efd9bb2d1af651461cb736e7a228deb3e7878cf94bbc423ab359",
      codexAstraSparkleIdlePhaseB:
        "3bec8b4d0fba626508fc865e90e72b04a60f5e2c449e8bfa148fc6158151ad2c",
      codexAstraSparkleIdleAnsiPhaseA:
        "1e995e3ec004c8a7fb5e5d9ac29c0fa4f79d6958507d49e9383f751be1d3a3c9",
      codexAstraSparkleIdleAnsiPhaseB:
        "9370b5b4de56f463f966f025c74c70cd20efd1170ff358d79fdde2423a2b6c04",
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

test("Codex 0.154 Astra sparkle idle goldens remain diagnostic-only idle", () => {
  for (const fixture of [
    TERMINAL_UI_GOLDENS.codexAstraSparkleIdlePhaseA,
    TERMINAL_UI_GOLDENS.codexAstraSparkleIdlePhaseB
  ]) {
    const inspection = inspectCodexScreen({
      screen: fixture.screen,
      runtime: { agentVersion: fixture.version }
    });
    assert.equal(inspection.activity.state, "idle", fixture.screen);
    assert.equal(inspection.approval.blocked, false, fixture.screen);
    assert.equal(
      codexComposerEmpty(fixture.screen),
      false,
      "diagnostic sparkle idle must not become exact-empty authority"
    );
  }
  for (const fixture of [
    TERMINAL_UI_GOLDENS.codexAstraSparkleIdleAnsiPhaseA,
    TERMINAL_UI_GOLDENS.codexAstraSparkleIdleAnsiPhaseB
  ]) {
    assert.equal(
      exactCodexReadyStyledComposerCapture(fixture.screen),
      undefined,
      "animated diagnostic idle must not prove an exact empty Composer"
    );
  }
});

test("Codex Astra sparkle idle grammar rejects incomplete and input-owning frames", () => {
  const base = TERMINAL_UI_GOLDENS.codexAstraSparkleIdlePhaseB.screen;
  const lines = base.split("\n");
  const composerIndex = lines.findIndex((line) => line.startsWith("»"));
  const composer = lines[composerIndex];
  const footer = lines.at(-1) as string;
  const cases = new Map<string, string>([
    ["missing footer", base.split("\n").slice(0, -1).join("\n")],
    ["truncated footer", base.replace(
      /gpt-6-astra high .*$/u,
      "gpt-6-astra high ·"
    )],
    ["ellipsis-truncated footer", base.replace(/Main \[default\]$/u, "Mai…")],
    ["silently clipped footer", base.replace(
      /~\/workspace .*$/u,
      "~/workspace"
    )],
    ["ASCII-ellipsis footer", base.replace(/Main \[default\]$/u, "Mai...")],
    ["unknown decoration", base.replace("⠈            ⠁", "⠈ unsafe ⠁")],
    ["too many decoration rows", [
      composer,
      " ⠁ ",
      " ⠂ ",
      " ⠄ ",
      footer
    ].join("\n")],
    ["zero marker separator", [
      "»Ask Codex to do anything⠁",
      footer
    ].join("\n")],
    ["unsupported marker whitespace", [
      "»\u00a0Ask Codex to do anything⠁",
      footer
    ].join("\n")],
    ["soft-wrapped placeholder", [
      "» ⠁Ask Codex to do",
      "  anything⠂",
      footer
    ].join("\n")],
    ["content after complete footer", [base, "unexpected new surface"].join("\n")],
    ["unknown Braille glyph", [
      "» Ask Codex to do anything⣿",
      "  gpt-6-astra high · ~/workspace · Main [default]"
    ].join("\n")],
    ["real sparkling draft", [
      "» Review the production database ⠁",
      "  gpt-6-astra high · ~/workspace · Main [default]"
    ].join("\n")],
    ["non-Astra footer", base.replace("gpt-6-astra", "gpt-5.6-sol")],
    ["questionnaire", [
      "☐ Framework",
      "Which framework should be used?",
      "❯ 1. React",
      "  2. Vue",
      "  3. Type something.",
      "  4. None of the above",
      "Press enter to submit answer · tab to add notes"
    ].join("\n")],
    ["model picker", TERMINAL_UI_GOLDENS.codexWidePicker.screen]
  ]);
  for (const [name, screen] of cases) {
    assert.equal(
      inspectCodexScreen({
        screen,
        runtime: { agentVersion: "0.154.0" }
      }).activity.state,
      "unknown",
      name
    );
  }

  for (const agentVersion of [undefined, "0.153.4", "0.155.0"]) {
    assert.equal(
      inspectCodexScreen({
        screen: base,
        runtime: agentVersion === undefined ? undefined : { agentVersion }
      }).activity.state,
      "unknown",
      `sparkle grammar is not authorized for ${agentVersion ?? "a missing version"}`
    );
  }

  const approval = inspectCodexScreen({
    screen: [
      composer,
      "Would you like to run the following command?",
      "  $ npm test",
      "» 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "  Press enter to confirm or esc to cancel"
    ].join("\n"),
    runtime: { agentVersion: "0.154.0" }
  });
  assert.equal(approval.activity.state, "awaiting_approval");

  const working = inspectCodexScreen({
    screen: [
      composer,
      "• Working (12s • esc to interrupt)"
    ].join("\n"),
    runtime: { agentVersion: "0.154.0" }
  });
  assert.equal(working.activity.state, "working");
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
