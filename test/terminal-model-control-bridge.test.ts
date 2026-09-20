import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import { createTerminalModelControlPorts } from
  "../src/terminal-model-control-bridge.js";
import {
  planTerminalModelControl,
  probeTerminalModelControl,
  terminalModelControlProfileForPlan
} from "../src/terminal-model-control.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "codex:0.0",
  session: "codex",
  window: 0,
  pane: 0,
  panePid: 101,
  currentCommand: "codex",
  currentPath: "/repo",
  capabilities: ["screen_status", "send_keys"]
};

test("model-control bridge keeps Codex input permits operation-local", async () => {
  const physicalText: string[] = [];
  let captures = 0;
  const plan = planTerminalModelControl(
    probeTerminalModelControl("codex", "0.154.0")
  );
  const createPorts = () => createTerminalModelControlPorts({
    adapter: codexTerminalAgentAdapter,
    plan,
    beforeInput: () => undefined,
    runtimePorts: {
      verifyTerminalIdentity: async (_agent, control) => control,
      captureStyled: async () => {
        captures += 1;
        return "stable exact composer";
      },
      sendText: async (_control, text) => {
        physicalText.push(text);
      },
      sendKeys: async () => undefined,
      sleep: async () => undefined
    },
    classifiers: {
      stripEscapes: (value) => value,
      sameIdentity: (left, right) => left === right,
      currentCodexComposer: () => ({
        state: "exact_empty",
        digest: "stable-composer-digest"
      }),
      inspectCodexAsyncQuestionInputMode: () => "absent",
      codexActiveWriterViewerVisible: () => false,
      isExactClaudeIdleComposer: () => false,
      exactClaudeModelControlComposer: () => undefined,
      exactTerminalComposer: () => undefined
    }
  });
  const firstOperation = createPorts();
  const secondOperation = createPorts();

  await firstOperation.capture({ terminalControl: CONTROL });
  assert.equal(captures, 1);

  await assert.rejects(
    secondOperation.sendText(CONTROL, "/model"),
    /Codex \/model text requires one fresh exact empty-composer permit/u
  );
  assert.deepEqual(physicalText, []);
  assert.equal(captures, 1);

  await firstOperation.sendText(CONTROL, "/model");
  assert.deepEqual(physicalText, ["/model"]);
  assert.equal(captures, 2);

  await assert.rejects(
    firstOperation.sendText(CONTROL, "/model"),
    /Codex \/model text requires one fresh exact empty-composer permit/u
  );
  assert.deepEqual(physicalText, ["/model"]);
  assert.equal(captures, 2);
});

test("Codex 0.155.1 model-control bridge blocks its profiled questionnaire", async () => {
  const plan = planTerminalModelControl(
    probeTerminalModelControl("codex", "0.155.1")
  );
  assert.equal(
    terminalModelControlProfileForPlan(plan)?.agentVersion,
    "0.155.1"
  );
  const bridgeSource = fs.readFileSync(
    path.resolve("src/terminal-model-control-bridge.ts"),
    "utf8"
  );
  assert.match(
    bridgeSource,
    /inspectNativeQuestionnaire\(\{[\s\S]*?version:\s*modelControlProfile\.agentVersion,[\s\S]*?screen:\s*styledScreen/u,
    "bridge must bind questionnaire inspection to the plan's exact profile"
  );
  assert.doesNotMatch(
    bridgeSource,
    /version:\s*CODEX_MODEL_CONTROL_AGENT_VERSION/u
  );
  const questionnaire = [
    "  Question 1/1 (1 unanswered)",
    "  Choose an option.",
    "",
    "  › 1. Option 1  First choice.",
    "    2. Option 2  Second choice.",
    "",
    "  tab to add notes | enter to submit answer | esc to interrupt"
  ].join("\n");
  const ports = createTerminalModelControlPorts({
    adapter: codexTerminalAgentAdapter,
    plan,
    beforeInput: () => undefined,
    runtimePorts: {
      verifyTerminalIdentity: async (_agent, control) => control,
      captureStyled: async () => questionnaire,
      sendText: async () => undefined,
      sendKeys: async () => undefined,
      sleep: async () => undefined
    },
    classifiers: {
      stripEscapes: (value) => value,
      sameIdentity: (left, right) => left === right,
      currentCodexComposer: () => ({
        state: "exact_empty",
        digest: "synthetic-empty-composer"
      }),
      inspectCodexAsyncQuestionInputMode: () => "absent",
      codexActiveWriterViewerVisible: () => false,
      isExactClaudeIdleComposer: () => false,
      exactClaudeModelControlComposer: () => undefined,
      exactTerminalComposer: () => undefined
    }
  });

  const captured = await ports.capture({ terminalControl: CONTROL });
  assert.equal(captured.inputBlocked, true);
  await assert.rejects(
    ports.sendText(CONTROL, "/model"),
    /exact Codex empty composer changed/u
  );
});
