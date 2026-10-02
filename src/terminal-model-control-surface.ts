export { probeTerminalModelControl, planTerminalModelControl } from "./terminal-model-control-profile.js";
import {
  createHash
} from "node:crypto";
import {
  isCodexPaginatedVersion
} from "./codex-lifecycle-compatibility.js";
import {
  captureCodexFullscreenComposerFrame
} from "./codex-fullscreen-composer-proof.js";
import {
  isTerminalModelControlPlanForAgent,
  terminalModelControlProfileForPlan,
  type TerminalModelControlPlan
} from "./terminal-model-control-profile.js";
import {
  isTerminalModelReasoningEffort
} from "./terminal-model-control-contract.js";
import type {
  TerminalModelReasoningEffort,
  TerminalModelNativeEffort,
  TerminalModelChoice,
  TerminalModelValue,
  TerminalModelSwitchRequest,
  CodexNativeModelCatalog,
  ModelRow,
  EffortRow,
  TerminalModelControlObservation,
  TerminalModelControlCapture,
  ExactTerminalModelControlObservation,
  TerminalModelControlSurface
} from "./terminal-model-control-contract.js";

/** Pure native surfaces and semantic navigation; this module never performs input. */
export function parseCodexNativeModelCatalog(
  value: unknown
): CodexNativeModelCatalog {
  if (!isPlainRecord(value) || !Array.isArray(value.models)) {
    throw new Error("the exact running Codex model catalog has an unknown shape");
  }
  const models = value.models.flatMap((candidate): TerminalModelChoice[] => {
    if (!isPlainRecord(candidate) || candidate.visibility !== "list") return [];
    const id = nonBlank(candidate.slug);
    const label = nonBlank(candidate.display_name) ?? id;
    if (!id || !label || !/^[a-z0-9][a-z0-9._:/+\-]{0,127}$/u.test(id) ||
        !Array.isArray(candidate.supported_reasoning_levels)) {
      throw new Error("the exact running Codex model catalog contains an invalid visible row");
    }
    const efforts = candidate.supported_reasoning_levels.flatMap(
      (entry): TerminalModelReasoningEffort[] => {
        const effort = isPlainRecord(entry) ? entry.effort : undefined;
        return isTerminalModelReasoningEffort(effort) ? [effort] : [];
      }
    );
    if (efforts.length === 0 || new Set(efforts).size !== efforts.length) {
      throw new Error(
        `the exact running Codex model catalog has no unique supported efforts for ${id}`
      );
    }
    return [{ id, label, reasoningEfforts: efforts }];
  });
  if (models.length === 0 ||
      new Set(models.map((model) => model.id)).size !== models.length) {
    throw new Error("the exact running Codex model catalog has no unique visible models");
  }
  return { models };
}

export function observeCodexIdleModel(screen: string, plan?: TerminalModelControlPlan):
(TerminalModelValue & { readonly planMode: boolean }) | undefined {
  const lines = stripAnsi(screen).replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  const version = plan && terminalModelControlProfileForPlan(plan)?.agentVersion;
  const modern = isCodexPaginatedVersion(version);
  const frame = modern ? captureCodexFullscreenComposerFrame(screen, version) : undefined;
  const footer = modern
    ? frame?.hasShortcutFooter ? frame.plainLines[frame.footerIndex] : undefined
    : lines.at(-1);
  const match = footer
    ? /^\s{2,}([A-Za-z0-9][A-Za-z0-9._:/+\-]{0,127})\s+(low|medium|high|xhigh|max|ultra)(?:\s+fast)?(?:\s+·.*|\s+Plan mode(?:\s+\([^)]*\))?)?\s*$/u
      .exec(footer)
    : undefined;
  if (!match || !isTerminalModelReasoningEffort(match[2])) return undefined;
  const model = codexSemanticModelLabel(match[1]!, modern);
  if (!model) return undefined;
  return {
    model,
    reasoningEffort: match[2],
    planMode: /\bPlan mode\b/u.test(footer ?? "")
  };
}

