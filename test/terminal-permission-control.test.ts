import assert from "node:assert/strict";
import test from "node:test";
import {
  discoverTerminalPermissionOptions,
  permissionModeFromStatus,
  switchTerminalPermissions,
  terminalPermissionControlProfileFor,
  TerminalPermissionInputUncertainError,
  type PermissionCapture,
  type TerminalPermissionControlPorts,
  type TerminalPermissionStatus
} from "../src/terminal-permission-control.js";
import { observeCodexPermissionSurface, type CodexPermissionId,
  type CodexPermissionRow } from "../src/codex-permission-surface.js";
import { inspectCodexScreen } from "../src/codex-terminal-agent-adapter.js";
import { inspectNativeQuestionnaire } from "../src/terminal-questionnaire-adapter.js";
import {
  codexBlockingModalVisible,
  terminalUserExplicitInputOwnerBlocked,
  terminalUserExplicitInputSafetyFailure
} from "../src/terminal-composer-classifier.js";

const profile = terminalPermissionControlProfileFor("0.159.2")!;
const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
type InputAction = Parameters<TerminalPermissionControlPorts["input"]>[0];

// Final picker frame from the owned Codex 0.160.0 granular-menu native capture.
// Keep its wrapped selected description and SGR transitions. The selected first
// row is not a '(current)' marker; all three standard presets are inactive.
const GRANULAR_PICKER = [
  "  \x1b[1mUpdate Model Permissions\x1b[0m", "", "",
  "\x1b[1;7m› 1. Ask for approval  \x1b[0;7mRead and edit workspace files and run commands, with approval required for internet access or edits outside the\x1b[1m",
  "                       \x1b[0;7mworkspace\x1b[1m",
  "\x1b[0m  2. Approve for me    \x1b[2mOnly ask for actions detected as potentially unsafe\x1b[0m",
  "  3. Full Access       \x1b[2mUse with caution: Codex can edit files outside this workspace and access the internet without approval\x1b[0m", "",
  "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
].join("\n");

function granularNativePane() {
  const parsed = observeCodexPermissionSurface(GRANULAR_PICKER);
  assert.ok(parsed.state === "picker");
  assert.equal(parsed.selectedIndex, 0);
  assert.equal(parsed.rows.some((row) => row.current), false);
  return nativePane("workspace_granular", parsed.rows);
}

