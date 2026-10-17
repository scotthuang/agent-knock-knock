import type { DesktopCompatibility, DesktopInteraction } from "./desktop-types.js";

export const VERIFIED_DESKTOP_BUILD = Object.freeze({ version: "26.1002.52244", build: "13536" });
export const DESKTOP_CREATION_BUILD = Object.freeze({ version: "26.1007.30912", build: "20156" });
export const DESKTOP_20398_BUILD = Object.freeze({ version: "26.1007.71326", build: "20398" });
export interface DesktopCapabilityProfile {
  readonly send: boolean;
  readonly approvals: boolean;
  readonly blockingAnswers: boolean;
  readonly asyncAnswers: boolean;
  readonly nativeControls: boolean;
}
const FULL = Object.freeze({ send: true, approvals: true, blockingAnswers: true, asyncAnswers: true, nativeControls: true });
const TASK_INTERACTIONS = Object.freeze({ send: true, approvals: true, blockingAnswers: true, asyncAnswers: true, nativeControls: false });
const READ_ONLY = Object.freeze({ send: false, approvals: false, blockingAnswers: false, asyncAnswers: false, nativeControls: false });

/** Exact app builds, not minimum versions. Native controls need their own evidence. */
export function desktopCapabilityProfile(compatibility: DesktopCompatibility): DesktopCapabilityProfile {
  const matches = (expected: DesktopCompatibility) => compatibility.version === expected.version && compatibility.build === expected.build;
  return matches(VERIFIED_DESKTOP_BUILD) || matches(DESKTOP_20398_BUILD) ? FULL
    : matches(DESKTOP_CREATION_BUILD) ? TASK_INTERACTIONS : READ_ONLY;
}

/** Boolean input retains the existing projection contract for callers with an all-write verdict. */
export function desktopProjectionCapabilities(value: DesktopCapabilityProfile | boolean): DesktopCapabilityProfile {
  return typeof value === "boolean" ? value ? FULL : READ_ONLY : value;
}

/** Each interaction kind requires its own evidence, independently of session controls. */
export function desktopInteractionResponseVerified(value: DesktopCapabilityProfile | boolean, kind: DesktopInteraction["kind"]): boolean {
  const profile = desktopProjectionCapabilities(value);
  return kind === "command_approval" || kind === "file_approval" ? profile.approvals
    : kind === "blocking_question" ? profile.blockingAnswers : kind === "async_question" && profile.asyncAnswers;
}