/**
 * Observe only complete, current model-control modal frames. Historical or
 * partial picker text is never sufficient to authorize a key dispatch.
 */
export function observeTerminalModelControl(
  plan: TerminalModelControlPlan,
  screen: string
): TerminalModelControlObservation {
  const normalized = stripAnsi(screen).replace(/\r\n?/gu, "\n");
  return isTerminalModelControlPlanForAgent(plan, "codex")
    ? observeCodexModelControl(normalized, plan)
    : observeClaudeModelControl(normalized);
}

export function modelControlMoveKeys(
  currentIndex: number,
  targetIndex: number
): readonly string[] {
  if (
    !Number.isSafeInteger(currentIndex) ||
    !Number.isSafeInteger(targetIndex) ||
    currentIndex < 0 ||
    targetIndex < 0
  ) {
    throw new Error("model-control selection index is invalid");
  }
  const key = targetIndex >= currentIndex ? "Down" : "Up";
  return Array.from(
    { length: Math.abs(targetIndex - currentIndex) },
    () => key
  );
}

/** Adapter-owned native navigation; never serialize these keys to a caller. */
export function modelControlSelectModelKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_model_picker" | "claude_model_picker" }
  >,
  model: string
): readonly string[] {
  const row = observation.rows.find((candidate) => candidate.id === model);
  if (!row) throw new Error("the requested model is absent from the current native picker");
  return [
    ...modelControlMoveKeys(observation.selectedIndex, row.nativeIndex),
    ...(observation.state === "codex_model_picker" ? ["C-m"] : [])
  ];
}

export function selectedClaudeModelId(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "claude_model_picker" }
  >
): string | undefined {
  return observation.rows.find((row) =>
    row.nativeIndex === observation.selectedIndex
  )?.id;
}

export function codexModelControlSelectEffortKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_reasoning_picker" | "codex_advanced_reasoning_picker" }
  >,
  effort: TerminalModelReasoningEffort
): readonly string[] {
  const direct = observation.rows.find((row) =>
    row.kind === "effort" && row.effort === effort
  );
  const target = direct ?? (
    observation.state === "codex_reasoning_picker" &&
    (effort === "max" || effort === "ultra")
      ? observation.rows.find((row) => row.kind === "advanced")
      : undefined
  );
  if (!target) {
    throw new Error("the requested reasoning effort is absent from the current native picker");
  }
  const targetIndex = observation.rows.indexOf(target);
  return [
    ...modelControlMoveKeys(observation.selectedIndex, targetIndex),
    "C-m"
  ];
}

export function codexModelControlAllModesKeys(
  observation: Extract<
    TerminalModelControlObservation,
    { state: "codex_plan_scope_picker" }
  >
): readonly string[] {
  const targetIndex = observation.rows.indexOf(
    "Apply to global default and Plan mode override"
  );
  if (targetIndex < 0) {
    throw new Error("Codex Plan-mode scope picker has no global-default choice");
  }
  return [
    ...modelControlMoveKeys(observation.selectedIndex, targetIndex),
    "C-m"
  ];
}

export function claudeModelControlEffortKey(
  direction: "lower" | "higher"
): readonly ["Left" | "Right"] {
  return [direction === "lower" ? "Left" : "Right"];
}

export function claudeModelControlCommitKeys(
  plan: TerminalModelControlPlan
): readonly ["s"] {
  if (
    !isTerminalModelControlPlanForAgent(plan, "claude") ||
    plan.scope !== "current_session"
  ) {
    throw new Error("Claude model control cannot commit outside session-only scope");
  }
  return ["s"];
}

export function isExactTerminalModelControlObservation(
  observation: TerminalModelControlObservation
): observation is ExactTerminalModelControlObservation {
  return observation.state !== "none" && observation.state !== "ambiguous";
}

