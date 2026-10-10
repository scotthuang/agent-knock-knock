import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCodexScreen,
  observeCodexNativeInspection,
  planCodexNativeInspection,
  probeCodexNativeInspection,
  probeCodexThreadLifecycle
} from "../src/codex-terminal-agent-adapter.js";
import { isAuditedCodexPaginatedServerPair, isCodexPaginatedReadCandidate,
  isCodexPaginatedVersion } from "../src/codex-lifecycle-compatibility.js";
import { exactCodexReadyStyledComposerCapture } from
  "../src/terminal-native-inspection-bridge.js";
import { captureCodexFullscreenComposerFrame } from
  "../src/codex-fullscreen-composer-proof.js";

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
const observe = (screen: string, expectedAgentVersion = "0.159.0") => observeCodexNativeInspection({
  operation: { kind: "status" }, screen, expectedAgentVersion
});

test("0.162.1 recognizes the new usage URL without relaxing exact status identity", () => {
  // Public rust-v0.162.1 status/card.rs changed only this informational URL.
  // Synthetic account, path and UUID deliberately contain no local evidence.
  const screen = SCREEN.replace("v0.159.0", "v0.162.1")
    .replace("https://chatgpt.com/codex/settings/usage", "https://chatgpt.com/settings/usage");
  const observed = observe(screen, "0.162.1");
  assert.equal(observed.status, "observed");
  assert.equal(observed.nativeThreadId, THREAD);
  assert.equal(observed.observedAgentVersion, "0.162.1");
  assert.equal(observed.result?.fields.find(({ name }) => name === "Account")?.value, "[REDACTED]");
  assert.equal(probeCodexNativeInspection("0.162.1").versionCompatibility, "verified");
  assert.equal(isAuditedCodexPaginatedServerPair("0.162.1", "0.162.1"), true);
  for (const backend of ["0.162.0", "0.162.2", "0.160.0"]) {
    assert.equal(isAuditedCodexPaginatedServerPair("0.162.1", backend), false);
  }
  const lifecycle = probeCodexThreadLifecycle("0.162.1");
  assert.equal(lifecycle.newThread, false);
  assert.equal(lifecycle.resumeExact, false);
  for (const changed of [
    screen.replace("https://chatgpt.com/settings/usage", "https://example.test/settings/usage"),
    screen.replace("for up-to-date", "for usage details"),
    screen.replace("v0.162.1", "v0.162.0"),
    screen.replace(`  Session:             ${THREAD}`, `  Session:             ${THREAD}\n  Session:             ${THREAD}`),
    screen.replace("? for shortcuts", "? for short…")
  ]) assert.notEqual(observe(changed, "0.162.1").status, "observed");
  assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, screen,
    expectedAgentVersion: "0.162.1", preEnterEvidenceInventory: observed.evidenceInventory }).status, "stale");
  const queue = "• Working (2s • esc to interrupt)\n\n• Queued follow-up inputs\n  ? 1 question · 5s\n    ⇧← to answer";
  assert.equal(observe(screen.replace(PLAIN_COMPOSER, `${queue}\n\n${PLAIN_COMPOSER}`), "0.162.1").status, "observed");
});

// 0.159.2 has the same official TUI rendering code as 0.159.0. Keep its
// physical version independent even though the card grammar is shared.
test("0.159.2 borderless status retains its exact physical version through idle and active observations", () => {
  const card = CARD.replace("v0.159.0", "v0.159.2");
  const idle = `${card}\n\n${PLAIN_COMPOSER}`;
  const observed = observe(idle, "0.159.2");
  assert.equal(observed.status, "observed");
  assert.equal(observed.observedAgentVersion, "0.159.2");
  assert.equal(observed.nativeThreadId, THREAD);
  assert.equal(observed.result?.fields.find((field) => field.name === "Account")?.value, "[REDACTED]");
  for (const suffix of [
    "• Inspecting the selected test files (9s • esc to interrupt)",
    "• Working (2s • esc to interrupt)\n\n• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer"
  ]) {
    const screen = `${card}\n\n${suffix}\n\n${PLAIN_COMPOSER}`;
    const active = observe(screen, "0.159.2");
    assert.equal(active.status, "observed");
    assert.equal(active.evidenceFingerprint, observed.evidenceFingerprint);
    assert.equal(inspectCodexScreen({ screen, runtime: { agentVersion: "0.159.2" } }).activity.state, "working");
  }
  assert.equal(observe(SCREEN, "0.159.2").status, "mismatch");
  assert.equal(observe(idle, "0.159.0").status, "mismatch");
  for (const changed of [
    idle.replace("v0.159.2", "v0.159.1"),
    idle.replace("v0.159.2", "v0.159.3"),
    idle.replace("? for shortcuts", "? for short…"),
    `${card}\n\n• Thinking (2s • esc to interrupt)\n  └ Session: another-session\n\n${PLAIN_COMPOSER}`
  ]) assert.notEqual(observe(changed, "0.159.2").status, "observed");
});

