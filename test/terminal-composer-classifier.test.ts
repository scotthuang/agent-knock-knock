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
import { captureCodexFullscreenComposerFrame, exactCodexFullscreenSlashComposerCapture } from
  "../src/codex-fullscreen-composer-proof.js";

const FULLSCREEN_IDLE = [
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m",
  "", "  GPT-6-Astra high · /repo",
  "  ← for agents · ? for shortcuts                              ⚠ 2 warnings · f2 to view"
].join("\n");

for (const version of ["0.158.0", "0.159.0", "0.159.2"]) {
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

for (const version of ["0.158.0", "0.159.0", "0.159.2"]) {
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

test("Codex fullscreen popup styling uses effective SGR state rather than byte spelling", () => {
  const rows = ["› /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"];
  const popup = ["\x1b[0m\x1b[1m\x1b[7m" + rows[0] + "\x1b[0m",
    rows[1]!, "", "\x1b[0;1;48;2;57;57;57m›\x1b[0;48;2;57;57;57m /status\x1b[0m",
    "", "  GPT-6-Astra high · /repo"].join("\n");
  const capture = (screen: string) => exactCodexFullscreenSlashComposerCapture(
    screen, "/status", rows, true, "0.159.0");
  assert.ok(capture(popup));
  for (const changed of [
    popup.replace("\x1b[7m", "\x1b[7;27m"),
    popup.replace("\x1b[7m", "\x1b[38;5;7m"),
    popup.replace("\x1b[7m", "\x1b[38;2;7;7;7m"),
    popup.replace("\x1b[7m", "\x1b[7;2m"),
    popup.replace("0;1;48", "0;1;22;48"),
    popup.replace("0;1;48", "0;1;2;48"),
    popup.replace("show current session", "\x1b[27mshow current session")
  ]) {
    assert.equal(capture(changed), undefined);
  }
  const plain = rows.join("\n") + "\n\n› /status\n\n  GPT-6-Astra high · /repo";
  const padded = plain.split("\n").map((line) => line.padEnd(91)).join("\r\n");
  assert.equal(exactCodexFullscreenSlashComposerCapture(padded, "/status", rows, false, "0.159.0")?.digest,
    exactCodexFullscreenSlashComposerCapture(plain, "/status", rows, false, "0.159.0")?.digest);
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

test("Claude input proof distinguishes occupied stashes from known footer syntax", () => {
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
  const failure = (trailing: readonly string[], proof: {
    screen?: string;
    requireExactEmptyClaudeComposer?: boolean;
    requireEmptyClaudeStash?: boolean;
  } = {}) =>
    terminalUserExplicitInputSafetyFailure({
      agent: "claude",
      displayName: "Claude Code",
      screen: [
        "✻ Brewed for 43s · done 1:37", "",
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
      requireExactEmptyClaudeComposer: true,
      requireEmptyClaudeStash: true,
      ...proof
    });
  assert.match(failure([
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    "  › stashed"
  ]) ?? "", /stash/iu);
  assert.equal(failure([
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to",
    "  interrupt · ← for ag…"
  ]), undefined);
  for (const footer of ["  ⏸ manual mode on", "  ⏸ manual mode on       › stashed"]) {
    if (footer.includes("› stashed")) assert.match(failure([footer]) ?? "", /stash/iu);
    else assert.equal(failure([footer]), undefined);
    assert.match(failure([`${footer} unexpected overlay`]) ?? "", /footer/iu);
  }
  assert.match(
    failure(["  Unknown overlay still owns input"]) ?? "",
    /footer/iu
  );
  const dynamicFooter = "  ⏵⏵ auto mode on · 1 shell · esc to interrupt · ← for agents · ↓ to manage          Debug";
  for (const nativeFooter of [
    [dynamicFooter],
    [dynamicFooter, "                                       › stashed"],
    [dynamicFooter.replace("1 shell", "2 shells")],
    ["  ⏵⏵ auto mode on · 1 shell · esc to", "  interrupt · ← for agents · ↓ to manage          Debug",
      "                                       › stashed"],
    ["  ⏵⏵ auto mode on · 1 shell · esc to interrupt · ← for agents", "  · ↓ to manage          Debug"],
    [dynamicFooter, "                             Draft restored · › stashed", "  ● high · /effort"]
  ]) {
    if (nativeFooter.some(line => line.includes("› stashed"))) {
      assert.match(failure(nativeFooter) ?? "", /stash/iu,
        "known wrapped footer syntax does not permit consuming an occupied stash");
    } else assert.equal(failure(nativeFooter), undefined, "closed native components survive wrapping and right alignment");
  }
  for (const unsupported of [
    dynamicFooter.replace("auto mode on", "auto mode on arbitrary text"),
    dynamicFooter.replace("1 shell", "1 shell · unfamiliar shortcut"),
    dynamicFooter.replace("← for agents", "← for agents unrelated overlay"),
    dynamicFooter + " unexpected overlay",
    dynamicFooter.replace("Debug", "Debugger"),
    dynamicFooter.replace("↓ to manage", "↓ to manage secrets"),
    dynamicFooter.replace("1 shell", "some shells")
  ]) assert.match(failure([unsupported]) ?? "", /footer/iu,
    "an unknown token anywhere in the footer cannot be swallowed by wildcard matching");
  assert.match(failure([dynamicFooter, "                              › stashed"], { requireEmptyClaudeStash: true }) ?? "",
    /stash/iu, "right-aligned multiline stash blocks before cleanup begins");
  const footer = ["  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"];
  const currentBlock = (history: readonly string[], trailing = footer) => failure(trailing, {
    screen: [...history, "────────────────────────────────────────────────", "❯ ",
      "────────────────────────────────────────────────", ...trailing].join("\n")
  });
  assert.equal(currentBlock([
    "✽ Working… (8s · ↓ 123 tokens)", "", "⏺ The requested read-only check is complete.",
    "  Current branch: feature/example", ""
  ]), undefined, "a historical spinner above a later assistant reply does not claim current input");
  // Actual 2.1.295 layouts place the notification row above the Composer's
  // upper border. It may contain either a standalone badge or native /clear advice.
  const capturedStashAboveComposer = [
    "✻ Brewed for 1m 0s · done 3:19 · 1 shell still running",
    "                                                                                 › stashed",
    "────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "────────────────────────────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on · 1 shell · ← for agents · ↓ to manage                             Debug"
  ].join("\n");
  assert.match(failure([], { screen: capturedStashAboveComposer }) ?? "", /stash/iu,
    "a native badge immediately above the input border refuses before a restore key");
  const clearHint = "new task? /clear to save 337.6k tokens";
  const capturedInlineStashAboveComposer = [
    `                                       ${clearHint} · › stashed`,
    "──────────────────────────── example-feature-branch-20261027示例开发                      ─",
    "❯",
    "───────────────────────────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
  ].join("\n");
  assert.match(failure([], { screen: capturedInlineStashAboveComposer }) ?? "", /stash/iu,
    "the actual /clear notification plus suffix badge refuses before any restore probe");
  assert.equal(failure([], { screen: capturedInlineStashAboveComposer.replace(" · › stashed", "") }), undefined,
    "/clear advice above the input is not an unknown footer component");
  for (const prefix of ["", "Draft restored · ", `${clearHint} · `,
    "/clear to save 1k tokens · ", `Draft restored · ${clearHint} · `]) {
    assert.match(currentBlock([
      "✻ Brewed for 1m 0s · done 3:19 · 1 shell still running",
      `                          ${prefix}› stashed`, ""
    ]) ?? "", /stash/iu, "the nearest nonempty native badge belongs to the current input");
    assert.equal(currentBlock([
      `                          ${prefix}› stashed`, "",
      "⏺ A newer normal reply has completed the current work.", ""
    ]), undefined, "an older badge above a newer reply is history, not current stash evidence");
    assert.match(failure([...footer, `                          ${prefix}›\tstashed  `]) ?? "", /stash/iu,
      "the trailing path recognizes the same suffix badge independently of its prefix");
  }
  assert.equal(currentBlock([clearHint]), undefined, "native /clear advice alone does not block an empty prompt");
  for (const amount of ["337.6k", "999", "1m", "1.2b", "1t"]) {
    assert.equal(currentBlock(["✻ Brewed for 43s · done 1:37", clearHint.replace("337.6k", amount)], [dynamicFooter]), undefined,
      "the native compact-number /clear notification does not hide the last foreground completion");
  }
  assert.match(currentBlock(["✻ Brewed for 43s · done 1:37", "✽ Working… (8s · thinking)", clearHint],
    [dynamicFooter]) ?? "", /foreground.*(?:running|turn)|still running/iu,
    "ignoring native /clear advice cannot hide an active foreground spinner");
  for (const unknownHint of [`${clearHint} unexpected overlay`, clearHint.replace("337.6k", "337.65k")]) {
    assert.match(currentBlock(["✻ Brewed for 43s · done 1:37", unknownHint],
      [dynamicFooter]) ?? "", /foreground.*(?:running|turn)|still running/iu,
      "unknown notification text or non-native numeric format cannot manufacture foreground completion proof");
  }
  assert.match(failure([...footer, clearHint]) ?? "", /footer/iu,
    "supporting advice above the input does not whitelist arbitrary components below it");
  assert.match(failure([...footer, `${clearHint} · › stashed unexpected overlay`]) ?? "", /footer/iu,
    "non-suffix badge text cannot swallow an unknown trailing component");
  for (const glyph of ["✽", "·", "●", "✳", "✶"]) {
    assert.match(currentBlock([
      "✻ Brewed for 43s · done 1:37", "",
      `${glyph} Thinking… (8s · ↓ 123 tokens)`,
      "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's",
      "     current work", ""
    ], [dynamicFooter]) ?? "", /foreground.*(?:running|turn)|still running/iu,
    "the current spinner and wrapped native tip override an earlier completion summary");
  }
  assert.equal(currentBlock(["✻ Sautéed for 16s · done 1:35 PM", ""], [dynamicFooter]), undefined,
    "native localized completion time permits a remaining background shell");
  assert.match(failure([...footer, "  › stashed"], { requireEmptyClaudeStash: true }) ?? "",
    /stash/iu, "an occupied native stash is rejected before any input");
  assert.equal(failure(footer, { requireEmptyClaudeStash: true }), undefined);
  for (const prefix of ["", "Draft restored · "]) {
    const reason = failure([...footer, `                            ${prefix}› stashed`]);
    assert.match(reason ?? "", /stash/iu, "the restored toast does not mean the current stash is consumed");
    assert.match(reason ?? "", /Ctrl\+S|C-s/iu, "recovery explains the native restore key");
    assert.match(reason ?? "", /AKK/iu, "legacy marker recovery is explained without erasing hidden text");
  }
  const marker = " [AKK replacing current draft 12345678-abcd-4abc-9abc-1234567890ab]";
  const draftFailure = (draft: string, history: readonly string[] = []) => failure(footer, {
    screen: [...history, "────────────────────────────────────────────────", `❯ ${draft}`,
      "────────────────────────────────────────────────", ...footer].join("\n")
  });
  for (const draft of [marker, " [AKK replacing current draft]"]) {
    assert.match(draftFailure(draft) ?? "", /AKK/iu);
    assert.match(draftFailure(draft) ?? "", /(?:clear|remove|delete)/iu,
      "an exact visible legacy marker has actionable manual recovery");
  }
  assert.match(draftFailure("my own text") ?? "", /draft/iu);
  assert.doesNotMatch(draftFailure("my own text", [`⏺ ${marker}`]) ?? "", /(?:leftover|legacy) AKK/iu,
    "a historical marker cannot establish ownership of the current user draft");
  assert.match(failure(["Unknown overlay", "  › stashed"]) ?? "", /stash/iu,
    "positive stash evidence gives the actionable refusal even with another unknown component");
  assert.match(failure(["Unknown overlay"]) ?? "", /footer/iu,
    "without a stash badge the same unknown component still fails the closed footer whitelist");
});


for (const version of ["0.164.0", "0.165.0"]) test(`${version} contextual footer closes the default-effort Composer without inventing idle or effort authority`, () => {
  // Layout from the owned 0.164 CLI: no separate shortcut row; warning shares
  // the model/path row. Only synthetic path and transcript are retained.
  const ready = "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n" +
    "  GPT-6.1-Sol default · /repo                     ⚠ 3 warnings · f2 to view";
  const frame = captureCodexFullscreenComposerFrame(ready, version);
  assert.equal(frame?.hasContextFooter, true);
  assert.equal(frame?.hasShortcutFooter, false);
  assert.equal(currentCodexComposerCapture(ready, "task", false, false,
    undefined, false, version)?.state, "exact_empty");
  for (const label of ["GPT-6.1-Sol xhigh fast", "GPT-6-Astra ultra fast", "GPT-6-Astra max fast", "GPT-6.1 Terra low"]) {
    const rendered = ready.replace("GPT-6.1-Sol default", label);
    assert.equal(currentCodexComposerCapture(rendered, "task", false, false,
      undefined, false, version)?.state, "exact_empty");
  }
  for (const changed of [ready.replace("default", "unknown"),
    ready + "\n  unknown input owner",
    ready + "\n  New activity · Back to bottom",
    ready + "\n  enter/esc latest · ? shortcuts", ready.replace("Ask Codex to do anything", "pending draft")]) {
    assert.notEqual(currentCodexComposerCapture(changed, "task", false, false,
      undefined, false, version)?.state, "exact_empty");
  }
  assert.equal(captureCodexFullscreenComposerFrame(ready, "0.162.1")?.hasContextFooter, false,
    "new passive footer does not silently authorize older versions");
  const rows = ["› /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"];
  const popup = "\x1b[1;7m" + rows[0] + "\x1b[0m\n" + rows[1] + "\n\n" +
    ready.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "/status");
  assert.equal(captureCodexFullscreenComposerFrame(popup, version)?.hasContextFooter, false);
  assert.ok(exactCodexFullscreenSlashComposerCapture(popup, "/status", rows, true, version));
  assert.equal(exactCodexFullscreenSlashComposerCapture(popup.replace("\x1b[1;7m", "\x1b[1m"),
    "/status", rows, true, version), undefined);
});
