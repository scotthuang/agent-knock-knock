/** Parse `ps etime` (`[[DD-]HH:]MM:SS`) into elapsed seconds. */
export function parseProcessElapsedSeconds(
  value: unknown
): number | undefined {
  const match =
    /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/u.exec(
      String(value ?? "").trim()
    );
  if (!match) {
    return undefined;
  }
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (
    ![days, hours, minutes, seconds].every(Number.isSafeInteger) ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return undefined;
  }
  return (((days * 24 + hours) * 60 + minutes) * 60) + seconds;
}
