import assert from "node:assert/strict";
import test from "node:test";
import { codexTerminalAgentAdapter } from "../src/codex-terminal-agent-adapter.js";
import {
  createTerminalPermissionControlPorts,
  type PermissionBridgeRuntime
} from "../src/terminal-permission-control-bridge.js";
import { TerminalPermissionInputUncertainError } from "../src/terminal-permission-control.js";
import { stripTerminalEscapeSequences } from "../src/terminal-native-inspection-bridge.js";
import { codex1621PermissionConfirmation } from "./fixtures/codex-permission-confirmation-01621.js";

// Actual final command frame from isolated Codex 0.159.3; only cwd redacted.
const COMMAND = [
  "\x1b[1;7m› /permissions  \x1b[0;7mchoose what Codex is allowed to do\x1b[1m", "",
  "\x1b[0;1m›\x1b[0m /permissions", "",
  "  \x1b[38;2;246;226;183mGPT-6.1-Sol high fast\x1b[39m · \x1b[38;2;171;223;167m/repo\x1b[39m",
  "  \x1b[1mtab\x1b[0m to queue message", ""
].join("\n");
const IDLE = [
  "\x1b[1m›\x1b[0m ", "",
  "  GPT-6.1-Sol high fast · /repo",
  "  ? for shortcuts"
].join("\n");
const PICKER = [
  "  \x1b[1mUpdate Model Permissions\x1b[0m", "", "",
  "\x1b[1;7m› 1. Ask for approval  \x1b[0;7mRead and edit workspace files and run commands, with approval required for internet access or edits outside the workspace\x1b[1m",
  "\x1b[0m  2. Approve for me    \x1b[2mOnly ask for actions detected as potentially unsafe\x1b[0m",
  "  3. Full Access       \x1b[2mUse with caution: Codex can edit files outside this workspace and access the internet without approval\x1b[0m", "",
  "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
].join("\n");
const CONFIRM_HEADER = [
  "  \x1b[1mEnable full access?\x1b[0m",
  "  When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. \x1b[38;5;1mExercise caution when enabling full access. This\x1b[39m",
  "  \x1b[38;5;1msignificantly increases the risk of data loss, leaks, or unexpected behavior.\x1b[39m", "", ""
];
function confirmation(selected: 0 | 1): string {
  return [...CONFIRM_HEADER,
    selected === 0
      ? "\x1b[1;7m› 1. Yes, continue anyway  \x1b[0;7mApply full access for this session\x1b[1m"
      : "  1. Yes, continue anyway  \x1b[2mApply full access for this session\x1b[0m",
    selected === 1
      ? "\x1b[1;7m› 2. Cancel                \x1b[0;7mGo back without enabling full access\x1b[1m"
      : "\x1b[0m  2. Cancel                \x1b[2mGo back without enabling full access\x1b[0m", "",
    "  \x1b[0;1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
  ].join("\n");
}

function terminal(screen: string, agentVersion = "0.159.3") {
  const sent: Array<string | readonly string[]> = [];
  const events: string[] = [];
  let verifies = 0;
  const state = { screen, failIdentityAt: 0, failTransport: false,
    beforeInput: () => undefined as void };
  const runtime: PermissionBridgeRuntime = {
    adapter: codexTerminalAgentAdapter, agentVersion,
    runtime: { agentVersion, pid: 101, cwd: "/repo" },
    verifyIdentity: async () => {
      events.push("identity");
      verifies += 1;
      if (verifies === state.failIdentityAt) throw new Error("terminal incarnation changed");
    },
    captureStyled: async () => { events.push("capture"); return state.screen; },
    beforeInput: () => { events.push("fence"); state.beforeInput(); },
    inspectStatus: async () => ({ threadId: "native-thread", mode: "read_only" }),
    sendText: async (text) => {
      events.push("text"); sent.push(text);
      if (state.failTransport) throw new Error("socket closed after dispatch");
    },
    sendKeys: async (keys) => {
      events.push("keys"); sent.push(keys);
      if (state.failTransport) throw new Error("socket closed after dispatch");
    },
    sleep: async () => undefined
  };
  return { state, runtime, sent, events, ports: createTerminalPermissionControlPorts(runtime) };
}

test("native permission command uses its exact styled frame when general activity is unknown", async () => {
  assert.equal(codexTerminalAgentAdapter.inspectScreen({
    screen: stripTerminalEscapeSequences(COMMAND), runtime: { agentVersion: "0.159.3" }
  }).activity.state, "unknown", "native completion replaces the normal idle footer");
  const native = terminal(COMMAND);
  const frame = await native.ports.capture();
  assert.equal(frame.state, "command");
  await native.ports.input("C-m", frame);
  assert.deepEqual(native.sent, [["C-m"]]);
  assert.deepEqual(native.events.slice(3), ["fence", "identity", "capture", "identity", "identity", "keys"]);

  native.state.screen = `• Working (1s • esc to interrupt)\n${COMMAND}`;
  const busy = await native.ports.capture();
  assert.equal(busy.state, "blocked", "positive working evidence still blocks the native completion");
  await assert.rejects(native.ports.input("C-m", busy), /not authorized/u);
  assert.deepEqual(native.sent, [["C-m"]]);
});

