import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  codexActiveWriterViewerVisible,
  codexBlockingModalVisible,
  exactClaudeInjectedPastePlaceholderCapture,
  exactTerminalComposerCapture,
  inspectCodexAsyncQuestionInputMode,
  terminalComposerRowsMatchExpected
} from "../src/terminal-composer-classifier.js";
import {
  inspectCodexAsyncQuestionInputMode as inspectCodexAsyncQuestionInputModeFromBridge
} from "../src/terminal-agent-bridge.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("composer classifiers remain pure and the Bridge keeps its compatibility export", () => {
  const classifierSource = fs.readFileSync(
    path.join(repoRoot, "src", "terminal-composer-classifier.ts"),
    "utf8"
  );
  const bridgeSource = fs.readFileSync(
    path.join(repoRoot, "src", "terminal-agent-bridge.ts"),
    "utf8"
  );

  for (const forbidden of [
    "TerminalControlProvider",
    "sendKeys(",
    "sendText(",
    "inputLedger",
    "withWriterLock",
    "saveState(",
    "listConversations("
  ]) {
    assert.equal(
      classifierSource.includes(forbidden),
      false,
      `classifier must not own transport, input, locks, or Store access: ${forbidden}`
    );
  }
  assert.match(
    bridgeSource,
    /export \{[\s\S]*inspectCodexAsyncQuestionInputMode,[\s\S]*\} from "\.\/terminal-composer-classifier\.js";/u
  );

  const screen = [
    "• Queued follow-up inputs",
    "",
    "  2 of 2",
    "  Second?",
    "",
    "  › 1. Next",
    "    2. Other",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ prev question"
  ].join("\n");
  assert.equal(
    inspectCodexAsyncQuestionInputModeFromBridge(screen),
    inspectCodexAsyncQuestionInputMode(screen)
  );
});

test("Codex async-question input ownership preserves exact classification priority", () => {
  const cases = [
    {
      expected: "absent",
      screen: [
        "› Summarize recent commits",
        "gpt-5.6-sol high · /repo"
      ].join("\n")
    },
    {
      expected: "collapsed",
      screen: [
        "• Queued follow-up inputs",
        "  ? 2 questions · 15s",
        "    ⌥ + ↑ to answer",
        "› Summarize recent commits",
        "gpt-5.6-sol high · /repo"
      ].join("\n")
    },
    {
      expected: "expanded",
      screen: [
        "• Queued follow-up inputs",
        "",
        "  2 of 2",
        "  Second?",
        "",
        "  › 1. Next",
        "    2. Other",
        "",
        "  enter submit   ctrl + ] skip   ⌥ + ↓ prev question"
      ].join("\n")
    },
    {
      expected: "ambiguous",
      screen: [
        "  2 of",
        "  Secon",
        "  d",
        "  › x",
        "  ente…",
        "  ctrl…"
      ].join("\n")
    }
  ] as const;

  for (const { expected, screen } of cases) {
    assert.equal(inspectCodexAsyncQuestionInputMode(screen), expected);
  }
});

test("exact Claude composer classification accepts only exact visual wraps", () => {
  const request = "Herdr live validation. Reply with exactly: " +
    "AKK-HERDR-CLAUDE-LIVE-1786438038. Do not run commands or modify files.";
  const exactRows = [
    "Herdr live validation. Reply with exactly:",
    "AKK-HERDR-CLAUDE-LIVE-1786438038. Do not run",
    "commands or modify files."
  ];
  assert.equal(terminalComposerRowsMatchExpected(exactRows, request), true);
  assert.equal(
    terminalComposerRowsMatchExpected(
      [...exactRows.slice(0, -1), "commands or modify filez."],
      request
    ),
    false
  );

  const screen = [
    "───────────────────────────────────────────────────",
    "❯\u00a0Herdr live validation. Reply with exactly:",
    "  AKK-HERDR-CLAUDE-LIVE-1786438038. Do not run",
    "  commands or modify files.",
    "───────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
  ].join("\n");
  assert.match(
    exactTerminalComposerCapture("claude", screen, request)?.digest ?? "",
    /^[a-f0-9]{64}$/u
  );
  assert.equal(
    exactTerminalComposerCapture(
      "claude",
      screen.replace("modify files.", "modify filez."),
      request
    ),
    undefined
  );
});

test("Claude injected-paste proof binds the placeholder to the payload line count", () => {
  const request = "line one\nline two\nline three\nline four";
  const screen = [
    "────────────────────────────────────────────────",
    "❯ [Pasted text #7 +3 lines]",
    "────────────────────────────────────────────────",
    "  paste again to expand       ✘ Auto-update failed · Run claude doctor",
    "                              ● high · /effort"
  ].join("\n");

  const capture = exactClaudeInjectedPastePlaceholderCapture(screen, request);
  assert.equal(capture?.state, "exact_injected_paste_placeholder");
  assert.equal(capture?.pasteId, 7);
  assert.equal(capture?.newlineCount, 3);
  assert.match(capture?.digest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(
    exactClaudeInjectedPastePlaceholderCapture(
      screen.replace("+3 lines", "+2 lines"),
      request
    ),
    undefined
  );
});

test("Codex writer and modal evidence yields to a later exact main Composer", () => {
  const writer = [
    "  🔒   This conversation is open in another app  R to Retry",
    "  Close it there and press R to continue here.",
    "  R retry   E exit   T transcript"
  ].join("\n");
  assert.equal(codexActiveWriterViewerVisible(writer), true);
  assert.equal(codexBlockingModalVisible(writer), true);

  const repaintedMainComposer = [
    writer,
    "› ",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  assert.equal(codexActiveWriterViewerVisible(repaintedMainComposer), false);
  assert.equal(codexBlockingModalVisible(repaintedMainComposer), false);
});