/** This fake models observable native effects, not the transaction's control flow. */
function nativePane(initial: CodexPermissionId | "workspace_granular" = "ask_for_approval",
  nativeRows?: readonly CodexPermissionRow[]) {
  let state: PermissionCapture["state"] = "idle";
  let current: CodexPermissionId | "workspace_granular" = initial;
  let threadId = THREAD_A;
  let selectedIndex = 0;
  let available: CodexPermissionId[] = ["ask_for_approval", "approve_for_me", "full_access"];
  let statusAfterMutation: TerminalPermissionStatus | undefined;
  let menuCurrentAfterMutation: CodexPermissionId | "workspace_granular" | undefined;
  let menuCurrentBeforeMutation: CodexPermissionId | undefined;
  let omitFullAccessConfirmation = false;
  let inputFailure: ((action: InputAction, frame: PermissionCapture) => boolean) | undefined;
  const inputs: Array<{ action: InputAction; state: PermissionCapture["state"] }> = [];
  const mutations: string[] = [];
  let statusReads = 0;
  const frame = (): PermissionCapture => {
    const fingerprint = [state, selectedIndex, current, available.join(",")].join(":");
    if (state === "picker") {
      return {
        state, fingerprint, selectedIndex,
        rows: available.map((id, index) => ({
          id, index, label: nativeRows?.find((row) => row.id === id)?.label ?? id,
          description: nativeRows?.find((row) => row.id === id)?.description ?? `Native capability ${id}`,
          current: id === (mutations.length > 0
            ? menuCurrentAfterMutation ?? current
            : menuCurrentBeforeMutation ?? current)
        }))
      };
    }
    if (state === "full_access_confirmation") return { state, fingerprint, selectedIndex };
    return { state, fingerprint };
  };
  const commit = (mode: CodexPermissionId) => {
    mutations.push(mode);
    current = mode;
    state = "idle";
  };
  const ports: TerminalPermissionControlPorts = {
    capture: async () => frame(),
    inspectStatus: async () => {
      assert.equal(state, "idle", "status requires the native menu to be closed");
      statusReads += 1;
      return mutations.length > 0 && statusAfterMutation
        ? statusAfterMutation
        : { threadId, mode: current };
    },
    input: async (action, expected) => {
      assert.equal(expected.state, state, "input targets its observed native surface");
      assert.equal(expected.fingerprint, frame().fingerprint, "input uses a fresh surface fingerprint");
      inputs.push({ action, state });
      if (inputFailure?.(action, expected)) {
        throw new TerminalPermissionInputUncertainError("transport may have delivered input");
      }
      if (action === "command") { assert.equal(state, "idle"); state = "command"; return; }
      if (action === "Escape") {
        assert.ok(state === "picker" || state === "command");
        state = state === "picker" ? "idle" : "bare_command";
        return;
      }
      if (action === "C-u") { assert.equal(state, "bare_command"); state = "idle"; return; }
      if (action === "Up" || action === "Down") {
        assert.ok(state === "picker" || state === "full_access_confirmation");
        selectedIndex += action === "Up" ? -1 : 1;
        assert.ok(selectedIndex >= 0);
        return;
      }
      assert.equal(action, "C-m");
      if (state === "command") { state = "picker"; selectedIndex = 0; return; }
      if (state === "picker") {
        const selected = available[selectedIndex]!;
        if (selected === "full_access") {
          state = omitFullAccessConfirmation ? "blocked" : "full_access_confirmation";
          selectedIndex = 1; // Native full access confirmation defaults to Cancel.
        } else commit(selected);
        return;
      }
      assert.equal(state, "full_access_confirmation");
      assert.equal(selectedIndex, 0, "the cancellation row cannot grant full access");
      commit("full_access");
    },
    sleep: async () => undefined
  };
  return {
    ports, inputs, mutations,
    get state() { return state; },
    get statusReads() { return statusReads; },
    changeCurrent: () => { current = "ask_for_approval"; },
    switchThread: () => { threadId = THREAD_B; },
    changeCatalog: () => { available = ["ask_for_approval", "full_access"]; },
    disagreeStatus: (mode: string, differentThread = false) => {
      statusAfterMutation = { threadId: differentThread ? THREAD_B : THREAD_A, mode };
    },
    disagreeMenu: () => { menuCurrentAfterMutation = "ask_for_approval"; },
    omitCurrentMarker: () => { menuCurrentAfterMutation = "workspace_granular"; },
    disagreeInitialMenu: () => { menuCurrentBeforeMutation = "approve_for_me"; },
    omitConfirmation: () => { omitFullAccessConfirmation = true; },
    failInput: (predicate: typeof inputFailure) => { inputFailure = predicate; }
  };
}

test("permission discovery closes its menu without changing permissions", async () => {
  const native = nativePane();
  const result = await discoverTerminalPermissionOptions(profile, native.ports);
  assert.equal(result.current, "ask_for_approval");
  assert.equal(result.scope, "current_session");
  assert.deepEqual(result.choices.map(({ id }) => id), [
    "ask_for_approval", "approve_for_me", "full_access"
  ]);
  assert.equal(native.statusReads, 1);
  assert.equal(native.state, "idle");
  assert.deepEqual(native.mutations, []);
  assert.ok(!native.inputs.some(({ action, state }) => action === "C-m" && state === "picker"));
});

test("0.160 permission offers retain current-session scope and cannot migrate between frontend profiles", async () => {
  const native = nativePane();
  const current = terminalPermissionControlProfileFor("0.160.0")!;
  const offer = await discoverTerminalPermissionOptions(current, native.ports);
  assert.equal(offer.agentVersion, "0.160.0");
  assert.equal(offer.scope, "current_session");
  await assert.rejects(switchTerminalPermissions(profile, "full_access", offer.catalogFingerprint, native.ports),
    /thread or permission catalog changed/u);
  assert.deepEqual(native.mutations, []);
  assert.equal(terminalPermissionControlProfileFor("0.160.1"), undefined);
});

