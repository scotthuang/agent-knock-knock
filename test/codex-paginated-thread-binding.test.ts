import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { captureCodexPaginatedThreadBinding } from "../src/codex-paginated-thread-binding.js";
import { observeCodexNativeInspection } from "../src/codex-terminal-agent-adapter.js";
import {
  exactCodexReadyStyledComposerCapture,
  stripTerminalEscapeSequences,
  type TerminalCodexStatusProbeResult
} from "../src/terminal-native-inspection-bridge.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";

type BindingInput = Parameters<typeof captureCodexPaginatedThreadBinding>[0];
const NOW = new Date("2026-10-01T00:00:00.000Z");
const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const CONTROL: TerminalControlRef = {
  kind: "herdr", target: "workspace/tab/pane", session: "fixture-session",
  socketPath: "/tmp/fixture.sock", panePid: 4242, currentCommand: "codex",
  currentPath: "/repo", capabilities: ["screen_status", "send_keys"],
  sessionDir: "/tmp/fixture-session", workspaceId: "workspace", tabId: "tab",
  paneId: "pane", terminalId: "terminal_resource"
};
const STATUS_CARD = [
  "/status", "", "╭───────────────────────────────────────────────────────────────────────────────────╮",
  "│  >_ OpenAI Codex (v0.158.0)                                                       │",
  "│                                                                                   │",
  "│  Server:               Local background server                                    │",
  "│  Model:                GPT-6-Astra (reasoning high, summaries auto)               │",
  "│  Directory:            /repo                                                     │",
  `│  Session:              ${THREAD}                       │`,
  "╰───────────────────────────────────────────────────────────────────────────────────╯"
].join("\n");
const READY_COMPOSER = [
  "", "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
  "  GPT-6-Astra high · /repo", "  ← for agents · ? for shortcuts"
].join("\n");
const POST_STATUS = `${STATUS_CARD}\n${READY_COMPOSER}`;
const PRE_ENTER = [
  STATUS_CARD, "",
  "\x1b[1;7m› /status      show current session configuration and token usage\x1b[0m",
  "  /statusline  configure which items appear in the status line", "",
  "\x1b[1m›\x1b[0m /status", "", "  GPT-6-Astra high · /repo"
].join("\n");
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(frames: readonly string[] = [POST_STATUS]) {
  const events: string[] = [];
  let captureIndex = 0;
  let incarnationCount = 0;
  const state = { processChanged: false };
  const receipt: TerminalCodexStatusProbeResult = {
    stage: "enter_dispatched", agent: "codex", terminalControl: CONTROL,
    command: "/status", behaviorProfile: "codex-tui-0.158.0", enterCount: 1,
    preTextScreenDigest: `sha256:${digest(READY_COMPOSER)}`,
    preEnterScreenDigest: `sha256:${digest(PRE_ENTER)}`,
    observationBaselineDigest: digest(PRE_ENTER), observationScrollbackLines: 240,
    preEnterEvidenceInventory: observeCodexNativeInspection({
      operation: { kind: "status" }, screen: stripTerminalEscapeSequences(POST_STATUS)
    }).evidenceInventory ?? [],
    materialization: {
      kind: "exact_slash_popup", digest: digest(PRE_ENTER),
      stableCaptures: 2, stableForMs: 100
    }
  };
  const input: BindingInput = {
    terminalControl: CONTROL, pid: 4242, agentVersion: "0.158.0",
    codexHome: "/codex", now: () => NOW,
    bridge: {
      async submitCodexStatusProbe(control, version, options) {
        events.push("closed_status");
        assert.equal(control, CONTROL);
        assert.equal(version, "0.158.0");
        assert.deepEqual(options?.runtime, { pid: 4242, agentVersion: "0.158.0" });
        return receipt;
      },
      async captureCodexStatusFrame() {
        events.push("capture");
        const screen = frames[Math.min(captureIndex++, frames.length - 1)]!;
        return { screen, emptyComposer: exactCodexReadyStyledComposerCapture(screen, "0.158.0") !== undefined };
      }
    },
    incarnation(pid) {
      assert.equal(pid, 4242);
      events.push("incarnation");
      incarnationCount += 1;
      const birth = state.processChanged && incarnationCount > 1 ? "changed-birth" : "exact-birth";
      return { processUuid: `codex-pid:4242:birth:${birth}`, processBirth: birth, evidence: "codex_process_birth" };
    },
    sleep: async (ms) => { assert.equal(ms, 100); events.push("sleep"); }
  };
  return { input, receipt, events, state };
}

