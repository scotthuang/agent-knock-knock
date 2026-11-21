import test from "node:test";
import assert from "node:assert/strict";
import { desktopQueueAccountEvidence, desktopQueueEndpointId, desktopQueueSigningSubjects, verifyDesktopQueueEndpoint, verifyDesktopQueueOwner } from "../src/desktop-queue-owner.js";

const uuid = "00000000-0000-7000-8000-000000000001";
const owner = "e".repeat(64);
const commonKey = "electron-persisted-atom-state";
const scopedKey = "electron-owner-atoms:" + owner;
const drafts = "composer-prompt-drafts-v2";
const retained = "composer-retained-documents-v1";
const scope = "local:" + uuid;
const empty = { "electron-renderer-content-owner": owner, [commonKey]: { [drafts]: {} }, [scopedKey]: {} };

test("queue admission checks the exact local composer scope in both owner banks, including retained editors", () => {
  assert.equal(desktopQueueAccountEvidence(empty, uuid).draft, "none_persisted");
  const unrelated = "local:00000000-0000-7000-8000-000000000002";
  assert.equal(desktopQueueAccountEvidence({ ...empty, [commonKey]: { [drafts]: { [unrelated]: {} } } }, uuid).draft, "none_persisted");
  for (const bank of [commonKey, scopedKey]) {
    for (const key of [drafts, "composer-prompt-drafts-v1", retained]) {
      assert.equal(desktopQueueAccountEvidence({ ...empty, [bank]: { [key]: { [scope]: {} } } }, uuid).draft, "present");
    }
  }
  for (const malformed of [{ ...empty, [commonKey]: { [drafts]: [] } }, { ...empty, [commonKey]: {} }]) {
    assert.equal(desktopQueueAccountEvidence(malformed, uuid).draft, "unknown");
  }
});

test("unidentified renderer banks cannot produce matching owner proofs; changing account changes the opaque scope", () => {
  for (const state of [{ ...empty, [scopedKey]: null }, { ...empty, [scopedKey]: undefined },
    { ...empty, "electron-renderer-content-owner": "signed-out" }, { [commonKey]: {} }]) {
    assert.throws(() => desktopQueueAccountEvidence(state, uuid), { code: "desktop_queue_owner_unverified" });
  }
  const changed = "a".repeat(64);
  const original = desktopQueueAccountEvidence(empty, uuid).ownerScope;
  assert.notEqual(original, owner);
  assert.notEqual(original, desktopQueueAccountEvidence({ ...empty,
    "electron-renderer-content-owner": changed, ["electron-owner-atoms:" + changed]: {} }, uuid).ownerScope);
});

test("only the exact Desktop writer/helper/application ancestry qualifies for dynamic signature verification", () => {
  const contents = "/Applications/ChatGPT.app/Contents/";
  const exe = (pid: number, ppid: number, exe: string) => ({ pid, ppid, exe, birth: [1, pid] as [number, number] });
  const main = exe(12, 1, contents + "MacOS/ChatGPT");
  const helper = exe(34, 12, contents + "Frameworks/Codex Framework.framework/Versions/158/Helpers/Codex (Aperitif).app/Contents/MacOS/Codex (Aperitif)");
  const writer = exe(56, 34, contents + "Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
  const daemon = exe(78, 1, "/example/standalone/bin/codex");
  const proof = { writer, helper, main, daemon };
  assert.deepEqual(desktopQueueSigningSubjects(proof).map(([p, subject]) => [p.pid, subject]),
    [[56, "codex"], [34, "com.openai.codex.helper"], [12, "com.openai.codex"], [78, "codex"]]);
  for (const conflict of [{ ...proof, writer: { ...writer, exe: daemon.exe } },
    { ...proof, helper: { ...helper, ppid: 999 } }, { ...proof, main: { ...main, exe: "/tmp/ChatGPT" } },
    { ...proof, daemon: writer }, { ...proof, helper: { ...helper, exe: "/tmp/Codex (Aperitif)" } }]) {
    assert.throws(() => desktopQueueSigningSubjects(conflict), { code: "desktop_queue_owner_unverified" });
  }
});

test("foreign hosts and ambiguous thread selectors never authorize a Desktop queue owner", async () => {
  for (const [hostId, threadId] of [["remote", uuid], ["local", "../" + uuid], ["local", "named-thread"]]) {
    await assert.rejects(verifyDesktopQueueOwner({ codexHome: "/unused", hostId, threadId }),
      { code: "desktop_queue_owner_unverified" });
  }
});

test("a queue receipt pins its exact signed daemon incarnation, home and socket independently of the Desktop writer", async () => {
  const socket = { real: "/private/scratch/endpoint", dev: 8, ino: 21, linkDev: 8, linkInode: 41 };
  const daemon = { pid: 23, ppid: 1, exe: "/signed/install/codex", birth: [99, 3] as [number, number] };
  const home = "/private/example";
  const fence = desktopQueueEndpointId(home, socket, daemon);
  assert.match(fence, /^[a-f0-9]{64}$/u);
  assert.notEqual(desktopQueueEndpointId(home + "-other", socket, daemon), fence);
  assert.notEqual(desktopQueueEndpointId(home, { ...socket, ino: 22 }, daemon), fence);
  assert.notEqual(desktopQueueEndpointId(home, { ...socket, linkInode: 42 }, daemon), fence);
  assert.notEqual(desktopQueueEndpointId(home, socket, { ...daemon, birth: [99, 4] }), fence);
  assert.throws(() => desktopQueueEndpointId(home, socket, { ...daemon, exe: "/tmp/other" }), { code: "desktop_queue_owner_unverified" });
  await assert.rejects(verifyDesktopQueueEndpoint("relative-home"), { code: "desktop_queue_owner_unverified" });
});
