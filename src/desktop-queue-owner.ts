import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DesktopThreadIdentity } from "./desktop-types.js";

export interface DesktopQueueOwner {
  /** Opaque process-incarnation/lock evidence. Never an independent write credential. */
  ownerId: string;
  endpointId: string;
  draft: "none_persisted" | "present" | "retained_editor" | "unknown";
  /** The renderer can hold buffered edits that are not present in the atom file. */
  liveDraft: "unknown";
}

const execute = promisify(execFile);
const app = "/Applications/ChatGPT.app/Contents";
const mainExecutable = app + "/MacOS/ChatGPT";
const writerExecutable = app + "/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const helperExecutable = /^\/Applications\/ChatGPT\.app\/Contents\/Frameworks\/[^/]+\.framework\/Versions\/[^/]+\/Helpers\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/u;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function unverified(): never {
  throw Object.assign(new Error("Desktop queue writer or shared endpoint identity could not be verified"),
    { code: "desktop_queue_owner_unverified" });
}

/** Darwin proc_pidinfo and proc_pidpath expose process identity, including the
 * microsecond start time, without reading process arguments or the environment. */
const darwinProcessIdentity = String.raw`
import ctypes,json,os,struct,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
def process(pid):
 b=ctypes.create_string_buffer(136)
 if lib.proc_pidinfo(pid,3,0,b,136)!=136: raise ValueError()
 info=struct.unpack('=12I48s6I2Q',b.raw)
 if info[3]!=pid or info[5]!=os.getuid() or info[7]!=os.getuid() or info[-2]<=0: raise ValueError()
 buf=ctypes.create_string_buffer(4096)
 if lib.proc_pidpath(pid,buf,4096)<=0: raise ValueError()
 return dict(pid=pid,ppid=info[4],birth=[info[-2],info[-1]],exe=os.fsdecode(buf.value))
`;

/** F_GETLK observes the existing exclusive whole-file lock without acquiring it. */
const darwinKernelEvidence = String.raw`
${darwinProcessIdentity}
import fcntl,stat
path,writer,daemon=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
fd=os.open(path,os.O_RDONLY | os.O_NOFOLLOW)
try:
 s=os.fstat(fd)
 if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1 or s.st_uid!=os.getuid() or s.st_mode & 0o022: raise ValueError()
 fmt='=qqihh'
 query=struct.pack(fmt,0,0,-1,fcntl.F_RDLCK,os.SEEK_SET)
 start,size,pid,kind,whence=struct.unpack(fmt,fcntl.fcntl(fd,fcntl.F_GETLK,query))
 if (kind,start,size,whence)!=(fcntl.F_WRLCK,0,0,os.SEEK_SET) or pid not in (-1,writer): raise ValueError()
 lock=[s.st_dev,s.st_ino]
finally:
 os.close(fd)
w=process(writer); h=process(w['ppid']); m=process(h['ppid'])
print(json.dumps(dict(lock=lock,writer=w,helper=h,main=m,daemon=process(daemon))))
`;

async function run(file: string, args: string[]): Promise<string> {
  const output = await execute(file, args, { encoding: "utf8", timeout: 4000, maxBuffer: 64 * 1024,
    env: { PATH: "/usr/bin:/bin:/usr/sbin", LC_ALL: "C" } });
  if (output.stderr.trim()) unverified();
  return output.stdout;
}

type Process = { pid: number; ppid: number; birth: [number, number]; exe: string };
type Kernel = { lock: [number, number]; writer: Process; helper: Process; main: Process; daemon: Process };
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Build 29513 saves local scopes under local:<thread UUID>. Reject malformed or
 * unavailable owner banks and check retained editor documents as well as prompt drafts. */
export function desktopQueueAccountEvidence(value: unknown, threadId: string) {
  if (!record(value) || !uuid.test(threadId)) unverified();
  const owner = value["electron-renderer-content-owner"];
  if (typeof owner !== "string" || !/^[a-f0-9]{64}$/u.test(owner)) unverified();
  const common = value["electron-persisted-atom-state"], scoped = value[`electron-owner-atoms:${owner}`];
  if (!record(common) || !record(scoped)) unverified();
  return { ownerScope: digest(owner), draft: persistedDraft([common, scoped], threadId) };
}

