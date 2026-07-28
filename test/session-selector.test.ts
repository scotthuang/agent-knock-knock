import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSessionSelector,
  sessionSelectorCandidateDetails,
  sessionShortRef,
  SessionSelectorError,
  type SessionSelectorCandidate
} from "../src/session-selector.js";

test("full ids resolve exactly and take precedence over selector keywords", () => {
  const latestId = candidate({
    id: "latest",
    agent: "claude",
    updatedAtMs: 1
  });
  const actuallyNewest = candidate({
    id: "task-newest",
    agent: "codex",
    updatedAtMs: 2
  });

  const result = resolveSessionSelector("latest", [latestId, actuallyNewest]);

  assert.equal(result.id, latestId.id);
  assert.equal(result.candidate, latestId);
  assert.equal(result.matchedBy, "full_id");
});

test("omission is allowed only when exactly one actionable target exists", () => {
  const actionable = candidate({ id: "task-open", agent: "codex" });
  const closed = candidate({
    id: "task-closed",
    agent: "claude",
    actionable: false
  });

  assert.equal(
    resolveSessionSelector(undefined, [closed, actionable]).id,
    actionable.id
  );
  assert.equal(
    resolveSessionSelector("   ", [actionable, closed]).matchedBy,
    "implicit_only"
  );
  assert.equal(
    resolveSessionSelector("only", [closed, actionable]).matchedBy,
    "only"
  );
});

test("omission rejects ambiguity with deterministic candidate details", () => {
  const error = captureSelectorError(() =>
    resolveSessionSelector(undefined, [
      candidate({
        id: "task-older",
        agent: "claude",
        updatedAtMs: 10,
        workspace: "/work/claude"
      }),
      candidate({
        id: "task-newer",
        agent: "codex",
        updatedAtMs: 20,
        workspace: "/work/codex"
      })
    ], { operation: "send" })
  );

  assert.equal(error.code, "ambiguous");
  assert.equal(error.selector, undefined);
  assert.deepEqual(
    error.candidates.map((item) => item.id),
    ["task-newer", "task-older"]
  );
  assert.match(error.message, /omitted session selector/i);
  assert.match(error.message, /task-newer/);
  assert.match(error.message, /@[\da-f]{10}/);
});

test("only reports empty and non-actionable candidate sets separately", () => {
  const emptyError = captureSelectorError(() =>
    resolveSessionSelector("only", [], { operation: "send" })
  );
  assert.equal(emptyError.code, "no_actionable_targets");
  assert.deepEqual(emptyError.candidates, []);

  const inactive = candidate({
    id: "task-inactive",
    agent: "cursor",
    actionable: false,
    status: "closed"
  });
  const inactiveError = captureSelectorError(() =>
    resolveSessionSelector("only", [inactive], { operation: "send" })
  );
  assert.equal(inactiveError.code, "not_actionable");
  assert.deepEqual(inactiveError.candidates.map((item) => item.id), [inactive.id]);
  assert.match(inactiveError.message, /for send/);
});

test("latest selects the uniquely newest actionable target independent of input order", () => {
  const oldest = candidate({
    id: "task-oldest",
    agent: "claude",
    updatedAtMs: 1
  });
  const newest = candidate({
    id: "terminal:v2:tmux:codex:work:0.1:4321",
    agent: "codex",
    updatedAtMs: 3
  });
  const closedButNewer = candidate({
    id: "task-closed",
    agent: "cursor",
    actionable: false,
    updatedAtMs: 4
  });

  for (const candidates of [
    [oldest, newest, closedButNewer],
    [closedButNewer, newest, oldest]
  ]) {
    const result = resolveSessionSelector("LATEST", candidates);
    assert.equal(result.id, newest.id);
    assert.equal(result.matchedBy, "latest");
  }
});

test("latest fails closed when recency is missing or tied", () => {
  const missingRecencyError = captureSelectorError(() =>
    resolveSessionSelector("latest", [
      candidate({ id: "task-timestamped", agent: "codex", updatedAtMs: 2 }),
      candidate({ id: "task-unknown-time", agent: "claude" })
    ])
  );
  assert.equal(missingRecencyError.code, "ambiguous");
  assert.match(missingRecencyError.message, /recency is missing/);
  assert.equal(missingRecencyError.candidates.length, 2);

  const tiedError = captureSelectorError(() =>
    resolveSessionSelector("latest", [
      candidate({ id: "task-a", agent: "codex", updatedAtMs: 2 }),
      candidate({ id: "task-b", agent: "claude", updatedAtMs: 2 }),
      candidate({ id: "task-old", agent: "cursor", updatedAtMs: 1 })
    ])
  );
  assert.equal(tiedError.code, "ambiguous");
  assert.match(tiedError.message, /tied/);
  assert.deepEqual(
    tiedError.candidates.map((item) => item.id),
    ["task-b", "task-a"]
  );
});

test("bare agent selectors require exactly one actionable target for that agent", () => {
  const codex = candidate({ id: "codex-open", agent: "codex" });
  const claude = candidate({ id: "claude-open", agent: "claude" });
  const cursor = candidate({ id: "cursor-open", agent: "cursor" });

  assert.equal(resolveSessionSelector("codex", [claude, codex]).id, codex.id);
  assert.equal(resolveSessionSelector("CLAUDE", [codex, claude]).id, claude.id);
  assert.equal(resolveSessionSelector("cursor", [cursor, codex]).id, cursor.id);

  const ambiguous = captureSelectorError(() =>
    resolveSessionSelector("codex", [
      codex,
      candidate({ id: "codex-second", agent: "codex" }),
      claude
    ])
  );
  assert.equal(ambiguous.code, "ambiguous");
  assert.deepEqual(
    ambiguous.candidates.map((item) => item.agent),
    ["codex", "codex"]
  );
  assert.doesNotMatch(ambiguous.message, /claude-open/);
});

