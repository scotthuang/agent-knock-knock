import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTOR_KINDS,
  executorDefinitionForAlias,
  executorDefinitionForKind,
  parseLeadingExecutorAlias,
  resolveExecutor
} from "../src/executors.js";

test("executor registry exposes the supported coding agents", () => {
  assert.deepEqual(EXECUTOR_KINDS, ["claude", "codex"]);

  const claude = executorDefinitionForKind("claude");
  assert.equal(claude.actor, "claude-code");
  assert.equal(claude.defaultSession, "claude");
  assert.equal(claude.displayName, "Claude Code");

  const codex = executorDefinitionForKind("codex");
  assert.equal(codex.actor, "codex");
  assert.equal(codex.defaultSession, "codex");
  assert.equal(codex.displayName, "Codex");
});

test("executor registry resolves slash command aliases", () => {
  assert.equal(executorDefinitionForAlias("claude")?.kind, "claude");
  assert.equal(executorDefinitionForAlias("claude-code")?.kind, "claude");
  assert.equal(executorDefinitionForAlias("codex")?.kind, "codex");
  assert.equal(executorDefinitionForAlias("c")?.kind, "codex");
  assert.equal(executorDefinitionForAlias("unknown-agent"), undefined);
});

test("executor registry parses leading agent aliases from delegated request text", () => {
  assert.deepEqual(parseLeadingExecutorAlias("codex 帮我检查这个改动"), {
    kind: "codex",
    request: "帮我检查这个改动"
  });
  assert.deepEqual(parseLeadingExecutorAlias("Claude: review this patch"), {
    kind: "claude",
    request: "review this patch"
  });
  assert.deepEqual(parseLeadingExecutorAlias("claude-code：review this patch"), {
    kind: "claude",
    request: "review this patch"
  });
  assert.equal(parseLeadingExecutorAlias("unknown-agent: say hello"), undefined);
  assert.equal(parseLeadingExecutorAlias("please ask an unknown agent to say hello"), undefined);
});

test("resolved executors use the tmux transport", () => {
  const codex = resolveExecutor({ kind: "codex", session: "codex-work" });
  assert.deepEqual(codex, {
    kind: "codex",
    actor: "codex",
    session: "codex-work",
    display_name: "Codex",
    transport: "tmux"
  });

  assert.deepEqual(resolveExecutor({ kind: "claude" }), {
    kind: "claude",
    actor: "claude-code",
    session: "claude",
    display_name: "Claude Code",
    transport: "tmux"
  });
  assert.throws(
    () => executorDefinitionForKind("unknown-agent"),
    /unsupported executor: unknown-agent/
  );
});