function persistedDraft(banks: RecordValue[], threadId: string): DesktopQueueOwner["draft"] {
  let available = false, malformed = false;
  for (const key of ["composer-retained-documents-v1", "composer-prompt-drafts-v2", "composer-prompt-drafts-v1"]) {
    // Observe both banks conservatively during save/migration. Never return a draft's contents.
    for (const bank of banks) {
      const entries = bank[key];
      if (entries === undefined) continue;
      if (!record(entries)) { malformed = true; continue; }
      if (key === "composer-prompt-drafts-v2") available = true;
      if (entries[`local:${threadId}`] != null || entries[threadId] != null) {
        return key === "composer-retained-documents-v1" ? "retained_editor" : "present";
      }
    }
  }
  return available && !malformed ? "none_persisted" : "unknown";
}

async function readDraft(target: DesktopThreadIdentity) {
  const name = path.join(target.codexHome, ".codex-global-state.json");
  const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (!s.isFile() || s.uid !== process.getuid?.() || s.mode & 0o022 || s.size > 16 * 1024 * 1024) unverified();
    const data: unknown = JSON.parse(await file.readFile("utf8"));
    const current = await fs.lstat(name);
    if (current.dev !== s.dev || current.ino !== s.ino || current.ctimeMs !== s.ctimeMs) unverified();
    return desktopQueueAccountEvidence(data, target.threadId);
  } finally { await file.close(); }
}

async function safeDirectory(dir: string, privateMode: boolean): Promise<void> {
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.() || st.mode & (privateMode ? 0o077 : 0o022)) unverified();
}

/** Canonical directories below a root-owned sticky tmp directory can be safe.
 * A writable intermediate directory without sticky ownership protection is not. */
async function safeAncestors(real: string) {
  for (let dir = path.dirname(real);;) {
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== process.getuid?.()) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))) unverified();
    const parent = path.dirname(dir);
    if (dir === parent) return;
    dir = parent;
  }
}

async function socketEndpoint(home: string) {
  const dir = path.join(home, "app-server-control"), socket = path.join(dir, "app-server-control.sock");
  await safeDirectory(dir, true);
  const link = await fs.lstat(socket), real = await fs.realpath(socket);
  if (link.uid !== process.getuid?.()) unverified();
  if (link.isSymbolicLink()) {
    await safeDirectory(path.dirname(real), true);
    await safeAncestors(real);
  }
  const s = await fs.lstat(real);
  if (!s.isSocket() || s.uid !== process.getuid?.() || s.mode & 0o077) unverified();
  return { real, dev: s.dev, ino: s.ino, linkDev: link.dev, linkInode: link.ino };
}

async function soleHolder(file: string): Promise<number> {
  const output = await run("/usr/sbin/lsof", ["-nP", "-t", "--", file]);
  const ids = [...new Set(output.trim().split(/\s+/u))];
  if (ids.length !== 1 || !/^[1-9]\d*$/u.test(ids[0]!)) unverified();
  return Number(ids[0]);
}

async function soleWriter(lock: string) {
  const st = await fs.lstat(lock);
  const fields = (await run("/usr/sbin/lsof", ["-nP", "-FpuftaDi", "--", lock])).trim().split("\n");
  const expected = ["u" + process.getuid?.(), "au", "tREG", "D0x" + st.dev.toString(16), "i" + st.ino];
  if (!st.isFile() || !expected.every(field => fields.includes(field)) ||
    fields.filter(field => field.startsWith("p")).length !== 1 ||
    fields.filter(field => field.startsWith("f")).length !== 1 || !/^p[1-9]\d*$/u.test(fields[0]!)) unverified();
  return { pid: Number(fields[0]!.slice(1)), dev: st.dev, ino: st.ino };
}

async function sample(target: DesktopThreadIdentity) {
  const lockDir = path.join(target.codexHome, "thread-writer-locks"), lock = path.join(lockDir, target.threadId + ".lock");
  await safeDirectory(lockDir, false);
  const endpoint = await socketEndpoint(target.codexHome);
  const [writer, daemon] = await Promise.all([soleWriter(lock), soleHolder(endpoint.real)]);
  if (writer.pid === daemon) unverified();
  const raw = await run("/usr/bin/python3", ["-I", "-B", "-c", darwinKernelEvidence, lock, String(writer.pid), String(daemon)]);
  const kernel = JSON.parse(raw) as Kernel;
  if (kernel.writer.pid !== writer.pid || kernel.daemon.pid !== daemon ||
    kernel.lock[0] !== writer.dev || kernel.lock[1] !== writer.ino) unverified();
  return { kernel, endpoint };
}