/** Pure capture classifier. It never authorizes input by itself. */
export function classifyTerminalModelControlSurface(
  plan: TerminalModelControlPlan,
  capture: TerminalModelControlCapture
): TerminalModelControlSurface {
  const observation = observeTerminalModelControl(plan, capture.screen);

  // Approval and a positively identified non-model input owner remain hard
  // safety boundaries even when stale transcript text resembles a picker.
  const hardBlock = modelControlHardBlock(capture);
  if (hardBlock) return hardBlock;

  // Exact profile-owned surfaces outrank generic lifecycle activity. Codex and
  // Claude can report working/waiting while their native picker owns input.
  if (isExactTerminalModelControlObservation(observation)) {
    return {
      state: "picker",
      pickerKind: modelControlPickerKind(observation),
      observation
    };
  }

  // Only a complete picker owns the lifecycle override. Composer proofs do
  // not supersede genuine working/approval lifecycle state.
  const activityBlock = modelControlActivityBlock(capture);
  if (activityBlock) return activityBlock;

  return classifyModelControlComposerSurface(capture, observation);
}

export function modelControlHardBlock(
  capture: TerminalModelControlCapture
): Extract<TerminalModelControlSurface, { state: "blocked" }> | undefined {
  if (capture.approvalBlocked) {
    return { state: "blocked", owner: "approval" };
  }
  return capture.inputBlocked === true
    ? { state: "blocked", owner: "input" }
    : undefined;
}

export function modelControlActivityBlock(
  capture: TerminalModelControlCapture
): Extract<TerminalModelControlSurface, { state: "blocked" }> | undefined {
  return capture.activityState === "working" ||
      capture.activityState === "awaiting_approval"
    ? { state: "blocked", owner: "agent" }
    : undefined;
}

export function modelControlPickerKind(
  observation: ExactTerminalModelControlObservation
): "model" | "effort" | "scope" {
  if (observation.state === "codex_reasoning_picker" ||
      observation.state === "codex_advanced_reasoning_picker") {
    return "effort";
  }
  return observation.state === "codex_plan_scope_picker" ? "scope" : "model";
}

export function classifyModelControlComposerSurface(
  capture: TerminalModelControlCapture,
  observation: TerminalModelControlObservation
): TerminalModelControlSurface {

  const contradictoryComposerProof =
    capture.exactEmptyComposer && capture.exactCommandComposer ||
    capture.exactCommandReady && capture.exactBareCommand === true ||
    (capture.exactCommandReady || capture.exactBareCommand === true) &&
      !capture.exactCommandComposer;
  if (contradictoryComposerProof) {
    return {
      state: "unknown",
      reason: "model-control Composer proofs conflict"
    };
  }
  if (
    capture.exactCommandComposer &&
    capture.exactCommandReady
  ) {
    return {
      state: "command_popup",
      ...(capture.exactCommandFingerprint
        ? { fingerprint: capture.exactCommandFingerprint }
        : {})
    };
  }
  if (
    capture.exactCommandComposer &&
    capture.exactBareCommand === true
  ) {
    return {
      state: "bare_command",
      ...(capture.exactCommandFingerprint
        ? { fingerprint: capture.exactCommandFingerprint }
        : {})
    };
  }
  if (capture.exactCommandComposer) {
    return {
      state: "command_draft",
      ...(capture.exactCommandFingerprint
        ? { fingerprint: capture.exactCommandFingerprint }
        : {})
    };
  }
  if (capture.exactEmptyComposer && capture.activityState === "idle") {
    return { state: "idle_empty" };
  }
  return {
    state: "unknown",
    reason: observation.state === "ambiguous"
      ? observation.reason
      : "no exact current model-control surface is proven"
  };
}

export function modelControlCaptureBlocked(
  capture: TerminalModelControlCapture
): boolean {
  return capture.approvalBlocked || capture.inputBlocked === true;
}

