import type { DesktopCompatibility } from "./desktop-types.js";

export const VERIFIED_DESKTOP_BUILD = Object.freeze({ version: "26.1002.52244", build: "13536" });
export const DESKTOP_CREATION_BUILD = Object.freeze({ version: "26.1007.30912", build: "20156" });
export interface DesktopCapabilityProfile {
  readonly send: boolean;
  readonly nativeControls: boolean;
}
const FULL = Object.freeze({ send: true, nativeControls: true });
const SEND_ONLY = Object.freeze({ send: true, nativeControls: false });
const READ_ONLY = Object.freeze({ send: false, nativeControls: false });

/** Exact app builds, not minimum versions. Native controls need their own evidence. */
export function desktopCapabilityProfile(compatibility: DesktopCompatibility): DesktopCapabilityProfile {
  const matches = (expected: DesktopCompatibility) => compatibility.version === expected.version && compatibility.build === expected.build;
  return matches(VERIFIED_DESKTOP_BUILD) ? FULL : matches(DESKTOP_CREATION_BUILD) ? SEND_ONLY : READ_ONLY;
}

/** Boolean input retains the existing projection contract for callers with an all-write verdict. */
export function desktopProjectionCapabilities(value: DesktopCapabilityProfile | boolean): DesktopCapabilityProfile {
  return typeof value === "boolean" ? value ? FULL : READ_ONLY : value;
}
