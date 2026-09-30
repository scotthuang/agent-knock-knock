import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalAgentAdapterRegistry,
  terminalControlCapabilitiesForAdapter,
  type TerminalRuntimeIdentity
} from "../src/terminal-agent-adapter.js";
import {
  createClaudeTerminalAgentAdapter,
  planClaudeNativeInspection,
  probeClaudeNativeInspection
} from "../src/claude-terminal-agent-adapter.js";
import { createCodexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import {
  StaticTerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type { TerminalEndpointRef } from
  "../src/terminal-control-ref.js";
import { TerminalNativeInspectionBridge, stripTerminalEscapeSequences, exactCodexReadyStyledComposerCapture, isExactClaudeIdleComposer } from
  "../src/terminal-native-inspection-bridge.js";

test("OSC hyperlinks preserve visible commands and status between independently terminated links", () => {
  for (const end of ["\x1b\\", "\x07"]) {
    const link = (url: string, label: string) =>
      `\x1b]8;;${url}${end}${label}\x1b]8;;${end}`;
    const screen = [
      link("https://github.com/openai/codex/releases/latest", "Release notes"),
      "\x1b[38;5;5m/status\x1b[39m",
      "│ >_ \x1b[1mOpenAI Codex\x1b[0m (v0.157.1) │",
      `│ Visit ${link("https://chatgpt.com/codex/settings/usage", "usage")} │`,
      "│ Session: 22222222-2222-4222-8222-222222222222 │"
    ].join("\n");
    assert.equal(stripTerminalEscapeSequences(screen), [
      "Release notes",
      "/status",
      "│ >_ OpenAI Codex (v0.157.1) │",
      "│ Visit usage │",
      "│ Session: 22222222-2222-4222-8222-222222222222 │"
    ].join("\n"));
  }
});

const PANE: TerminalPane = {
  kind: "tmux",
  target: "native-inspection:0.0",
  socketPath: "/tmp/native-inspection-client.sock",
  serverSocketPath: "/tmp/native-inspection-server.sock",
  paneId: "%91",
  session: "native-inspection",
  window: 0,
  pane: 0,
  panePid: 900,
  currentCommand: "claude",
  currentPath: "/repo",
  columns: 80,
  rows: 40
};
const RUNTIME: TerminalRuntimeIdentity = { pid: 901 };
const IDLE_SCREEN = [
  "────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
].join("\n");
test("Claude named-session border preserves empty-composer proof without treating titles or drafts as authority", () => {
  const named = [
    "──────────────────────────────────────── AKK-CC285-compat ─",
    "❯\u00a0",
    "──────────────────────────────────────────────────────────",
    "  ⏸ manual mode on · ? for shortcuts · ← for agents    › stashed"
  ].join("\n");
  assert.equal(isExactClaudeIdleComposer(named), true);
  assert.equal(isExactClaudeIdleComposer(named.replace("❯\u00a0", "❯ unsent draft")), false);
  assert.equal(isExactClaudeIdleComposer(named + "\nSelect an option"), false);
  assert.equal(isExactClaudeIdleComposer(named.replace("AKK-CC285-compat ─", "truncated title")), false);
  assert.equal(isExactClaudeIdleComposer(named.replace("AKK-CC285-compat", "x".repeat(129))), false);
  assert.equal(isExactClaudeIdleComposer(named.replace("──────────────────────────────────────────────────────────", "──────────────────────────────────────── closing title ─")), false);
});
const COMPOSER_SCREEN = [
  "────────────────────────────────────────────────",
  "❯ /status",
  "────────────────────────────────────────────────",
  "/status                       Show Claude Code status including version, model, account, API",
  "                              connectivity, and tool statuses",
  "/statusline                   Set up Claude Code's status line UI",
  "/ide                          Manage IDE integrations and show status",
  "/usage                        Show session cost, plan usage, and activity stats"
].join("\n");

const CODEX_FULLSCREEN_IDLE = [
  "• Working (2s • esc to interrupt)", "",
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
  "  GPT-6-Astra high · /repo", "  ← for agents · ? for shortcuts"
].join("\n");
const CODEX_FULLSCREEN_STATUS_POPUP = [
  "• Working (2s • esc to interrupt)", "",
  "\x1b[1;7m› /status      show current session configuration and token usage\x1b[0m",
  "  /statusline  configure which items appear in the status line", "",
  "\x1b[1m›\x1b[0m /status", "", "  GPT-6-Astra high · /repo"
].join("\n");

// Captured from the designated Herdr Codex 0.159.0 pane. Keep its separate
// SGR resets, truecolor selection fill, CRLF, and 91-column background padding.
const HERDR_CODEX_159_STATUS_POPUP = [
  "\x1b[0m\x1b[1m\x1b[38;2;0;0;46m\x1b[48;2;99;168;248m› /status      " +
    "\x1b[0m\x1b[38;2;0;0;46m\x1b[48;2;99;168;248mshow current session configuration and token usage" +
    "\x1b[0m\x1b[1m\x1b[38;2;0;0;46m\x1b[48;2;99;168;248m" + " ".repeat(26) + "\x1b[0m",
  "  /\x1b[0m\x1b[1mstatus\x1b[0mline  \x1b[0m\x1b[2mconfigure which items appear in the status line\x1b[0m",
  "\x1b[0m\x1b[48;2;57;57;57m" + " ".repeat(91) + "\x1b[0m",
  "\x1b[0m\x1b[1m\x1b[48;2;57;57;57m›\x1b[0m\x1b[48;2;57;57;57m /status" + " ".repeat(82) + "\x1b[0m",
  "\x1b[0m\x1b[48;2;57;57;57m" + " ".repeat(91) + "\x1b[0m",
  "  \x1b[0m\x1b[38;2;246;226;183mGPT-6-Astra high\x1b[0m\x1b[38;2;165;165;165m · " +
    "\x1b[0m\x1b[38;2;171;223;167m/repo\x1b[0m"
].join("\r\n");

for (const version of ["0.158.0", "0.159.0", "0.159.2"]) {
  test(`Codex ${version} empty startup without sibling agents retains exact shortcuts and warning footer`, () => {
    const screen = CODEX_FULLSCREEN_IDLE.replace("• Working (2s • esc to interrupt)\n\n", "")
      .replace("← for agents · ? for shortcuts", "? for shortcuts                              ⚠ 2 warnings · f2 to view");
    assert.ok(exactCodexReadyStyledComposerCapture(screen, version));
    assert.equal(createCodexTerminalAgentAdapter().inspectScreen({
      screen: stripTerminalEscapeSequences(screen), runtime: { agentVersion: version }
    }).activity.state, "idle");
    assert.equal(createCodexTerminalAgentAdapter().inspectScreen({
      screen: stripTerminalEscapeSequences(screen), runtime: { agentVersion: "0.157.1" }
    }).activity.state, "unknown");
    assert.equal(exactCodexReadyStyledComposerCapture(
      screen.replace("? for shortcuts", "? for short…"), version), undefined);
    assert.equal(exactCodexReadyStyledComposerCapture(
      screen.replace("f2 to view", "f2 to vi…"), version), undefined);
  });
}

async function codexFullscreenFixture(popup = CODEX_FULLSCREEN_STATUS_POPUP, finalStyledPopup = popup) {
  const adapter = createCodexTerminalAgentAdapter();
  const events: Event[] = [];
  class Provider extends StaticTerminalControlProvider {
    screen = CODEX_FULLSCREEN_IDLE;
    constructor() { super({ panes: [{ ...PANE, currentCommand: "codex", columns: 120 }] }); }
    override async capture(_terminal: TerminalEndpointRef, options: {
      scrollbackLines?: number; preserveEscapes?: boolean;
    } = {}): Promise<string> {
      return options.preserveEscapes && this.screen !== CODEX_FULLSCREEN_IDLE
        ? finalStyledPopup : this.screen;
    }
    override async sendText(_terminal: TerminalEndpointRef, text: string): Promise<void> {
      events.push(`text:${text}`); this.screen = popup;
    }
    override async sendKeys(_terminal: TerminalEndpointRef, keys: readonly string[]): Promise<void> {
      events.push(`keys:${keys.join(",")}`);
    }
  }
  const provider = new Provider();
  const control = provider.toControlRef((await provider.listTerminals())[0]!,
    terminalControlCapabilitiesForAdapter(adapter));
  let nowMs = 0;
  const service = new TerminalNativeInspectionBridge<string>({
    registry: createTerminalAgentAdapterRegistry([adapter]), terminalProvider: provider,
    runtime: {
      verifyIdentity: async (_agent, current) => current,
      captureInspection: async (currentAdapter, current, options) => ({
        terminalControl: current, screen: provider.screen,
        inspection: currentAdapter.inspectScreen({ screen: provider.screen, runtime: options.runtime })
      }),
      statusFromInspection: () => "status", nowMs: () => nowMs,
      sleep: async (ms) => { nowMs += ms; }
    }
  });
  return { events, service, control };
}

for (const version of ["0.158.0", "0.159.0", "0.159.2"]) {
  test(`private Codex ${version} working status probe requires empty Composer and the exact above-input popup`, async () => {
    const runtime = { pid: 901, agentVersion: version };
    const blocked = await codexFullscreenFixture();
    await assert.rejects(blocked.service.submitCodexStatusProbe(blocked.control, version, { runtime }));
    assert.deepEqual(blocked.events, []);
    const allowed = await codexFullscreenFixture();
    await allowed.service.submitCodexStatusProbe(allowed.control, version, {
      runtime, allowWorkingCodexStatus: true
    });
    assert.deepEqual(allowed.events, ["text:/status", "keys:C-m"]);
    const clipped = await codexFullscreenFixture(CODEX_FULLSCREEN_STATUS_POPUP.replace(
      "configure which items appear in the status line", "configure which items appear…"
    ));
    await assert.rejects(clipped.service.submitCodexStatusProbe(clipped.control, version, {
      runtime, allowWorkingCodexStatus: true
    }));
    assert.deepEqual(clipped.events, ["text:/status"]);
  });
}

test("private Codex working status retains closed popup proof with queue-message footer", async () => {
  const runtime = { pid: 901, agentVersion: "0.158.0" };
  const popup = `${CODEX_FULLSCREEN_STATUS_POPUP}\n  tab to queue message                              ⚠ 2 warnings · f2 to view`;
  const allowed = await codexFullscreenFixture(popup);
  await allowed.service.submitCodexStatusProbe(allowed.control, "0.158.0", {
    runtime, allowWorkingCodexStatus: true
  });
  assert.deepEqual(allowed.events, ["text:/status", "keys:C-m"]);
  const blocked = await codexFullscreenFixture(popup);
  await assert.rejects(blocked.service.submitCodexStatusProbe(blocked.control, "0.158.0", { runtime }));
  assert.deepEqual(blocked.events, []);
  const unstyled = await codexFullscreenFixture(popup.replace("\x1b[1;7m", "\x1b[1m"));
  await assert.rejects(unstyled.service.submitCodexStatusProbe(unstyled.control, "0.158.0", {
    runtime, allowWorkingCodexStatus: true
  }));
  assert.deepEqual(unstyled.events, ["text:/status"]);
});

test("Codex status retains exact command proof when the native queue hint disappears before Enter", async () => {
  const popup = `${CODEX_FULLSCREEN_STATUS_POPUP}\n  tab to queue message`;
  const fixture = await codexFullscreenFixture(popup, CODEX_FULLSCREEN_STATUS_POPUP);
  await fixture.service.submitCodexStatusProbe(fixture.control, "0.158.0", {
    runtime: { pid: 901, agentVersion: "0.158.0" }, allowWorkingCodexStatus: true
  });
  assert.deepEqual(fixture.events, ["text:/status", "keys:C-m"]);
  const changed = await codexFullscreenFixture(popup,
    CODEX_FULLSCREEN_STATUS_POPUP.replace("/repo", "/other"));
  await assert.rejects(changed.service.submitCodexStatusProbe(changed.control, "0.158.0", {
    runtime: { pid: 901, agentVersion: "0.158.0" }, allowWorkingCodexStatus: true
  }));
  assert.deepEqual(changed.events, ["text:/status"]);
});

test("Codex fullscreen status popup may directly overlay transcript but must retain styled selection before Enter", async () => {
  const runtime = { pid: 901, agentVersion: "0.158.0" };
  const adjacent = await codexFullscreenFixture(
    CODEX_FULLSCREEN_STATUS_POPUP.replace("• Working (2s • esc to interrupt)\n\n",
      "• Working (2s • esc to interrupt)\n\n│  Weekly limit:         81% left │\n"));
  await adjacent.service.submitCodexStatusProbe(adjacent.control, "0.158.0", {
    runtime, allowWorkingCodexStatus: true
  });
  assert.deepEqual(adjacent.events, ["text:/status", "keys:C-m"]);
  const unstyled = await codexFullscreenFixture(
    CODEX_FULLSCREEN_STATUS_POPUP.replace("\x1b[1;7m", "\x1b[1m"));
  await assert.rejects(unstyled.service.submitCodexStatusProbe(unstyled.control, "0.158.0", {
    runtime, allowWorkingCodexStatus: true
  }), /exact styled popup/u);
  assert.deepEqual(unstyled.events, ["text:/status"]);
});

for (const version of ["0.159.0", "0.159.2"]) {
  test(`Codex ${version} Herdr status reconciles detection text with the native painted selection`, async () => {
    const plain = stripTerminalEscapeSequences(HERDR_CODEX_159_STATUS_POPUP)
      .split(/\r?\n/u).map((line) => line.trimEnd()).join("\n");
    const fixture = await codexFullscreenFixture(plain, HERDR_CODEX_159_STATUS_POPUP);
    await fixture.service.submitCodexStatusProbe(fixture.control, version, {
      runtime: { pid: 901, agentVersion: version }, allowWorkingCodexStatus: true
    });
    assert.deepEqual(fixture.events, ["text:/status", "keys:C-m"]);

    for (const changed of [
      HERDR_CODEX_159_STATUS_POPUP.replaceAll("\x1b[48;2;99;168;248m", ""),
      HERDR_CODEX_159_STATUS_POPUP.replaceAll("\x1b[48;2;99;168;248m", "\x1b[48;2;99;168;247m"),
      HERDR_CODEX_159_STATUS_POPUP.replace("m› /status", "m\x1b[0m› /status"),
      HERDR_CODEX_159_STATUS_POPUP.replace("m›\x1b[0m", "m\x1b[2m›\x1b[0m"),
      HERDR_CODEX_159_STATUS_POPUP.replace("show current session configuration", "\x1b[0mshow current session configuration"),
      HERDR_CODEX_159_STATUS_POPUP.replace("/repo", "/other"),
      HERDR_CODEX_159_STATUS_POPUP + "\r\n  ctrl+c copy · enter copy & follow · esc clear",
      plain
    ]) {
      const blocked = await codexFullscreenFixture(plain, changed);
      await assert.rejects(blocked.service.submitCodexStatusProbe(blocked.control, version, {
        runtime: { pid: 901, agentVersion: version }, allowWorkingCodexStatus: true
      }), /exact styled popup/u);
      assert.deepEqual(blocked.events, ["text:/status"]);
    }
  });
}

type Event =
  | "verify"
  | "capture"
  | "before_enter"
  | `sleep:${number}`
  | `text:${string}`
  | `keys:${string}`;

class RecordingNativeInspectionProvider extends StaticTerminalControlProvider {
  readonly events: Event[];
  screen = IDLE_SCREEN;

  constructor(events: Event[]) {
    super({ panes: [PANE] });
    this.events = events;
  }

  override async capture(_terminal: TerminalEndpointRef): Promise<string> {
    return this.screen;
  }

  override async sendText(
    _terminal: TerminalEndpointRef,
    text: string
  ): Promise<void> {
    this.events.push(`text:${text}`);
    this.screen = COMPOSER_SCREEN;
  }

  override async sendKeys(
    _terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    this.events.push(`keys:${keys.join(",")}`);
  }
}

async function fixture() {
  const adapter = createClaudeTerminalAgentAdapter();
  const registry = createTerminalAgentAdapterRegistry([adapter]);
  const events: Event[] = [];
  const provider = new RecordingNativeInspectionProvider(events);
  const endpoint = (await provider.listTerminals())[0];
  assert.ok(endpoint);
  const control = provider.toControlRef(
    endpoint,
    terminalControlCapabilitiesForAdapter(adapter)
  );
  let nowMs = 0;
  const service = new TerminalNativeInspectionBridge<string>({
    registry,
    terminalProvider: provider,
    runtime: {
      verifyIdentity: async (_agent, currentControl) => {
        events.push("verify");
        return currentControl;
      },
      captureInspection: async (currentAdapter, currentControl, options) => {
        events.push("capture");
        const screen = await provider.capture(provider.endpoint(currentControl));
        return {
          terminalControl: currentControl,
          screen,
          inspection: currentAdapter.inspectScreen({
            screen,
            runtime: options.runtime
          })
        };
      },
      statusFromInspection: () => "status",
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        events.push(`sleep:${milliseconds}`);
        nowMs += milliseconds;
      }
    }
  });
  const capabilities = probeClaudeNativeInspection("2.1.218");
  const plan = planClaudeNativeInspection({ kind: "status" }, capabilities);
  return { events, provider, service, control, plan };
}

test("closed native inspection keeps one text and Enter around the reservation hook", async () => {
  const { events, service, control, plan } = await fixture();

  const result = await service.submitNativeInspection(
    "claude",
    control,
    plan,
    {
      runtime: RUNTIME,
      beforeEnter: () => {
        events.push("before_enter");
      }
    }
  );

  assert.equal(result.stage, "enter_dispatched");
  assert.equal(result.enterCount, 1);
  assert.equal(result.materialization.kind, "exact_slash_popup");
  assert.ok(result.materialization.stableForMs >= 80);
  assert.equal(events.filter((event) => event === "text:/status").length, 1);
  assert.equal(events.filter((event) => event === "keys:C-m").length, 1);

  const textIndex = events.indexOf("text:/status");
  const reservationIndex = events.indexOf("before_enter");
  const enterIndex = events.indexOf("keys:C-m");
  assert.ok(textIndex >= 0 && textIndex < reservationIndex);
  assert.ok(reservationIndex < enterIndex);
  assert.equal(events.slice(reservationIndex + 1, enterIndex).includes("capture"), true);
  assert.equal(events.slice(reservationIndex + 1, enterIndex).includes("verify"), true);
});

test("post-reservation composer drift sends zero Enter and remains non-retryable", async () => {
  const { events, provider, service, control, plan } = await fixture();

  await assert.rejects(
    service.submitNativeInspection(
      "claude",
      control,
      plan,
      {
        runtime: RUNTIME,
        beforeEnter: () => {
          events.push("before_enter");
          provider.screen = COMPOSER_SCREEN.replace("/usage", "/doctor");
        }
      }
    ),
    (error: unknown) => {
      assert.equal(
        error instanceof Error ? error.message : String(error),
        "Claude Code /status composer changed after its stable pre-submit capture"
      );
      assert.equal(
        typeof error === "object" && error !== null && "stage" in error
          ? error.stage
          : undefined,
        "text_injected"
      );
      assert.equal(
        typeof error === "object" && error !== null && "doNotRetry" in error
          ? error.doNotRetry
          : undefined,
        true
      );
      return true;
    }
  );
  assert.equal(events.includes("text:/status"), true);
  assert.equal(events.some((event) => event.startsWith("keys:")), false);
});
