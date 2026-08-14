import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function loadSelectionModule() {
  return import(
    pathToFileURL(path.join(repoRoot, "scripts", "affected-test-selection.js")).href
  );
}

function loadTiers(): { fast: string[]; integration: string[] } {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, "test", "test-tiers.json"), "utf8")
  );
}

test("package exposes the build-once affected-test runner", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
  );
  assert.equal(
    packageJson.scripts["test:affected"],
    "npm run build && node scripts/run-affected-tests.js"
  );
  assert.equal(
    packageJson.scripts["validate:architecture"],
    "node scripts/validate-architecture.js"
  );
});

test("non-production affected-test map contains only exact integration-tier manifest entries", async () => {
  const selection = await loadSelectionModule();
  const integration = new Set(loadTiers().integration);
  for (const mappedTests of Object.values(selection.targetedIntegrationByPath) as string[][]) {
    assert.ok(mappedTests.length > 0);
    for (const testPath of mappedTests) {
      assert.ok(integration.has(testPath), `${testPath} must remain an integration test`);
    }
  }
});

test("known source subsystems select exact integration files in manifest order", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  assert.deepEqual(
    selection.selectAffectedTests([
      "src/runtime-log.ts",
      "src/session-selector.ts",
      "src/runtime-log.ts"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/runtime-log.ts", "src/session-selector.ts"],
      integrationFiles: tiers.integration.filter((testPath) => [
        "test/delegate-cli.test.ts",
        "test/session-selector-cli.test.ts",
        "test/management-cli.test.ts",
        "test/runtime-log.test.ts"
      ].includes(testPath))
    }
  );
  assert.deepEqual(
    selection.selectAffectedTests([
      "src/verified-dead-agent-policy.ts"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/verified-dead-agent-policy.ts"],
      integrationFiles: [
        "test/human-handoff-adoption-cli.test.ts",
        "test/shards/agent-cli-monitor-recovery.test.ts"
      ]
    }
  );
  assert.deepEqual(
    selection.selectAffectedTests(["src/mutation-transaction.ts"], tiers),
    {
      mode: "full",
      changedPaths: ["src/mutation-transaction.ts"],
      reason:
        "production domain requires full suite: mutation-transaction " +
        "(src/mutation-transaction.ts)"
    }
  );
});

test("terminal binding authority selects its exact parity integration set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/human-handoff-adoption-cli.test.ts",
    "test/native-thread-lifecycle-cli.test.ts",
    "test/native-thread-lifecycle-recovery-cli.test.ts",
    "test/session-selector-cli.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts",
    "test/stale-bound-resume-cli.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-binding-authority.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-binding-authority.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("callback outbox policy selects retry, approval, and monitor recovery coverage", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/callback-cli.test.ts",
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-monitor-approval-context.test.ts",
    "test/shards/agent-cli-monitor-lifecycle.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/callback-outbox-policy.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/callback-outbox-policy.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("callback transport selects delivery, recovery, and plugin parity coverage", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/callback-cli.test.ts",
    "test/openclaw-plugin-contract.test.ts",
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-monitor-approval-context.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests([
      "src/openclaw-callback-transport.ts"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/openclaw-callback-transport.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("terminal monitor poll policy selects its timeout and recovery parity set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts",
    "test/shards/agent-cli-monitor-lifecycle.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-monitor-poll-policy.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-monitor-poll-policy.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("terminal monitor supervision seams select launch and recovery parity", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-monitor-approval-context.test.ts",
    "test/shards/agent-cli-monitor-lifecycle.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts"
  ];
  for (const changedPath of [
    "src/terminal-monitor-launch-plan.ts",
    "src/terminal-monitor-ownership-policy.ts"
  ]) {
    assert.deepEqual(selection.selectAffectedTests([changedPath], tiers), {
      mode: "targeted",
      changedPaths: [changedPath],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    });
  }
});

test("native thread transition policy selects its exact lifecycle parity set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/human-handoff-adoption-cli.test.ts",
    "test/native-thread-lifecycle-cli.test.ts",
    "test/native-thread-lifecycle-recovery-cli.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests([
      "src/native-thread-transition-policy.ts"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/native-thread-transition-policy.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("terminal dispatch ledger codec retains the full persistence gate", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  assert.deepEqual(
    selection.selectAffectedTests([
      "src/terminal-dispatch-ledger-codec.ts"
    ], tiers),
    {
      mode: "full",
      changedPaths: ["src/terminal-dispatch-ledger-codec.ts"],
      reason:
        "production domain requires full suite: terminal-dispatch-ledger " +
        "(src/terminal-dispatch-ledger-codec.ts)"
    }
  );
});

test("zero-input dispatch abort selects its three exact parity witnesses", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/shards/agent-cli-dispatch-authority.test.ts",
    "test/shards/agent-cli-dispatch-recovery.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-dispatch-abort.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-dispatch-abort.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("terminal dispatch policy selects its exact parity integration set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/shards/agent-cli-composer-replay.test.ts",
    "test/shards/agent-cli-dispatch-authority.test.ts",
    "test/shards/agent-cli-dispatch-recovery.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-dispatch-policy.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-dispatch-policy.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("terminal list renderer selects public JSON parity coverage", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/human-handoff-adoption-cli.test.ts",
    "test/management-cli.test.ts",
    "test/session-selector-cli.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-list-renderer.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-list-renderer.ts"],
      integrationFiles: tiers.integration.filter((testPath) =>
        expected.includes(testPath)
      )
    }
  );
});

