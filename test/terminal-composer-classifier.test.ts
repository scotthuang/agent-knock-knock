import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  codexActiveWriterViewerVisible,
  codexBlockingModalVisible,
  currentCodexComposerCapture,
  exactClaudeInjectedPastePlaceholderCapture,
  exactTerminalComposerCapture,
  inspectCodexAsyncQuestionInputMode,
  terminalUserExplicitInputSafetyFailure,
  terminalUserExplicitInputOwnerBlocked,
  terminalComposerRowsMatchExpected
} from "../src/terminal-composer-classifier.js";
import {
  inspectCodexAsyncQuestionInputMode as inspectCodexAsyncQuestionInputModeFromBridge
} from "../src/terminal-agent-bridge.js";
import { exactCodexFullscreenSlashComposerCapture } from
  "../src/codex-fullscreen-composer-proof.js";

const FULLSCREEN_IDLE = [
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
  "", "  GPT-6-Astra high · /repo",
  "  ← for agents · ? for shortcuts                              ⚠ 2 warnings · f2 to view"
].join("\n");

for (const version of ["0.158.0", "0.159.0"]) {
  test(`Codex ${version} fullscreen Composer distinguishes above-input popup, bare cleanup, and clipped footer`, () => {
    const idle = currentCodexComposerCapture(FULLSCREEN_IDLE, "new request",
      false, false, undefined, false, version);
    assert.equal(idle?.state, "exact_empty");
    const popup = [
      "\x1b[1;7m› /model  choose what model and reasoning effort to use\x1b[0m",
      "", "\x1b[1m›\x1b[0m /model", "", "  GPT-6-Astra high · /repo"
    ].join("\n");
    const completionRows = ["› /model  choose what model and reasoning effort to use"];
    const parsed = currentCodexComposerCapture(popup, "/model", false,
      false, completionRows, true, version);
    assert.equal(parsed?.state, "exact_draft");
    assert.equal(parsed?.profiledSlashPopup, true);
    assert.equal(currentCodexComposerCapture(
      `│  Weekly limit:         81% left │\n${popup}`, "/model", false,
      false, completionRows, true, version)?.profiledSlashPopup, true);
    assert.equal(currentCodexComposerCapture(
      `  /model-copy  another model command\n${popup}`, "/model", false,
      false, completionRows, true, version), undefined);
    const bare = FULLSCREEN_IDLE.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "/model")
      .replace("  ← for agents · ? for shortcuts", "                              ");
    const cleanup = currentCodexComposerCapture(bare, "/model", false,
      false, completionRows, true, version);
    assert.equal(cleanup?.bareCommand, true);
    assert.equal(cleanup?.profiledSlashPopup, undefined);
    const typed = bare.replace("/model", "akk composer diagnostic");
    assert.equal(currentCodexComposerCapture(typed, "akk composer diagnostic", false,
      false, undefined, false, version)?.state, "exact_draft");
    assert.equal(currentCodexComposerCapture(
      popup.replace("/model  choose", "/model-copy  choose"), "/model", false,
      false, completionRows, true, version), undefined);
    assert.equal(currentCodexComposerCapture(
      FULLSCREEN_IDLE.replace("? for shortcuts", "? for short…"), "new request",
      false, false, undefined, false, version), undefined);
  });
}

for (const version of ["0.158.0", "0.159.0"]) {
  test(`Codex ${version} task-running queue footer closes only a nonempty draft`, () => {
    const queueFooter = "  tab to queue message                              ⚠ 2 warnings · f2 to view";
    const popup = [
      "\x1b[1;7m› /status      show current session configuration and token usage\x1b[0m",
      "  /statusline  configure which items appear in the status line", "",
      "\x1b[1m›\x1b[0m /status", "", "  GPT-6-Astra high · /repo", queueFooter
    ].join("\n");
    const rows = ["› /status      show current session configuration and token usage",
      "  /statusline  configure which items appear in the status line"];
    assert.equal(currentCodexComposerCapture(popup, "/status", false,
      false, rows, true, version)?.profiledSlashPopup, true);
    assert.equal(currentCodexComposerCapture(popup.replace("\x1b[1;7m", "\x1b[1m"),
      "/status", false, false, rows, true, version), undefined);
    assert.equal(currentCodexComposerCapture(popup.replace("tab to queue message", "tab to queue mes…"),
      "/status", false, false, rows, true, version), undefined);
    const empty = FULLSCREEN_IDLE.replace("  ← for agents · ? for shortcuts                              ⚠ 2 warnings · f2 to view", queueFooter);
    assert.equal(currentCodexComposerCapture(empty, "new request", false,
      false, undefined, false, version), undefined);
    const ordinaryDraft = empty.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "pending text");
    assert.equal(currentCodexComposerCapture(ordinaryDraft, "pending text", false,
      false, undefined, false, version)?.state, "exact_draft");
  });
}