export function observeCodexModelControl(
  screen: string,
  plan: TerminalModelControlPlan
): TerminalModelControlObservation {
  const lines = terminalTailLines(screen);
  const fingerprint = screenFingerprint(lines);
  const entryHeader = lastIndex(lines, (line) =>
    line.trim() === "Select Model"
  );
  const modelHeader = lastIndex(lines, (line) =>
    line.trim() === "Select Model and Effort"
  );
  const reasoningHeader = lastIndex(lines, (line) =>
    /^\s*Select Reasoning Level for \S+\s*$/u.test(line)
  );
  const advancedHeader = lastIndex(lines, (line) =>
    line.trim() === "Advanced Reasoning"
  );
  const scopeHeader = lastIndex(lines, (line) =>
    line.trim() === "Apply reasoning change"
  );
  const latest = Math.max(
    entryHeader, modelHeader, reasoningHeader, advancedHeader, scopeHeader
  );
  if (latest < 0) {
    return { state: "none", fingerprint, reason: "no current Codex model picker is visible" };
  }
  const modern = isCodexPaginatedVersion(terminalModelControlProfileForPlan(plan)?.agentVersion);
  const region = currentPickerRegion(lines, latest, modern);
  if (!region) {
    return {
      state: "ambiguous",
      fingerprint,
      reason: "the current Codex model picker is incomplete or has trailing content"
    };
  }
  if (region.some((line) => line.includes("OpenAI base URL is overridden"))) {
    return {
      state: "ambiguous",
      fingerprint,
      reason: "Codex model control is unavailable with an overridden OpenAI base URL"
    };
  }
  if (latest === entryHeader) {
    const parsedEntry = parseCodexEntryModelPicker(region);
    if (!parsedEntry) {
      return {
        state: "ambiguous",
        fingerprint,
        reason: "the Codex entry model picker is not exact"
      };
    }
    return { state: "codex_entry_model_picker", fingerprint, ...parsedEntry };
  }
  if (latest === modelHeader) {
    const parsedRows = parseCodexModelRows(region, modern);
    if (!parsedRows || modern && ![
      "enter select · esc back", "enter default · s session · esc back"
    ].includes(region.at(-1)!.trim())) {
      return { state: "ambiguous", fingerprint, reason: "the Codex model catalog frame is not exact" };
    }
    return { state: "codex_model_picker", fingerprint, ...parsedRows };
  }
  if (latest === reasoningHeader) {
    const modelLabel = /^\s*Select Reasoning Level for (\S+)\s*$/u.exec(
      region[0] ?? ""
    )?.[1];
    const model = modelLabel && codexSemanticModelLabel(modelLabel, modern);
    const parsedRows = parseCodexEffortRows(region, false);
    if (!model || !parsedRows || modern &&
        !codexFullscreenEffortFooterMatches(region, parsedRows.rows[parsedRows.selectedIndex]!)) {
      return { state: "ambiguous", fingerprint, reason: "the Codex reasoning frame is not exact" };
    }
    return {
      state: "codex_reasoning_picker",
      fingerprint,
      model,
      ...parsedRows
    };
  }
  if (latest === advancedHeader) {
    const parsedRows = parseCodexEffortRows(region, true);
    if (!parsedRows || modern &&
        !codexFullscreenEffortFooterMatches(region, parsedRows.rows[parsedRows.selectedIndex]!)) {
      return { state: "ambiguous", fingerprint, reason: "the Codex advanced-reasoning frame is not exact" };
    }
    return {
      state: "codex_advanced_reasoning_picker",
      fingerprint,
      ...parsedRows
    };
  }
  const rows = region.flatMap((line) => {
    const match = (modern
      ? /^\s*(?:›\s*)?\d+\.\s+(Apply to (?:Plan mode override|global default and Plan mode override))(?:\s{2,}.+)?\s*$/u
      : /^\s*(?:›\s*)?\d+\.\s+(Apply to (?:Plan mode override|global default and Plan mode override))\s*$/u)
      .exec(line);
    return match ? [match[1]] : [];
  });
  const numberedLines = region.filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedLines = numberedLines.filter((line) => /^\s*›\s*\d+\./u.test(line));
  if (
    rows.length !== 2 ||
    numberedLines.length !== rows.length ||
    selectedLines.length !== 1 ||
    rows[0] !== "Apply to Plan mode override" ||
    rows[1] !== "Apply to global default and Plan mode override" ||
    modern && region.at(-1)?.trim() !== "enter select · esc back" ||
    !numberedLines.every((line, index) =>
      new RegExp(`^\\s*(?:›\\s*)?${index + 1}\\.`).test(line)
    )
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Codex Plan-mode scope frame is not exact" };
  }
  const selectedRow = numberedLines.findIndex((line) => /^\s*›/u.test(line));
  return {
    state: "codex_plan_scope_picker",
    fingerprint,
    rows,
    selectedIndex: selectedRow
  };
}

