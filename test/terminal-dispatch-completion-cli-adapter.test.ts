import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTerminalDispatchCompletionCliAdapter } from
  "../src/terminal-dispatch-completion-cli-adapter.js";
import {
  captureCodexRolloutAcceptanceAnchor,
  detectCodexRolloutAcceptance,
  type CodexRolloutIdentity
} from "../src/terminal-submission-acceptance.js";

const SESSION_ID = "019f0000-0000-7000-8000-000000000126";
const TURN_ID = "019f0000-0000-7000-8000-000000000127";
const REQUEST = "verify the exact completion bytes";
const REQUEST_HASH = createHash("sha256").update(REQUEST).digest("hex");

test("exact completion requirements read synthetic acceptance dynamically", () => {
  let synthetic = false;
  const adapter = createTerminalDispatchCompletionCliAdapter({
    environment: { syntheticTerminalAcceptanceAllowed: () => synthetic }
  });
  const conversation = {
    native_session_takeover: {
      terminal_agent_identity_protocol: 1,
      terminal_bridge_submission: { status: "agent_accepted" }
    }
  };
  assert.equal(adapter.requiresExactBoundCodexCompletion(conversation), true);
  assert.throws(() => adapter.detectExactBoundCodexCompletion({
    conversation,
    request: {}
  }), /codex_exact_bound_rollout:invalid_acceptance_evidence/u);

  synthetic = true;
  assert.equal(adapter.requiresExactBoundCodexCompletion(conversation), false);
  assert.deepEqual(adapter.detectExactBoundCodexCompletion({
    conversation,
    request: {}
  }), { handled: false });
});

test("exact completion gates accepted status and source before anchor inspection", () => {
  const adapter = createTerminalDispatchCompletionCliAdapter({
    environment: { syntheticTerminalAcceptanceAllowed: () => false }
  });
  const unacceptedTakeover = {
    terminal_agent_identity_protocol: 1,
    terminal_bridge_submission: { status: "prepared" }
  };
  Object.defineProperty(unacceptedTakeover, "codex_rollout_acceptance_anchor", {
    get: () => { throw new Error("anchor read before accepted status"); }
  });
  assert.deepEqual(adapter.detectExactBoundCodexCompletion({
    conversation: { native_session_takeover: unacceptedTakeover },
    nativeTakeover: unacceptedTakeover,
    request: {}
  }), { handled: false });

  const acceptedTakeover = {
    terminal_agent_identity_protocol: 1,
    terminal_bridge_submission: {
      status: "agent_accepted",
      acceptance_evidence: { source: "claude_transcript" }
    }
  };
  Object.defineProperty(acceptedTakeover, "codex_rollout_acceptance_anchor", {
    get: () => { throw new Error("anchor read before source validation"); }
  });
  assert.throws(() => adapter.detectExactBoundCodexCompletion({
    conversation: { native_session_takeover: acceptedTakeover },
    nativeTakeover: acceptedTakeover,
    request: {}
  }), /codex_exact_bound_rollout:invalid_acceptance_evidence/u);
});