/** Build the signing requirements for this particular process ancestry. A signed CLI
 * running in a terminal, a renderer, or the shared daemon cannot be the Desktop writer. */
export function desktopQueueSigningSubjects(kernel: Omit<Kernel, "lock">): [Process, string][] {
  const { writer, helper, main, daemon } = kernel;
  if (new Set([writer.pid, helper.pid, main.pid, daemon.pid]).size !== 4 ||
    writer.ppid !== helper.pid || helper.ppid !== main.pid ||
    writer.exe !== writerExecutable || main.exe !== mainExecutable ||
    !helperExecutable.test(helper.exe) || path.basename(daemon.exe) !== "codex") unverified();
  return [[writer, "codex"], [helper, "com.openai.codex.helper"], [main, "com.openai.codex"], [daemon, "codex"]];
}

async function authenticate(proc: Process, identifier: string) {
  // Dynamic designated requirement checks authenticate the running code. Matching
  // mapped executable vnodes prevents an on-disk upgrade from attesting an old process.
  const requirement = `anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2" and identifier "${identifier}"`;
  await run("/usr/bin/codesign", ["--verify", "-R=" + requirement, String(proc.pid)]);
  const st = await fs.stat(proc.exe);
  const mapped = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(proc.pid), "-d", "txt", "-FfDi", "--", proc.exe]);
  const lines = mapped.trim().split("\n");
  if (!lines.includes("ftxt") || !lines.includes("D0x" + st.dev.toString(16)) || !lines.includes("i" + st.ino)) unverified();
}

async function checkHome(home: string) {
  if (process.platform !== "darwin" || !path.isAbsolute(home) || await fs.realpath(home) !== home) unverified();
  await safeDirectory(home, false);
  await safeAncestors(home);
  // A missing developer-tools runtime must not open the system installation UI.
  await run("/usr/bin/xcode-select", ["-p"]);
}

type SocketEndpoint = Awaited<ReturnType<typeof socketEndpoint>>;

/** Captures the shared reader's incarnation independently of whichever native client owns a thread. */
export function desktopQueueEndpointId(home: string, endpoint: SocketEndpoint, daemon: Process) {
  if (path.basename(daemon.exe) !== "codex") unverified();
  return digest([home, endpoint, daemon]);
}

async function sampleSharedEndpoint(home: string) {
  const endpoint = await socketEndpoint(home);
  const pid = await soleHolder(endpoint.real);
  const probe = darwinProcessIdentity + "\nprint(json.dumps(process(int(sys.argv[1]))))";
  const daemon: Process = JSON.parse(await run("/usr/bin/python3", ["-I", "-B", "-c", probe, String(pid)]));
  if (daemon.pid !== pid) unverified();
  return { daemon, id: desktopQueueEndpointId(home, endpoint, daemon) };
}

/** Reconnect observations only to the signed daemon at the original queue endpoint.
 * A Desktop writer, renderer account, current draft, or active GUI is unnecessary for this read. */
export async function verifyDesktopQueueEndpoint(home: string): Promise<string> {
  try {
    await checkHome(home);
    const before = await sampleSharedEndpoint(home);
    await authenticate(before.daemon, "codex");
    if ((await sampleSharedEndpoint(home)).id !== before.id) unverified();
    return before.id;
  } catch { return unverified(); }
}

/** Call again immediately before dispatch; tokens are valid for the observed
 * incarnation only. Native queues never need access to the Desktop's internal stdio. */
export async function verifyDesktopQueueOwner(target: DesktopThreadIdentity): Promise<DesktopQueueOwner> {
  try {
    if (target.hostId !== "local" || !uuid.test(target.threadId)) unverified();
    await checkHome(target.codexHome);
    const before = await sample(target), { writer, helper, main, daemon } = before.kernel;
    await Promise.all(desktopQueueSigningSubjects(before.kernel).map(([proc, id]) => authenticate(proc, id)));
    const after = await sample(target);
    if (digest(before) !== digest(after)) unverified();
    const { draft, ownerScope } = await readDraft(target);
    return { ownerId: digest([target.threadId, target.codexHome, ownerScope, before.kernel.lock, writer, helper, main]),
      endpointId: desktopQueueEndpointId(target.codexHome, before.endpoint, daemon), draft, liveDraft: "unknown" };
  } catch { return unverified(); }
}
