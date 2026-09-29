import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCodexScreen,
  observeCodexNativeInspection
} from "../src/codex-terminal-agent-adapter.js";
import { exactCodexReadyStyledComposerCapture } from
  "../src/terminal-native-inspection-bridge.js";

const THREAD = "11111111-2222-4333-8444-555555555555";
const COMPOSER = [
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
  "  GPT-6-Astra high · /repo", "  ← for agents · ? for shortcuts"
].join("\n");
const PLAIN_COMPOSER = COMPOSER.replace(/\x1b\[[0-9;]*m/gu, "");
// Native 0.159 /status, sanitized from the idle tmux probe. The header and
// fields are borderless; the next live Composer closes the output.
const CARD = [
  "/status", "", "  >_ OpenAI Codex (v0.159.0)", "",
  "  Visit https://chatgpt.com/codex/settings/usage for up-to-date",
  "  information on rate limits and credits", "",
  "  Server:              Local background server", "",
  "  Model:               GPT-6-Astra (reasoning high, summaries auto)",
  "  Model provider:      openai",
  "  Directory:           /repo",
  "  Permissions:         Workspace (Ask for approval)",
  "  Agents.md:           AGENTS.md",
  "  Account:             developer@example.test",
  "  Collaboration mode:  Default",
  `  Session:             ${THREAD}`, "",
  "  Weekly limit:        [█████████████░░░░░░░] 63% left (resets 12:58 AM on 4 Oct)"
].join("\n");
const SCREEN = `${CARD}\n\n${PLAIN_COMPOSER}`;
const observe = (screen: string) => observeCodexNativeInspection({
  operation: { kind: "status" }, screen, expectedAgentVersion: "0.159.0"
});

test("0.159 borderless status proves its native identity and keeps account values private", () => {
  const status = observe(SCREEN);
  assert.equal(status.status, "observed");
  assert.equal(status.nativeThreadId, THREAD);
  assert.equal(status.result?.fields.find((field) => field.name === "Server")?.value,
    "Local background server");
  assert.equal(status.result?.fields.find((field) => field.name === "Account")?.value, "[REDACTED]");
  assert.ok(!JSON.stringify(status).includes("developer@example.test"));
  assert.equal(observe(SCREEN.replace("Permissions:         Workspace (Ask for approval)",
    "Permissions:         Custom (workspace with network access,\n                       Ask for approval)")).status, "observed");
  // A prior card stays countable while a fresh command is in the Composer.
  const preEnter = `${CARD}\n\n› /status\n\n  GPT-6-Astra high · /repo`;
  assert.equal(observe(preEnter).evidenceInventory?.length, 1);
  assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, screen: SCREEN,
    preEnterEvidenceInventory: observe(SCREEN).evidenceInventory }).status, "stale");
});

test("0.159 status refuses clipped, mixed-version, duplicated and non-native identity surfaces", () => {
  for (const [label, screen] of Object.entries({
    unclosed: CARD,
    missing_header: SCREEN.replace("  >_ OpenAI Codex (v0.159.0)\n", ""),
    incomplete_footer: SCREEN.replace("? for shortcuts", "? for short…"),
    old_version: SCREEN.replace("v0.159.0", "v0.158.0"),
    unknown_version: SCREEN.replace("v0.159.0", "v0.159.1"),
    duplicate_session: SCREEN.replace(`  Session:             ${THREAD}`, `  Session:             ${THREAD}\n  Session:             ${THREAD}`),
    duplicate_server: SCREEN.replace("  Server:              Local background server", "  Server:              Remote server\n  Server:              Local background server"),
    header_injection: SCREEN.replace("  Model provider:", "  >_ OpenAI Codex (v0.159.0)\n  Model provider:"),
    missing_required: SCREEN.replace("  Permissions:         Workspace (Ask for approval)\n", ""),
    incomplete_uuid: SCREEN.replace(THREAD, THREAD.slice(0, -1)),
    wrapped_uuid: SCREEN.replace(THREAD, `${THREAD.slice(0, 24)}\n                       ${THREAD.slice(24)}`),
    unrelated_task: `${CARD}\n\n› work on something else\n• Done\n${PLAIN_COMPOSER}`,
    arbitrary_transcript: `${CARD}\n\n• Finished another task\n${PLAIN_COMPOSER}`,
    malformed_field: SCREEN.replace("  Directory:", "   Directory:")
  })) assert.notEqual(observe(screen).status, "observed", label);
});

