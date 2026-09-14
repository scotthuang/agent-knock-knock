import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverTerminalModelOptions,
  inspectTerminalModelControlResidual,
  observeTerminalModelControl,
  parseCodexNativeModelCatalog,
  planTerminalModelControl,
  probeTerminalModelControl,
  repairTerminalModelControlResidual,
  switchTerminalModel,
  type TerminalModelControlPorts,
  type TerminalModelReasoningEffort,
  terminalModelCatalogFingerprint
} from "../src/terminal-model-control.js";

const CODEX_PLAN = planTerminalModelControl(
  probeTerminalModelControl("codex", "0.154.0")
);
const CLAUDE_PLAN = planTerminalModelControl(
  probeTerminalModelControl("claude", "2.1.266")
);

test("model control is closed to exact regression-tested agent versions", () => {
  assert.deepEqual(
    {
      status: probeTerminalModelControl("codex", "0.154.0").status,
      scope: probeTerminalModelControl("codex", "0.154.0").scope
    },
    { status: "supported", scope: "current_and_new_sessions" }
  );
  assert.deepEqual(
    {
      status: probeTerminalModelControl("claude", "2.1.266").status,
      scope: probeTerminalModelControl("claude", "2.1.266").scope
    },
    { status: "supported", scope: "current_session" }
  );
  assert.equal(probeTerminalModelControl("codex", "0.154.1").status, "unsupported");
  assert.equal(probeTerminalModelControl("claude", "2.1.267").status, "unsupported");
  assert.throws(
    () => planTerminalModelControl(
      probeTerminalModelControl("codex", undefined)
    ),
    /could not be verified/u
  );
});

test("Codex 0.154 parser preserves live positions and catalog preset markers", () => {
  const observed = observeTerminalModelControl(CODEX_PLAN, [
    "earlier transcript",
    "Select Model and Effort",
    "  1. gpt-6-astra (default)  Frontier coding model",
    "  2. future-unprofiled-model  Must remain a native navigation row",
    "› 3. gpt-5.2 (current)  Previous generation",
    "Press enter to confirm or esc to go back"
  ].join("\n"));

  assert.equal(observed.state, "codex_model_picker");
  if (observed.state !== "codex_model_picker") return;
  assert.equal(observed.currentModel, "gpt-5.2");
  assert.equal(observed.selectedIndex, 2);
  assert.deepEqual(
    observed.rows.map((row) => ({
      id: row.id,
      nativeIndex: row.nativeIndex,
      current: row.current,
      default: row.presetDefault
    })),
    [
      { id: "gpt-6-astra", nativeIndex: 0, current: false, default: true },
      { id: "future-unprofiled-model", nativeIndex: 1, current: false, default: false },
      { id: "gpt-5.2", nativeIndex: 2, current: true, default: false }
    ]
  );
});

test("Codex reasoning parser keeps unsupported Persistent as a native row", () => {
  const observed = observeTerminalModelControl(CODEX_PLAN, [
    "Select Reasoning Level for gpt-6-astra",
    "  1. Low (default)  Fast",
    "  2. Medium",
    "› 3. High (current)",
    "  4. Extra high",
    "  5. Persistent",
    "  6. More reasoning…",
    "Press enter to confirm or esc to go back"
  ].join("\n"));

  assert.equal(observed.state, "codex_reasoning_picker");
  if (observed.state !== "codex_reasoning_picker") return;
  assert.equal(observed.currentEffort, "high");
  assert.equal(observed.presetDefaultEffort, "low");
  assert.equal(observed.rows.length, 6);
  assert.equal(observed.rows[4].kind, "unsupported");
  assert.equal(observed.rows[5].kind, "advanced");
  assert.equal(observed.selectedIndex, 2);
});

test("Codex 0.154 parser recognizes the exact quick-auto entry menu", () => {
  const observed = observeTerminalModelControl(CODEX_PLAN, [
    "Select Model",
    "Pick a quick auto mode or browse all models.",
    "  1. codex-auto-fast       Fast automatic routing",
    "› 2. All models (current)  Choose a specific model and reasoning level",
    "                          (current: gpt-5.2)",
    "Press enter to confirm or esc to go back"
  ].join("\n"));
  assert.equal(observed.state, "codex_entry_model_picker");
  if (observed.state !== "codex_entry_model_picker") return;
  assert.equal(observed.kind, "quick_auto");
  assert.equal(observed.selectedIndex, 1);
  assert.equal(observed.currentNativeIndex, 1);
  assert.equal(observed.allModelsNativeIndex, 1);
});

