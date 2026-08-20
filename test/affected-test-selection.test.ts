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

function copyReflectedSemantics(source: object): Record<PropertyKey, unknown> {
  const reflectedCopy = { ...source } as Record<PropertyKey, unknown>;
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol);
    assert.ok(descriptor);
    Object.defineProperty(reflectedCopy, symbol, descriptor);
  }
  return reflectedCopy;
}

function walkTypeScriptSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walkTypeScriptSources(absolutePath);
    }
    return entry.isFile() && entry.name.endsWith(".ts")
      ? [path.relative(repoRoot, absolutePath).split(path.sep).join("/")]
      : [];
  });
}

function directTestSupportConsumers(supportPath: string): string[] {
  const consumers: string[] = [];
  for (const importerPath of walkTypeScriptSources(path.join(repoRoot, "test"))) {
    const source = fs.readFileSync(path.join(repoRoot, importerPath), "utf8");
    const specifiers = source.matchAll(
      /(?:\bfrom\s+|\bimport\s*\()(["'])([^"']+)\1/gu
    );
    for (const match of specifiers) {
      if (!match[2].startsWith(".")) {
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(
        path.posix.dirname(importerPath),
        match[2].replace(/\.js$/u, ".ts")
      ));
      if (resolved === supportPath) {
        consumers.push(importerPath);
        break;
      }
    }
  }
  return consumers.sort();
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
  const fast = new Set(loadTiers().fast);
  for (const [supportPath, consumers] of Object.entries(
    selection.testSupportImpactByPath
  ) as Array<[string, string[]]>) {
    assert.ok(consumers.length > 0, `${supportPath} must retain a consumer`);
    for (const consumer of consumers) {
      assert.ok(
        integration.has(consumer) || fast.has(consumer) ||
          Object.hasOwn(selection.testSupportImpactByPath, consumer),
        `${supportPath} has an unknown consumer ${consumer}`
      );
    }
    assert.deepEqual(
      [...consumers].sort(),
      directTestSupportConsumers(supportPath),
      `${supportPath} consumer ownership must match the current import graph`
    );
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

test("terminal list authority domains select at most five exact witnesses", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const fixtures = [
    {
      changedPath: "src/terminal-action-projection.ts",
      expected: [
        "test/human-handoff-adoption-cli.test.ts",
        "test/management-cli.test.ts",
        "test/session-selector-cli.test.ts",
        "test/shards/agent-cli-session-acceptance.test.ts",
        "test/shards/agent-cli-terminal-send-gates.test.ts"
      ]
    },
    {
      changedPath: "src/terminal-authority-policy.ts",
      expected: [
        "test/codex-no-rollout-binding-cli.test.ts",
        "test/human-handoff-adoption-cli.test.ts",
        "test/session-selector-cli.test.ts",
        "test/shards/agent-cli-session-acceptance.test.ts",
        "test/shards/agent-cli-terminal-send-gates.test.ts"
      ]
    }
  ];
  for (const fixture of fixtures) {
    assert.deepEqual(
      selection.selectAffectedTests([fixture.changedPath], tiers),
      {
        mode: "targeted",
        changedPaths: [fixture.changedPath],
        integrationFiles: tiers.integration.filter((testPath) =>
          fixture.expected.includes(testPath)
        )
      }
    );
  }
});

test("terminal runtime composition selects five exact provider and identity witnesses", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/claude-native-inspection-cli.test.ts",
    "test/native-thread-lifecycle-cli.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/cli-core-import.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-runtime-cli-adapter.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-runtime-cli-adapter.ts"],
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

test("terminal monitor decision and poll policies select their parity set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/shards/agent-cli-claude-callback.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts",
    "test/shards/agent-cli-monitor-lifecycle.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-monitor-approval-context.test.ts"
  ];
  for (const changedPath of [
    "src/terminal-monitor-decision-policy.ts",
    "src/terminal-monitor-reconciliation-eligibility.ts",
    "src/terminal-monitor-poll-policy.ts"
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

test("terminal submission facts select acceptance and monitor parity", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/shards/agent-cli-dispatch-recovery.test.ts",
    "test/shards/agent-cli-monitor-recovery.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ];
  assert.deepEqual(
    selection.selectAffectedTests(["src/terminal-submission-facts.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["src/terminal-submission-facts.ts"],
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

test("dispatch application selects application and receipt parity witnesses", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
    "test/codex-no-rollout-binding-cli.test.ts",
    "test/shards/agent-cli-dispatch-recovery.test.ts",
    "test/shards/agent-cli-receipt-fences.test.ts",
    "test/shards/agent-cli-session-acceptance.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ];
  for (const changedPath of [
    "src/terminal-dispatch-application.ts",
    "src/terminal-dispatch-receipt.ts"
  ]) {
    assert.deepEqual(
      selection.selectAffectedTests([changedPath], tiers),
      {
        mode: "targeted",
        changedPaths: [changedPath],
        integrationFiles: tiers.integration.filter((testPath) =>
          expected.includes(testPath)
        )
      }
    );
  }
});

test("terminal dispatch policy selects its exact parity integration set", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const expected = [
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
  assert.deepEqual(
    selection.selectAffectedTests([
      "templates/openclaw-skills/agent-knock-knock/SKILL.md"
    ], tiers),
    {
      mode: "targeted",
      changedPaths: [
        "templates/openclaw-skills/agent-knock-knock/SKILL.md"
      ],
      integrationFiles: []
    }
  );
});

test("normal production domains select at most five witnesses", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  for (const changedPath of [
    "src/agent-session-provider.ts",
    "src/cli-core.ts",
    "src/deferred-foreground-transfer.ts",
    "src/managed-session.ts",
    "src/claude-terminal-agent-adapter.ts",
    "src/herdr-terminal-control-provider.ts",
    "src/terminal-agent-bridge.ts"
  ]) {
    const result = selection.selectAffectedTests([changedPath], tiers);
    assert.equal(result.mode, "targeted", changedPath);
    assert.ok(result.integrationFiles.length > 0, changedPath);
    assert.ok(result.integrationFiles.length <= 5, changedPath);
  }
});

test("test support ownership follows exact transitive consumers", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const directAgentConsumers = selection.selectAffectedTests(
    ["test/agent-cli-fixtures.ts"],
    tiers
  );
  assert.equal(directAgentConsumers.mode, "targeted");
  assert.deepEqual(directAgentConsumers.integrationFiles, tiers.integration.filter(
    (testPath) => selection.testSupportImpactByPath[
      "test/agent-cli-fixtures.ts"
    ].includes(testPath)
  ));
  assert.deepEqual(
    selection.selectAffectedTests(["test/codex-sticky-rollout-fixture.ts"], tiers),
    {
      mode: "targeted",
      changedPaths: ["test/codex-sticky-rollout-fixture.ts"],
      integrationFiles: []
    }
  );
  const commonFixture = selection.selectAffectedTests(
    ["test/in-process-cli-fixtures.ts"],
    tiers
  );
  assert.equal(commonFixture.mode, "targeted");
  assert.ok(commonFixture.integrationFiles.length > directAgentConsumers.integrationFiles.length);
  for (const requiredConsumer of [
    "test/callback-cli.test.ts",
    "test/claude-native-inspection-cli.test.ts",
    "test/native-lifecycle-command-guard-cli.test.ts",
    "test/shards/agent-cli-terminal-send-gates.test.ts"
  ]) {
    assert.ok(commonFixture.integrationFiles.includes(requiredConsumer));
  }
});

test("additive tier semantics are content-proven while deletion, movement, and forged proofs fail closed", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const addedPath = "test/human-handoff-adoption-cli.test.ts";
  const before = structuredClone(tiers);
  before.integration = before.integration.filter((testPath) => testPath !== addedPath);
  const valid = selection.analyzeChangedFileSemantics({
    changedPaths: ["test/test-tiers.json", addedPath],
    readBeforePath: (repositoryPath: string) => {
      if (repositoryPath === "test/test-tiers.json") {
        return JSON.stringify(before);
      }
      throw new Error("new test is absent from the base revision");
    },
    readAfterPath: (repositoryPath: string) => repositoryPath ===
      "test/test-tiers.json" ? JSON.stringify(tiers) : "test('new witness', () => {});",
    pathExistsBefore: () => false
  });
  assert.deepEqual(
    selection.selectAffectedTests(
      ["test/test-tiers.json", addedPath],
      tiers,
      { changeSemantics: valid }
    ),
    {
      mode: "targeted",
      changedPaths: [addedPath, "test/test-tiers.json"],
      integrationFiles: [addedPath]
    }
  );
  assert.equal(selection.selectAffectedTests(
    ["test/test-tiers.json", addedPath],
    tiers,
    { changeSemantics: copyReflectedSemantics(valid) }
  ).mode, "full", "reflecting every Symbol must not forge a tier proof");
  const existingFileAddition = selection.analyzeChangedFileSemantics({
    changedPaths: ["test/test-tiers.json", addedPath],
    readBeforePath: (repositoryPath: string) => repositoryPath ===
      "test/test-tiers.json" ? JSON.stringify(before) : "existing test source",
    readAfterPath: (repositoryPath: string) => repositoryPath ===
      "test/test-tiers.json" ? JSON.stringify(tiers) : "changed test source",
    pathExistsBefore: () => true
  });
  assert.equal(selection.selectAffectedTests(
    ["test/test-tiers.json", addedPath],
    tiers,
    { changeSemantics: existingFileAddition }
  ).mode, "full", "a manifest edit cannot bless an already-existing test");
  const unreadableBase = selection.analyzeChangedFileSemantics({
    changedPaths: ["test/test-tiers.json", addedPath],
    readBeforePath: (repositoryPath: string) => repositoryPath ===
      "test/test-tiers.json" ? JSON.stringify(before) : undefined,
    readAfterPath: (repositoryPath: string) => repositoryPath ===
      "test/test-tiers.json" ? JSON.stringify(tiers) : "changed test source",
    pathExistsBefore: () => {
      throw new Error("git tree lookup failed");
    }
  });
  assert.equal(selection.selectAffectedTests(
    ["test/test-tiers.json", addedPath],
    tiers,
    { changeSemantics: unreadableBase }
  ).mode, "full", "a Git read failure must not masquerade as an absent file");

  const unsafeAfterValues = [
    {
      ...structuredClone(tiers),
      integration: tiers.integration.filter((testPath) => testPath !== addedPath)
    },
    {
      ...structuredClone(tiers),
      integration: [tiers.integration[1], tiers.integration[0], ...tiers.integration.slice(2)]
    },
    {
      fast: [...tiers.fast, addedPath],
      integration: tiers.integration.filter((testPath) => testPath !== addedPath)
    }
  ];
  for (const after of unsafeAfterValues) {
    const unsafe = selection.analyzeChangedFileSemantics({
      changedPaths: ["test/test-tiers.json", addedPath],
      readBeforePath: () => JSON.stringify(tiers),
      readAfterPath: () => JSON.stringify(after)
    });
    const result = selection.selectAffectedTests(
      ["test/test-tiers.json", addedPath],
      tiers,
      { changeSemantics: unsafe }
    );
    assert.equal(result.mode, "full");
    assert.match(result.reason, /lacks a safe semantic proof/u);
  }

  const missingChangedPathProof = selection.analyzeChangedFileSemantics({
    changedPaths: ["test/test-tiers.json"],
    readBeforePath: () => JSON.stringify(before),
    readAfterPath: () => JSON.stringify(tiers)
  });
  assert.equal(selection.selectAffectedTests(
    ["test/test-tiers.json"],
    tiers,
    { changeSemantics: missingChangedPathProof }
  ).mode, "full");
  assert.equal(selection.selectAffectedTests(
    ["test/test-tiers.json", addedPath],
    tiers,
    {
      changeSemantics: {
        testTierManifest: {
          kind: "additive-test-tier-entries",
          entries: [{ path: addedPath, tier: "integration" }]
        }
      }
    }
  ).mode, "full", "an unbranded caller proof must not bypass content review");
});

test("package manifests narrow only for synchronized version-only content", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  const packageAfter = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const lockAfter = JSON.parse(fs.readFileSync(path.join(repoRoot, "package-lock.json"), "utf8"));
  const packageBefore = structuredClone(packageAfter);
  const lockBefore = structuredClone(lockAfter);
  packageBefore.version = "0.12.10";
  lockBefore.version = "0.12.10";
  lockBefore.packages[""].version = "0.12.10";
  const contents = new Map([
    ["before:package.json", JSON.stringify(packageBefore)],
    ["before:package-lock.json", JSON.stringify(lockBefore)],
    ["after:package.json", JSON.stringify(packageAfter)],
    ["after:package-lock.json", JSON.stringify(lockAfter)]
  ]);
  const changedPaths = ["package.json", "package-lock.json"];
  const valid = selection.analyzeChangedFileSemantics({
    changedPaths,
    readBeforePath: (repositoryPath: string) => contents.get(`before:${repositoryPath}`),
    readAfterPath: (repositoryPath: string) => contents.get(`after:${repositoryPath}`)
  });
  assert.deepEqual(selection.selectAffectedTests(changedPaths, tiers, {
    changeSemantics: valid
  }), {
    mode: "targeted",
    changedPaths: ["package-lock.json", "package.json"],
    integrationFiles: []
  });
  assert.equal(selection.selectAffectedTests(changedPaths, tiers, {
    changeSemantics: copyReflectedSemantics(valid)
  }).mode, "full", "reflecting every Symbol must not forge a package proof");

  const dependencyChange = structuredClone(packageAfter);
  dependencyChange.scripts = {
    ...dependencyChange.scripts,
    unsafe_new_script: "node arbitrary.js"
  };
  const unsafe = selection.analyzeChangedFileSemantics({
    changedPaths,
    readBeforePath: (repositoryPath: string) => contents.get(`before:${repositoryPath}`),
    readAfterPath: (repositoryPath: string) => repositoryPath === "package.json"
      ? JSON.stringify(dependencyChange)
      : contents.get(`after:${repositoryPath}`)
  });
  assert.equal(selection.selectAffectedTests(changedPaths, tiers, {
    changeSemantics: unsafe
  }).mode, "full");
  assert.equal(selection.selectAffectedTests(changedPaths, tiers, {
    changeSemantics: { packageVersion: { kind: "synchronized-package-version-only" } }
  }).mode, "full", "a forged package proof must remain full");
  assert.equal(selection.selectAffectedTests(["package.json"], tiers, {
    changeSemantics: valid
  }).mode, "full", "an unpaired package manifest must remain full");
});

test("unknown paths, Store/protocol, and shared authorities fail closed", async () => {
  const selection = await loadSelectionModule();
  const tiers = loadTiers();
  for (const changedPath of [
    "src/new-subsystem.ts",
    "docs/new-generator.js",
    "test/new-fixture.ts",
    "src/store.ts",
    "src/protocol.ts",
    "src/mutation-transaction.ts",
    "src/terminal-dispatch-ledger-codec.ts",
    "scripts/affected-test-selection.js",
    "config/production-module-ownership.json",
    "tsconfig.json"
  ]) {
    const result = selection.selectAffectedTests([changedPath], tiers);
    assert.equal(result.mode, "full", changedPath);
    assert.match(
      result.reason,
      /(?:unmapped changed path|production module has no owner|production domain requires full suite|shared test or architecture configuration changed)/u
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
