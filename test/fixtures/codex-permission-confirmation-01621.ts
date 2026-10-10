/** Synthetic public fixture for the 0.162.1 72-column confirmation overlay. */
export function codex1621PermissionConfirmation(selected: 0 | 1 = 0): string {
  const rows = [
    "  \x1b[1mEnable full access?\x1b[0m",
    "  When Codex runs with full access, it can edit any file on your",
    "  computer and run commands with network, without your approval.",
    "  \x1b[38;5;1mExercise caution when enabling full access. This significantly\x1b[39m",
    "  \x1b[38;5;1mincreases the risk of data loss, leaks, or unexpected behavior.\x1b[39m",
    "", "",
    selected === 0
      ? "\x1b[1;7m› 1. Yes, continue anyway  \x1b[0;7mApply full access for this session\x1b[0m"
      : "  1. Yes, continue anyway  \x1b[2mApply full access for this session\x1b[0m",
    selected === 1
      ? "\x1b[1;7m› 2. Cancel                \x1b[0;7mGo back without enabling full access\x1b[0m"
      : "  2. Cancel                \x1b[2mGo back without enabling full access\x1b[0m",
    "",
    "  \x1b[1menter\x1b[0;2m select · \x1b[0;1mesc\x1b[0;2m back\x1b[0m"
  ];
  const modal = rows.map((row) => {
    const width = row.replace(/\x1b\[[0-9;]*m/gu, "").length;
    return `Previous public update    ${row}${" ".repeat(72 - width)} retained text`;
  });
  return ["Earlier transcript", ...modal, "Later transcript", "\x1b[1m›\x1b[0m ",
    "  GPT-6.1-Sol high · /repo", "  ? for shortcuts"].join("\n");
}