test("projectless granular permissions stay current-only and require an exact status label", async () => {
  assert.equal(permissionModeFromStatus("Workspace (granular)"), "workspace_granular");
  for (const value of [
    "Workspace (Granular)", "Workspace(granular)", "Workspace (granular) ",
    "Workspace (granular\n)", "Workspace (granular, Ask for approval)",
    "Workspace with network access (granular)", "Read Only (granular)",
    "Custom (workspace, granular)", "Profile :workspace (workspace, granular)"
  ]) assert.equal(permissionModeFromStatus(value), undefined, value);
  const native = granularNativePane();
  const current = terminalPermissionControlProfileFor("0.160.0")!;
  const offered = await discoverTerminalPermissionOptions(current, native.ports);
  assert.equal(offered.current, "workspace_granular");
  assert.deepEqual(offered.choices.map(({ id, label }) => ({ id, label })), [
    { id: "ask_for_approval", label: "Ask for approval" },
    { id: "approve_for_me", label: "Approve for me" },
    { id: "full_access", label: "Full Access" }
  ]);
  assert.equal(native.state, "idle");
  assert.deepEqual(native.mutations, []);
  const inputCount = native.inputs.length;
  await assert.rejects(switchTerminalPermissions(current, "workspace_granular", offered.catalogFingerprint, native.ports),
    /must come from the current native permission catalog/u);
  assert.equal(native.inputs.length, inputCount, "a current-only ID must be refused before terminal input");
  native.disagreeInitialMenu();
  await assert.rejects(discoverTerminalPermissionOptions(current, native.ports),
    /menu and fresh \/status disagree/u);
  assert.deepEqual(native.mutations, []);
});

test("granular permissions switch once to an offered preset and prove its current marker on the same thread", async () => {
  const current = terminalPermissionControlProfileFor("0.160.0")!;
  for (const mode of ["ask_for_approval", "approve_for_me", "full_access"]) {
    const native = granularNativePane();
    const offered = await discoverTerminalPermissionOptions(current, native.ports);
    const result = await switchTerminalPermissions(current, mode, offered.catalogFingerprint, native.ports);
    assert.equal(result.outcome, "changed", "granular never implies an already-effective standard preset");
    assert.deepEqual(result.effective, { mode });
    assert.equal(result.defaultsChanged, false);
    assert.equal(result.doNotRetry, false);
    assert.deepEqual(native.mutations, [mode]);
    assert.equal(native.statusReads, 3);
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "picker").length, 1);
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "full_access_confirmation").length,
      mode === "full_access" ? 1 : 0);
    assert.equal(native.state, "idle");
  }
});

test("granular permission offers pin the current state, thread and menu before selection", async () => {
  const current = terminalPermissionControlProfileFor("0.160.0")!;
  for (const change of ["changeCurrent", "switchThread", "changeCatalog"] as const) {
    const native = granularNativePane();
    const offered = await discoverTerminalPermissionOptions(current, native.ports);
    native[change]();
    await assert.rejects(switchTerminalPermissions(current, "full_access", offered.catalogFingerprint, native.ports),
      /thread or permission catalog changed/u);
    assert.deepEqual(native.mutations, []);
    assert.equal(native.state, "idle");
    assert.ok(!native.inputs.some(({ action, state }) => action === "C-m" && state === "picker"));
  }
});

test("granular transitions retain uncertainty when status, thread or current-marker proof disagrees", async () => {
  const current = terminalPermissionControlProfileFor("0.160.0")!;
  for (const mismatch of ["status", "thread", "menu", "missing_marker"] as const) {
    const native = granularNativePane();
    const offered = await discoverTerminalPermissionOptions(current, native.ports);
    if (mismatch === "status") native.disagreeStatus("workspace_granular");
    if (mismatch === "thread") native.disagreeStatus("approve_for_me", true);
    if (mismatch === "menu") native.disagreeMenu();
    if (mismatch === "missing_marker") native.omitCurrentMarker();
    const result = await switchTerminalPermissions(current, "approve_for_me", offered.catalogFingerprint, native.ports);
    assert.equal(result.outcome, "uncertain", mismatch);
    assert.equal(result.doNotRetry, true);
    assert.equal(result.effective, undefined);
    assert.deepEqual(native.mutations, ["approve_for_me"]);
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "picker").length, 1);
  }
});

test("permission offers bind the native thread and live catalog before any mutation", async () => {
  for (const change of ["switchThread", "changeCatalog"] as const) {
    const native = nativePane();
    const offered = await discoverTerminalPermissionOptions(profile, native.ports);
    native[change]();
    await assert.rejects(switchTerminalPermissions(profile, "full_access", offered.catalogFingerprint, native.ports), /thread or permission catalog changed/u);
    assert.deepEqual(native.mutations, []);
    assert.equal(native.state, "idle");
    assert.ok(!native.inputs.some(({ action, state }) => action === "C-m" && state === "picker"));
  }
});

