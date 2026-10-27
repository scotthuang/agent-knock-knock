import fs from "node:fs";
import path from "node:path";

/** A real fixture image; ps/lsof producers must still name its exact PID and inode. */
export function createRunningCodexExecutableFixture(root: string, version: string) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("invalid fixture Codex version");
  const executablePath = path.join(root, "mapped-codex", version, "codex");
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.writeFileSync(executablePath, [
    "#!/bin/sh",
    'if [ "$#" -ne 1 ] || [ "$1" != "--version" ]; then exit 64; fi',
    `printf '%s\\n' 'codex-cli ${version}'`,
    ""
  ].join("\n"), { mode: 0o700 });
  const stat = fs.statSync(executablePath, { bigint: true });
  // Simulate process launch after image installation, retaining real file metadata.
  const birthAt = Date.now() + 60_000;
  const psDate = (offset: number) => new Date(birthAt + offset).toUTCString()
    .replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/u, "$1 $3 $2 $5 $4");
  return {
    executablePath,
    processBirth: psDate(0),
    secondProcessBirth: psDate(1_000),
    mappedFields: `ftxt\nD0x${stat.dev.toString(16)}\ni${stat.ino}\nn${executablePath}\n`
  };
}
