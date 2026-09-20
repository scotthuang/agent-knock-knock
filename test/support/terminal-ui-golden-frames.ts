/**
 * Typed, redacted terminal UI goldens captured from supported native clients.
 *
 * This module deliberately imports no production parser, profile, or regular
 * expression. A parser regression therefore cannot silently rewrite the test
 * evidence that is meant to constrain it.
 */

export type TerminalUiGoldenAgent = "codex" | "claude";
export type TerminalUiGoldenViewport = "wide" | "narrow";
export type TerminalUiGoldenSurface =
  | "idle_composer"
  | "command_popup"
  | "model_picker"
  | "reasoning_picker"
  | "advanced_reasoning_picker";

export interface TerminalUiGoldenFrame {
  readonly agent: TerminalUiGoldenAgent;
  readonly version: string;
  readonly surface: TerminalUiGoldenSurface;
  readonly viewport: TerminalUiGoldenViewport;
  readonly ansi: boolean;
  readonly complete: boolean;
  readonly screen: string;
}

export type GoldenReasoningEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export interface Codex0154ModelRow {
  readonly id: string;
  readonly current?: boolean;
  readonly presetDefault?: boolean;
  readonly description?: string;
}

const CODEX_COLUMNS = 80;

function styledCodexRow(value: string): string {
  const width = Array.from(value).length;
  return `\u001b[48;2;57;57;57m${value}${" ".repeat(
    Math.max(0, CODEX_COLUMNS - width)
  )}\u001b[0m`;
}