test("model-control parsers reject skipped or duplicate native numbering", () => {
  assert.equal(observeTerminalModelControl(CODEX_PLAN, [
    "Select Model and Effort",
    "› 1. gpt-6-astra (current)",
    "  3. future/model",
    "Press enter to confirm or esc to go back"
  ].join("\n")).state, "ambiguous");
  assert.equal(observeTerminalModelControl(CLAUDE_PLAN, [
    "▔".repeat(80),
    "   Select model",
    "   ❯ 1. Claude Opus 4.6 ✔  Claude Opus 4.6 model",
    "     1. Claude Sonnet 4.6  Claude Sonnet 4.6 model",
    "   ● High effort ←/→ to adjust",
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n")).state, "ambiguous");
});

test("Codex catalog parser keeps live visible namespaced models and closed efforts", () => {
  assert.deepEqual(parseCodexNativeModelCatalog({ models: [
    {
      slug: "openai/gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      visibility: "list",
      supported_reasoning_levels: [
        { effort: "low" }, { effort: "high" }, { effort: "persistent" }
      ]
    },
    {
      slug: "hidden-model",
      display_name: "Hidden",
      visibility: "hide",
      supported_reasoning_levels: [{ effort: "high" }]
    }
  ] }), {
    models: [{
      id: "openai/gpt-5.3-codex-spark",
      label: "GPT-5.3-Codex-Spark",
      reasoningEfforts: ["low", "high"]
    }]
  });
});

test("Claude 2.1.266 parser exposes semantic families despite duplicate provider labels", () => {
  const observed = observeTerminalModelControl(CLAUDE_PLAN, [
    "▔".repeat(80),
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new sessions.",
    "",
    "     1. Default (recommended)  Use the default model (currently deepseek-flash[1m])",
    "   ❯ 2. deepseek-flash ✔       Custom Opus model",
    "     3. deepseek-flash         Custom Sonnet model",
    "     4. deepseek-flash         Custom Haiku model",
    "",
    "   ◈ Max effort ←/→ to adjust",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n"));

  assert.equal(observed.state, "claude_model_picker");
  if (observed.state !== "claude_model_picker") return;
  assert.equal(observed.currentModel, "opus");
  assert.equal(observed.currentEffort, "max");
  assert.equal(observed.displayedEffort, "max");
  assert.deepEqual(observed.rows.map((row) => row.id), ["opus", "sonnet", "haiku"]);
  assert.deepEqual(observed.rows.map((row) => row.nativeIndex), [1, 2, 3]);
});

test("Claude Default-current is accepted only when its description proves a family", () => {
  const fixture = (description: string) => [
    "▔".repeat(80),
    "   Select model",
    "   Switch between Claude models.",
    `   ❯ 1. Default (recommended) ✔  ${description}`,
    "     2. Claude Opus 4.6           Claude Opus 4.6 model",
    "     3. Claude Sonnet 4.6         Claude Sonnet 4.6 model",
    "     4. Claude Haiku 4.5          Claude Haiku 4.5 model",
    "   ● High effort (default) ←/→ to adjust",
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n");
  const exact = observeTerminalModelControl(
    CLAUDE_PLAN,
    fixture("Use the default model (currently Claude Sonnet 4.6)")
  );
  assert.equal(exact.state, "claude_model_picker");
  if (exact.state === "claude_model_picker") {
    assert.equal(exact.currentModel, "sonnet-4.6");
    assert.equal(exact.selectedIndex, 0);
  }
  assert.equal(
    observeTerminalModelControl(
      CLAUDE_PLAN,
      fixture("Use the default model (currently provider-model-123)")
    ).state,
    "ambiguous"
  );
});

test("Claude Ultracode is observed but never projected as an allowed effort", () => {
  const observed = observeTerminalModelControl(CLAUDE_PLAN, [
    "▔".repeat(80),
    "   Select model",
    "   Switch between Claude models.",
    "   ❯ 1. Claude Sonnet ✔  Claude Sonnet model",
    "   ✦ Ultracode effort ←/→ to adjust",
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n"));
  assert.equal(observed.state, "claude_model_picker");
  if (observed.state !== "claude_model_picker") return;
  assert.equal(observed.displayedEffort, "ultracode");
  assert.equal(observed.currentEffort, undefined);
});

test("Claude semantic ids distinguish versions and long context while excluding Fable", () => {
  const observed = observeTerminalModelControl(CLAUDE_PLAN, [
    "▔".repeat(100),
    "   Select model",
    "   Switch between Claude models.",
    "   ❯ 1. Claude Opus 4.6 ✔       Claude Opus 4.6 model",
    "     2. Claude Opus 4.5         Claude Opus 4.5 model",
    "     3. Claude Sonnet 4.6 [1M]  Claude Sonnet 4.6 with 1M context",
    "     4. Fable                    Experimental Fable model",
    "   ● High effort ←/→ to adjust",
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n"));
  assert.equal(observed.state, "claude_model_picker");
  if (observed.state !== "claude_model_picker") return;
  assert.deepEqual(observed.rows.map((row) => row.id), [
    "opus-4.6", "opus-4.5", "sonnet-4.6-1m"
  ]);
});

test("catalog fingerprint covers the live effort catalog independently of current tuple", () => {
  const base = {
    agent: "codex" as const,
    agentVersion: "0.154.0",
    behaviorProfile: CODEX_PLAN.behaviorProfile,
    scope: CODEX_PLAN.scope,
    current: { model: "gpt-6-astra", reasoningEffort: "ultra" as const },
    models: [{
      id: "gpt-6-astra",
      label: "gpt-6-astra",
      reasoningEfforts: ["low", "ultra"] as const
    }]
  };
  const lowCatalog = terminalModelCatalogFingerprint({
    ...base,
    models: [{
      ...base.models[0],
      reasoningEfforts: ["low"]
    }]
  });
  const highCatalog = terminalModelCatalogFingerprint({
    ...base,
    models: [{
      ...base.models[0],
      reasoningEfforts: ["high"]
    }]
  });
  assert.match(lowCatalog, /^[0-9a-f]{64}$/u);
  assert.notEqual(lowCatalog, highCatalog);
});

test("Codex discovery intersects its picker with debug models without entering a model", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high"
  });
  const result = await discoverTerminalModelOptions({
    agent: "codex",
    agentVersion: "0.154.0",
    plan: CODEX_PLAN,
    terminalControl: "control",
    ports: native.ports
  });

  assert.equal(result.catalog.current.model, "gpt-5.2");
  assert.equal(result.catalog.current.reasoningEffort, "high");
  assert.deepEqual(result.catalog.models.map((model) => model.id), [
    "gpt-6-astra", "gpt-5.2"
  ]);
  assert.deepEqual(result.catalog.models[0].reasoningEfforts, [
    "low", "medium", "high", "xhigh", "max", "ultra"
  ]);
  assert.equal(native.phase, "idle");
  assert.equal(native.sentKeys.filter((keys) => keys[0] === "C-m").length, 1);
  assert.ok(native.sentKeys.every((keys) => keys.length === 1));
  assert.equal(native.authorityChecks, native.transportCalls);
});

test("Codex discovery accepts an exact bare /model materialization without the historical timeout", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high",
    materializeBareCommand: true
  });

  const result = await discoverTerminalModelOptions({
    agent: "codex",
    agentVersion: "0.154.0",
    plan: CODEX_PLAN,
    terminalControl: "control",
    ports: native.ports
  });

  assert.equal(result.catalog.current.model, "gpt-5.2");
  assert.equal(native.sentText.length, 1);
  assert.equal(native.sentKeys[0]?.[0], "C-m");
  assert.equal(native.phase, "idle");
});

test("Codex discovery continues one exact residual /model without retyping it", async () => {
  for (const initialResidual of [
    "profiled_command_popup",
    "bare_command"
  ] as const) {
    const native = new FakeModelTerminal("codex", {
      currentModel: "gpt-5.2",
      currentEffort: "high",
      defaultModel: "gpt-5.2",
      defaultEffort: "high",
      initialResidual
    });
    const residual = await inspectTerminalModelControlResidual({
      plan: CODEX_PLAN,
      terminalControl: "control",
      ports: native.ports
    });
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") continue;
    assert.equal(residual.kind, initialResidual);

    const result = await discoverTerminalModelOptions({
      agent: "codex",
      agentVersion: "0.154.0",
      plan: CODEX_PLAN,
      terminalControl: "control",
      ports: native.ports,
      initialResidual: residual
    });

    assert.equal(result.catalog.current.model, "gpt-5.2");
    assert.equal(result.catalog.current.reasoningEffort, "high");
    assert.deepEqual(native.sentText, []);
    assert.equal(native.sentKeys[0]?.[0], "C-m");
    assert.equal(native.phase, "idle");
  }
});

test("an exact Codex model picker is a repairable input-owner surface", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high"
  });
  native.phase = "codex_model";
  native.selectedModelIndex = 1;

  const residual = await inspectTerminalModelControlResidual({
    plan: CODEX_PLAN,
    terminalControl: "control",
    ports: native.ports
  });
  assert.equal(residual.state, "recoverable");
  if (residual.state !== "recoverable") return;
  assert.equal(residual.kind, "model_surface");

  const repaired = await repairTerminalModelControlResidual({
    plan: CODEX_PLAN,
    terminalControl: residual.terminalControl,
    expectedResidualFingerprint: residual.fingerprint,
    ports: native.ports
  });
  assert.equal(repaired.outcome, "repaired");
  assert.equal(repaired.composerPostcondition, "empty");
  assert.equal(native.phase, "idle");
  assert.deepEqual(native.sentKeys, [["Escape"]]);
});

test("Codex discovery uses the final authority-revalidated idle tuple", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high",
    mutateEffortBeforeFirstInput: "low"
  });
  const result = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  assert.equal(result.catalog.current.reasoningEffort, "low");
});

