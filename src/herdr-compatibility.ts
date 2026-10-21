/**
 * Releases with direct behavior evidence, not a runtime version allowlist.
 * Herdr's endpoint protocol generation is a separate UI protocol; ping and
 * session.snapshot report the protocol numbers below.
 *
 * v0.8.0 and v0.9.5 retain the same NDJSON envelopes, terminal/process identity,
 * pane.read sources and formats, and single-enqueue pane.send_input semantics.
 * v0.9.5 adds a pre-enqueue canonical-line size check (pane_send_failed).
 */
export const HERDR_COMPATIBILITY_PROFILES = [
  { version: "0.9.5", protocol: 22 },
  { version: "0.8.0", protocol: 19 }
] as const;

export type HerdrCompatibilityProfile =
  typeof HERDR_COMPATIBILITY_PROFILES[number];

export interface HerdrServerObservation {
  version: string;
  protocol: number;
  baselineKnown: boolean;
}

export interface HerdrOperationCapability {
  state: "available" | "unsupported" | "unknown";
  reason: string;
  evidence: "runtime_probe" | "matching_cli_schema" | "verified_release" | "none";
}

export interface HerdrOperationCapabilities {
  visibleText: HerdrOperationCapability;
  visibleAnsi: HerdrOperationCapability;
  detectionText: HerdrOperationCapability;
  textInput: HerdrOperationCapability;
  keyInput: HerdrOperationCapability;
  rawTextInput: HerdrOperationCapability;
}

/** Latest verified release, retained for diagnostic and fixture compatibility. */
export const HERDR_EXACT_VERSION = HERDR_COMPATIBILITY_PROFILES[0].version;
export const HERDR_EXACT_PROTOCOL = HERDR_COMPATIBILITY_PROFILES[0].protocol;

export const HERDR_SUPPORTED_VERSIONS = HERDR_COMPATIBILITY_PROFILES.map(
  (profile) => profile.version
);

export function herdrCompatibilityProfile(
  version: unknown
): HerdrCompatibilityProfile | undefined {
  return HERDR_COMPATIBILITY_PROFILES.find((profile) => profile.version === version);
}

export function matchesHerdrCompatibilityProfile(
  value: { version?: unknown; protocol?: unknown },
  profile: Pick<HerdrServerObservation, "version" | "protocol">
): boolean {
  return value.version === profile.version && value.protocol === profile.protocol;
}

export function observeHerdrServer(
  value: { version?: unknown; protocol?: unknown }
): HerdrServerObservation | undefined {
  if (typeof value.version !== "string" || !value.version.trim() ||
      typeof value.protocol !== "number" || !Number.isSafeInteger(value.protocol) ||
      value.protocol < 0) return undefined;
  const baseline = herdrCompatibilityProfile(value.version);
  return {
    version: value.version,
    protocol: value.protocol,
    baselineKnown: baseline !== undefined && baseline.protocol === value.protocol
  };
}
