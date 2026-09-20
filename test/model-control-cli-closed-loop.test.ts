import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodexOpenRootRolloutInventory } from
  "../src/agent-session-provider.js";
import type { CodexLocalSessionAdapter } from
  "../src/codex-local-session-provider.js";
import {
  MutableRecordingTerminalProvider,
  MutableTerminalProcessSource,
  runInProcessCli,
  terminalCliDependencies,
  VirtualClock
} from "./in-process-cli-fixtures.js";
import {
  codex0154AdvancedReasoningFrame,
  codex0154CommandPopupFrame,
  codex0154IdleFrame,
  codex0154ModelPickerFrame,
  codex0154ReasoningPickerFrame,
  type Codex0154ModelRow,
  type GoldenReasoningEffort
} from "./support/terminal-ui-golden-frames.js";

type CodexModelControlPhase =
  | "idle"
  | "command_popup"
  | "model_picker"
  | "reasoning_picker"
  | "advanced_reasoning_picker";

class Codex0154ClosedLoopTui {
  readonly models: readonly Codex0154ModelRow[] = Object.freeze([
    { id: "gpt-6-astra", description: "Frontier coding model" },
    { id: "gpt-5.6-sol", description: "Fast coding model" },
    { id: "gpt-5.6-terra", description: "Balanced coding model" }
  ]);
  phase: CodexModelControlPhase = "idle";
  currentModel = "gpt-5.6-sol";
  currentEffort: GoldenReasoningEffort = "high";
  defaultModel = "gpt-5.6-sol";
  defaultEffort: GoldenReasoningEffort = "high";
  selectedModelIndex = 1;
  selectedReasoningIndex = 2;
  selectedAdvancedIndex = 0;
  selectedModel = this.currentModel;
  readonly history: string[] = [];

  screen(): string {
    if (this.phase === "idle") {
      return codex0154IdleFrame({
        model: this.currentModel,
        effort: this.currentEffort,
        history: this.history
      });
    }
    if (this.phase === "command_popup") {
      return codex0154CommandPopupFrame();
    }
    if (this.phase === "model_picker") {
      return codex0154ModelPickerFrame({
        rows: this.models.map((row) => ({
          ...row,
          current: row.id === this.currentModel,
          presetDefault: row.id === this.defaultModel
        })),
        selectedIndex: this.selectedModelIndex
      });
    }
    if (this.phase === "reasoning_picker") {
      return codex0154ReasoningPickerFrame({
        model: this.selectedModel,
        selectedIndex: this.selectedReasoningIndex,
        ...(this.selectedModel === this.currentModel
          ? { currentEffort: this.currentEffort }
          : {})
      });
    }
    return codex0154AdvancedReasoningFrame({
      selectedIndex: this.selectedAdvancedIndex,
      ...(this.selectedModel === this.currentModel
        ? { currentEffort: this.currentEffort }
        : {})
    });
  }

  receiveText(text: string): void {
    assert.equal(this.phase, "idle");
    assert.equal(text, "/model");
    this.phase = "command_popup";
  }

  receiveKeys(keys: readonly string[]): void {
    assert.equal(keys.length, 1);
    const [key] = keys;
    if (key === "Escape") {
      this.phase = "idle";
      return;
    }
    if (this.phase === "command_popup") {
      assert.equal(key, "C-m");
      this.phase = "model_picker";
      this.selectedModelIndex = this.models.findIndex((row) =>
        row.id === this.currentModel
      );
      return;
    }
    if (this.phase === "model_picker") {
      if (this.move(key, "selectedModelIndex", this.models.length)) return;
      assert.equal(key, "C-m");
      this.selectedModel = this.models[this.selectedModelIndex].id;
      this.selectedReasoningIndex = this.selectedModel === this.currentModel
        ? this.reasoningIndex(this.currentEffort)
        : 0;
      this.phase = "reasoning_picker";
      return;
    }
    if (this.phase === "reasoning_picker") {
      if (this.move(key, "selectedReasoningIndex", 6)) return;
      assert.equal(key, "C-m");
      if (this.selectedReasoningIndex === 5) {
        this.phase = "advanced_reasoning_picker";
        this.selectedAdvancedIndex = 0;
        return;
      }
      const effort = ["low", "medium", "high", "xhigh"][
        this.selectedReasoningIndex
      ] as GoldenReasoningEffort | undefined;
      assert.ok(effort, "Persistent is not a semantic AKK effort");
      this.commit(effort);
      return;
    }
    assert.equal(this.phase, "advanced_reasoning_picker");
    if (this.move(key, "selectedAdvancedIndex", 2)) return;
    assert.equal(key, "C-m");
    this.commit(this.selectedAdvancedIndex === 0 ? "max" : "ultra");
  }