test("Codex discovery safely enters All models from its quick-auto menu", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high",
    codexEntryMode: "quick_auto_regular"
  });
  const result = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  assert.equal(result.catalog.current.model, "gpt-5.2");
  assert.equal(native.phase, "idle");
  assert.equal(native.sentKeys.filter((keys) => keys[0] === "C-m").length, 2);
});

test("Codex quick-auto and Luna Reserve failures unwind their exact entry menu", async () => {
  for (const codexEntryMode of ["quick_auto_current", "luna_reserve"] as const) {
    const native = new FakeModelTerminal("codex", {
      currentModel: "gpt-5.2",
      currentEffort: "high",
      defaultModel: "gpt-5.2",
      defaultEffort: "high",
      codexEntryMode
    });
    await assert.rejects(discoverTerminalModelOptions({
      agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
      terminalControl: "control", ports: native.ports
    }), /quick-auto|Luna Reserve/u);
    assert.equal(native.phase, "idle");
    assert.equal(native.sentKeys.at(-1)?.[0], "Escape");
  }
});

test("Codex cross-model Plan switch reconciles current and future Max in a second pass", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "low",
    defaultModel: "gpt-5.2",
    defaultEffort: "low",
    planMode: true
  });
  const offer = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  const result = await switchTerminalModel({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports,
    expectedCatalogFingerprint: offer.catalog.catalogFingerprint,
    request: { model: "gpt-6-astra", reasoningEffort: "max" }
  });

  assert.equal(result.outcome, "changed");
  assert.deepEqual(result.effective, {
    model: "gpt-6-astra", reasoningEffort: "max"
  });
  assert.deepEqual(result.newSessionDefaults, {
    model: "gpt-6-astra", reasoningEffort: "max"
  });
  assert.equal(result.defaultsChanged, true);
  assert.equal(native.scopeCommits, 1);
  assert.equal(native.phase, "idle");
  assert.ok(native.sentKeys.every((keys) => keys.length === 1));
});

