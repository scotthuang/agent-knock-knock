import assert from "node:assert/strict";
import test from "node:test";
import { observeCodexPermissionSurface } from "../src/codex-permission-surface.js";

// Text matches upstream Codex 0.159.2/0.159.3/0.160.0 snapshots. ANSI matches
// SelectionView's native bold heading and selection_style() reverse fallback.
const PICKER = [
  "\x1b[1m  Update Model Permissions\x1b[0m", "", "",
  "\x1b[1;7m› 1. Ask for approval (current)  \x1b[0;7mRead and edit workspace files and run commands,\x1b[0m",
  "                                 with approval required for internet access or",
  "                                 edits outside the workspace",
  "  2. Approve for me              Only ask for actions detected as potentially",
  "                                 unsafe",
  "  3. Full Access                 Use with caution: Codex can edit files outside",
  "                                 this workspace and access the internet without",
  "                                 approval", "",
  "  \x1b[2menter select · esc back\x1b[0m"
].join("\n");
const CONFIRM = [
  "  \x1b[1mEnable full access?\x1b[0m",
  "  When Codex runs with full access, it can edit any file on your computer and",
  "  run commands with network, without your approval. Exercise caution when",
  "  enabling full access. This significantly increases the risk of data loss,",
  "  leaks, or unexpected behavior.", "", "",
  "\x1b[1;7m› 1. Yes, continue anyway  \x1b[0;7mApply full access for this session\x1b[0m",
  "  2. Cancel                Go back without enabling full access", "",
  "  \x1b[2menter select · esc back\x1b[0m"
].join("\n");

// Complete final picker frame from an isolated Codex 0.159.3 tmux capture.
// The transcript above this frame contained the temporary cwd and is omitted.
const NATIVE_PICKER_FRAME = [
  "  \x1b[1mUpdate Model Permissions\x1b[0m", "", "",
  "\x1b[1;7m› 1. Ask for approval  \x1b[0;7mRead and edit workspace files and run commands, with approval required for internet access or edits outside the workspace\x1b[1m",
  "\x1b[0m  2. Approve for me    \x1b[2mOnly ask for actions detected as potentially unsafe\x1b[0m",
  "  3. Full Access       \x1b[2mUse with caution: Codex can edit files outside this workspace and access the internet without approval\x1b[0m", "",
  "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
].join("\n");
const NATIVE_FULL_SELECTED_FRAME = [
  "  \x1b[1mUpdate Model Permissions\x1b[0m", "", "",
  "  1. Ask for approval  \x1b[2mRead and edit workspace files and run commands, with approval required for internet access or edits outside the workspace\x1b[0m",
  "  2. Approve for me    \x1b[2mOnly ask for actions detected as potentially unsafe\x1b[0m",
  "\x1b[1;7m› 3. Full Access       \x1b[0;7mUse with caution: Codex can edit files outside this workspace and access the internet without approval\x1b[1m",
  "\x1b[0m",
  "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
].join("\n");
const NATIVE_CONFIRM_FRAME = [
  "  \x1b[1mEnable full access?\x1b[0m",
  "  When Codex runs with full access, it can edit any file on your computer and run commands with network, without your approval. \x1b[38;5;1mExercise caution when enabling full access. This\x1b[39m",
  "  \x1b[38;5;1msignificantly increases the risk of data loss, leaks, or unexpected behavior.\x1b[39m", "", "",
  "\x1b[1;7m› 1. Yes, continue anyway  \x1b[0;7mApply full access for this session\x1b[1m",
  "\x1b[0m  2. Cancel                \x1b[2mGo back without enabling full access\x1b[0m", "",
  "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back", ""
].join("\n");

test("real Codex 0.159.3 picker accepts the distinct native label and description styles", () => {
  const observed = observeCodexPermissionSurface(NATIVE_PICKER_FRAME);
  assert.equal(observed.state, "picker");
  if (observed.state === "picker") {
    assert.equal(observed.selectedIndex, 0);
    assert.equal(observed.rows.some((row) => row.current), false);
  }
  for (const changed of [
    NATIVE_PICKER_FRAME.replace("\x1b[0;7mRead", "\x1b[1;7mRead"),
    NATIVE_PICKER_FRAME.replace("\x1b[0;7mRead", "\x1b[0mRead"),
    NATIVE_PICKER_FRAME.replace("\x1b[1;7m›", "\x1b[0;7m›")
  ]) assert.equal(observeCodexPermissionSurface(changed).state, "ambiguous");
});