test("an integration test selects itself while fast and documentation changes still use fast only", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  assert.deepEqual(
    selection.selectAffectedTests([
      "test\\runtime-log.test.ts",
      "./test/protocol.test.ts",
      "docs/testing.md"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: [
        "docs/testing.md",
        "test/protocol.test.ts",
        "test/runtime-log.test.ts"
      ],
      integrationFiles: ["test/runtime-log.test.ts"]
    }
  );
  const noChanges = selection.selectAffectedTests([], tiers);
  assert.deepEqual(noChanges, {
    mode: "targeted",
    changedPaths: [],
    integrationFiles: []
  });
  assert.deepEqual(selection.affectedTestRuns(noChanges), [
    { tier: "fast", files: [] }
  ]);
});

test("unknown paths and full production domains fail closed", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  for (const changedPath of [
    "src/new-subsystem.ts",
    "docs/new-generator.js",
    "src/cli.ts",
    "src/cli-core.ts",
    "src/cli-runtime-context.ts",
    "src/store.ts",
    "src/protocol.ts",
    "src/claude-local-transcript-provider.ts",
    "src/herdr-terminal-control-provider.ts",
    "src/terminal-control-provider.ts",
    "src/native-thread-lifecycle-policy.ts"
  ]) {
    const result = selection.selectAffectedTests([changedPath], tiers);
    assert.equal(result.mode, "full", changedPath);
    assert.match(
      result.reason,
      /(?:unmapped changed path|production module has no owner|production domain requires full suite)/u
    );
  }
});

test("a stale targeted mapping fails closed instead of silently dropping integration coverage", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const withoutRuntimeLog = {
    ...tiers,
    integration: tiers.integration.filter((testPath) => testPath !== "test/runtime-log.test.ts")
  };
  const result = selection.selectAffectedTests(["src/runtime-log.ts"], withoutRuntimeLog);
  assert.equal(result.mode, "full");
  assert.match(result.reason, /production ownership unavailable/u);
  assert.match(result.reason, /is not in the integration tier/u);
});

test("an unavailable production ownership manifest fails closed", async () => {
  const selection = await loadSelectionModule();
  const result = selection.selectAffectedTests(
    ["docs/testing.md"],
    loadTiers(),
    {
      loadProductionOwnership() {
        throw new Error("missing ownership manifest");
      }
    }
  );
  assert.equal(result.mode, "full");
  assert.match(result.reason, /production ownership unavailable/u);
  assert.match(result.reason, /missing ownership manifest/u);
});

test("affected-test arguments accept one explicit base and reject ambiguous input", async () => {
  const selection = await loadSelectionModule();
  assert.deepEqual(selection.parseAffectedArguments([]), { base: undefined });
  assert.deepEqual(selection.parseAffectedArguments(["--base", "origin/main"]), {
    base: "origin/main"
  });
  assert.deepEqual(selection.parseAffectedArguments(["--base=HEAD~2"]), {
    base: "HEAD~2"
  });
  assert.throws(() => selection.parseAffectedArguments(["--base"]), /requires/u);
  assert.throws(
    () => selection.parseAffectedArguments(["--base=main", "--base", "HEAD"]),
    /only once/u
  );
  assert.throws(() => selection.parseAffectedArguments(["main"]), /unknown/u);
});

test("changed-path discovery uses NUL-safe git output, explicit bases, and untracked files", async () => {
  const selection = await loadSelectionModule();
  const calls: string[][] = [];
  const outputs = [
    "0123456789012345678901234567890123456789\n",
    "src/runtime-log.ts\0docs/name with spaces.md\0",
    "test/new-fixture.ts\0src/runtime-log.ts\0"
  ];
  const changedPaths = selection.collectChangedPaths({
    repoRoot,
    base: "origin/main",
    runGit(args: string[]) {
      calls.push(args);
      return { status: 0, stdout: outputs.shift(), stderr: "" };
    }
  });
  assert.deepEqual(calls, [
    ["rev-parse", "--verify", "origin/main^{commit}"],
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "0123456789012345678901234567890123456789",
      "--"
    ],
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ]);
  assert.deepEqual(changedPaths, [
    "docs/name with spaces.md",
    "src/runtime-log.ts",
    "test/new-fixture.ts"
  ]);
});

test("changed-path discovery errors are surfaced for the runner's full-suite fallback", async () => {
  const selection = await loadSelectionModule();
  assert.throws(
    () => selection.collectChangedPaths({
      repoRoot,
      runGit() {
        return { status: 128, stdout: "", stderr: "bad revision" };
      }
    }),
    /git diff against HEAD failed: bad revision/u
  );

  const result = selection.determineAffectedSelection({
    tiers: loadTiers(),
    repoRoot,
    runGit() {
      return { status: 128, stdout: "", stderr: "bad revision" };
    }
  });
  assert.equal(result.mode, "full");
  assert.match(result.reason, /selection failed: git diff against HEAD failed/u);
  assert.deepEqual(selection.affectedTestRuns(result), [
    { tier: "full", files: [] }
  ]);
});