test("Codex Plan reconciliation fails closed when its override persistence fails", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "low",
    defaultModel: "gpt-5.2",
    defaultEffort: "low",
    planMode: true,
    planPersistenceFailure: true
  });
  const offer = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  const result = await switchTerminalModel({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports,
    expectedCatalogFingerprint: offer.catalog.catalogFingerprint,
    request: { model: "gpt-6-astra", reasoningEffort: "max" }
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.defaultsChanged, null);
  assert.match(result.reason ?? "", /Plan mode|persisted/u);
});

test("Codex Ultra reports an exact current tuple without inventing native fallback effort", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "low",
    defaultModel: "gpt-5.2",
    defaultEffort: "low",
    planMode: true
  });
  const offer = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  const result = await switchTerminalModel({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports,
    expectedCatalogFingerprint: offer.catalog.catalogFingerprint,
    request: { model: "gpt-6-astra", reasoningEffort: "ultra" }
  });

  assert.equal(result.outcome, "changed");
  assert.deepEqual(result.effective, {
    model: "gpt-6-astra", reasoningEffort: "ultra"
  });
  assert.deepEqual(result.newSessionDefaults, { model: "gpt-6-astra" });
  assert.equal(native.defaultEffort, "low");
  assert.equal(native.scopeCommits, 0);
});

test("an irreversible Codex persistence failure reports unknown default mutation", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "low",
    defaultModel: "gpt-5.2",
    defaultEffort: "low",
    persistenceFailure: true
  });
  const offer = await discoverTerminalModelOptions({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports
  });
  const result = await switchTerminalModel({
    agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
    terminalControl: "control", ports: native.ports,
    expectedCatalogFingerprint: offer.catalog.catalogFingerprint,
    request: { model: "gpt-6-astra", reasoningEffort: "high" }
  });
  assert.equal(result.outcome, "uncertain");
  assert.equal(result.defaultsChanged, null);
  assert.equal(result.doNotRetry, true);
});