test("0.159.2 compact welcome with GPT-6.1 Sol still requires the exact styled empty Composer", () => {
  const header = "  >_ OpenAI Codex (v0.159.2)\n     /repo\n\n  The code must flow.\n\n";
  const composer = COMPOSER.replace("GPT-6-Astra", "GPT-6.1-Sol");
  assert.ok(exactCodexReadyStyledComposerCapture(`${header}${composer}`, "0.159.2"));
  assert.equal(inspectCodexScreen({ screen: PLAIN_COMPOSER.replace("GPT-6-Astra", "GPT-6.1-Sol"),
    runtime: { agentVersion: "0.159.2" } }).activity.state, "idle");
  assert.equal(exactCodexReadyStyledComposerCapture(`${header}${PLAIN_COMPOSER}`, "0.159.2"), undefined);
  assert.equal(exactCodexReadyStyledComposerCapture(
    composer.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "keep my draft"), "0.159.2"), undefined);
  // Recognizing the same Composer grammar is not proof of the header version.
  // The complete status parser independently pins that version and Session.
  assert.ok(captureCodexFullscreenComposerFrame(`${header}${composer}`, "0.159.3"));
  assert.equal(observe(`${CARD}\n\n${PLAIN_COMPOSER}`, "0.159.3").status, "mismatch");
});

for (const version of ["0.160.1", "1.0.0"]) {
  test(`unverified Codex ${version} observes the shared UI contract without gaining native write support`, () => {
    assert.equal(isCodexPaginatedReadCandidate(version), true);
    assert.equal(isCodexPaginatedVersion(version), false);
    assert.equal(isAuditedCodexPaginatedServerPair(version, version), false);
    const capability = probeCodexNativeInspection(version);
    assert.equal(capability.versionCompatibility, "unverified");
    assert.match(capability.compatibilityWarning!, /not been regression-tested/u);
    assert.equal(planCodexNativeInspection({ kind: "status" }, capability).behaviorProfile,
      `codex-tui-fullscreen-status-v1@${version}`);
    const lifecycle = probeCodexThreadLifecycle(version);
    assert.equal(lifecycle.newThread, false);
    assert.equal(lifecycle.resumeExact, false);
    const screen = SCREEN.replace("v0.159.0", `v${version}`);
    const observed = observe(screen, version);
    assert.equal(observed.status, "observed");
    assert.equal(observed.observedAgentVersion, version);
    assert.equal(observed.nativeThreadId, THREAD);
    assert.equal(observe(screen, "0.159.2").status, "mismatch");
    assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, screen,
      expectedAgentVersion: version, preEnterEvidenceInventory: observed.evidenceInventory }).status, "stale");
    for (const changed of [
      screen.replace("? for shortcuts", "? for short…"),
      screen.replace(`  Session:             ${THREAD}`, `  Session:             ${THREAD}\n  Session:             ${THREAD}`),
      screen.replace("  Permissions:         Workspace (Ask for approval)\n", ""),
      screen.replace("  Directory:", "   Directory:")
    ]) assert.notEqual(observe(changed, version).status, "observed");
    for (const [state, prefix] of [
      ["working", "• Waiting for background terminal (7m 58s • esc to interrupt)"],
      ["idle", "• Done.\n  Worked for 2s • 10:00 AM"]
    ]) {
      const inspected = inspectCodexScreen({ screen: `${prefix}\n\n${PLAIN_COMPOSER}`,
        runtime: { agentVersion: version }, screenChangedSinceSend: true });
      assert.equal(inspected.activity.state, state);
      assert.equal(inspected.completion, undefined,
        "a recognized idle screen must not become exact completion evidence");
    }
    for (const changed of [
      PLAIN_COMPOSER.replace("? for shortcuts", "unknown footer"),
      PLAIN_COMPOSER.replace("Ask Codex to do anything", "") + "\n  unknown input owner",
      PLAIN_COMPOSER.replace("Ask Codex to do anything", "unsent draft")
    ]) assert.equal(inspectCodexScreen({ screen: changed,
      runtime: { agentVersion: version } }).activity.state, "unknown");
  });
}