test("native permission input requires a single operation-local captured permit", async () => {
  const first = terminal(COMMAND);
  const other = terminal(COMMAND);
  const original = await first.ports.capture();
  await assert.rejects(other.ports.input("C-m", original), /operation-local/u);
  await assert.rejects(first.ports.input("C-m", { ...original }), /operation-local/u);
  assert.deepEqual([...first.sent, ...other.sent], []);
  const fresh = await first.ports.capture();
  await first.ports.input("C-m", fresh);
  await assert.rejects(first.ports.input("C-m", fresh), /operation-local/u);
  assert.deepEqual(first.sent, [["C-m"]]);
});

test("identity, fresh frame and mutation fence changes stop permission input before dispatch", async () => {
  for (const failIdentityAt of [3, 4, 5]) {
    const native = terminal(COMMAND);
    const expected = await native.ports.capture();
    native.state.failIdentityAt = failIdentityAt;
    await assert.rejects(native.ports.input("C-m", expected), /incarnation changed/u);
    assert.deepEqual(native.sent, []);
  }
  const changed = terminal(COMMAND);
  const expected = await changed.ports.capture();
  changed.state.beforeInput = () => { changed.state.screen = COMMAND.replace("high fast", "medium fast"); };
  await assert.rejects(changed.ports.input("C-m", expected), /surface changed/u);
  assert.deepEqual(changed.sent, []);

  const fenced = terminal(IDLE);
  const idle = await fenced.ports.capture();
  assert.equal(idle.state, "idle");
  fenced.state.beforeInput = () => { throw new Error("input owner changed"); };
  await assert.rejects(fenced.ports.input("command", idle), /input owner changed/u);
  assert.deepEqual(fenced.sent, []);
});

test("a permission transport error is uncertain and consumes the dispatch permit", async () => {
  for (const screen of [IDLE, COMMAND]) {
    const native = terminal(screen);
    const frame = await native.ports.capture();
    const action = screen === IDLE ? "command" : "C-m";
    native.state.failTransport = true;
    await assert.rejects(native.ports.input(action, frame), (error: unknown) =>
      error instanceof TerminalPermissionInputUncertainError && error.doNotRetry === true &&
      error.cause instanceof Error && error.cause.message === "socket closed after dispatch");
    await assert.rejects(native.ports.input(action, frame), /operation-local/u);
    assert.equal(native.sent.length, 1, "an uncertain input is not replayed or cleaned up by the bridge");
  }
});

test("owned permission surfaces admit only their scoped keys and exact affirmative confirmation", async () => {
  const yes = terminal(confirmation(0));
  const affirmative = await yes.ports.capture();
  assert.equal(affirmative.state, "full_access_confirmation");
  await yes.ports.input("C-m", affirmative);
  assert.deepEqual(yes.sent, [["C-m"]]);

  const cancel = terminal(confirmation(1));
  const negative = await cancel.ports.capture();
  assert.equal(negative.state, "full_access_confirmation");
  await assert.rejects(cancel.ports.input("C-m", negative), /not authorized/u);
  await cancel.ports.input("Up", await cancel.ports.capture());
  assert.deepEqual(cancel.sent, [["Up"]], "only navigation is allowed while Cancel is selected");

  const picker = terminal(PICKER);
  const selected = await picker.ports.capture();
  assert.equal(selected.state, "picker");
  await assert.rejects(picker.ports.input("command", selected), /not authorized/u);
  await picker.ports.input("Escape", await picker.ports.capture());
  assert.deepEqual(picker.sent, [["Escape"]]);
  const clipped = terminal(confirmation(0).replace("  \x1b[38;5;1msignificantly increases the risk of data loss, leaks, or unexpected behavior.\x1b[39m\n", ""));
  const blocked = await clipped.ports.capture();
  assert.equal(blocked.state, "blocked");
  await assert.rejects(clipped.ports.input("C-m", blocked), /not authorized/u);
  assert.deepEqual(clipped.sent, []);
});

test("permission bridge refuses a mismatched or unreviewed runtime profile before capture", () => {
  const native = terminal(IDLE);
  assert.throws(() => createTerminalPermissionControlPorts({ ...native.runtime, agentVersion: "0.159.4" }), /matching Codex/u);
  assert.throws(() => createTerminalPermissionControlPorts({ ...native.runtime,
    runtime: { ...native.runtime.runtime, agentVersion: "0.159.2" } }), /matching Codex/u);
  assert.deepEqual(native.events, []);
});


test("0.162.1 centered confirmation sends only on a fresh exact affirmative frame", async () => {
  const native = terminal(codex1621PermissionConfirmation(), "0.162.1");
  const yes = await native.ports.capture();
  assert.equal(yes.state, "full_access_confirmation");
  await native.ports.input("C-m", yes);
  assert.deepEqual(native.sent, [["C-m"]]);
  const changed = terminal(codex1621PermissionConfirmation(), "0.162.1");
  const expected = await changed.ports.capture();
  changed.state.beforeInput = () => { changed.state.screen = codex1621PermissionConfirmation(1); };
  await assert.rejects(changed.ports.input("C-m", expected), /surface changed/u);
  assert.deepEqual(changed.sent, []);
  const cancel = await changed.ports.capture();
  assert.equal(cancel.state, "full_access_confirmation");
  await assert.rejects(changed.ports.input("C-m", cancel), /not authorized/u);
  assert.deepEqual(changed.sent, []);
});