test("Claude switch uses literal session-only s and never mutates defaults", async () => {
  const native = new FakeModelTerminal("claude", {
    currentModel: "opus",
    currentEffort: "high",
    defaultModel: "opus",
    defaultEffort: "high"
  });
  const offer = await discoverTerminalModelOptions({
    agent: "claude", agentVersion: "2.1.266", plan: CLAUDE_PLAN,
    terminalControl: "control", ports: native.ports
  });
  const result = await switchTerminalModel({
    agent: "claude", agentVersion: "2.1.266", plan: CLAUDE_PLAN,
    terminalControl: "control", ports: native.ports,
    expectedCatalogFingerprint: offer.catalog.catalogFingerprint,
    request: { model: "sonnet", reasoningEffort: "low" }
  });

  assert.equal(result.outcome, "changed");
  assert.equal(result.scope, "current_session");
  assert.equal(result.defaultsChanged, false);
  assert.deepEqual(result.effective, { model: "sonnet", reasoningEffort: "low" });
  assert.equal(native.defaultModel, "opus");
  assert.ok(native.sentKeys.some((keys) => keys[0] === "s"));
  assert.ok(native.sentKeys.every((keys) => keys.length === 1));
});

test("Claude discovery projects each model's live effort ring and excludes no-effort rows", async () => {
  const native = new FakeModelTerminal("claude", {
    currentModel: "opus",
    currentEffort: "high",
    defaultModel: "opus",
    defaultEffort: "high",
    claudeEffortsByModel: {
      opus: ["low", "high", "max"],
      sonnet: ["low", "medium", "high", "xhigh"],
      haiku: []
    }
  });
  const result = await discoverTerminalModelOptions({
    agent: "claude", agentVersion: "2.1.266", plan: CLAUDE_PLAN,
    terminalControl: "control", ports: native.ports
  });
  assert.deepEqual(result.catalog.models.map((model) => ({
    id: model.id,
    efforts: model.reasoningEfforts
  })), [
    { id: "opus", efforts: ["low", "high", "max"] },
    { id: "sonnet", efforts: ["low", "medium", "high", "xhigh"] }
  ]);
  assert.equal(native.phase, "idle");
});

test("reversible discovery failure unwinds only exact frames back to idle", async () => {
  const native = new FakeModelTerminal("codex", {
    currentModel: "gpt-5.2",
    currentEffort: "high",
    defaultModel: "gpt-5.2",
    defaultEffort: "high",
    throwOnceInPhase: "codex_model"
  });
  await assert.rejects(
    discoverTerminalModelOptions({
      agent: "codex", agentVersion: "0.154.0", plan: CODEX_PLAN,
      terminalControl: "control", ports: native.ports
    }),
    /synthetic capture failure/u
  );
  assert.equal(native.phase, "idle");
  assert.ok(native.sentKeys.some((keys) => keys[0] === "Escape"));
  assert.ok(native.sentKeys.every((keys) => keys.length === 1));
});

type FakePhase = "idle" | "composer" | "codex_entry" | "codex_model" |
  "codex_reasoning" | "codex_advanced" | "codex_scope" | "claude_model";

class FakeModelTerminal {
  readonly sentKeys: string[][] = [];
  readonly sentText: string[] = [];
  readonly history: string[] = [];
  readonly planMode: boolean;
  readonly persistenceFailure: boolean;
  readonly planPersistenceFailure: boolean;
  readonly codexEntryMode?:
    "quick_auto_regular" | "quick_auto_current" | "luna_reserve";
  readonly mutateEffortBeforeFirstInput?: TerminalModelReasoningEffort;
  readonly initialResidual?: "profiled_command_popup" | "bare_command";
  readonly materializeBareCommand: boolean;
  readonly claudeEffortsByModel: Readonly<Record<
    string, readonly TerminalModelReasoningEffort[]
  >>;
  phase: FakePhase = "idle";
  currentModel: string;
  currentEffort: TerminalModelReasoningEffort;
  defaultModel: string;
  defaultEffort: TerminalModelReasoningEffort;
  selectedModelIndex = 0;
  selectedEffortIndex = 0;
  selectedAdvancedIndex = 0;
  selectedScopeIndex = 0;
  selectedModel = "";
  authorityChecks = 0;
  transportCalls = 0;
  lastCaptureAuthority = 0;
  scopeCommits = 0;
  throwOnceInPhase?: FakePhase;
  private threw = false;