test("paginated read eligibility rejects malformed and older version identities", () => {
  for (const version of [undefined, null, 159, "0.157.1", "0.159", "0.159.3-beta", "00.159.3", "1.0.0 extra"]) {
    assert.equal(isCodexPaginatedReadCandidate(version), false, String(version));
  }
  assert.equal(isAuditedCodexPaginatedServerPair("0.159.2", "0.159.3"), false);
});

test("0.160 server status omits summaries while compact Option queue chrome stays outside identity", () => {
  // Official #49145 changes Model content, not Session or card boundaries.
  const card = CARD.replace("v0.159.0", "v0.160.0").replace(
    "(reasoning high, summaries auto)", "(reasoning high)"
  );
  const idle = observe(`${card}\n\n${PLAIN_COMPOSER}`, "0.160.0");
  assert.equal(idle.status, "observed");
  assert.equal(idle.result?.fields.find(({ name }) => name === "Model")?.value,
    "GPT-6-Astra (reasoning high)");
  const queued = "• Working (2s • esc to interrupt)\n\n• Queued follow-up inputs\n  ? 2 questions · 5s\n    ⌥↑ to answer";
  const screen = `${card}\n\n${queued}\n\n${PLAIN_COMPOSER}`;
  const active = observe(screen, "0.160.0");
  assert.equal(active.status, "observed");
  assert.equal(active.nativeThreadId, THREAD);
  assert.equal(active.evidenceFingerprint, idle.evidenceFingerprint);
  assert.equal(inspectCodexScreen({ screen, runtime: { agentVersion: "0.160.0" } }).activity.state, "working");
  assert.equal(observe(screen, "0.159.3").status, "mismatch");
  for (const changed of [
    screen.replace("⌥↑ to answer", "⌥ ↑ to answer"),
    screen.replace("⌥↑ to answer", "alt+↑ to answer"),
    screen.replace("⌥↑ to answer", `⌥↑ to answer Session: ${THREAD}`),
    screen.replace("  Permissions:         Workspace (Ask for approval)\n", ""),
    `${card}\n\nReconnecting to server…\n  ctrl+c quit`
  ]) assert.notEqual(observe(changed, "0.160.0").status, "observed");
});

test("0.160 Plan cycling hint retains the styled empty Composer and cannot disguise a draft or modal", () => {
  // Official #49037 renders this hint only when wide enough and input is idle.
  for (const mode of ["Plan mode", "Plan mode (shift+tab to cycle)"]) {
    const screen = COMPOSER.replace("high · /repo", `high · /repo                  ${mode}`);
    assert.ok(exactCodexReadyStyledComposerCapture(screen, "0.160.0"));
    assert.equal(inspectCodexScreen({ screen, runtime: { agentVersion: "0.160.0" } }).activity.state, "idle");
    assert.equal(exactCodexReadyStyledComposerCapture(screen.replace(
      "\x1b[2mAsk Codex to do anything\x1b[0m", "unsent draft"
    ), "0.160.0"), undefined);
    assert.equal(exactCodexReadyStyledComposerCapture(
      `${screen}\n  enter select · esc back`, "0.160.0"), undefined);
    assert.equal(exactCodexReadyStyledComposerCapture(
      screen.replaceAll(/\x1b\[[0-9;]*m/gu, ""), "0.160.0"), undefined);
  }
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


test("native collapsed-question countdown is optional and limited to the source-rendered final twenty seconds", () => {
  for (const countdown of ["", " · 1s", " · 16s", " · 20s"]) {
    const screen = `${CARD}\n\n• Queued follow-up inputs\n  ? 1 question${countdown}\n    shift+← to answer\n\n${PLAIN_COMPOSER}`;
    assert.equal(observe(screen).status, "observed", countdown);
  }
  for (const countdown of [" · 0s", " · 21s", " · 999s", " · 1m", " · 20s extra"]) {
    const screen = `${CARD}\n\n• Queued follow-up inputs\n  ? 1 question${countdown}\n    shift+← to answer\n\n${PLAIN_COMPOSER}`;
    assert.notEqual(observe(screen).status, "observed", countdown);
  }
});