export function observeClaudeModelControl(
  screen: string
): TerminalModelControlObservation {
  const lines = terminalTailLines(screen);
  const fingerprint = screenFingerprint(lines);
  const headerIndex = lastIndex(lines, (line) =>
    line.trim() === "Select model"
  );
  if (headerIndex < 0) {
    return { state: "none", fingerprint, reason: "no current Claude model picker is visible" };
  }
  if (
    headerIndex === 0 ||
    !/^\s*[▔¯─━]{8,}\s*$/u.test(lines[headerIndex - 1])
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model picker is not anchored to its top border" };
  }
  const region = lines.slice(headerIndex);
  const footerIndex = region.findIndex((line) =>
    /^\s*Enter to set as default\s+·\s+s to use this session only\s+·\s+Esc to cancel\s*$/u
      .test(line)
  );
  if (footerIndex < 0 || region.slice(footerIndex + 1).some((line) => line.trim())) {
    return { state: "ambiguous", fingerprint, reason: "the current Claude model picker footer is incomplete" };
  }
  const picker = region.slice(0, footerIndex + 1);
  const rows: ModelRow[] = [];
  const nativeRows: Array<{
    nativeIndex: number;
    selected: boolean;
    label: string;
    description: string;
    current: boolean;
  }> = [];
  for (const line of picker) {
    const match = /^\s*(❯\s*)?(\d+)\.\s+(.+?)(?:\s{2,})(\S.*)$/u.exec(line);
    if (!match) continue;
    const rawLabel = match[3].trim();
    const label = rawLabel.replace(/\s+✔\s*$/u, "").trim();
    const description = match[4].trim();
    nativeRows.push({
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      label,
      description,
      current: rawLabel.endsWith("✔")
    });
  }
  const numberedClaudeLines = picker.filter((line) =>
    /^\s*(?:❯\s*)?\d+\./u.test(line)
  );
  if (numberedClaudeLines.length !== nativeRows.length ||
      nativeRows.some((row, index) => row.nativeIndex !== index)) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model numbering is not exact" };
  }
  for (const row of nativeRows) {
    if (
      /^Default(?:\s+\(recommended\))?$/iu.test(row.label) ||
      /Opus Plan Mode/iu.test(row.label) ||
      /Opus Plan Mode/iu.test(row.description) ||
      /\bFable\b/iu.test(row.label) ||
      /\bFable\b/iu.test(row.description)
    ) continue;
    const id = claudeSemanticModelId(`${row.label} ${row.description}`);
    if (!id) continue;
    rows.push({
      id,
      label: row.label,
      nativeIndex: row.nativeIndex,
      selected: row.selected,
      current: row.current,
      presetDefault: false
    });
  }
  const selectedRows = nativeRows.filter((row) => row.selected);
  const selectedNativeIndex = selectedRows[0]?.nativeIndex ?? -1;
  const currentNativeRows = nativeRows.filter((row) => row.current);
  const currentModel = currentNativeRows.length === 1
    ? claudeSemanticModelId(
        `${currentNativeRows[0].label} ${currentNativeRows[0].description}`
      )
    : undefined;
  if (
    rows.length === 0 ||
    selectedRows.length !== 1 ||
    !currentModel ||
    !rows.some((row) => row.id === currentModel) ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    return { state: "ambiguous", fingerprint, reason: "the Claude model rows are not profiled" };
  }
  const displayedEfforts = picker.flatMap((line) => {
    const match = /^\s*[●○◐◉◈✦]\s+(Low|Medium|High|Extra high|Xhigh|Max|Ultracode)\s+effort\b/iu
      .exec(line);
    const value = match ? claudeEffortFromNativeLabel(match[1]) : undefined;
    return value ? [value] : [];
  });
  if (displayedEfforts.length > 1) {
    return { state: "ambiguous", fingerprint, reason: "the Claude effort row is not exact" };
  }
  const displayedEffort = displayedEfforts[0];
  return {
    state: "claude_model_picker",
    fingerprint,
    rows,
    selectedIndex: selectedNativeIndex,
    currentNativeIndex: currentNativeRows[0].nativeIndex,
    currentModel,
    ...(displayedEffort && displayedEffort !== "ultracode"
      ? { currentEffort: displayedEffort }
      : {}),
    ...(displayedEffort ? { displayedEffort } : {})
  };
}

