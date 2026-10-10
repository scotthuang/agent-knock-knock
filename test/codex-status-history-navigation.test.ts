import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { captureCodexStatusHistory } from "../src/codex-status-history-navigation.js";
import { observeCodexNativeInspection } from "../src/codex-terminal-agent-adapter.js";
import { stripTerminalEscapeSequences, type TerminalCodexStatusProbeResult } from "../src/terminal-native-inspection-bridge.js";

// Sanitized literal geometry from native 0.159.2, owned 91x24 viewport.
// PageUp reveals the real header and exactly one overlapping continuation row.
const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const HEADER = [
  "/status", "", "  >_ OpenAI Codex (v0.159.2)", "",
  "  Visit https://chatgpt.com/codex/settings/usage for up-to-date",
  "  information on rate limits and credits"
];
const FIELDS = [
  "  information on rate limits and credits", "",
  "  Server:              Local background server", "",
  "  Model:               GPT-6-Astra (reasoning high, summaries auto)",
  "  Model provider:      openai",
  "  Directory:           /repo",
  "  Permissions:         Full Access",
  "  Agents.md:           <none>",
  "  Account:             Pro (More)",
  "  Thread name:         Compatibility test",
  "  Collaboration mode:  Default",
  `  Session:             ${THREAD}`, "",
  "  Context window:      98% left (17.2K used / 258K)",
  "  Weekly limit:        [████████░░░░░░░░░░░░] 39% left",
  "  Credits:             62500 credits"
];
const COMPOSER = [
  "", "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
  "  GPT-6-Astra high · /repo · Compatibility test",
  "  ← for agents · ? for shortcuts                                 ⚠ 2 warnings · f2 to view"
];
const PAUSED_COMPOSER = [
  "", "                                  ↓ Back to bottom · esc", "",
  ...COMPOSER.slice(1, -1),
  "  enter/esc latest · ? shortcuts                                 ⚠ 2 warnings · f2 to view"
];
const LATEST = ["› Prior user prompt pinned by native UI", ...FIELDS, ...COMPOSER].join("\n");
const PAUSED = ["• Prior completed response", "", ...HEADER, ...PAUSED_COMPOSER].join("\n");
const COMPLETE = [...HEADER.slice(0, -1), ...FIELDS, ...COMPOSER].join("\n");
const RECEIPT = {
  stage: "enter_dispatched", agent: "codex", command: "/status", enterCount: 1,
  behaviorProfile: "codex-tui-0.159.2", observationBaselineDigest: "a".repeat(64),
  preEnterEvidenceInventory: []
} as unknown as TerminalCodexStatusProbeResult;

function run(input: {
  screen?: string; version?: string; receipt?: TerminalCodexStatusProbeResult | null;
  frames?: readonly string[]; failKey?: "PageUp" | "C-End";
  scroll?: boolean; viewport?: { columns: number; rows: number };
} = {}) {
  const keys: string[] = [];
  let captures = 0;
  const frames = input.frames ?? [LATEST, PAUSED, PAUSED, LATEST];
  const result = captureCodexStatusHistory({
    screen: input.screen ?? LATEST, version: input.version ?? "0.159.2",
    submission: input.receipt === null ? undefined : input.receipt ?? RECEIPT,
    ports: {
      capture: async () => frames[Math.min(captures++, frames.length - 1)]!,
      sendKey: async (key) => { keys.push(key); if (key === input.failKey) throw new Error("identity changed before key"); },
      sleep: async (ms) => { assert.equal(ms, 50); },
      ...(input.scroll ? {
        inspectViewport: async () => input.viewport ?? { columns: 91, rows: 29 },
        scrollHistoryDown: async (viewport: { columns: number; rows: number }) => {
          assert.deepEqual(viewport, input.viewport ?? { columns: 91, rows: 29 });
          keys.push("WheelDown");
        }
      } : {})
    }
  });
  return { result, keys, count: () => captures };
}

