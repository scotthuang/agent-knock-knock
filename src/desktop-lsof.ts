/** Node on macOS raises RLIMIT_NOFILE for its children. lsof startup scales
 * with that limit even for a single PID. Bound the observer only; target
 * descriptors are enumerated by the kernel and can exceed this limit. */
export function desktopLsofCommand(args: string[]): [string, string[]] {
  const command = `limit=$(ulimit -S -n) || exit 1
if [ "$limit" = unlimited ] || [ "$limit" -gt 4096 ]; then
  ulimit -S -n 4096 || exit 1
fi
exec /usr/sbin/lsof "$@"`;
  return ["/bin/sh", ["-c", command, "lsof", ...args]];
}

type Executable = { pid: number; dev: bigint; ino: bigint };

/** Darwin lsof starts each process with p and each file within it with f.
 * Keep both boundaries: multiple selected processes may map the same binary. */
export function verifyDesktopMappedExecutables(output: string, expected: readonly Executable[]): void {
  const remaining = new Map(expected.map(executable => ["p" + executable.pid, executable]));
  for (const processRecord of output.split(/(?=^p)/mu)) {
    const [header, ...files] = processRecord.split(/(?=^f)/mu);
    const pidField = header.trimEnd();
    const executable = remaining.get(pidField);
    if (!executable) continue;
    const device = "D0x" + executable.dev.toString(16), inode = "i" + executable.ino;
    if (files.some(file => {
      const [descriptor, ...fields] = file.trimEnd().split("\n");
      return descriptor === "ftxt" && fields.includes(device) && fields.includes(inode);
    })) remaining.delete(pidField);
  }
  if (remaining.size) throw new Error("Could not verify the mapped Desktop executable for every process");
}