  private move(
    key: string,
    field: "selectedModelIndex" | "selectedReasoningIndex" |
      "selectedAdvancedIndex",
    count: number
  ): boolean {
    if (key !== "Up" && key !== "Down") return false;
    const delta = key === "Down" ? 1 : -1;
    this[field] = Math.max(0, Math.min(count - 1, this[field] + delta));
    return true;
  }

  private reasoningIndex(effort: GoldenReasoningEffort): number {
    return ({
      low: 0,
      medium: 1,
      high: 2,
      xhigh: 3,
      max: 5,
      ultra: 5
    } as const)[effort];
  }

  private commit(effort: GoldenReasoningEffort): void {
    this.currentModel = this.selectedModel;
    this.currentEffort = effort;
    this.defaultModel = this.selectedModel;
    if (effort !== "ultra") this.defaultEffort = effort;
    this.history.push(
      `• Model changed to ${this.selectedModel} ${effort}` +
      (effort === "ultra" ? " for this conversation" : "")
    );
    this.phase = "idle";
  }
}

for (const { version, behaviorProfile } of [
  {
    version: "0.154.0",
    behaviorProfile: "codex-model-control-0.154.0"
  },
  {
    version: "0.155.1",
    behaviorProfile: "codex-model-control-0.155.1"
  }
] as const) {
test(`in-process CLI closes Codex ${version} List to one-shot model control with exact postconditions`, async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-model-control-cli-closed-loop-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const codexHome = path.join(root, "codex-home");
  const fakeBin = path.join(root, "bin");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome);
  fs.mkdirSync(fakeBin);

  const codexExecutable = path.join(
    root,
    "standalone",
    "releases",
    `${version}-aarch64-apple-darwin`,
    "bin",
    "codex"
  );
  fs.mkdirSync(path.dirname(codexExecutable), { recursive: true });
  fs.writeFileSync(codexExecutable, [
    "#!/bin/sh",
    "printf '%s\\n' '{\"models\":[" +
      "{\"slug\":\"gpt-6-astra\",\"display_name\":\"GPT-6 Astra\"," +
      "\"visibility\":\"list\",\"supported_reasoning_levels\":[" +
      "{\"effort\":\"low\"},{\"effort\":\"medium\"}," +
      "{\"effort\":\"high\"},{\"effort\":\"xhigh\"}," +
      "{\"effort\":\"max\"},{\"effort\":\"ultra\"}]}," +
      "{\"slug\":\"gpt-5.6-sol\",\"display_name\":\"GPT-5.6 Sol\"," +
      "\"visibility\":\"list\",\"supported_reasoning_levels\":[" +
      "{\"effort\":\"low\"},{\"effort\":\"medium\"}," +
      "{\"effort\":\"high\"},{\"effort\":\"xhigh\"}]}," +
      "{\"slug\":\"gpt-5.6-terra\",\"display_name\":\"GPT-5.6 Terra\"," +
      "\"visibility\":\"list\",\"supported_reasoning_levels\":[" +
      "{\"effort\":\"low\"},{\"effort\":\"medium\"}," +
      "{\"effort\":\"high\"},{\"effort\":\"xhigh\"}]}]}'"
  ].join("\n"));
  fs.chmodSync(codexExecutable, 0o700);
  const lsofExecutable = path.join(fakeBin, "lsof");
  fs.writeFileSync(lsofExecutable, [
    "#!/bin/sh",
    `printf '%s\\n' 'n${codexExecutable}'`
  ].join("\n"));
  fs.chmodSync(lsofExecutable, 0o700);

  const panePid = 9000;
  const codexPid = 4242;
  const target = "model-control:0.0";
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const processBirth = "fixture-codex-process-birth";
  const processUuid = `codex-pid:${codexPid}:birth:${processBirth}`;
  const processSnapshots = [
    {
      pid: panePid,
      ppid: 1,
      elapsed: "00:20",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: codexPid,
      ppid: panePid,
      elapsed: "00:19",
      command: codexExecutable,
      cwd: workspace
    }
  ];
  const inventoryAuthority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid: codexPid,
    processUuid,
    processBirth,
    cwd: workspace,
    roots: [] as []
  };
  const zeroRolloutInventory: CodexOpenRootRolloutInventory = {
    ...inventoryAuthority,
    status: "verified_absent",
    inventoryFingerprint: createHash("sha256")
      .update(JSON.stringify(inventoryAuthority))
      .digest("hex")
  };
  const codexAdapter: CodexLocalSessionAdapter = {
    listThreadRows: async () => [],
    readRollout: async () => undefined,
    listProcessSnapshots: async () => processSnapshots,
    resolveActiveSessionIdentityForPid: async () => undefined,
    inspectOpenRootRolloutInventoryForPid: async () => zeroRolloutInventory
  };

  const tui = new Codex0154ClosedLoopTui();
  const terminalProvider = new MutableRecordingTerminalProvider({
    panes: [{
      kind: "tmux",
      target,
      session: "model-control",
      window: 0,
      pane: 0,
      panePid,
      currentCommand: "codex",
      currentPath: workspace
    }],
    screens: { [target]: tui.screen() },
    hooks: {
      sendText(operation, provider) {
        tui.receiveText(operation.text);
        provider.setScreen(target, tui.screen());
      },
      sendKeys(operation, provider) {
        tui.receiveKeys(operation.keys);
        provider.setScreen(target, tui.screen());
      }
    }
  });
  const clock = new VirtualClock("2026-09-15T03:00:00.000Z");
  const dependencies = terminalCliDependencies({
    terminalProvider,
    processSource: new MutableTerminalProcessSource(processSnapshots),
    clock,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
      HOME: root,
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_LOG_LEVEL: "silent",
      TMUX: ""
    },
    overrides: {
      codexLocalSessionAdapter: codexAdapter,
      agentVersionForRunningProcess: () => version,
      codexProcessBirthForPid: () => processBirth,
      processBirthForPid: () => processBirth,
      pid: 600_042
    }
  });
  const storeArgs = [
    "--store-dir", storeDir,
    "--codex-home", codexHome
  ];

  const listed = await runInProcessCli(["list", ...storeArgs], dependencies);
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const listOutput = JSON.parse(listed.stdout) as {
    terminals: Array<Record<string, any>>;
  };
  const terminal = listOutput.terminals.find((entry) => entry.id === terminalId);
  assert.ok(terminal, listed.stdout);
  assert.equal(terminal.native_identity_state, "verified_absent");
  assert.equal(terminal.screen_state, "idle");
  assert.equal(
    terminal.model_control.behaviorProfile,
    behaviorProfile
  );
  const listAction = terminal.available_actions.model_options;
  assert.equal(listAction.tool, "agent_knock_knock_model_options");
  assert.equal(listAction.authority_scope, "terminal_user_explicit_model_control");
  const listBindingToken = String(
    listAction.arguments.expected_binding_token
  );
  assert.match(listBindingToken, /^[0-9a-f]{64}$/u);

  const optionsResult = await runInProcessCli([
    "model-options",
    "--terminal", terminalId,
    "--expected-binding-token", listBindingToken,
    ...storeArgs
  ], dependencies);
  assert.equal(optionsResult.status, 0, optionsResult.stderr || optionsResult.stdout);
  const optionsOutput = JSON.parse(optionsResult.stdout) as Record<string, any>;
  assert.deepEqual(optionsOutput.current, {
    model: "gpt-5.6-sol",
    reasoning_effort: "high"
  });
  assert.deepEqual(
    optionsOutput.models.map((model: Record<string, unknown>) => model.id),
    ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]
  );
  const setAction = optionsOutput.available_actions.set_model;
  assert.deepEqual(Object.keys(optionsOutput.available_actions), ["set_model"]);
  assert.equal(setAction.tool, "agent_knock_knock_set_model");
  assert.equal(
    setAction.arguments.expected_binding_token,
    listBindingToken
  );
  assert.match(
    String(setAction.arguments.expected_catalog_fingerprint),
    /^[0-9a-f]{64}$/u
  );

  const switched = await runInProcessCli([
    "set-model",
    "--terminal", terminalId,
    "--expected-binding-token",
    String(setAction.arguments.expected_binding_token),
    "--expected-catalog-fingerprint",
    String(setAction.arguments.expected_catalog_fingerprint),
    "--model", "gpt-5.6-terra",
    "--reasoning-effort", "high",
    ...storeArgs
  ], dependencies);
  assert.equal(switched.status, 0, switched.stderr || switched.stdout);
  const switchedOutput = JSON.parse(switched.stdout);
  assert.equal(switchedOutput.outcome, "changed");
  assert.deepEqual(switchedOutput.effective, {
    model: "gpt-5.6-terra",
    reasoning_effort: "high"
  });
  assert.deepEqual(switchedOutput.new_session_defaults, {
    model: "gpt-5.6-terra",
    reasoning_effort: "high"
  });
  assert.equal(switchedOutput.defaults_changed, true);
  assert.equal(switchedOutput.do_not_retry, false);
  assert.equal(tui.phase, "idle");
  assert.equal(tui.currentModel, "gpt-5.6-terra");
  assert.equal(tui.currentEffort, "high");
  assert.equal(tui.defaultModel, "gpt-5.6-terra");
  assert.equal(tui.defaultEffort, "high");

  const terminalInputs = terminalProvider.operations.filter((operation) =>
    operation.kind === "text" || operation.kind === "keys"
  );
  assert.ok(terminalInputs.length > 0);
  assert.equal(terminalProvider.literalInputs().every((text) => text === "/model"), true);
  assert.equal(terminalProvider.keyDispatches().every((keys) => keys.length === 1), true);
});
}