test("short native viewport joins captured unique overlap, then restores latest before exposing identity", async () => {
  const h = run();
  const screen = await h.result;
  const observed = observeCodexNativeInspection({ operation: { kind: "status" }, expectedAgentVersion: "0.159.2", screen: stripTerminalEscapeSequences(screen) });
  assert.equal(observed.status, "observed");
  assert.equal(observed.nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
  assert.equal(h.count(), 4);
  assert.ok(!screen.includes("Prior completed response"));
  assert.ok(!screen.includes("Back to bottom"));
});

test("0.162.1 clipped status recovers the new usage preamble through exact history overlap", async () => {
  const modern = (screen: string) => screen.replace("v0.159.2", "v0.162.1")
    .replace("https://chatgpt.com/codex/settings/usage", "https://chatgpt.com/settings/usage");
  // This narrow viewport retains the usage row but clips the command/header.
  const latest = [HEADER[4]!, ...FIELDS, ...COMPOSER].join("\n");
  const h = run({ version: "0.162.1", screen: modern(latest),
    receipt: { ...RECEIPT, behaviorProfile: "codex-tui-0.162.1" },
    frames: [modern(latest), modern(PAUSED), modern(PAUSED), modern(latest)] });
  const observed = observeCodexNativeInspection({ operation: { kind: "status" },
    expectedAgentVersion: "0.162.1", screen: stripTerminalEscapeSequences(await h.result) });
  assert.equal(observed.status, "observed");
  assert.equal(observed.nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
  const unknown = run({ version: "0.162.1",
    receipt: { ...RECEIPT, behaviorProfile: "codex-tui-0.162.1" },
    screen: modern(latest).replace("https://chatgpt.com/settings/usage", "https://example.test/usage") });
  await unknown.result;
  assert.deepEqual(unknown.keys, []);
});

test("verified and unverified frontends reuse history navigation only with the exact status profile and UI", async () => {
  for (const [version, behaviorProfile] of [
    ["0.159.3", "codex-tui-0.159.3"], ["0.160.0", "codex-tui-0.160.0"],
    ["0.160.1", "codex-tui-fullscreen-status-v1@0.160.1"],
    ["1.0.0", "codex-tui-fullscreen-status-v1@1.0.0"]
  ]) {
    const paused = PAUSED.replace("v0.159.2", `v${version}`);
    const receipt = { ...RECEIPT, behaviorProfile };
    const h = run({ version, receipt, frames: [LATEST, paused, paused, LATEST] });
    const observed = observeCodexNativeInspection({ operation: { kind: "status" },
      expectedAgentVersion: version, screen: stripTerminalEscapeSequences(await h.result) });
    assert.equal(observed.status, "observed");
    assert.equal(observed.nativeThreadId, THREAD);
    assert.deepEqual(h.keys, ["PageUp", "C-End"]);
    const changed = run({ version, receipt,
      screen: LATEST.replace("? for shortcuts", "unknown pager") });
    await changed.result;
    assert.deepEqual(changed.keys, []);
  }
});

test("active 91x29 viewport with only the command clipped recovers its real command through unique version-header overlap", async () => {
  const active = [
    "› Prior user prompt pinned by native UI", ...HEADER.slice(2, -1), ...FIELDS,
    "", "◦ Working (15s • esc to interrupt)", ...COMPOSER
  ].join("\n");
  const paused = ["• Prior completed response", "", ...HEADER.slice(0, 3), ...PAUSED_COMPOSER].join("\n");
  const busyPaused = paused.replace(PAUSED_COMPOSER.join("\n"), ["", "◦ Working (15s • esc to interrupt)", ...PAUSED_COMPOSER].join("\n"));
  const h = run({ screen: active, frames: [active, busyPaused, busyPaused, active.replace("(15s •", "(16s •")] });
  const result = await h.result;
  assert.equal(observeCodexNativeInspection({
    operation: { kind: "status" }, expectedAgentVersion: "0.159.2",
    screen: stripTerminalEscapeSequences(result)
  }).nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

test("repeated identical pre-Enter status inventory does not replace the fresh closed-command transition", async () => {
  const inventory = observeCodexNativeInspection({ operation: { kind: "status" }, screen: stripTerminalEscapeSequences(COMPLETE) }).evidenceInventory!;
  const h = run({ receipt: { ...RECEIPT, preEnterEvidenceInventory: inventory } });
  await h.result;
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

test("active native timer drift outside the captured static card does not invalidate restoration", async () => {
  const active = LATEST.replace(COMPOSER.join("\n"), ["", "• Working (3s • esc to interrupt)", "  └ Tip: Keep working.", ...COMPOSER].join("\n"));
  const busyPaused = PAUSED.replace(PAUSED_COMPOSER.join("\n"), ["", "• Working (3s • esc to interrupt)", "  └ Tip: Keep working.", ...PAUSED_COMPOSER].join("\n"));
  const h = run({ screen: active, frames: [active, busyPaused, busyPaused, active.replace("(3s •", "(4s •")] });
  assert.match(await h.result, /Working \(3s/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

for (const [name, screen, version, receipt] of [
  ["complete card", COMPLETE, "0.159.2", RECEIPT],
  ["mismatched version receipt", LATEST, "0.159.3", RECEIPT],
  ["legacy bordered profile", LATEST, "0.158.0", RECEIPT],
  ["unowned prior history", LATEST, "0.159.2", null],
  ["wrong command receipt", LATEST, "0.159.2", { ...RECEIPT, command: "/model" }],
  ["unchanged pre-Enter capture", LATEST, "0.159.2", { ...RECEIPT, observationBaselineDigest: createHash("sha256").update(LATEST).digest("hex") }],
  ["real draft", LATEST.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "user draft"), "0.159.2", RECEIPT],
  ["copy selection footer", LATEST.replace(/  ← for agents · \? for shortcuts[^\n]*/u, "  ctrl+c copy · enter copy & follow · esc clear"), "0.159.2", RECEIPT],
  ["unrelated transcript prefix", LATEST.replace(FIELDS[0]!, "This is arbitrary model prose"), "0.159.2", RECEIPT],
  ["missing UUID", LATEST.replace(THREAD, "truncated"), "0.159.2", RECEIPT],
  ["mismatched visible native version", LATEST.replace(FIELDS[0]!, "  >_ OpenAI Codex (v0.159.0)\n" + FIELDS[0]), "0.159.2", RECEIPT]
] as const) {
  test(`history navigation emits no key for ${name}`, async () => {
    const h = run({ screen, version, receipt: receipt as TerminalCodexStatusProbeResult | null });
    assert.equal(await h.result, screen);
    assert.deepEqual(h.keys, []);
  });
}

for (const [name, paused, message] of [
  ["mismatched overlap", PAUSED.replace(FIELDS[0]!, "  unrelated continuation"), /overlap is missing/u],
  ["duplicated overlap", PAUSED.replace(HEADER[2]!, `${HEADER[2]}\n${FIELDS[0]}`), /not unique/u],
  ["version mismatch", PAUSED.replace("v0.159.2", "v0.159.0"), /incomplete or ambiguous/u],
  ["foreign identity field", PAUSED.replace(HEADER[2]!, `${HEADER[2]}\n  Session:             00000000-0000-0000-0000-000000000000`), /incomplete or ambiguous/u],
  ["newest command belongs to another surface", PAUSED.replace("/status", "/model"), /latest \/status command/u]
] as const) {
  test(`bad reconstructed status ${name} restores latest and refuses identity`, async () => {
    const h = run({ frames: [LATEST, paused, paused, LATEST] });
    await assert.rejects(h.result, message);
    assert.deepEqual(h.keys, ["PageUp", "C-End"]);
  });
}

test("draft/modal/selection drift after PageUp forbids blind restoration input", async () => {
  const draft = PAUSED.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "new user draft");
  const h = run({ frames: [LATEST, draft] });
  await assert.rejects(h.result, /lost its exact Composer/u);
  assert.deepEqual(h.keys, ["PageUp"]);
});

test("unknown history footer before restoration forbids Ctrl+End", async () => {
  const h = run({ frames: [LATEST, PAUSED, PAUSED.replace("enter/esc latest · ? shortcuts", "ctrl+c copy · enter copy & follow · esc clear")] });
  await assert.rejects(h.result, /changed before restoring/u);
  assert.deepEqual(h.keys, ["PageUp"]);
});

test("unchanged PageUp is bounded and never retried", async () => {
  const h = run({ frames: [LATEST] });
  await assert.rejects(h.result, /did not expose a proven paused/u);
  assert.deepEqual(h.keys, ["PageUp"]);
  assert.equal(h.count(), 9);
});

test("changed Session during restore withholds reconstructed identity", async () => {
  const h = run({ frames: [LATEST, PAUSED, PAUSED, LATEST.replace(THREAD, "00000000-0000-0000-0000-000000000000")] });
  await assert.rejects(h.result, /did not restore its exact latest card tail/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

for (const failKey of ["PageUp", "C-End"] as const) {
  test(`identity/transport failure before ${failKey} is not retried`, async () => {
    const h = run({ failKey });
    await assert.rejects(h.result, /identity changed/u);
    assert.deepEqual(h.keys, failKey === "PageUp" ? ["PageUp"] : ["PageUp", "C-End"]);
  });
}

const ASYNC_CHROME = ["", "◦ Working (8m 58s • esc to interrupt)", "", "• Queued follow-up inputs", "  ? 1 question", "    shift+← to answer"];
const BLANK_LATEST = ["› Prior user prompt pinned by native UI", ...FIELDS.slice(1), ...ASYNC_CHROME, ...COMPOSER].join("\n");
function pausedAsync(prefix: readonly string[]): string {
  const rows = [...prefix, ...ASYNC_CHROME, ...PAUSED_COMPOSER];
  return [...Array(Math.max(0, 29 - rows.length)).fill(""), ...rows].join("\n");
}
const BLANK_PAUSED = pausedAsync(HEADER);
const BRIDGED_PAUSED = pausedAsync([...HEADER, "", FIELDS[2]!]);

test("paused async chrome is separate from status history; one three-row wheel bridges an actual blank page boundary", async () => {
  const h = run({
    screen: BLANK_LATEST, scroll: true,
    frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, BRIDGED_PAUSED, BRIDGED_PAUSED, BLANK_LATEST]
  });
  const screen = await h.result;
  const observed = observeCodexNativeInspection({ operation: { kind: "status" }, expectedAgentVersion: "0.159.2", screen: stripTerminalEscapeSequences(screen) });
  assert.equal(observed.status, "observed");
  assert.equal(observed.nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
});

test("blank-only overlap without a closed wheel capability remains rejected and restored", async () => {
  const h = run({ screen: BLANK_LATEST, frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, BLANK_LATEST] });
  await assert.rejects(h.result, /overlap is missing or ambiguous/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

for (const viewport of [{ columns: 79, rows: 29 }, { columns: 91, rows: 28 }]) {
  test(`wheel refuses unproven viewport ${viewport.columns}x${viewport.rows} without emitting mouse input`, async () => {
    const h = run({ screen: BLANK_LATEST, scroll: true, viewport,
      frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, BLANK_PAUSED, BLANK_LATEST] });
    await assert.rejects(h.result, /lacks an exact paused transcript viewport/u);
    assert.deepEqual(h.keys, ["PageUp", "C-End"]);
  });
}

test("unchanged wheel result is bounded, never repeated, and safely restored", async () => {
  const h = run({ screen: BLANK_LATEST, scroll: true,
    frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, ...Array(9).fill(BLANK_PAUSED), BLANK_LATEST] });
  await assert.rejects(h.result, /did not provide a unique nonblank status overlap/u);
  assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
});

test("arbitrary paused prose cannot masquerade as native working or queued chrome", async () => {
  const bad = BLANK_PAUSED.replace("  ? 1 question", "  Session:             00000000-0000-0000-0000-000000000000");
  const h = run({ screen: BLANK_LATEST, scroll: true, frames: [BLANK_LATEST, bad] });
  await assert.rejects(h.result, /lost its exact Composer or native footer/u);
  assert.deepEqual(h.keys, ["PageUp"]);
});

test("wheel is unavailable for a missing nonblank overlap even when a provider supports it", async () => {
  const bad = PAUSED.replace(FIELDS[0]!, "  unrelated continuation");
  const h = run({ scroll: true, frames: [LATEST, bad, bad, LATEST] });
  await assert.rejects(h.result, /overlap is missing/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

test("multiple nonblank overlap candidates never authorize the blank-boundary wheel fallback", async () => {
  const server = FIELDS[2]!;
  const duplicateTail = BLANK_LATEST.replace(server, `${server}\n\n${server}`);
  const ambiguous = pausedAsync([...HEADER, "", server, "", server]);
  const h = run({ screen: duplicateTail, scroll: true,
    frames: [duplicateTail, ambiguous, ambiguous, duplicateTail] });
  await assert.rejects(h.result, /overlap is ambiguous/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});


test("Herdr 0.159.0 paused separator hides the header below a command-only stub; one wheel supplies the required observed header overlap", async () => {
  const active = ["› Prior user prompt pinned by native UI", ...HEADER.slice(2, -1), ...FIELDS,
    "", "• Working (14s • esc to interrupt)", ...COMPOSER].join("\n").replaceAll("v0.159.2", "v0.159.0");
  const paused = (prefix: readonly string[]) => {
    const rows = [...prefix, "", "• Working (17s • esc to interrupt)", ...PAUSED_COMPOSER];
    return [...Array(Math.max(0, 29 - rows.length)).fill(""), ...rows].join("\n").replaceAll("v0.159.2", "v0.159.0");
  };
  const stub = paused(["/status", ""]);
  const withHeader = paused(HEADER.slice(0, 3));
  const h = run({ screen: active, version: "0.159.0", scroll: true,
    receipt: { ...RECEIPT, behaviorProfile: "codex-tui-0.159.0" },
    frames: [active, stub, stub, withHeader, withHeader, active.replace("(14s •", "(19s •")] });
  assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, expectedAgentVersion: "0.159.0",
    screen: stripTerminalEscapeSequences(await h.result) }).nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
});

for (const prefix of [
  ["/status", "This is arbitrary prose"],
  ["/status", "", "  >_ OpenAI Codex (v0.159.0)", ""],
  ["/status", "", ...HEADER.slice(2), "  Session:             00000000-0000-0000-0000-000000000000"]
]) {
  test(`incompatible partial status prefix refuses wheel ${JSON.stringify(prefix)}`, async () => {
    const paused = pausedAsync(prefix);
    const h = run({ screen: BLANK_LATEST, scroll: true,
      frames: [BLANK_LATEST, paused, paused, BLANK_LATEST] });
    await assert.rejects(h.result, /overlap is missing/u);
    assert.deepEqual(h.keys, ["PageUp", "C-End"]);
  });
}


for (const [initial, during, restored] of [
  ["", " · 20s", " · 19s"], [" · 20s", " · 19s", " · 18s"], [" · 1s", "", ""]
]) {
  test(`native optional question countdown can appear, advance, or disappear during one history read ${initial}/${during}/${restored}`, async () => {
    const withTimer = (screen: string, timer: string) => screen.replace("  ? 1 question", `  ? 1 question${timer}`);
    const latest = withTimer(BLANK_LATEST, initial);
    const before = withTimer(BLANK_PAUSED, initial);
    const after = withTimer(BRIDGED_PAUSED, during);
    const h = run({ screen: latest, scroll: true,
      frames: [latest, before, before, after, after, withTimer(BLANK_LATEST, restored)] });
    assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, expectedAgentVersion: "0.159.2",
      screen: stripTerminalEscapeSequences(await h.result) }).nativeThreadId, THREAD);
    assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
  });
}

test("unknown countdown text never weakens the paused history footer guard", async () => {
  const bad = BRIDGED_PAUSED.replace("  ? 1 question", "  ? 1 question · 21s");
  const h = run({ screen: BLANK_LATEST, scroll: true,
    frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, bad, bad] });
  await assert.rejects(h.result, /changed before restoring latest/u);
  assert.deepEqual(h.keys, ["PageUp", "WheelDown"]);
});


function withNewActivity(screen: string): string {
  return screen.replace("enter/esc latest · ? shortcuts", "New activity · enter/esc latest · ? shortcuts")
    .replace("↓ Back to bottom · esc", "New activity · ↓ Back to bottom · esc");
}

test("the exact native New activity footer and return control still permit guarded restoration", async () => {
  const newActivity = withNewActivity(PAUSED);
  const h = run({ frames: [LATEST, newActivity, newActivity, LATEST] });
  assert.equal(observeCodexNativeInspection({ operation: { kind: "status" }, expectedAgentVersion: "0.159.2",
    screen: stripTerminalEscapeSequences(await h.result) }).nativeThreadId, THREAD);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

test("native New activity never substitutes new task output for the exact restored status tail", async () => {
  const newActivity = withNewActivity(PAUSED);
  const changed = LATEST.replace(`  Session:             ${THREAD}`, "• A new task completed.");
  const h = run({ frames: [LATEST, newActivity, newActivity, changed] });
  await assert.rejects(h.result, /did not restore its exact latest card tail/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

for (const prefix of ["Arbitrary activity · ", "New task · ", "New activity · New activity · "]) {
  test(`unrecognized history status prefix never authorizes restoration: ${prefix}`, async () => {
    const unproven = PAUSED.replace("enter/esc latest", `${prefix}enter/esc latest`)
      .replace("↓ Back to bottom", `${prefix}↓ Back to bottom`);
    const h = run({ frames: [LATEST, unproven] });
    await assert.rejects(h.result, /lost its exact Composer or native footer/u);
    assert.deepEqual(h.keys, ["PageUp"]);
  });
}


test("known completion while paused permits only restoration and withholds identity when new output replaces the card", async () => {
  const active = LATEST.replace(COMPOSER.join("\n"), ["", "• Working (3s • esc to interrupt)", ...COMPOSER].join("\n"));
  const activePaused = PAUSED.replace(PAUSED_COMPOSER.join("\n"), ["", "• Working (3s • esc to interrupt)", ...PAUSED_COMPOSER].join("\n"));
  const completedPaused = withNewActivity(PAUSED);
  const completedLatest = ["• Task completed.", ...COMPOSER].join("\n");
  const h = run({ screen: active, frames: [active, activePaused, completedPaused, completedLatest] });
  await assert.rejects(h.result, /did not restore its exact latest card tail/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});

test("changed valid native pending-question count permits restoration without weakening reconstruction", async () => {
  const changed = withNewActivity(BRIDGED_PAUSED.replace("  ? 1 question", "  ? 2 questions"));
  const h = run({ screen: BLANK_LATEST, scroll: true,
    frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, BRIDGED_PAUSED, changed, BLANK_LATEST] });
  await h.result;
  assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
});

test("changed question chrome before reconstruction still refuses identity, while restoring a known native paused surface", async () => {
  const changed = withNewActivity(BRIDGED_PAUSED.replace("  ? 1 question", "  ? 2 questions"));
  const h = run({ screen: BLANK_LATEST, scroll: true,
    frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, changed, changed, BLANK_LATEST] });
  await assert.rejects(h.result, /lost its exact paused viewport/u);
  assert.deepEqual(h.keys, ["PageUp", "WheelDown", "C-End"]);
});

test("malformed current question chrome and user drafts do not authorize restore-only navigation", async () => {
  for (const changed of [
    BRIDGED_PAUSED.replace("  ? 1 question", "  ? 2 question"),
    BRIDGED_PAUSED.replace("\x1b[2mAsk Codex to do anything\x1b[0m", "a new user draft")
  ]) {
    const h = run({ screen: BLANK_LATEST, scroll: true,
      frames: [BLANK_LATEST, BLANK_PAUSED, BLANK_PAUSED, BRIDGED_PAUSED, withNewActivity(changed)] });
    await assert.rejects(h.result, /changed before restoring latest/u);
    assert.deepEqual(h.keys, ["PageUp", "WheelDown"]);
  }
});


test("completion in the first PageUp frame still restores known native history and rejects the interrupted binding", async () => {
  const active = LATEST.replace(COMPOSER.join("\n"), ["", "• Working (3s • esc to interrupt)", ...COMPOSER].join("\n"));
  const completed = withNewActivity(PAUSED);
  const h = run({ screen: active, frames: [active, completed, completed, LATEST] });
  await assert.rejects(h.result, /lost its exact Composer or native footer/u);
  assert.deepEqual(h.keys, ["PageUp", "C-End"]);
});