test("real Codex 0.159.3 Full Access selection and confirmation remain separate surfaces", () => {
  const selected = observeCodexPermissionSurface(NATIVE_FULL_SELECTED_FRAME);
  const confirmed = observeCodexPermissionSurface(NATIVE_CONFIRM_FRAME);
  assert.equal(selected.state, "picker");
  assert.equal(confirmed.state, "full_access_confirmation");
  if (selected.state !== "picker" || confirmed.state !== "full_access_confirmation") return;
  assert.equal(selected.selectedIndex, 2);
  assert.equal(selected.rows[2]!.id, "full_access");
  assert.equal(selected.rows[2]!.current, false, "highlight alone does not establish effective permissions");
  assert.equal(confirmed.selectedIndex, 0);
  assert.notEqual(selected.fingerprint, confirmed.fingerprint);
  assert.equal(observeCodexPermissionSurface(NATIVE_CONFIRM_FRAME
    .replace("significantly increases the risk of data loss, leaks, or unexpected behavior.", "[… 1 line]")).state, "ambiguous");
});

test("permission picker preserves native choices, selected position and current permission separately", () => {
  const observed = observeCodexPermissionSurface(PICKER);
  assert.equal(observed.state, "picker");
  if (observed.state !== "picker") return;
  assert.deepEqual(observed.rows.map(({ id, current, index }) => ({ id, current, index })), [
    { id: "ask_for_approval", current: true, index: 0 },
    { id: "approve_for_me", current: false, index: 1 },
    { id: "full_access", current: false, index: 2 }
  ]);
  assert.equal(observed.selectedIndex, 0);
  assert.match(observed.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(observeCodexPermissionSurface(PICKER.replace(" (current)", "")).state, "picker",
    "read-only can be active while absent from the macOS legacy picker");
});

test("full access confirmation requires complete warning and both exact choices", () => {
  const observed = observeCodexPermissionSurface(CONFIRM);
  assert.equal(observed.state, "full_access_confirmation");
  if (observed.state === "full_access_confirmation") assert.equal(observed.selectedIndex, 0);
  for (const changed of [
    CONFIRM.replace("  leaks, or unexpected behavior.\n", ""),
    CONFIRM.replace("  2. Cancel                Go back without enabling full access\n", ""),
    CONFIRM.replace("Apply full access for this session", "Approve all future sessions"),
    CONFIRM.replace("\x1b[1;7m", "\x1b[1m")
  ]) assert.equal(observeCodexPermissionSurface(changed).state, "ambiguous");
});

test("permission controls reject transcript lookalikes, clipping, disabled choices and extra input", () => {
  for (const changed of [
    PICKER.replace(/\x1b\[[0-9;]*m/gu, ""),
    PICKER.replace("\x1b[1m  Update", "  Update"),
    PICKER.replace("\x1b[1;7m", "\x1b[1m"),
    PICKER.replace("  3. Full Access", "     Full Access (disabled)"),
    PICKER.replace("  3. Full Access", "  3. custom-profile"),
    PICKER.replace("  3. Full Access", "  4. Full Access"),
    PICKER.replace("                                 approval\n", ""),
    PICKER.replace("  3. Full Access", "  3. Full Access (current)"),
    `${PICKER}\n› send a task`,
    `${PICKER}\n  enter select · esc back`,
    `${PICKER}\n${PICKER}`
  ]) assert.equal(observeCodexPermissionSurface(changed).state, "ambiguous");
  assert.deepEqual(observeCodexPermissionSurface("› Ready for your task"), { state: "none" });
});

test("permission selection recognizes the verified truecolor native highlight", () => {
  const truecolor = PICKER
    .replace("\x1b[1;7m", "\x1b[1;38;2;0;0;46;48;2;99;168;248m")
    .replace("\x1b[0;7m", "\x1b[0;38;2;0;0;46;48;2;99;168;248m");
  const observed = observeCodexPermissionSurface(truecolor);
  assert.equal(observed.state, "picker");
  assert.equal(observeCodexPermissionSurface(truecolor.replaceAll("99;168;248", "10;20;30")).state, "ambiguous");
});
