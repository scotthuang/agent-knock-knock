import type {
  TerminalModelControlPlan
} from "./terminal-model-control-profile.js";
import {
  TERMINAL_MODEL_REASONING_EFFORTS
} from "./terminal-model-control-contract.js";
import type {
  TerminalModelControlPorts,
  TerminalModelControlCapture,
  TerminalModelControlObservation,
  TerminalModelReasoningEffort,
  TerminalModelNativeEffort,
  TerminalModelSwitchRequest
} from "./terminal-model-control-contract.js";
import {
  modelControlMoveKeys,
  modelControlSelectModelKeys,
  selectedClaudeModelId,
  codexModelControlSelectEffortKeys,
  codexModelControlAllModesKeys,
  claudeModelControlEffortKey,
  claudeModelControlCommitKeys
} from "./terminal-model-control-surface.js";
import {
  transitionModelControl,
  exactDispatchKeys,
  waitForObservation
} from "./terminal-model-control-input.js";

/** Agent-specific selection paths share input proofs, not commit semantics. */
export async function inspectClaudeModelEfforts(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
picker: Extract<TerminalModelControlObservation, { state: "claude_model_picker" }>,
model: string): Promise<{
  capture: TerminalModelControlCapture;
  observation: Extract<TerminalModelControlObservation, { state: "claude_model_picker" }>;
  reasoningEfforts: readonly TerminalModelReasoningEffort[];
}> {
  const selected = await transitionModelControl(
    input,
    terminalControl,
    picker,
    modelControlSelectModelKeys(picker, model),
    ["claude_model_picker"]
  );
  if (selected.observation.state !== "claude_model_picker" ||
      selectedClaudeModelId(selected.observation) !== model) {
    throw new Error("Claude highlighted a different model during catalog inspection");
  }
  let control = selected.capture.terminalControl;
  let live = selected.observation;
  const initial = live.displayedEffort;
  if (!initial) {
    return {
      capture: selected.capture,
      observation: live,
      reasoningEfforts: []
    };
  }
  const seen = new Set<TerminalModelNativeEffort>([initial]);
  for (let count = 0; count < 8; count += 1) {
    const next = await transitionModelControl(
      input,
      control,
      live,
      claudeModelControlEffortKey("higher"),
      ["claude_model_picker"]
    );
    if (next.observation.state !== "claude_model_picker" ||
        selectedClaudeModelId(next.observation) !== model) {
      throw new Error("Claude changed the highlighted model while probing its effort ring");
    }
    control = next.capture.terminalControl;
    live = next.observation;
    const effort = live.displayedEffort;
    if (!effort) {
      throw new Error("Claude removed its effort row while it was being inspected");
    }
    if (effort === initial) {
      return {
        capture: next.capture,
        observation: live,
        reasoningEfforts: TERMINAL_MODEL_REASONING_EFFORTS.filter((effort) =>
          seen.has(effort)
        )
      };
    }
    if (seen.has(effort)) {
      throw new Error("Claude's native effort ring did not return to its initial value");
    }
    seen.add(effort);
  }
  throw new Error("Claude's native effort ring exceeded the verified bounded size");
}

