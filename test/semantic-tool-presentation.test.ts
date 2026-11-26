import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  bindHostBridgeToolPresentation,
  formatStatusCommandResult,
  modelFacingToolError,
  toolResult,
  usesHostBridgeToolPresentation
} from "../src/semantic-tool-presentation.js";

test("Desktop Status prints the latest plain answer and identifies a saved turn when live activity is unknown", () => {
  const turn = { id: "manual-turn", status: "completed", items_complete: true, final_text: "Answer from Desktop." };
  const base = { source: "codex_desktop", conversation_id: "fixture" };
  const live = formatStatusCommandResult({ ...base, activity_state: "idle", latest_turn: turn });
  const saved = formatStatusCommandResult({ ...base, activity_state: "unknown", persisted_history: { latest_turn: turn } });
  for (const output of [live, saved]) assert.match(output, /result: Answer from Desktop\./u);
  assert.match(saved, /status: unknown/u);
  assert.match(saved, /latest saved turn: completed/u);
  assert.doesNotMatch(live, /latest saved turn/u);
});

test("semantic presentation keeps Host mode owner-local", () => {
  const hostOwner = {};
  const openClawOwner = {};

  bindHostBridgeToolPresentation(hostOwner);

  assert.equal(usesHostBridgeToolPresentation(hostOwner), true);
  assert.equal(usesHostBridgeToolPresentation(openClawOwner), false);
});

test("semantic presentation preserves identity normalization and redaction bytes", () => {
  const rendered = toolResult({
    conversation_id: "turn-presented",
    expected_terminal_token: "private-terminal-authority",
    composer_draft: "private draft",
    reason: "safe diagnostic",
    nested: {
      expected_binding_token: "private-binding-authority",
      value: 7
    }
  }, { compactText: true });

  assert.deepEqual(rendered.details, {
    conversation_id: "turn-presented",
    reason: "safe diagnostic",
    nested: { value: 7 },
    session_id: "turn-presented",
    turn_id: "turn-presented"
  });
  assert.equal(rendered.content[0]?.text, JSON.stringify(rendered.details));
  assert.equal(rendered.isError, undefined);
});

test("semantic presentation preserves AbortError and sanitizes other failures", () => {
  const abort = new Error("cancelled");
  abort.name = "AbortError";
  assert.equal(modelFacingToolError(abort), abort);

  const sanitized = modelFacingToolError(
    new Error("terminal token private-terminal-authority is invalid")
  );
  assert.doesNotMatch(sanitized.message, /private-terminal-authority/u);
  assert.match(sanitized.message, /private authority changed/u);
});

test("runtime delegates presentation without a reverse dependency", () => {
  const runtimeSource = fs.readFileSync("src/semantic-tool-runtime.ts", "utf8");
  const presentationSource = fs.readFileSync(
    "src/semantic-tool-presentation.ts",
    "utf8"
  );

  assert.match(runtimeSource, /from "\.\/semantic-tool-presentation\.js"/u);
  assert.doesNotMatch(runtimeSource, /function sanitizeModelFacingValue/u);
  assert.doesNotMatch(runtimeSource, /function formatDelegateCommandResult/u);
  assert.doesNotMatch(presentationSource, /semantic-tool-runtime/u);
  assert.doesNotMatch(presentationSource, /openclaw-plugin-command-adapter/u);
  assert.doesNotMatch(presentationSource, /openclaw-plugin-schemas/u);
  assert.doesNotMatch(presentationSource, /openclaw-private-authority-offers/u);
});
