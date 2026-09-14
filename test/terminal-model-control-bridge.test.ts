import test from "node:test";
import assert from "node:assert/strict";
import { codexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import { createTerminalModelControlPorts } from
  "../src/terminal-model-control-bridge.js";
import {
  planTerminalModelControl,
  probeTerminalModelControl
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