  constructor(
    readonly agent: "codex" | "claude",
    options: {
      currentModel: string;
      currentEffort: TerminalModelReasoningEffort;
      defaultModel: string;
      defaultEffort: TerminalModelReasoningEffort;
      planMode?: boolean;
      throwOnceInPhase?: FakePhase;
      persistenceFailure?: boolean;
      planPersistenceFailure?: boolean;
      codexEntryMode?:
        "quick_auto_regular" | "quick_auto_current" | "luna_reserve";
      mutateEffortBeforeFirstInput?: TerminalModelReasoningEffort;
      initialResidual?: "profiled_command_popup" | "bare_command";
      materializeBareCommand?: boolean;
      claudeEffortsByModel?: Readonly<Record<
        string, readonly TerminalModelReasoningEffort[]
      >>;
    }
  ) {
    this.currentModel = options.currentModel;
    this.currentEffort = options.currentEffort;
    this.defaultModel = options.defaultModel;
    this.defaultEffort = options.defaultEffort;
    this.planMode = options.planMode ?? false;
    this.persistenceFailure = options.persistenceFailure ?? false;
    this.planPersistenceFailure = options.planPersistenceFailure ?? false;
    this.codexEntryMode = options.codexEntryMode;
    this.mutateEffortBeforeFirstInput = options.mutateEffortBeforeFirstInput;
    this.initialResidual = options.initialResidual;
    this.materializeBareCommand = options.materializeBareCommand ?? false;
    this.claudeEffortsByModel = options.claudeEffortsByModel ?? {
      opus: ["low", "medium", "high", "xhigh", "max"],
      sonnet: ["low", "medium", "high", "xhigh", "max"],
      haiku: ["low", "medium", "high", "xhigh", "max"]
    };
    this.throwOnceInPhase = options.throwOnceInPhase;
    if (this.initialResidual) {
      this.phase = "composer";
      this.composerReady = this.initialResidual === "profiled_command_popup";
    }
  }

  private composerReady = true;

  readonly ports: TerminalModelControlPorts = {
    beforeInput: async () => {
      if (this.authorityChecks === 0 && this.phase === "idle" &&
          this.mutateEffortBeforeFirstInput) {
        this.currentEffort = this.mutateEffortBeforeFirstInput;
      }
      this.authorityChecks += 1;
    },
    loadCodexCatalog: async () => ({
      models: this.models().map((model) => ({
        id: model,
        label: model,
        reasoningEfforts: this.agent === "codex"
          ? model === "gpt-6-astra"
            ? ["low", "medium", "high", "xhigh", "max", "ultra"]
            : ["low", "medium", "high", "xhigh"]
          : ["low", "medium", "high", "xhigh", "max"]
      }))
    }),
    capture: async ({ expectedComposer }) => {
      this.lastCaptureAuthority = this.authorityChecks;
      if (!this.threw && this.throwOnceInPhase === this.phase) {
        this.threw = true;
        throw new Error("synthetic capture failure");
      }
      return {
        terminalControl: "control",
        screen: this.screen(),
        activityState: "idle" as const,
        approvalBlocked: false,
        exactEmptyComposer: this.phase === "idle",
        exactCommandReady:
          this.phase === "composer" && expectedComposer === "/model" &&
          this.composerReady,
        exactCommandComposer:
          this.phase === "composer" && expectedComposer === "/model",
        exactBareCommand:
          this.phase === "composer" && expectedComposer === "/model" &&
          !this.composerReady,
        ...(this.phase === "composer" && expectedComposer === "/model"
          ? { exactCommandFingerprint: `model:${this.composerReady}` }
          : {})
      };
    },
    sendText: async (_control, text) => {
      this.assertAuthorizedTransport();
      assert.equal(this.phase, "idle");
      this.sentText.push(text);
      this.phase = "composer";
      this.composerReady = !this.materializeBareCommand;
    },
    sendKeys: async (_control, keys) => {
      this.assertAuthorizedTransport();
      assert.equal(keys.length, 1);
      this.sentKeys.push([...keys]);
      this.key(keys[0]);
    },
    sleep: async () => {}
  };

  private assertAuthorizedTransport(): void {
    assert.equal(this.authorityChecks, this.transportCalls + 1);
    assert.equal(this.lastCaptureAuthority, this.authorityChecks);
    this.transportCalls += 1;
  }