export async function applyCodexModelSelection(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
picker: Extract<TerminalModelControlObservation, { state: "codex_model_picker" }>,
request: TerminalModelSwitchRequest,
beforeCommitAttempt: () => void): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  const target = picker.rows.find((row) => row.id === request.model);
  if (!target) {
    throw new Error("the requested Codex model left the current native picker");
  }
  const moved = await transitionModelControl(
    input,
    terminalControl,
    picker,
    modelControlMoveKeys(picker.selectedIndex, target.nativeIndex),
    ["codex_model_picker"]
  );
  if (moved.observation.state !== "codex_model_picker") {
    throw new Error("Codex model navigation left its native picker");
  }
  const movedSelection = moved.observation.selectedIndex;
  if (moved.observation.rows.find((row) =>
    row.nativeIndex === movedSelection
  )?.id !== request.model) {
    throw new Error("Codex highlighted a different model before selection");
  }
  // A remotely refreshed model can become single-effort after discovery; in
  // that case Enter may commit immediately instead of opening a submenu.
  beforeCommitAttempt();
  const reasoning = await transitionModelControl(
    input,
    moved.capture.terminalControl,
    moved.observation,
    ["C-m"],
    ["codex_reasoning_picker"]
  );
  if (reasoning.observation.state !== "codex_reasoning_picker" ||
      reasoning.observation.model !== request.model) {
    throw new Error("Codex opened a different reasoning picker");
  }
  let selection: Extract<
    TerminalModelControlObservation,
    { state: "codex_reasoning_picker" | "codex_advanced_reasoning_picker" }
  > = reasoning.observation;
  let keys = codexModelControlSelectEffortKeys(
    selection, request.reasoningEffort
  );
  const advanced = request.reasoningEffort === "max" ||
    request.reasoningEffort === "ultra";
  if (!advanced) beforeCommitAttempt();
  let selected = await transitionModelControl(
    input,
    reasoning.capture.terminalControl,
    selection,
    keys,
    advanced
      ? ["codex_advanced_reasoning_picker"]
      : ["none", "codex_plan_scope_picker"],
    advanced ? {} : { allowImmediateNone: true }
  );
  if (advanced) {
    if (selected.observation.state !== "codex_advanced_reasoning_picker") {
      throw new Error("Codex advanced-reasoning picker did not materialize");
    }
    selection = selected.observation;
    keys = codexModelControlSelectEffortKeys(
      selection, request.reasoningEffort
    );
    beforeCommitAttempt();
    selected = await transitionModelControl(
      input,
      selected.capture.terminalControl,
      selection,
      keys,
      ["none", "codex_plan_scope_picker"],
      { allowImmediateNone: true }
    );
  }
  if (selected.observation.state !== "codex_plan_scope_picker") {
    return selected;
  }
  beforeCommitAttempt();
  return transitionModelControl(
    input,
    selected.capture.terminalControl,
    selected.observation,
    codexModelControlAllModesKeys(selected.observation),
    ["none"],
    { allowImmediateNone: true }
  );
}

export async function applyClaudeModelSelection(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
picker: Extract<TerminalModelControlObservation, { state: "claude_model_picker" }>,
request: TerminalModelSwitchRequest,
beforeCommitAttempt: () => void,
// Keep failure cleanup on the latest identity-fenced control, even if this path throws.
onControlObserved: (control: unknown) => void): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  let control = terminalControl;
  const requestedEffort = request.reasoningEffort;
  const selected = await transitionModelControl(
    input,
    control,
    picker,
    modelControlSelectModelKeys(picker, request.model),
    ["claude_model_picker"]
  );
  control = selected.capture.terminalControl;
  onControlObserved(control);
  if (selected.observation.state !== "claude_model_picker") {
    throw new Error("Claude model selection did not remain in its picker");
  }
  if (selectedClaudeModelId(selected.observation) !== request.model) {
    throw new Error("Claude highlighted a different model before effort selection");
  }
  let effortPicker = selected.observation;
  const seen = new Set<TerminalModelNativeEffort>();
  for (let count = 0; count < 7; count += 1) {
    const displayed = effortPicker.displayedEffort;
    if (!displayed) throw new Error("Claude model picker has no exact effort value");
    if (displayed === requestedEffort) break;
    if (seen.has(displayed)) {
      throw new Error("the requested effort is absent from Claude's live effort ring");
    }
    seen.add(displayed);
    const next = await transitionModelControl(
      input,
      control,
      effortPicker,
      claudeModelControlEffortKey("higher"),
      ["claude_model_picker"]
    );
    control = next.capture.terminalControl;
    onControlObserved(control);
    if (next.observation.state !== "claude_model_picker") {
      throw new Error("Claude effort adjustment left the model picker");
    }
    if (selectedClaudeModelId(next.observation) !== request.model) {
      throw new Error("Claude changed the highlighted model during effort selection");
    }
    effortPicker = next.observation;
  }
  if (effortPicker.displayedEffort !== requestedEffort) {
    throw new Error("the requested effort is absent from Claude's live effort ring");
  }
  if (selectedClaudeModelId(effortPicker) !== request.model) {
    throw new Error("Claude changed the highlighted model before session-only commit");
  }
  beforeCommitAttempt();
  await exactDispatchKeys(
    input,
    control,
    effortPicker,
    claudeModelControlCommitKeys(input.plan)
  );
  const closed = await waitForObservation(input, control, ["none"], {
    allowImmediateNone: true
  });
  return closed;
}
