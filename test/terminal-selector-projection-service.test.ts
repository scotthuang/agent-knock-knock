import assert from "node:assert/strict";
import test from "node:test";
import {
  projectSessionSelectorCandidate,
  type TerminalSelectorEntry,
  type TerminalSelectorProjectionPolicy
} from "../src/terminal-selector-projection-service.js";

const policy: TerminalSelectorProjectionPolicy = {
  isActiveStatus: (status) =>
    !["done", "failed", "closed", "cancelled"].includes(status)
};

test("selector projection preserves the legacy public JSON bytes and key order", () => {
  const observedAtMs = Date.parse("2026-08-15T00:00:10.000Z");
  const candidate = projectSessionSelectorCandidate({
    id: "terminal:v2:tmux:codex:work:0.0:4321",
    agent: "codex",
    source: "terminal",
    status: "idle",
    workspace: "/repo",
    request: "continue refactor",
    updated_at: "2026-08-15T00:00:00.000Z",
    available_actions: {
      send: {
        tool: "agent_knock_knock_send",
        arguments: { session_id: "session-1" }
      }
    }
  }, "send", observedAtMs, {
    defaultActionable: true,
    mutationsAllowed: true
  }, policy);

  assert.equal(
    JSON.stringify(candidate),
    "{\"id\":\"terminal:v2:tmux:codex:work:0.0:4321\"," +
      "\"targetId\":\"session-1\",\"agent\":\"codex\"," +
      "\"actionable\":true,\"defaultActionable\":true," +
      "\"updatedAtMs\":1786752000000,\"source\":\"terminal\"," +
      "\"status\":\"idle\",\"workspace\":\"/repo\"," +
      "\"label\":\"continue refactor\"}"
  );
});

test("mutation-disabled selectors do not consume available-actions getters", () => {
  let availableActionReads = 0;
  const entry: TerminalSelectorEntry = {
    id: "turn-closed",
    agent: "codex",
    source: "managed_turn",
    status: "closed",
    get available_actions() {
      availableActionReads += 1;
      throw new Error("available actions must stay lazy");
    }
  };

  const candidate = projectSessionSelectorCandidate(entry, "send", 10, {
    defaultActionable: false,
    mutationsAllowed: false
  }, policy);

  assert.equal(availableActionReads, 0);
  assert.equal(candidate.actionable, false);
  assert.equal(candidate.id, "turn-closed");
});

test("approval fallback preserves legacy getter reads and target selection", () => {
  const reads: string[] = [];
  const currentTurn: TerminalSelectorEntry = {
    id: "turn-current",
    source: "managed_turn",
    status: "waiting_for_agent",
    get executor() {
      reads.push("current.executor");
      return { transport: "tmux" };
    }
  };
  const managed = {
    get current_turn() {
      reads.push("managed.current_turn");
      return currentTurn;
    }
  };
  const entry: TerminalSelectorEntry = {
    id: "terminal-1",
    agent: "codex",
    source: "terminal",
    status: "idle",
    get available_actions() {
      reads.push("entry.available_actions");
      return {};
    },
    get managed() {
      reads.push("entry.managed");
      return managed;
    }
  };

  const candidate = projectSessionSelectorCandidate(entry, "approve", 10, {
    defaultActionable: true,
    mutationsAllowed: true
  }, policy);

  assert.deepEqual(reads, [
    "entry.available_actions",
    "entry.available_actions",
    "entry.managed",
    "entry.managed",
    "managed.current_turn",
    "managed.current_turn",
    "current.executor",
    "current.executor"
  ]);
  assert.equal(candidate.actionable, true);
  assert.equal(candidate.targetId, "turn-current");
});