test("agent:latest selects within one agent and fails closed on an unavailable agent", () => {
  const codexOld = candidate({
    id: "codex-old",
    agent: "codex",
    updatedAtMs: 1
  });
  const codexNew = candidate({
    id: "codex-new",
    agent: "codex",
    updatedAtMs: 2
  });
  const claudeNewer = candidate({
    id: "claude-newer",
    agent: "claude",
    updatedAtMs: 3
  });

  const result = resolveSessionSelector(
    "codex:latest",
    [claudeNewer, codexOld, codexNew]
  );
  assert.equal(result.id, codexNew.id);
  assert.equal(result.matchedBy, "agent_latest");

  const unavailable = captureSelectorError(() =>
    resolveSessionSelector("cursor:latest", [codexNew])
  );
  assert.equal(unavailable.code, "no_actionable_targets");
  assert.deepEqual(unavailable.candidates, []);
});

test("stable short references resolve exactly and do not depend on visible candidates", () => {
  const selected = candidate({
    id: "task-20260728T012345-abcdef12",
    agent: "codex"
  });
  const other = candidate({ id: "task-other", agent: "claude" });
  const shortRef = sessionShortRef(selected.id);

  assert.equal(shortRef, "@d3f99eba33");
  assert.equal(sessionShortRef(selected.id), shortRef);
  assert.equal(
    sessionSelectorCandidateDetails([other, selected])
      .find((item) => item.id === selected.id)?.shortRef,
    shortRef
  );

  const result = resolveSessionSelector(shortRef.toUpperCase(), [other, selected]);
  assert.equal(result.id, selected.id);
  assert.equal(result.matchedBy, "short_ref");
});

test("id prefixes, fuzzy agent names, and partial short refs are not selectors", () => {
  const target = candidate({
    id: "task-20260728T012345-abcdef12",
    agent: "claude"
  });
  const attempts = [
    "task-20260728",
    "claude-code",
    "cla",
    sessionShortRef(target.id).slice(0, -1)
  ];

  for (const selector of attempts) {
    const error = captureSelectorError(() =>
      resolveSessionSelector(selector, [target])
    );
    assert.equal(error.code, "not_found", selector);
  }
});

test("short-reference collisions and duplicate full ids reject ambiguity", () => {
  // These two ids have the same first six domain-separated SHA-256 hex digits.
  const first = candidate({ id: "collision-1211", agent: "codex" });
  const second = candidate({ id: "collision-1961", agent: "claude" });
  const collidingRef = sessionShortRef(first.id, 6);
  assert.equal(sessionShortRef(second.id, 6), collidingRef);

  const collision = captureSelectorError(() =>
    resolveSessionSelector(collidingRef, [first, second], {
      shortRefLength: 6
    })
  );
  assert.equal(collision.code, "ambiguous");
  assert.deepEqual(
    new Set(collision.candidates.map((item) => item.id)),
    new Set([first.id, second.id])
  );

  const duplicate = captureSelectorError(() =>
    resolveSessionSelector("duplicate", [
      candidate({ id: "duplicate", agent: "codex" }),
      candidate({ id: "duplicate", agent: "codex" })
    ])
  );
  assert.equal(duplicate.code, "ambiguous");
  assert.equal(duplicate.candidates.length, 2);
});

test("a complete id or short ref cannot bypass operation actionability", () => {
  const inactive = candidate({
    id: "task-inactive",
    agent: "codex",
    actionable: false
  });

  for (const selector of [inactive.id, sessionShortRef(inactive.id)]) {
    const error = captureSelectorError(() =>
      resolveSessionSelector(selector, [inactive], { operation: "send" })
    );
    assert.equal(error.code, "not_actionable");
    assert.equal(error.candidates[0].id, inactive.id);
  }
});

test("unknown selectors return actionable candidate details without guessing", () => {
  const actionable = candidate({
    id: "task-open",
    agent: "cursor",
    status: "idle",
    source: "akk_delegate",
    workspace: "/work/repo",
    label: "Continue the integration tests"
  });
  const inactive = candidate({
    id: "task-closed",
    agent: "codex",
    actionable: false
  });

  const error = captureSelectorError(() =>
    resolveSessionSelector("something-close", [inactive, actionable])
  );
  assert.equal(error.code, "not_found");
  assert.deepEqual(error.candidates.map((item) => item.id), [actionable.id]);
  assert.match(error.message, /Continue the integration tests/);
  assert.match(error.message, /\/work\/repo/);
});

test("candidate validation rejects unsafe or non-deterministic inputs", () => {
  assert.throws(
    () => resolveSessionSelector("only", [{
      id: "",
      agent: "codex",
      actionable: true
    }]),
    /non-empty string/
  );
  assert.throws(
    () => resolveSessionSelector("only", [{
      id: "task",
      agent: "unknown",
      actionable: true
    } as unknown as SessionSelectorCandidate]),
    /unsupported agent/
  );
  assert.throws(
    () => resolveSessionSelector("latest", [{
      id: "task",
      agent: "codex",
      actionable: true,
      updatedAtMs: Number.NaN
    }]),
    /must be finite/
  );
  assert.throws(
    () => sessionShortRef("task", 5),
    /between 6 and 64/
  );
});

function candidate(
  overrides: Partial<SessionSelectorCandidate> &
    Pick<SessionSelectorCandidate, "id" | "agent">
): SessionSelectorCandidate {
  return {
    actionable: true,
    ...overrides
  };
}

function captureSelectorError(callback: () => unknown): SessionSelectorError {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof SessionSelectorError);
    return error;
  }
  assert.fail("expected SessionSelectorError");
}
