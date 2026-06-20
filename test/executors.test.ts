import test from "node:test";
import assert from "node:assert/strict";
import {
  EXECUTOR_KINDS,
  acpxCommandForExecutor,
  executorDefinitionForAlias,
  executorDefinitionForKind,
  resolveExecutor
} from "../src/executors.js";

test("executor registry exposes the supported coding agents", () => {
  assert.deepEqual(EXECUTOR_KINDS, ["claude", "codex"]);

  const claude = executorDefinitionForKind("claude");
  assert.equal(claude.actor, "claude-code");
  assert.equal(claude.acpxCommand, "claude");
  assert.equal(claude.sessionPrefix, "akk-claude");

  const codex = executorDefinitionForKind("codex");
  assert.equal(codex.actor, "codex");
  assert.equal(codex.acpxCommand, "codex");
  assert.equal(codex.sessionPrefix, "akk-codex");
});

test("executor registry resolves slash command aliases", () => {
  assert.equal(executorDefinitionForAlias("claude")?.kind, "claude");
  assert.equal(executorDefinitionForAlias("claude-code")?.kind, "claude");
  assert.equal(executorDefinitionForAlias("codex")?.kind, "codex");
  assert.equal(executorDefinitionForAlias("c")?.kind, "codex");
  assert.equal(executorDefinitionForAlias("cursor"), undefined);
});

test("resolved executors keep the stable protocol shape", () => {
  const codex = resolveExecutor({ kind: "codex", session: "codex-work" });
  assert.deepEqual(codex, {
    kind: "codex",
    actor: "codex",
    session: "codex-work",
    display_name: "Codex",
    transport: "acpx"
  });
  assert.equal(acpxCommandForExecutor(codex), "codex");
});
