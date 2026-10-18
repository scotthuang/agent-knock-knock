import type { DesktopCompatibility, DesktopInteraction } from "./desktop-types.js";

export const VERIFIED_DESKTOP_BUILD = Object.freeze({ version: "26.1002.52244", build: "13536" });
export const DESKTOP_CREATION_BUILD = Object.freeze({ version: "26.1007.30912", build: "20156" });
export const DESKTOP_20398_BUILD = Object.freeze({ version: "26.1007.71326", build: "20398" });
export interface DesktopCapabilityProfile {
  /** Explicit installed-application identity failure is distinct from an untested version. */
  readonly applicationIdentityVerified?: boolean;
  readonly send: boolean;
  readonly approvals: boolean;
  readonly blockingAnswers: boolean;
  readonly asyncAnswers: boolean;
  readonly nativeControls: boolean;
}
const FULL = Object.freeze({ send: true, approvals: true, blockingAnswers: true, asyncAnswers: true, nativeControls: true });
const TASK_INTERACTIONS = Object.freeze({ send: true, approvals: true, blockingAnswers: true, asyncAnswers: true, nativeControls: false });
const READ_ONLY = Object.freeze({ send: false, approvals: false, blockingAnswers: false, asyncAnswers: false, nativeControls: false });

/** Historical verification evidence, not authorization to try the live native contract. */
export function desktopCapabilityProfile(compatibility: DesktopCompatibility): DesktopCapabilityProfile {
  const matches = (expected: DesktopCompatibility) => compatibility.version === expected.version && compatibility.build === expected.build;
  const profile = matches(VERIFIED_DESKTOP_BUILD) || matches(DESKTOP_20398_BUILD) ? FULL
    : matches(DESKTOP_CREATION_BUILD) ? TASK_INTERACTIONS : READ_ONLY;
  return compatibility.applicationIdentityVerified === undefined ? profile
    : { ...profile, applicationIdentityVerified: compatibility.applicationIdentityVerified };
}

/** Every implemented operation can be attempted; live identity/protocol checks still apply. */
export function desktopAttemptCapabilities(value: DesktopCapabilityProfile | boolean = false): DesktopCapabilityProfile {
  return desktopProjectionCapabilities(value).applicationIdentityVerified === false ? READ_ONLY : FULL;
}

export function desktopInteractionResponseAttemptable(kind: string, value: DesktopCapabilityProfile | boolean = false): boolean {
  return desktopProjectionCapabilities(value).applicationIdentityVerified !== false && ["command_approval", "file_approval", "blocking_question", "async_question"].includes(kind);
}

export function desktopCompatibilityProjection(value: DesktopCapabilityProfile | boolean) {
  const { applicationIdentityVerified, ...verification } = desktopProjectionCapabilities(value);
  return { ...(applicationIdentityVerified === undefined ? {} : { application_identity_verified: applicationIdentityVerified }), compatibility_policy: "attempt_native_contract", capability_verification: verification,
    compatibility_warning: applicationIdentityVerified === false || Object.values(verification).some(verified => !verified) };
}

/** Boolean input retains the existing projection contract for callers with an all-write verdict. */
export function desktopProjectionCapabilities(value: DesktopCapabilityProfile | boolean): DesktopCapabilityProfile {
  return typeof value === "boolean" ? value ? FULL : READ_ONLY : value;
}

/** Report verification evidence per interaction without using it as an execution gate. */
export function desktopInteractionResponseVerified(value: DesktopCapabilityProfile | boolean, kind: DesktopInteraction["kind"]): boolean {
  const profile = desktopProjectionCapabilities(value);
  return kind === "command_approval" || kind === "file_approval" ? profile.approvals
    : kind === "blocking_question" ? profile.blockingAnswers : kind === "async_question" && profile.asyncAnswers;
}
