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
import { currentCodexComposerCapture } from
  "../src/terminal-composer-classifier.js";
import { exactCodexReadyStyledComposerCapture,
  stripTerminalEscapeSequences } from
  "../src/terminal-native-inspection-bridge.js";
import { exactCodexAstraSparkleReadyStyledComposerCapture } from
  "../src/codex-astra-composer-proof.js";
import {
  classifyTerminalModelControlSurface,
  observeTerminalModelControl,
  planTerminalModelControl,
  probeTerminalModelControl,
  terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint,
  terminalModelControlSlashCompletionRows
} from "../src/terminal-model-control.js";
import { codex0154IdleFrame, TERMINAL_UI_GOLDENS } from
  "./support/terminal-ui-golden-frames.js";
import { CODEX_ASTRA_STYLED_COMPOSER_PHASES } from
  "./support/codex-astra-styled-composer.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const codexPlan = planTerminalModelControl(
  probeTerminalModelControl("codex", "0.154.0")
);
const codex01551Plan = planTerminalModelControl(
  probeTerminalModelControl("codex", "0.155.1")
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
      codex01551PlainPopup:
        "3ee105a34d099b65f52996e6449db462facfb5a7d0952b3f9a609257554669c8",
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

test("verified Codex Astra sparkle idle goldens remain diagnostic-only idle", () => {
  for (const agentVersion of ["0.154.0", "0.155.1"]) {
    for (const fixture of [
      TERMINAL_UI_GOLDENS.codexAstraSparkleIdlePhaseA,
      TERMINAL_UI_GOLDENS.codexAstraSparkleIdlePhaseB
    ]) {
      const inspection = inspectCodexScreen({
        screen: fixture.screen,
        runtime: { agentVersion }
      });
      assert.equal(inspection.activity.state, "idle", `${agentVersion}: ${fixture.screen}`);
      assert.equal(inspection.approval.blocked, false, fixture.screen);
      assert.equal(
        codexComposerEmpty(fixture.screen),
        false,
        "diagnostic sparkle idle must not become exact-empty authority"
      );
    }
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

  for (const agentVersion of [undefined, "0.153.4", "0.155.0", "0.155.2"]) {
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

test("captured Astra ANSI emptiness is versioned, styled, and stable across animation phases", () => {
  const digests = CODEX_ASTRA_STYLED_COMPOSER_PHASES.map((screen) => {
    const capture = exactCodexAstraSparkleReadyStyledComposerCapture(screen, "0.155.1");
    assert.ok(capture);
    assert.equal(inspectCodexScreen({
      screen: stripTerminalEscapeSequences(screen),
      runtime: { agentVersion: "0.155.1" }
    }).activity.state, "idle", "the complete task-title footer needs no Main suffix");
    assert.equal(exactCodexReadyStyledComposerCapture(screen), undefined,
      "native lifecycle/model/list callers do not acquire the new authority");
    assert.notEqual(currentCodexComposerCapture(screen, "new task")?.state, "exact_empty");
    assert.deepEqual(currentCodexComposerCapture(
      screen, "new task", false, false, undefined, false, "0.155.1"
    ), { state: "exact_empty", digest: capture.digest });
    return capture.digest;
  });
  assert.equal(digests[0], digests[1]);

  const markerSparkle = CODEX_ASTRA_STYLED_COMPOSER_PHASES[0].replace(
    "›\u001b[0m\u001b[48;2;57;57;57m ",
    "›\u001b[0m\u001b[38;2;112;112;112m\u001b[48;2;57;57;57m⠂"
  );
  assert.notEqual(markerSparkle, CODEX_ASTRA_STYLED_COMPOSER_PHASES[0]);
  assert.ok(exactCodexAstraSparkleReadyStyledComposerCapture(markerSparkle, "0.155.1"));
  assert.equal(inspectCodexScreen({
    screen: stripTerminalEscapeSequences(markerSparkle),
    runtime: { agentVersion: "0.155.1" }
  }).activity.state, "idle");
});

test("Astra styled proof rejects real Braille drafts, incomplete frames, and style ambiguity", () => {
  const base = CODEX_ASTRA_STYLED_COMPOSER_PHASES[0];
  const cases = new Map<string, string>([
    ["unstyled", stripTerminalEscapeSequences(base)],
    ["unpainted", base.replaceAll("\u001b[48;2;57;57;57m", "")],
    ["missing footer", base.split("\n").slice(0, -1).join("\n")],
    ["truncated footer", base.replace("调用原生异步提问", "调用原生…")],
    ["no task boundary", base.replace(/ · \u001b\[0m\u001b\[38;2;156;222;211m调用原生异步提问\u001b\[0m$/u, "")],
    ["unknown glyph", base.replace("⡀", "⣿")],
    ["real Braille draft", base.replace("Ask Codex to do anything", "⠁⠂⠄")],
    ["normal draft", base.replace("Ask Codex to do anything", "Review production ⠁")],
    ["literal placeholder draft", base.replace("\u001b[2m\u001b[48;2;57;57;57mAsk", "\u001b[48;2;57;57;57mAsk")],
    ["real draft after placeholder", base.replace("anything", "anything draft")],
    ["dim Braille continuation", base.replace("⡀", "\u001b[2m⡀")],
    ["non-Astra model", base.replace("gpt-6-astra", "gpt-5.6-sol")],
    ["new input surface", `${base}\n  enter submit   ctrl + ] skip`]
  ]);
  for (const [name, screen] of cases) {
    assert.notEqual(screen, base, name);
    assert.equal(exactCodexAstraSparkleReadyStyledComposerCapture(screen, "0.155.1"), undefined, name);
  }
  for (const version of [undefined, "0.155.0", "0.155.2"]) {
    assert.equal(exactCodexAstraSparkleReadyStyledComposerCapture(base, version), undefined);
  }
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

test("Codex 0.155.1 exact command popup does not require legacy full-row paint", () => {
  const capture = currentCodexComposerCapture(
    TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen,
    "/model",
    false,
    false,
    terminalModelControlSlashCompletionRows(codex01551Plan),
    terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(
      codex01551Plan
    )
  );
  assert.equal(capture?.state, "exact_draft");
  assert.equal(capture?.profiledSlashPopup, true);
  assert.equal(capture?.bareCommand, undefined);
  const classified = classifyTerminalModelControlSurface(codex01551Plan, {
    terminalControl: "control",
    screen: TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen,
    activityState: "idle",
    approvalBlocked: false,
    exactEmptyComposer: false,
    exactCommandReady: capture?.profiledSlashPopup === true,
    exactCommandComposer: capture?.state === "exact_draft",
    exactBareCommand: capture?.bareCommand === true,
    ...(capture ? { exactCommandFingerprint: capture.digest } : {})
  });
  assert.equal(classified.state, "command_popup");

  assert.equal(
    currentCodexComposerCapture(
      TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen,
      "/model",
      false,
      false,
      terminalModelControlSlashCompletionRows(codexPlan),
      terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(codexPlan)
    ),
    undefined,
    "the 0.155.1 transport shape must not widen the 0.154.0 profile"
  );

  const plainPopup = TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen
    .replace(/\u001b\[[0-9;]*m/gu, "");
  const misplacedAnsi = TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen
    .replace("\u001b[1m›\u001b[0m /model", "› \u001b[1m/model\u001b[0m")
    .replace(
      "  \u001b[1m\u001b[38;5;6m/model  choose what model and reasoning effort to use\u001b[0m",
      "  \u001b[1m/model\u001b[0m  \u001b[38;5;6mchoose what model and reasoning effort to use\u001b[0m"
    );
  const historicalPopupWithCurrentComposer = [
    TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen,
    codex0154IdleFrame({
      model: "gpt-5.6-sol",
      effort: "high",
      cwd: "/workspace"
    })
  ].join("\n");

  for (const changed of [
    plainPopup,
    misplacedAnsi,
    TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen.replace(
      "choose what model and reasoning effort to use",
      "unknown completion"
    ),
    `${TERMINAL_UI_GOLDENS.codex01551PlainPopup.screen}\n  unexpected row`
  ]) {
    assert.equal(
      currentCodexComposerCapture(
        changed,
        "/model",
        false,
        false,
        terminalModelControlSlashCompletionRows(codex01551Plan),
        terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(
          codex01551Plan
        )
      ),
      undefined
    );
  }

  const current = currentCodexComposerCapture(
    historicalPopupWithCurrentComposer,
    "/model",
    false,
    false,
    terminalModelControlSlashCompletionRows(codex01551Plan),
    terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(
      codex01551Plan
    )
  );
  assert.equal(current?.state, "exact_empty");
  assert.equal(current?.profiledSlashPopup, undefined);
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