  private key(key: string): void {
    if (this.phase === "composer") {
      if (key === "Escape") {
        if (this.composerReady) this.composerReady = false;
        else this.phase = "idle";
      } else if (key === "C-u" && !this.composerReady) {
        this.phase = "idle";
      }
      else {
        assert.equal(key, "C-m");
        this.phase = this.agent === "codex"
          ? this.codexEntryMode ? "codex_entry" : "codex_model"
          : "claude_model";
        this.selectedModelIndex = this.models().indexOf(this.currentModel);
        this.selectedModel = this.currentModel;
      }
      return;
    }
    if (key === "Escape") {
      this.escape();
      return;
    }
    if (this.phase === "codex_entry") {
      assert.equal(key, "C-m");
      assert.equal(this.codexEntryMode, "quick_auto_regular");
      this.phase = "codex_model";
      return;
    }
    if (this.phase === "codex_model") {
      if (this.move(key, "selectedModelIndex", this.models().length)) return;
      assert.equal(key, "C-m");
      this.selectedModel = this.models()[this.selectedModelIndex];
      this.phase = "codex_reasoning";
      this.selectedEffortIndex = this.codexReasoningIndex(this.selectedModel);
      return;
    }
    if (this.phase === "codex_reasoning") {
      if (this.move(key, "selectedEffortIndex", 6)) return;
      assert.equal(key, "C-m");
      if (this.selectedEffortIndex === 5) {
        this.phase = "codex_advanced";
        this.selectedAdvancedIndex = this.currentEffort === "ultra" ? 1 : 0;
        return;
      }
      this.commitCodex(["low", "medium", "high", "xhigh"][
        this.selectedEffortIndex
      ] as TerminalModelReasoningEffort);
      return;
    }
    if (this.phase === "codex_advanced") {
      if (this.move(key, "selectedAdvancedIndex", 2)) return;
      assert.equal(key, "C-m");
      this.commitCodex(this.selectedAdvancedIndex === 0 ? "max" : "ultra");
      return;
    }
    if (this.phase === "codex_scope") {
      if (this.move(key, "selectedScopeIndex", 2)) return;
      assert.equal(key, "C-m");
      assert.equal(this.selectedScopeIndex, 1);
      this.scopeCommits += 1;
      this.currentModel = this.selectedModel;
      this.currentEffort = this.pendingEffort;
      this.defaultModel = this.selectedModel;
      this.defaultEffort = this.pendingEffort;
      if (this.planPersistenceFailure) {
        this.history.push(
          "• Failed to save Plan mode reasoning effort: synthetic failure"
        );
      }
      this.history.push(
        `• Model changed to ${this.currentModel} ${this.currentEffort}`
      );
      this.phase = "idle";
      return;
    }
    if (this.phase === "claude_model") {
      if (key === "Up" || key === "Down") {
        this.move(key, "selectedModelIndex", this.models().length);
        const efforts = this.claudeEffortsByModel[
          this.models()[this.selectedModelIndex]
        ] ?? [];
        if (!efforts.includes(this.currentEffort) && efforts[0]) {
          this.currentEffort = efforts[0];
        }
        return;
      }
      if (key === "Right" || key === "Left") {
        const efforts = this.claudeEffortsByModel[
          this.models()[this.selectedModelIndex]
        ] ?? [];
        assert.ok(efforts.length > 0);
        const delta = key === "Right" ? 1 : -1;
        this.currentEffort = efforts[
          (efforts.indexOf(this.currentEffort) + delta + efforts.length) %
          efforts.length
        ];
        return;
      }
      assert.equal(key, "s");
      this.currentModel = this.models()[this.selectedModelIndex];
      this.phase = "idle";
      return;
    }
    assert.fail(`unexpected ${key} in ${this.phase}`);
  }

  private pendingEffort: TerminalModelReasoningEffort = "low";

  private commitCodex(effort: TerminalModelReasoningEffort): void {
    const modelChanged = this.selectedModel !== this.currentModel;
    if (this.planMode && !modelChanged && effort !== this.currentEffort) {
      this.pendingEffort = effort;
      this.selectedScopeIndex = 0;
      this.phase = "codex_scope";
      return;
    }
    const oldPlanEffort = this.currentEffort;
    this.currentModel = this.selectedModel;
    if (!(this.planMode && modelChanged && effort !== "ultra")) {
      this.currentEffort = effort;
    } else {
      this.currentEffort = oldPlanEffort;
    }
    this.defaultModel = this.selectedModel;
    if (effort !== "ultra") this.defaultEffort = effort;
    this.history.push(this.persistenceFailure
      ? "• Failed to save default model: synthetic failure"
      : `• Model changed to ${this.selectedModel} ${effort}` +
        (effort === "ultra" ? " for this conversation" : ""));
    this.phase = "idle";
  }

  private move(
    key: string,
    field: "selectedModelIndex" | "selectedEffortIndex" |
      "selectedAdvancedIndex" | "selectedScopeIndex",
    length: number
  ): boolean {
    if (key !== "Up" && key !== "Down") return false;
    const delta = key === "Down" ? 1 : -1;
    this[field] = Math.max(0, Math.min(length - 1, this[field] + delta));
    return true;
  }

  private escape(): void {
    if (this.phase === "codex_advanced") this.phase = "codex_reasoning";
    else if (this.phase === "codex_reasoning") this.phase = "codex_model";
    else this.phase = "idle";
  }

  private models(): string[] {
    return this.agent === "codex"
      ? ["gpt-6-astra", "gpt-5.2"]
      : ["opus", "sonnet", "haiku"];
  }