test("a known permission absent from this native menu is not selectable", async () => {
  const native = nativePane();
  const offered = await discoverTerminalPermissionOptions(profile, native.ports);
  await assert.rejects(switchTerminalPermissions(profile, "read_only", offered.catalogFingerprint, native.ports), /not available in this native menu/u);
  assert.equal(native.state, "idle");
  assert.deepEqual(native.mutations, []);
  const inputCount = native.inputs.length;
  const readCount = native.statusReads;
  await assert.rejects(switchTerminalPermissions(profile, "/permissions", offered.catalogFingerprint, native.ports), /must come from/u);
  assert.equal(native.inputs.length, inputCount);
  assert.equal(native.statusReads, readCount);
});

test("already effective permissions cause no selection or persistent mutation", async () => {
  const native = nativePane();
  const offered = await discoverTerminalPermissionOptions(profile, native.ports);
  const result = await switchTerminalPermissions(profile, "ask_for_approval", offered.catalogFingerprint, native.ports);
  assert.equal(result.outcome, "already_effective");
  assert.equal(result.defaultsChanged, false);
  assert.equal(result.doNotRetry, false);
  assert.deepEqual(native.mutations, []);
  assert.equal(native.state, "idle");
});

test("permission writes commit once and verify both status and the current menu marker", async () => {
  for (const mode of ["approve_for_me", "full_access"]) {
    const native = nativePane();
    const offered = await discoverTerminalPermissionOptions(profile, native.ports);
    const result = await switchTerminalPermissions(profile, mode, offered.catalogFingerprint, native.ports);
    assert.equal(result.outcome, "changed");
    assert.deepEqual(result.effective, { mode });
    assert.equal(result.defaultsChanged, false);
    assert.deepEqual(native.mutations, [mode]);
    assert.equal(native.statusReads, 3, "discovery, fresh precondition, and postcondition each read status");
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "picker").length, 1);
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "full_access_confirmation").length, mode === "full_access" ? 1 : 0);
    assert.equal(native.state, "idle");
  }
});

test("changed status, native thread, or menu evidence prevents a success receipt", async () => {
  for (const mismatch of ["status", "thread", "menu"] as const) {
    const native = nativePane();
    const offered = await discoverTerminalPermissionOptions(profile, native.ports);
    if (mismatch === "status") native.disagreeStatus("ask_for_approval");
    if (mismatch === "thread") native.disagreeStatus("approve_for_me", true);
    if (mismatch === "menu") native.disagreeMenu();
    const result = await switchTerminalPermissions(profile, "approve_for_me", offered.catalogFingerprint, native.ports);
    assert.equal(result.outcome, "uncertain", mismatch);
    assert.equal(result.doNotRetry, true);
    assert.equal(result.effective, undefined);
    assert.deepEqual(native.mutations, ["approve_for_me"]);
    assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "picker").length, 1);
  }
});

test("an uncertain input is the final input attempt, including before commit", async () => {
  for (const failureState of ["idle", "picker", "full_access_confirmation"] as const) {
    const native = nativePane();
    const offered = await discoverTerminalPermissionOptions(profile, native.ports);
    let failedAt: number | undefined;
    native.failInput((_action, frame) => {
      if (frame.state !== failureState) return false;
      failedAt = native.inputs.length;
      return true;
    });
    const result = await switchTerminalPermissions(profile, "full_access", offered.catalogFingerprint, native.ports);
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.doNotRetry, true);
    assert.equal(native.inputs.length, failedAt, "no Escape, Enter, or clearing follows an uncertain dispatch");
    assert.deepEqual(native.mutations, []);
  }
  const query = nativePane();
  query.failInput((action) => action === "command");
  await assert.rejects(discoverTerminalPermissionOptions(profile, query.ports), TerminalPermissionInputUncertainError);
  assert.deepEqual(query.inputs, [{ action: "command", state: "idle" }]);
});

test("full access cannot be granted without the exact native confirmation surface", async () => {
  const native = nativePane();
  const offered = await discoverTerminalPermissionOptions(profile, native.ports);
  native.omitConfirmation();
  const result = await switchTerminalPermissions(profile, "full_access", offered.catalogFingerprint, native.ports);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.doNotRetry, true);
  assert.deepEqual(native.mutations, []);
  assert.equal(native.inputs.filter(({ action, state }) => action === "C-m" && state === "picker").length, 1);
  assert.equal(native.inputs.some(({ state }) => state === "blocked"), false);
  assert.equal(native.inputs.some(({ state }) => state === "full_access_confirmation"), false);
});

