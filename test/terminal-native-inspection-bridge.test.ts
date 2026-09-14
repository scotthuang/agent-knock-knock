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
import {
  StaticTerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type { TerminalEndpointRef } from
  "../src/terminal-control-ref.js";
import { TerminalNativeInspectionBridge } from
  "../src/terminal-native-inspection-bridge.js";

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