  private codexReasoningIndex(model: string): number {
    if (model !== this.currentModel) return 0;
    return ({ low: 0, medium: 1, high: 2, xhigh: 3, max: 5, ultra: 5 } as const)[
      this.currentEffort
    ] ?? 0;
  }

  private screen(): string {
    const prefix = [...this.history];
    if (this.phase === "idle") return this.agent === "codex"
      ? [...prefix, "> Ask Codex to do anything",
          `  ${this.currentModel} ${this.currentEffort}${this.planMode ? " · Plan mode" : ""}`].join("\n")
      : [...prefix, "> Ask Claude"].join("\n");
    if (this.phase === "composer") return [
      ...prefix,
      "› /model",
      ...(this.composerReady ? [] : [
        `  ${this.currentModel} ${this.currentEffort}`
      ])
    ].join("\n");
    if (this.phase === "codex_entry") {
      if (this.codexEntryMode === "luna_reserve") {
        return [...prefix, "Select Model",
          "Other models return when ordinary usage is available again.",
          "› 1. Luna (current)  Temporary reserve model",
          "Press enter to confirm or esc to go back"].join("\n");
      }
      const autoCurrent = this.codexEntryMode === "quick_auto_current";
      return [...prefix, "Select Model",
        "Pick a quick auto mode or browse all models.",
        `${autoCurrent ? "›" : " "} 1. codex-auto-fast${autoCurrent ? " (current)" : ""}  Fast automatic routing`,
        `${autoCurrent ? " " : "›"} 2. All models${autoCurrent ? "" : " (current)"}  Choose a specific model and reasoning level`,
        "Press enter to confirm or esc to go back"].join("\n");
    }
    if (this.phase === "codex_model") {
      return [...prefix, "Select Model and Effort", ...this.models().map(
        (model, index) =>
          `${index === this.selectedModelIndex ? "›" : " "} ${index + 1}. ${model}` +
          `${model === this.defaultModel ? " (default)" : ""}` +
          `${model === this.currentModel ? " (current)" : ""}  Model description`
      ), "Press enter to confirm or esc to go back"].join("\n");
    }
    if (this.phase === "codex_reasoning") {
      const labels = ["Low", "Medium", "High", "Extra high", "Persistent", "More reasoning…"];
      return [...prefix, `Select Reasoning Level for ${this.selectedModel}`,
        ...labels.map((label, index) => {
          const effort = ["low", "medium", "high", "xhigh", undefined, undefined][index];
          const current = this.selectedModel === this.currentModel &&
            (effort === this.currentEffort ||
             index === 5 && ["max", "ultra"].includes(this.currentEffort));
          return `${index === this.selectedEffortIndex ? "›" : " "} ${index + 1}. ${label}` +
            `${index === 0 ? " (default)" : ""}${current ? " (current)" : ""}`;
        }), "Press enter to confirm or esc to go back"].join("\n");
    }
    if (this.phase === "codex_advanced") {
      return [...prefix, "Advanced Reasoning",
        `${this.selectedAdvancedIndex === 0 ? "›" : " "} 1. Max${this.currentEffort === "max" ? " (current)" : ""}`,
        `${this.selectedAdvancedIndex === 1 ? "›" : " "} 2. Ultra${this.currentEffort === "ultra" ? " (current)" : ""}`,
        "Press enter to confirm or esc to go back"].join("\n");
    }
    if (this.phase === "codex_scope") {
      return [...prefix, "Apply reasoning change",
        `${this.selectedScopeIndex === 0 ? "›" : " "} 1. Apply to Plan mode override`,
        `${this.selectedScopeIndex === 1 ? "›" : " "} 2. Apply to global default and Plan mode override`,
        "Press enter to confirm or esc to go back"].join("\n");
    }
    const effortLabels = { low: "○ Low", medium: "◐ Medium", high: "● High", xhigh: "◉ xHigh", max: "◈ Max" };
    const efforts = this.claudeEffortsByModel[
      this.models()[this.selectedModelIndex]
    ] ?? [];
    return [...prefix, "▔".repeat(80), "   Select model",
      "   Switch between Claude models.",
      "     1. Default (recommended)  Use the default model (currently Claude Opus)",
      ...this.models().map((model, index) =>
        `${index === this.selectedModelIndex ? "   ❯" : "    "} ${index + 2}. provider-model${model === this.currentModel ? " ✔" : ""}  Custom ${model[0].toUpperCase()}${model.slice(1)} model`
      ),
      ...(efforts.length > 0 ? [
        `   ${effortLabels[this.currentEffort as keyof typeof effortLabels]} effort${this.currentEffort === "high" ? " (default)" : ""} ←/→ to adjust`
      ] : []),
      "   Enter to set as default · s to use this session only · Esc to cancel"
    ].join("\n");
  }
}
