/** Output formats are selected explicitly; they never change action authority. */
export type HostListProjectionVersion = 4 | 5;

export function resolveHostListProjectionVersion(
  value: unknown,
  fallback: HostListProjectionVersion = 4
): HostListProjectionVersion {
  if (value === undefined) return fallback;
  if (value === 4 || value === 5) return value;
  throw new Error("listProjectionVersion must be 4 or 5; use 4 for the legacy List format");
}

/** Remove derived prose and an exact duplicate selector, not state or action inputs. */
export function compactListV5Row(row: Record<string, unknown>): Record<string, unknown> {
  const output = { ...row };
  delete output.usage;
  if (typeof output.conversation_id === "string" && output.id === output.conversation_id) delete output.id;
  if (Array.isArray(output.terminal_controls)) {
    output.terminal_controls = output.terminal_controls.map(value =>
      value && typeof value === "object" && !Array.isArray(value)
        ? compactListV5Row(value as Record<string, unknown>) : value);
  }
  return output;
}
