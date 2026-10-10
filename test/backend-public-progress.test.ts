import assert from "node:assert/strict";
import test from "node:test";
import { backendPublicProgress, backendPublicProgressReadError, DEFAULT_PUBLIC_PROGRESS_CODE_POINTS,
  type BackendProgressItem } from "../src/backend-public-progress.js";
import { reduceDesktopSnapshot } from "../src/desktop-snapshot.js";

const READ = "2026-10-10T12:00:00.000Z", START = Date.parse("2026-10-10T11:59:00.000Z");
const commentary = (text: string, extra: Partial<BackendProgressItem> = {}): BackendProgressItem =>
  ({ id: "commentary", type: "agentMessage", phase: "commentary", text, ...extra });
function progress(items: BackendProgressItem[]) {
  return backendPublicProgress({ nativeTurnId: "exact-turn", readAt: READ,
    turn: { id: "exact-turn", itemsComplete: true, items } });
}

test("public progress shares one 800-code-point budget and retains complete multilingual graphemes", () => {
  const graphemes = ["中", "👨‍👩‍👧‍👦", "e\u0301", "👍🏽", "🇨🇳"];
  for (const grapheme of graphemes) {
    const result = progress([commentary(grapheme.repeat(900)),
      { id: "command", type: "commandExecution", status: "completed", exitCode: 0 },
      { id: "files", type: "fileChange", status: "inProgress" }]);
    assert.equal(result.state, "available");
    assert.equal(result.truncated, true);
    assert.ok([...result.text].length <= DEFAULT_PUBLIC_PROGRESS_CODE_POINTS);
    const body = result.text.split("\n")[0];
    assert.equal(body.startsWith("…"), true);
    assert.ok(body.length > 1);
    assert.equal(body.slice(1), grapheme.repeat(body.slice(1).length / grapheme.length));
    assert.match(result.text, /Command execution: completed \(exit 0\)\nFile update: in progress$/u);
  }
  const commentaryOnly = progress([commentary("中".repeat(1000))]);
  assert.equal([...commentaryOnly.text].length, 800, "unused action budget belongs to commentary");
});

test("long tool output and private phases cannot displace the latest public commentary", () => {
  const rawItems = [commentary("old public update", { id: "old" }),
    { id: "old-tool", type: "webSearch", status: "completed" },
    commentary("正在构建并核对发布产物。", { startedAtMs: START }),
    { id: "hidden", type: "reasoning", text: "PRIVATE_REASONING", completedAtMs: START + 9000 },
    { id: "analysis", type: "agentMessage", phase: "analysis", text: "PRIVATE_ANALYSIS" },
    { id: "unknown", type: "agentMessage", text: "UNKNOWN_PHASE" },
    { id: "final", type: "agentMessage", phase: "final_answer", text: "DUPLICATE_FINAL" },
    { id: "command", type: "commandExecution", status: "completed", exitCode: 0, completedAtMs: START + 2000,
      command: "PRIVATE_COMMAND", aggregatedOutput: "PRIVATE_STDOUT".repeat(5000) },
    { id: "files", type: "fileChange", status: "inProgress", startedAtMs: START + 1000,
      changes: [{ path: "PRIVATE_PATH", diff: "PRIVATE_DIFF" }], arguments: { token: "PRIVATE_ARGS" } }];
  const result = progress(rawItems);
  assert.equal(result.text, "正在构建并核对发布产物。\nCommand execution: completed (exit 0)\nFile update: in progress");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|DUPLICATE_FINAL|UNKNOWN_PHASE|old public|Web search/u);
  assert.equal(result.latest_item_at, new Date(START + 2000).toISOString());
  assert.equal(result.read_at, READ);
  assert.equal(result.native_turn_id, "exact-turn");
  assert.equal(result.truncated, false);
});

test("public commentary is redacted before truncation and fenced raw output is omitted", () => {
  const secret = "sk-" + "S".repeat(1200);
  const result = progress([commentary(`Build checked ${secret}\npassword="private password"\n`
    + "https://example.test/?token=private-query&x=ok\n"
    + "```text\nPRIVATE_RAW_LOG\n```\n"
    + "Authorization: Bearer private-bearer\n"
    + "NPM_TOKEN=private-env npm_" + "A".repeat(30))]);
  assert.match(result.text, /sk-\[REDACTED\]/u);
  assert.match(result.text, /\[code omitted\]/u);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(result.text, /SSSS|private-password|private password|private-query|PRIVATE_RAW_LOG|private-bearer|private-env|AAAA/u);
  const short = progress([commentary(`Before ${secret} after`)]);
  assert.equal(short.text, "Before sk-[REDACTED] after");
  assert.equal(short.truncated, false, "redaction happens before measuring the body");
});

test("exact turn absence or incomplete reads differ from a successful read with no public progress", () => {
  const noProgress = progress([{ id: "analysis", type: "reasoning", text: "private" },
    commentary("question text", { delivery: "async" }),
    { id: "final", type: "agentMessage", phase: "final_answer", text: "final" }]);
  assert.equal(noProgress.state, "no_public_progress");
  assert.equal(noProgress.text, "");
  assert.equal(noProgress.latest_item_at, null);
  assert.equal(backendPublicProgress({ nativeTurnId: null, readAt: READ }).state, "no_public_progress");
  for (const [turn, reason] of [
    [undefined, "missing_exact_turn"],
    [{ id: "newer-turn", itemsComplete: true, items: [commentary("newer private task")] }, "identity_mismatch"],
    [{ id: "old-turn", itemsComplete: false, items: [commentary("partial")] }, "incomplete_items"]
  ] as const) {
    const result = backendPublicProgress({ nativeTurnId: "old-turn", readAt: READ,
      turn: turn ? { ...turn, items: [...turn.items] } : undefined });
    assert.equal(result.state, "read_error");
    assert.equal(result.reason, reason);
    assert.equal(result.native_turn_id, "old-turn");
    assert.equal(result.text, "");
  }
  assert.deepEqual(backendPublicProgressReadError("old-turn", READ), {
    state: "read_error", native_turn_id: "old-turn", read_at: READ,
    latest_item_at: null, truncated: false, text: "", reason: "read_failed"
  });
});

test("progress timestamps never substitute observation, turn, private item or malformed times", () => {
  assert.equal(progress([commentary("reading")]).latest_item_at, null);
  assert.equal(progress([commentary("reading", { startedAtMs: Number.NaN, completedAtMs: -1 })]).latest_item_at, null);
  const result = progress([commentary("reading", { startedAtMs: START }),
    { id: "private", type: "reasoning", completedAtMs: START + 100_000 }]);
  assert.equal(result.latest_item_at, new Date(START).toISOString());
  assert.notEqual(result.latest_item_at, READ);
});

test("Desktop normalization retains explicitly named native item timestamps for Status only", () => {
  const snapshot = reduceDesktopSnapshot({ id: "thread", hostId: "local", mode: "default", resumeState: "resumed",
    threadRuntimeStatus: { type: "active" }, requests: [], turns: [{ turnId: "exact-turn", status: "inProgress",
      items: [commentary("Desktop update", { startedAtMs: START }),
        { id: "command", type: "commandExecution", status: "completed", completedAtMs: START + 1000,
          aggregatedOutput: "PRIVATE_LOG" }] }] }, { threadId: "thread", ownerClientId: "owner", revision: 1 });
  const result = backendPublicProgress({ nativeTurnId: snapshot.latestTurnId, turn: snapshot.turns[0], readAt: READ });
  assert.equal(result.latest_item_at, new Date(START + 1000).toISOString());
  assert.match(result.text, /^Desktop update/u);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_LOG/u);
});