test("0.159 compact welcome and turn tips never replace exact Composer or completion evidence", () => {
  const header = "  >_ OpenAI Codex (v0.159.0)\n     /repo\n\n  The code must flow.\n\n";
  assert.ok(exactCodexReadyStyledComposerCapture(`${header}${COMPOSER}`, "0.159.0"));
  assert.equal(exactCodexReadyStyledComposerCapture(`${header}${PLAIN_COMPOSER}`, "0.159.0"), undefined);
  assert.equal(exactCodexReadyStyledComposerCapture(`${header}${COMPOSER.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "do not overwrite my draft")}`, "0.159.0"), undefined);
  for (const [state, transcript] of [
    ["working", "• Working (2s • esc to interrupt)\n  └ Tip: Try /help."],
    ["idle", "• Done.\n  └ Tip: Try /help.\n\n  Worked for 2s • 10:00 AM"]
  ]) {
    const inspected = inspectCodexScreen({ screen: `${transcript}\n\n${PLAIN_COMPOSER}`,
      runtime: { agentVersion: "0.159.0" }, screenChangedSinceSend: true });
    assert.equal(inspected.activity.state, state);
    assert.equal(inspected.completion, undefined);
  }
  const planModal = "  Implement this plan?\n\n› 1. Yes, implement this plan          Switch to Default and start coding\n  2. Yes, clear context and implement  Fresh thread with this plan\n  3. No, stay in Plan mode             Continue planning with the model\n\n  enter select · esc back";
  assert.equal(exactCodexReadyStyledComposerCapture(planModal, "0.159.0"), undefined);
});


test("0.159 active status ends before timed activity and collapsed-question controls", () => {
  const collapsed = "• Queued follow-up inputs\n  ? 1 question · 16s\n    shift+← to answer";
  const observedIdle = observe(SCREEN);
  for (const suffix of [
    "• Working (51s • esc to interrupt)",
    "◦ Working (1m 00s • esc to interrupt)",
    "Working (2h 03m 09s • esc to interrupt)",
    "• Thinking (4s • esc to interrupt) · Running hooks",
    "◦ Inspecting the selected test files (9s • esc to interrupt)",
    "• Compacting context (2s • esc to interrupt)",
    "• Waiting for background terminal (1m 02s • esc to interrupt)\n  └ npm run build",
    "• Thinking (2s • esc to interrupt)\n  └ Running hooks\n  └ Checking the project layout\n    and the remaining files\n    before starting the change",
    "• Working (2s • esc to interrupt)\n  └ Tip: Try /help.",
    `◦ Working (51s • esc to interrupt)\n\n${collapsed}`,
    collapsed
  ]) {
    const screen = `${CARD}\n\n${suffix}\n\n${PLAIN_COMPOSER}`;
    const status = observe(screen);
    assert.equal(status.status, "observed", suffix);
    assert.equal(status.nativeThreadId, THREAD);
    assert.equal(status.evidenceFingerprint, observedIdle.evidenceFingerprint,
      "live spinner/countdown text must not become status identity evidence");
    if (suffix.includes("to interrupt")) assert.equal(inspectCodexScreen({ screen,
      runtime: { agentVersion: "0.159.0" } }).activity.state, "working");
  }
  for (const suffix of [
    "• Working (2s • esc to interrupt)\n• Arbitrary assistant transcript",
    "• Working (2s • esc to interrupt)\n  └ Tip: Try /help.\n  injected continuation",
    "• Working (truncated…)",
    "• Thinking (4s • esc to inter…)",
    "• Thinking (4s)",
    "• Thinking (4s • esc to interrupt)\n    continuation without a branch",
    "• Thinking (4s • esc to interrupt)\n  └ Details\n    row two\n    row three\n    row four\n    oversized fifth row",
    "• Thinking (4s • esc to interrupt)\n  └ Session: another-session",
    "• Thinking (4s • esc to interrupt)\n  └ Details\n    Server: Local background server",
    "• Thinking (4s • esc to interrupt)\n  └ /status",
    "• Thinking (4s • esc to interrupt) · Session: another-session",
    "• Thinking (4s • esc to interrupt)\n  Session:             another-session",
    `${collapsed}\n• Arbitrary assistant transcript`,
    collapsed.replace("shift+←", "shift+→"),
    collapsed.replace("1 question", "1 questions"),
    collapsed.replace("1 question", "0 questions"),
    collapsed.replace("to answer", "to ans…"),
    `${collapsed}\n  Session:             ${THREAD}`
  ]) assert.notEqual(observe(`${CARD}\n\n${suffix}\n\n${PLAIN_COMPOSER}`).status, "observed", suffix);
});