function paddedCodexRow(value: string): string {
  const visible = value.replace(/\u001b\[[0-9;]*m/gu, "");
  return `${value}${" ".repeat(
    Math.max(0, CODEX_COLUMNS - Array.from(visible).length)
  )}`;
}

export function codex0154IdleFrame(input: Readonly<{
  model: string;
  effort: GoldenReasoningEffort;
  cwd?: string;
  history?: readonly string[];
}>): string {
  const footer = `${input.model} ${input.effort} · ${input.cwd ?? "/workspace"}`;
  return [
    ...(input.history ?? []),
    paddedCodexRow("Ready"),
    paddedCodexRow("› \u001b[2mAsk Codex to do anything\u001b[0m"),
    `  ${paddedCodexRow(footer).slice(0, -2)}`
  ].join("\n");
}

export function codex0154CommandPopupFrame(command = "/model"): string {
  return [
    "Ready",
    styledCodexRow(""),
    styledCodexRow(`› ${command}`),
    styledCodexRow(""),
    "  /model  choose what model and reasoning effort to use"
  ].join("\n");
}

/** Codex 0.155.1 tmux capture: exact popup without 0.154 full-row paint. */
export function codex01551CommandPopupFrame(command = "/model"): string {
  return [
    `\u001b[1m›\u001b[0m ${command}`,
    "",
    "  \u001b[1m\u001b[38;5;6m/model  choose what model and reasoning effort to use\u001b[0m"
  ].join("\n");
}

export function codex0154ModelPickerFrame(input: Readonly<{
  rows: readonly Codex0154ModelRow[];
  selectedIndex: number;
  viewport?: TerminalUiGoldenViewport;
  ansi?: boolean;
}>): string {
  const prefix = input.ansi ? "\u001b[1m" : "";
  const suffix = input.ansi ? "\u001b[0m" : "";
  const narrow = input.viewport === "narrow";
  return [
    `${prefix}  Select Model and Effort${suffix}`,
    ...input.rows.flatMap((row, index) => {
      const marker = index === input.selectedIndex ? "›" : " ";
      const label = `${marker} ${index + 1}. ${row.id}` +
        `${row.presetDefault ? " (default)" : ""}` +
        `${row.current ? " (current)" : ""}`;
      const description = row.description ?? "Model description";
      return narrow
        ? [label, `     ${description}`]
        : [`${label}  ${description}`];
    }),
    "  Press enter to confirm or esc to go back"
  ].join("\n");
}

export function codex0154ReasoningPickerFrame(input: Readonly<{
  model: string;
  selectedIndex: number;
  currentEffort?: GoldenReasoningEffort;
  viewport?: TerminalUiGoldenViewport;
}>): string {
  const rows: readonly Readonly<{
    label: string;
    effort?: GoldenReasoningEffort;
    advanced?: true;
  }>[] = [
    { label: "Low", effort: "low" },
    { label: "Medium", effort: "medium" },
    { label: "High", effort: "high" },
    { label: "Extra high", effort: "xhigh" },
    { label: "Persistent" },
    { label: "More reasoning…", advanced: true }
  ];
  const narrow = input.viewport === "narrow";
  return [
    `Select Reasoning Level for ${input.model}`,
    ...rows.flatMap((row, index) => {
      const selected = index === input.selectedIndex ? "›" : " ";
      const current = row.effort === input.currentEffort ||
        row.advanced && ["max", "ultra"].includes(input.currentEffort ?? "")
        ? " (current)"
        : "";
      const label = `${selected} ${index + 1}. ${row.label}` +
        `${index === 0 ? " (default)" : ""}${current}`;
      return narrow && (index === 0 || row.advanced)
        ? [label, index === 0 ? "     Fast responses" : "     Max and Ultra choices"]
        : [label];
    }),
    "Press enter to confirm or esc to go back"
  ].join("\n");
}

export function codex0154AdvancedReasoningFrame(input: Readonly<{
  selectedIndex: number;
  currentEffort?: GoldenReasoningEffort;
}>): string {
  return [
    "Advanced Reasoning",
    `${input.selectedIndex === 0 ? "›" : " "} 1. Max` +
      `${input.currentEffort === "max" ? " (current)" : ""}`,
    `${input.selectedIndex === 1 ? "›" : " "} 2. Ultra` +
      `${input.currentEffort === "ultra" ? " (current)" : ""}`,
    "Press enter to confirm or esc to go back"
  ].join("\n");
}

export function claude21266ModelPickerFrame(input: Readonly<{
  selectedIndex: number;
  currentModel: "opus" | "sonnet" | "haiku";
  currentEffort: Exclude<GoldenReasoningEffort, "ultra">;
  viewport?: TerminalUiGoldenViewport;
  ansi?: boolean;
}>): string {
  const rows = ["opus", "sonnet", "haiku"] as const;
  const narrow = input.viewport === "narrow";
  const emphasis = input.ansi ? "\u001b[1m" : "";
  const reset = input.ansi ? "\u001b[0m" : "";
  return [
    "▔".repeat(narrow ? 48 : 80),
    `   ${emphasis}Select model${reset}`,
    "   Switch between Claude models.",
    "     1. Default (recommended)  Use the default model (currently Claude Opus)",
    ...rows.flatMap((model, index) => {
      const selected = index === input.selectedIndex ? "   ❯" : "    ";
      const label = `${selected} ${index + 2}. provider-${model}` +
        `${model === input.currentModel ? " ✔" : ""}`;
      return narrow
        ? [label, `       Custom ${model[0].toUpperCase()}${model.slice(1)} model`]
        : [`${label}  Custom ${model[0].toUpperCase()}${model.slice(1)} model`];
    }),
    `   ● ${input.currentEffort[0].toUpperCase()}${input.currentEffort.slice(1)} effort ←/→ to adjust`,
    "   Enter to set as default · s to use this session only · Esc to cancel"
  ].join("\n");
}

const defaultCodexRows = Object.freeze([
  { id: "gpt-6-astra", presetDefault: true, description: "Frontier coding model" },
  { id: "gpt-5.6-sol", current: true, description: "Fast coding model" },
  { id: "gpt-5.6-terra", description: "Balanced coding model" }
] satisfies readonly Codex0154ModelRow[]);

/** Immutable independent goldens; malformed variants stay explicitly marked. */
export const TERMINAL_UI_GOLDENS = Object.freeze({
  codexAstraSparkleIdlePhaseA: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "idle_composer",
    viewport: "wide",
    ansi: false,
    complete: true,
    screen: [
      "Completed task summary.",
      "",
      "    ⠈                    ⢀                       ⠐ ⠐    ⡀⠐              ⠄          ⠄  ⠄",
      "» Ask Codex to do anything⡀  ⠈     ⠈ ⠂  ⠁ ⠁                  ⠈        ⠄                ⠁",
      "      ⠠⢀            ⠠                        ⢀       ⡀⠄                             ⠂",
      "  gpt-6-astra ultra · ~/workspace · Redacted task · Main [default]"
    ].join("\n")
  }),
  codexAstraSparkleIdlePhaseB: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "idle_composer",
    viewport: "wide",
    ansi: false,
    complete: true,
    screen: [
      "Completed task summary.",
      "",
      "  ⠁              ⠐              ⠠                       ⠈",
      "»⠂Ask Codex to do anything    ⡀       ⢀               ⠄",
      "       ⠈            ⠁                         ⠐          ⠠",
      "  gpt-6-astra high · ~/workspace · Redacted task · Main [default]"
    ].join("\n")
  }),
  codexAstraSparkleIdleAnsiPhaseA: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "idle_composer",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: [
      "Completed task summary.",
      "",
      "    \u001b[38;2;143;132;159m⠈                    ⢀                       ⠐\u001b[0m",
      "» \u001b[2mAsk Codex to do anything\u001b[22m" +
        "\u001b[38;2;143;132;159m⡀  ⠈     ⠂  ⠁\u001b[0m",
      "      \u001b[38;2;122;111;138m⠠⢀            ⡀⠄                 ⠂\u001b[0m",
      "  gpt-6-astra ultra · ~/workspace · Redacted task · Main [default]"
    ].join("\n")
  }),
  codexAstraSparkleIdleAnsiPhaseB: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "idle_composer",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: [
      "Completed task summary.",
      "",
      "  \u001b[38;2;129;118;145m⠁              ⠐              ⠠\u001b[0m",
      "»\u001b[38;2;129;118;145m⠂\u001b[0m" +
        "\u001b[2mAsk Codex to do anything\u001b[22m" +
        "\u001b[38;2;129;118;145m    ⡀       ⢀\u001b[0m",
      "       \u001b[38;2;151;140;167m⠈            ⠁                 ⠐\u001b[0m",
      "  gpt-6-astra high · ~/workspace · Redacted task · Main [default]"
    ].join("\n")
  }),
  codexWidePicker: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "model_picker",
    viewport: "wide",
    ansi: false,
    complete: true,
    screen: codex0154ModelPickerFrame({
      rows: defaultCodexRows,
      selectedIndex: 1
    })
  }),
  codexAnsiPicker: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "model_picker",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: codex0154ModelPickerFrame({
      rows: defaultCodexRows,
      selectedIndex: 1,
      ansi: true
    })
  }),
  codexNarrowMoreReasoning: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "reasoning_picker",
    viewport: "narrow",
    ansi: false,
    complete: true,
    screen: codex0154ReasoningPickerFrame({
      model: "gpt-6-astra",
      selectedIndex: 5,
      currentEffort: "ultra",
      viewport: "narrow"
    })
  }),
  codexPopup: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "command_popup",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: codex0154CommandPopupFrame()
  }),
  codex01551PlainPopup: Object.freeze({
    agent: "codex",
    version: "0.155.1",
    surface: "command_popup",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: codex01551CommandPopupFrame()
  }),
  codexPartialPicker: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "model_picker",
    viewport: "narrow",
    ansi: false,
    complete: false,
    screen: [
      "Select Model and Effort",
      "› 1. gpt-6-astra (current)",
      "  2. gpt-5.6-"
    ].join("\n")
  }),
  codexTruncatedReasoning: Object.freeze({
    agent: "codex",
    version: "0.154.0",
    surface: "reasoning_picker",
    viewport: "narrow",
    ansi: false,
    complete: false,
    screen: codex0154ReasoningPickerFrame({
      model: "gpt-6-astra",
      selectedIndex: 5,
      currentEffort: "ultra",
      viewport: "narrow"
    }).replace("Press enter to confirm or esc to go back", "")
  }),
  claudeWidePicker: Object.freeze({
    agent: "claude",
    version: "2.1.266",
    surface: "model_picker",
    viewport: "wide",
    ansi: false,
    complete: true,
    screen: claude21266ModelPickerFrame({
      selectedIndex: 0,
      currentModel: "opus",
      currentEffort: "high"
    })
  }),
  claudeAnsiPicker: Object.freeze({
    agent: "claude",
    version: "2.1.266",
    surface: "model_picker",
    viewport: "wide",
    ansi: true,
    complete: true,
    screen: claude21266ModelPickerFrame({
      selectedIndex: 0,
      currentModel: "opus",
      currentEffort: "high",
      ansi: true
    })
  }),
  claudeNarrowAnsiPicker: Object.freeze({
    agent: "claude",
    version: "2.1.266",
    surface: "model_picker",
    viewport: "narrow",
    ansi: true,
    complete: false,
    screen: claude21266ModelPickerFrame({
      selectedIndex: 0,
      currentModel: "opus",
      currentEffort: "high",
      viewport: "narrow",
      ansi: true
    })
  })
} satisfies Readonly<Record<string, TerminalUiGoldenFrame>>);