test("Codex fullscreen command stability excludes only its validated live hint tail", () => {
  const rows = ["› /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"];
  const popup = ["\x1b[1;7m› /status      show current session configuration and token usage\x1b[0m",
    rows[1]!, "", "\x1b[1m›\x1b[0m /status", "", "  GPT-6-Astra high · /repo"].join("\n");
  const capture = (screen: string) => exactCodexFullscreenSlashComposerCapture(screen, "/status", rows, true);
  const expected = capture(popup);
  assert.ok(expected);
  assert.equal(capture(`${popup}\n  tab to queue message`)?.digest, expected.digest);
  assert.equal(capture(`${popup}\n  tab to queue message                              ⚠ 2 warnings · f2 to view`)?.digest,
    expected.digest);
  assert.equal(capture(`${popup}\n  unknown input hint`), undefined);
  assert.equal(capture(popup.replace("\x1b[0m /status", "\x1b[0m /statusline")), undefined);
  assert.equal(capture(popup.replace("› /status      show", "› /status-copy show")), undefined);
  for (const changed of [popup.replace("GPT-6-Astra", "GPT-6-Sol"), popup.replace("/repo", "/other")]) {
    assert.notEqual(capture(changed)?.digest, expected.digest);
  }
});

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
      expected: "expanded",
      screen: [
        "• Queued follow-up inputs",
        "",
        "  1 of 1",
        "  Continue with the selected company?",
        "",
        "  › 1. Yes",
        "    2. Other",
        "",
        "  enter submit   ctrl+] skip   ⌥+↓ main prompt"
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
    if (expected === "expanded" || expected === "ambiguous") {
      assert.equal(terminalUserExplicitInputOwnerBlocked(screen), true);
    }
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

test("user-explicit input-owner detection blocks proven UI owners, not drafts", () => {
  const claudeStatus = [
    "────────────────────────────────────────────────",
    "  Settings  Status   Config   Usage   Stats",
    "",
    "  Version:             2.1.266",
    "  Session ID:          40ce9ddb-6de3-45d1-be57-7684808712a0",
    "  cwd:                 /repo",
    "  Model:               claude-sonnet",
    "",
    "  Esc to cancel"
  ].join("\n");
  assert.equal(terminalUserExplicitInputOwnerBlocked(claudeStatus), true);
  assert.equal(
    terminalUserExplicitInputOwnerBlocked(
      `${claudeStatus}\n────────────────────────────────\n❯ ordinary draft`
    ),
    false,
    "a later main Composer makes an old modal footer historical"
  );
  assert.equal(
    terminalUserExplicitInputOwnerBlocked(
      "❯ reverse-i-search: previous task\nEsc to cancel search"
    ),
    true
  );
  assert.equal(
    terminalUserExplicitInputOwnerBlocked(
      "❯ existing ordinary draft\n● high · /effort"
    ),
    false
  );
  assert.equal(terminalUserExplicitInputOwnerBlocked(undefined), false);
});

test("Claude stash-clear proof accepts known footers and rejects unknown overlays", () => {
  const control = {
    kind: "tmux" as const,
    target: "claude:0.0",
    session: "claude",
    window: 0,
    pane: 0,
    panePid: 100,
    currentCommand: "claude",
    currentPath: "/repo",
    capabilities: ["screen_status" as const, "send_keys" as const]
  };
  const failure = (trailing: readonly string[]) =>
    terminalUserExplicitInputSafetyFailure({
      agent: "claude",
      displayName: "Claude Code",
      screen: [
        "────────────────────────────────────────────────",
        "❯ ",
        "────────────────────────────────────────────────",
        ...trailing
      ].join("\n"),
      terminalControl: control,
      approvalBlocked: false,
      awaitingApproval: false,
      interactionActive: false,
      modelControlSurface: false,
      requireExactEmptyClaudeComposer: true
    });
  assert.equal(failure([
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    "  › stashed"
  ]), undefined);
  assert.equal(failure([
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to",
    "  interrupt · ← for ag…"
  ]), undefined);
  assert.match(
    failure(["  Unknown overlay still owns input"]) ?? "",
    /did not prove/u
  );
});