test("failed cleanup preserves uncertainty instead of hiding it behind a stale-catalog refusal", async () => {
  const query = nativePane();
  query.disagreeInitialMenu();
  query.failInput((action, frame) => action === "Escape" && frame.state === "picker");
  await assert.rejects(discoverTerminalPermissionOptions(profile, query.ports), TerminalPermissionInputUncertainError);
  assert.deepEqual(query.mutations, []);
  assert.equal(query.inputs.at(-1)?.action, "Escape");
  assert.equal(query.inputs.filter(({ action }) => action === "Escape").length, 1);

  const change = nativePane();
  const offered = await discoverTerminalPermissionOptions(profile, change.ports);
  change.switchThread();
  change.failInput((action, frame) => action === "Escape" && frame.state === "picker");
  const result = await switchTerminalPermissions(profile, "full_access", offered.catalogFingerprint, change.ports);
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.doNotRetry, true);
  assert.deepEqual(change.mutations, []);
  assert.equal(change.inputs.at(-1)?.action, "Escape");
});

test("native permission menus cannot be consumed as a task prompt or a generic approval", () => {
  const picker = [
    "\x1b[1m  Update Model Permissions\x1b[0m", "",
    "\x1b[1;7m› 1. Ask for approval (current)  \x1b[0;7mRead and edit workspace files and run commands, with approval required for internet access or edits outside the workspace\x1b[0m",
    "  2. Full Access  Use with caution: Codex can edit files outside this workspace and access the internet without approval",
    "", "  \x1b[2menter select · esc back\x1b[0m"
  ].join("\n");
  const confirmation = [
    "  \x1b[1mEnable full access?\x1b[0m",
    "  When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.",
    "", "\x1b[1;7m› 1. Yes, continue anyway  \x1b[0;7mApply full access for this session\x1b[0m",
    "  2. Cancel  Go back without enabling full access", "",
    "  \x1b[2menter select · esc back\x1b[0m"
  ].join("\n");
  const variants = [
    picker, confirmation,
    picker.replaceAll(/\x1b\[[0-9;]*m/gu, ""),
    confirmation.replace("  2. Cancel  Go back without enabling full access\n", ""),
    picker.slice(0, picker.indexOf("  2. Full Access")),
    "  Update Model Permiss…\n› 1. Ask for approval\n  enter select · esc back",
    "  Enable full acces…\n› 1. Yes, continue anyway\n  enter select · esc back"
  ];
  for (const screen of variants) {
    assert.equal(terminalUserExplicitInputOwnerBlocked(screen), true);
    assert.equal(codexBlockingModalVisible(screen), true);
    assert.match(terminalUserExplicitInputSafetyFailure({
      agent: "codex", displayName: "Codex", screen,
      terminalControl: {
        kind: "tmux", target: "test:0.0", session: "test", window: 0, pane: 0,
        panePid: 42, currentPath: "/repo", capabilities: ["send_keys", "screen_status"]
      },
      approvalBlocked: false, awaitingApproval: false, interactionActive: false,
      modelControlSurface: false, requireExactEmptyClaudeComposer: false
    }) ?? "", /blocked/u);
    const plain = screen.replaceAll(/\x1b\[[0-9;]*m/gu, "");
    for (const agentVersion of ["0.159.2", "0.159.3", "0.160.0"]) {
      const inspected = inspectCodexScreen({ screen: plain, runtime: { agentVersion } });
      assert.equal(inspected.approval.approvable, false);
      assert.notEqual(inspected.activity.state, "idle", "a permission menu cannot complete an activity Watch");
      assert.notEqual(inspectNativeQuestionnaire({ agent: "codex", version: agentVersion, screen }).status, "actionable");
    }
  }
  const laterComposer = [
    "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
    "  GPT-6-Astra high · /repo", "  ← for agents · ? for shortcuts"
  ].join("\n");
  for (const historical of [picker, confirmation]) {
    assert.equal(terminalUserExplicitInputOwnerBlocked(`${historical}\n${laterComposer}`), false);
    assert.equal(codexBlockingModalVisible(`${historical}\n${laterComposer}`), false);
  }
});
