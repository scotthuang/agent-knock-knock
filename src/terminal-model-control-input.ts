import type {
  TerminalModelControlPlan
} from "./terminal-model-control-profile.js";
import type {
  TerminalModelControlPorts,
  TerminalModelControlCapture,
  TerminalModelControlObservation
} from "./terminal-model-control-contract.js";
import {
  classifyTerminalModelControlSurface,
  observeTerminalModelControl
} from "./terminal-model-control-surface.js";

/** One capture and current-authority proof for every individual native key. */
export const MODEL_CONTROL_SETTLE_TIMEOUT_MS = 5_000;

export const MODEL_CONTROL_POLL_MS = 40;

export async function transitionModelControl(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown, observation: TerminalModelControlObservation,
keys: readonly string[], expectedStates: readonly TerminalModelControlObservation["state"][],
options: { allowImmediateNone?: boolean } = {}): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  if (keys.length === 0) {
    return waitForObservation(input, terminalControl, expectedStates, options);
  }
  let control = terminalControl;
  let current = observation;
  for (const [index, key] of keys.entries()) {
    control = await exactDispatchKeys(input, control, current, [key]);
    const isLast = index === keys.length - 1;
    const next = await waitForObservation(
      input,
      control,
      isLast ? expectedStates : [current.state],
      {
        ...(isLast ? options : {}),
        ...(key === "Up" || key === "Down" || key === "Left" || key === "Right"
          ? { excludeFingerprint: current.fingerprint }
          : {})
      }
    );
    current = next.observation;
    control = next.capture.terminalControl;
    if (isLast) return next;
  }
  throw new Error("model-control transition dispatched no key");
}

export async function exactDispatchKeys(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown, observation: TerminalModelControlObservation,
  keys: readonly string[]): Promise<unknown> {
  if (keys.length === 0) return terminalControl;
  if (keys.length !== 1) {
    throw new Error("model-control transport accepts exactly one native key per proof");
  }
  await input.ports.beforeInput();
  const captured = await input.ports.capture({ terminalControl });
  const surface = classifyTerminalModelControlSurface(input.plan, captured);
  const current = surface.state === "picker"
    ? surface.observation
    : undefined;
  if (
    !current ||
    current.state !== observation.state ||
    current.fingerprint !== observation.fingerprint
  ) {
    throw new Error("the native model-control frame changed before key dispatch");
  }
  await input.ports.sendKeys(captured.terminalControl, keys);
  return captured.terminalControl;
}

export async function waitForObservation(input: {
  plan: TerminalModelControlPlan;
  ports: TerminalModelControlPorts;
}, terminalControl: unknown,
expectedStates: readonly TerminalModelControlObservation["state"][],
options: {
  allowImmediateNone?: boolean;
  allowExactCommandComposer?: boolean;
  excludeFingerprint?: string;
} = {}): Promise<{
  capture: TerminalModelControlCapture;
  observation: TerminalModelControlObservation;
}> {
  const startedAt = Date.now();
  let stableFingerprint: string | undefined;
  let stableCaptures = 0;
  while (Date.now() - startedAt <= MODEL_CONTROL_SETTLE_TIMEOUT_MS) {
    const captured = await input.ports.capture({ terminalControl });
    const surface = classifyTerminalModelControlSurface(input.plan, captured);
    if (surface.state === "blocked") {
      throw new Error("the terminal became busy or blocked during model control");
    }
    const observation = surface.state === "picker"
      ? surface.observation
      : observeTerminalModelControl(input.plan, captured.screen);
    const expectedNone = observation.state === "none" && (
      options.allowImmediateNone === true && surface.state === "idle_empty" ||
      options.allowExactCommandComposer === true &&
        (surface.state === "command_popup" ||
          surface.state === "bare_command" ||
          surface.state === "command_draft")
    );
    const expected = observation.fingerprint !== options.excludeFingerprint &&
      expectedStates.includes(observation.state) &&
      (observation.state !== "none" || expectedNone);
    if (expected) {
      if (observation.fingerprint === stableFingerprint) stableCaptures += 1;
      else {
        stableFingerprint = observation.fingerprint;
        stableCaptures = 1;
      }
      if (stableCaptures >= 2) return { capture: captured, observation };
    } else {
      stableFingerprint = undefined;
      stableCaptures = 0;
    }
    await input.ports.sleep(MODEL_CONTROL_POLL_MS);
  }
  throw new Error("the expected native model-control frame did not become stable");
}