export function codexSemanticModelLabel(label: string, fullscreen: boolean): string | undefined {
  if (/^[a-z0-9][a-z0-9._:/+\-]*$/u.test(label)) return label;
  return fullscreen && /^GPT-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(label)
    ? label.toLowerCase()
    : undefined;
}

export function parseCodexModelRows(region: readonly string[], fullscreen = false): {
  rows: readonly ModelRow[];
  selectedIndex: number;
  currentNativeIndex: number;
  currentModel: string;
} | undefined {
  const rows: ModelRow[] = [];
  for (const line of region.slice(1, -1)) {
    const match = /^\s*(›\s*)?(\d+)\.\s+([A-Za-z0-9][A-Za-z0-9._:/+\-]*)(?:\s+((?:\((?:current|default)\)\s*){1,2}))?(?:\s{2,}.*)?$/u
      .exec(line);
    if (!match) continue;
    const id = codexSemanticModelLabel(match[3]!, fullscreen);
    if (!id) return undefined;
    const flags = match[4] ?? "";
    rows.push({
      id,
      label: match[3],
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      current: flags.includes("(current)"),
      presetDefault: flags.includes("(default)")
    });
  }
  const numberedLines = region.slice(1, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedRows = rows.filter((row) => row.selected);
  const selectedIndex = selectedRows[0]?.nativeIndex ?? -1;
  const currentRows = rows.filter((row) => row.current);
  if (
    rows.length === 0 ||
    numberedLines.length !== rows.length ||
    rows.some((row, index) => row.nativeIndex !== index) ||
    selectedRows.length !== 1 ||
    currentRows.length !== 1 ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  ) {
    return undefined;
  }
  return {
    rows,
    selectedIndex,
    currentNativeIndex: currentRows[0].nativeIndex,
    currentModel: currentRows[0].id
  };
}

export function parseCodexEntryModelPicker(region: readonly string[]): {
  kind: "quick_auto" | "luna_reserve";
  selectedIndex: number;
  currentNativeIndex: number;
  allModelsNativeIndex?: number;
} | undefined {
  const subtitle = region[1]?.trim();
  const kind = subtitle === "Pick a quick auto mode or browse all models."
    ? "quick_auto"
    : subtitle === "Other models return when ordinary usage is available again."
      ? "luna_reserve"
      : undefined;
  if (!kind) return undefined;
  const numbered = region.slice(2, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const rows = numbered.map((line) => {
    const match = /^\s*(›\s*)?(\d+)\.\s+(.+)$/u.exec(line);
    if (!match) return undefined;
    const current = /(?:^|\s)\(current\)(?:\s{2,}|\s*$)/u.test(match[3]);
    const label = match[3]
      .replace(/\s+\(current\)(?=\s{2,}|\s*$)/u, "")
      .split(/\s{2,}/u, 1)[0]
      ?.trim();
    return {
      nativeIndex: Number(match[2]) - 1,
      selected: Boolean(match[1]),
      current,
      label
    };
  });
  if (
    rows.some((row) => !row) ||
    rows.length === 0 ||
    rows.some((row, index) => row?.nativeIndex !== index)
  ) return undefined;
  const exactRows = rows.filter((row): row is NonNullable<typeof row> => Boolean(row));
  const selected = exactRows.filter((row) => row.selected);
  const current = exactRows.filter((row) => row.current);
  if (selected.length !== 1 || current.length !== 1) return undefined;
  if (kind === "quick_auto") {
    const allModels = exactRows.filter((row) => row.label === "All models");
    if (
      allModels.length !== 1 ||
      exactRows.at(-1)?.label !== "All models" ||
      exactRows.slice(0, -1).some((row) =>
        !/^codex-auto-[a-z0-9][a-z0-9._:/+\-]*$/u.test(row.label ?? "")
      )
    ) return undefined;
    return {
      kind,
      selectedIndex: selected[0].nativeIndex,
      currentNativeIndex: current[0].nativeIndex,
      allModelsNativeIndex: allModels[0].nativeIndex
    };
  }
  if (exactRows.length !== 1 || !exactRows[0].label) return undefined;
  return {
    kind,
    selectedIndex: selected[0].nativeIndex,
    currentNativeIndex: current[0].nativeIndex
  };
}

export function parseCodexEffortRows(
  region: readonly string[],
  advanced: boolean
): {
  rows: readonly EffortRow[];
  selectedIndex: number;
  currentEffort?: TerminalModelReasoningEffort;
  presetDefaultEffort?: TerminalModelReasoningEffort;
} | undefined {
  const rows: EffortRow[] = [];
  for (const line of region.slice(1, -1)) {
    const match = /^\s*(›\s*)?\d+\.\s+(Low|Medium|High|Extra high|Max|Ultra|Persistent|More reasoning…)(?:\s+((?:\((?:current|default)\)\s*){1,2}))?(?:\s{2,}.*)?$/u
      .exec(line);
    if (!match) continue;
    const effort = effortFromNativeLabel(match[2]);
    const flags = match[3] ?? "";
    rows.push({
      ...(effort ? { effort } : {}),
      kind: match[2] === "More reasoning…"
        ? "advanced"
        : match[2] === "Persistent"
          ? "unsupported"
          : "effort",
      selected: Boolean(match[1]),
      current: flags.includes("(current)"),
      presetDefault: flags.includes("(default)")
    });
  }
  const numberedLines = region.slice(1, -1).filter((line) =>
    /^\s*(?:›\s*)?\d+\./u.test(line)
  );
  const selectedRows = rows.filter((row) => row.selected);
  const selectedIndex = rows.findIndex((row) => row.selected);
  const current = rows.filter((row) => row.current && row.effort);
  const defaults = rows.filter((row) => row.presetDefault && row.effort);
  const allowed = advanced
    ? rows.every((row) => row.kind === "effort" && ["max", "ultra"].includes(row.effort ?? ""))
    : rows.every((row) => row.kind === "advanced" || row.kind === "unsupported" ||
        !["max", "ultra"].includes(row.effort ?? ""));
  if (
    rows.length === 0 ||
    numberedLines.length !== rows.length ||
    !numberedLines.every((line, index) =>
      new RegExp(`^\\s*(?:›\\s*)?${index + 1}\\.`).test(line)
    ) ||
    selectedRows.length !== 1 ||
    selectedIndex < 0 ||
    current.length > 1 ||
    defaults.length > 1 ||
    !allowed
  ) return undefined;
  return {
    rows,
    selectedIndex,
    ...(current[0]?.effort ? { currentEffort: current[0].effort } : {}),
    ...(defaults[0]?.effort
      ? { presetDefaultEffort: defaults[0].effort }
      : {})
  };
}

export function currentPickerRegion(
  lines: readonly string[],
  headerIndex: number,
  fullscreen = false
): readonly string[] | undefined {
  const after = lines.slice(headerIndex);
  const expectedFooters = fullscreen ? [
    "enter select · esc back",
    "enter default · s session · esc back",
    "enter apply · s session · esc back"
  ] : ["Press enter to confirm or esc to go back"];
  const footerIndex = after.findIndex((line) => expectedFooters.includes(line.trim()));
  if (footerIndex < 0 || after.slice(footerIndex + 1).some((line) => line.trim())) {
    return undefined;
  }
  return after.slice(0, footerIndex + 1);
}

export function codexFullscreenEffortFooterMatches(
  region: readonly string[],
  selected: EffortRow
): boolean {
  const expected = selected.kind !== "effort"
    ? "enter select · esc back"
    : selected.effort === "ultra"
      ? "enter apply · s session · esc back"
      : "enter default · s session · esc back";
  return region.at(-1)?.trim() === expected;
}

export function effortFromNativeLabel(
  label: string
): TerminalModelReasoningEffort | undefined {
  return ({
    Low: "low",
    Medium: "medium",
    High: "high",
    "Extra high": "xhigh",
    Max: "max",
    Ultra: "ultra"
  } as const)[label as "Low" | "Medium" | "High" | "Extra high" | "Max" | "Ultra"];
}

export function claudeEffortFromNativeLabel(
  label: string
): TerminalModelNativeEffort | undefined {
  const normalized = label.trim().toLowerCase();
  return ({
    low: "low",
    medium: "medium",
    high: "high",
    "extra high": "xhigh",
    xhigh: "xhigh",
    max: "max",
    ultracode: "ultracode"
  } as const)[normalized as
    "low" | "medium" | "high" | "extra high" | "xhigh" | "max" | "ultracode"];
}

export function claudeSemanticModelId(label: string): string | undefined {
  const family = /\b(opus|sonnet|haiku)\b/iu.exec(label)?.[1].toLowerCase();
  if (!family || !/^(?:opus|sonnet|haiku)$/u.test(family)) return undefined;
  const version = new RegExp(
    `\\b${family}[-\\s]+(\\d+(?:\\.\\d+)?)\\b`, "iu"
  ).exec(label)?.[1] ?? /\b(\d+\.\d+)\b/u.exec(label)?.[1];
  const longContext = /(?:\[?1m\]?|1\s*million)(?:\s+context)?\b/iu.test(label);
  return [family, version, longContext ? "1m" : undefined]
    .filter((part): part is string => Boolean(part))
    .join("-");
}

export function terminalTailLines(screen: string): readonly string[] {
  const lines = screen.split("\n").slice(-160);
  while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
  return lines;
}

export function lastIndex(
  lines: readonly string[],
  predicate: (line: string) => boolean
): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return index;
  }
  return -1;
}