test("exact completion preserves the bound rollout byte detector", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-completion-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const rolloutPath = path.join(directory, `rollout-${SESSION_ID}.jsonl`);
  writeRecords(rolloutPath, [{
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "session_meta",
    payload: { id: SESSION_ID, cwd: directory, source: "cli" }
  }]);
  const stat = fs.statSync(rolloutPath);
  const rollout: CodexRolloutIdentity = {
    fd: "12r", device: String(stat.dev), inode: String(stat.ino), path: rolloutPath
  };
  const processUuid = "codex-process-126";
  const processBirth = "Thu Aug 20 00:00:00 2026";
  const anchor = captureCodexRolloutAcceptanceAnchor({
    nativeThreadId: SESSION_ID, processUuid, processBirth,
    mode: "existing", rollout, now: new Date("2026-08-20T00:00:01.000Z")
  });
  appendRecords(rolloutPath, acceptedTurnRecords());
  const acceptanceEvidence = detectCodexRolloutAcceptance({
    anchor,
    currentIdentity: { sessionId: SESSION_ID, processUuid, processBirth, rollout },
    requestHash: REQUEST_HASH
  });
  assert.ok(acceptanceEvidence);
  appendRecords(rolloutPath, [{
    timestamp: "2026-08-20T00:00:03.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete", turn_id: TURN_ID,
      last_agent_message: "Exact completion result"
    }
  }]);
  const takeover = {
    terminal_agent_identity_protocol: 1,
    terminal_bridge_request_hash: REQUEST_HASH,
    codex_rollout_acceptance_anchor: anchor,
    terminal_bridge_submission: {
      status: "agent_accepted", acceptance_evidence: acceptanceEvidence
    }
  };
  const result = createTerminalDispatchCompletionCliAdapter({
    environment: { syntheticTerminalAcceptanceAllowed: () => false }
  }).detectExactBoundCodexCompletion({
    conversation: { native_session_takeover: takeover },
    nativeTakeover: takeover,
    request: { requestHash: REQUEST_HASH },
    runtime: {
      nativeSessionId: SESSION_ID, nativeProcessUuid: processUuid,
      nativeProcessBirth: processBirth, nativeRollout: rollout
    }
  });
  assert.equal(result.handled, true);
  assert.equal(result.completion?.text, "Exact completion result");
  assert.equal(result.completion?.metadata?.context_match, "exact_bound_rollout");
});

test("completion ownership and public facade declarations stay narrow", () => {
  const completionSource = fs.readFileSync(
    path.resolve("src/terminal-dispatch-completion-cli-adapter.ts"), "utf8");
  for (const forbidden of [
    "node:fs", "terminal-dispatch-repository", "terminal-dispatch-recovery",
    "ResolvedTerminalConversation", "Record<string, any>"
  ]) {
    assert.equal(completionSource.includes(forbidden), false, forbidden);
  }
  const coreSource = fs.readFileSync(path.resolve("src/cli-core.ts"), "utf8");
  for (const movedOwner of [
    "detectExactBoundCodexCompletion", "requiresExactBoundCodexCompletion",
    "refineTerminalTurnEndpoint", "terminalRuntimeIdentityForConversation",
    "terminalDurableRequestForConversation", "migrateLegacyTerminalAgentIdentity",
    "listActiveSessionsWithTerminalControl", "createAgentSessionProvider"
  ]) {
    assert.equal(
      new RegExp(`(?:async\\s+)?function\\s+${movedOwner}\\s*\\(`, "u")
        .test(coreSource),
      false,
      movedOwner
    );
  }
  for (const declaration of [
    "terminal-dispatch-completion-cli-adapter.d.ts",
    "terminal-runtime-cli-adapter.d.ts",
    "terminal-identity-authority-cli-adapter.d.ts"
  ]) {
    const source = fs.readFileSync(path.resolve("dist/src", declaration), "utf8");
    assert.doesNotMatch(source, /\bany\b|Record<[^>]*any|ResolvedTerminalConversation/u,
      declaration);
  }
});

function acceptedTurnRecords(): unknown[] {
  return [{
    timestamp: "2026-08-20T00:00:02.000Z",
    type: "event_msg",
    payload: { type: "task_started", turn_id: TURN_ID }
  }, {
    timestamp: "2026-08-20T00:00:02.010Z",
    type: "response_item",
    payload: {
      type: "message", role: "user",
      content: [{ type: "input_text", text: REQUEST }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN_ID }
    }
  }, {
    timestamp: "2026-08-20T00:00:02.011Z",
    type: "event_msg",
    payload: { type: "user_message", message: REQUEST }
  }];
}

function writeRecords(filePath: string, records: readonly unknown[]): void {
  fs.writeFileSync(filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    { mode: 0o600 });
}

function appendRecords(filePath: string, records: readonly unknown[]): void {
  fs.appendFileSync(filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}