test("closed fullscreen status accepts an identical newest card when the visible occurrence count plateaus", async () => {
  const harness = fixture();
  const post = observeCodexNativeInspection({
    operation: { kind: "status" }, screen: stripTerminalEscapeSequences(POST_STATUS)
  });
  assert.equal(post.status, "observed");
  assert.deepEqual(post.evidenceInventory, harness.receipt.preEnterEvidenceInventory);
  const binding = await captureCodexPaginatedThreadBinding(harness.input);
  assert.deepEqual(binding, {
    codexHome: "/codex", threadId: THREAD, serverVersion: "0.158.0", pid: 4242,
    processUuid: "codex-pid:4242:birth:exact-birth", processBirth: "exact-birth",
    observedAt: NOW.toISOString()
  });
  assert.deepEqual(harness.events, ["incarnation", "closed_status", "capture", "incarnation"]);
});

test("spinner redraw with the exact command still present waits for restored empty Composer", async () => {
  const spinner = `• Working (4s • esc to interrupt)\n${PRE_ENTER}`;
  const harness = fixture([spinner, POST_STATUS]);
  assert.equal((await captureCodexPaginatedThreadBinding(harness.input)).threadId, THREAD);
  assert.deepEqual(harness.events, ["incarnation", "closed_status", "capture", "sleep", "capture", "incarnation"]);
});

test("status binding refuses draft, spinner-only, clipped card/footer, embedded server, or wrong version", async () => {
  const invalidFrames = {
    draft: POST_STATUS.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "existing answer draft"),
    spinner_only: `• Working (4s • esc to interrupt)\n${PRE_ENTER}`,
    clipped_card: POST_STATUS.replace("╰───────────────────────────────────────────────────────────────────────────────────╯", ""),
    clipped_footer: POST_STATUS.replace("? for shortcuts", "? for short…"),
    embedded_server: POST_STATUS.replace("Local background server", "Embedded app server"),
    wrong_version: POST_STATUS.replace("(v0.158.0)", "(v0.158.1)")
  };
  for (const [reason, screen] of Object.entries(invalidFrames)) {
    const harness = fixture([screen]);
    await assert.rejects(captureCodexPaginatedThreadBinding(harness.input), /fresh exact foreground thread/u, reason);
    assert.equal(harness.events.filter((event) => event === "closed_status").length, 1, reason);
    assert.equal(harness.events.filter((event) => event === "capture").length, 40, reason);
    assert.equal(harness.events.filter((event) => event === "incarnation").length, 1, reason);
  }
});

test("status binding refuses an unchanged pre-Enter frame even if a caller claims its Composer empty", async () => {
  const harness = fixture([PRE_ENTER]);
  harness.input.bridge.captureCodexStatusFrame = async () => ({ screen: PRE_ENTER, emptyComposer: true });
  await assert.rejects(captureCodexPaginatedThreadBinding(harness.input), /fresh exact foreground thread/u);
});

test("status binding refuses a changed physical process and never retries the native command", async () => {
  const harness = fixture();
  harness.state.processChanged = true;
  await assert.rejects(captureCodexPaginatedThreadBinding(harness.input), /process changed/u);
  assert.deepEqual(harness.events, ["incarnation", "closed_status", "capture", "incarnation"]);
  const unsupported = fixture();
  await assert.rejects(captureCodexPaginatedThreadBinding({ ...unsupported.input, agentVersion: "0.158.1" }), /requires version 0\.158\.0/u);
  assert.deepEqual(unsupported.events, []);
});