export function screenFingerprint(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function stripAnsi(value: string): string {
  return value.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu,
    ""
  );
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function codexPersistencePostcondition(
  beforeScreen: string,
  afterScreen: string,
  request: TerminalModelSwitchRequest
): { proven: true } | {
  proven: false;
  final: boolean;
  reason: string;
} {
  const errorPatterns = [
    /Failed to save default model:/giu,
    /Failed to save Plan mode reasoning effort:/giu,
    /Saved default model and reasoning effort, but a higher-priority configuration\s+layer overrides the saved value\./giu,
    /Saved Plan mode reasoning effort, but a higher-priority configuration\s+layer overrides the saved value\./giu
  ];
  if (errorPatterns.some((pattern) =>
    matchCount(afterScreen, pattern) > matchCount(beforeScreen, pattern)
  )) {
    return {
      proven: false,
      final: true,
      reason:
        "Codex reported that its persisted model default failed or is overridden by a higher-priority configuration layer"
    };
  }
  const model = escapeRegExp(request.model);
  const effort = request.reasoningEffort === "xhigh"
    ? "(?:xhigh|extra high)"
    : escapeRegExp(request.reasoningEffort);
  const suffix = request.reasoningEffort === "ultra"
    ? "\\s+for this conversation"
    : "";
  const success = new RegExp(
    `Model changed to\\s+${model}\\s+${effort}${suffix}(?:\\s|$)`,
    "giu"
  );
  if (matchCount(afterScreen, success) <= matchCount(beforeScreen, success)) {
    return {
      proven: false,
      final: false,
      reason:
        "Codex did not expose a fresh exact model-default persistence success frame"
    };
  }
  return { proven: true };
}

export function matchCount(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
