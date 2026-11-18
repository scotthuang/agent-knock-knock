import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDesktopSidebarMetadata, parseDesktopSidebarMetadata } from "../src/desktop-sidebar-metadata.js";

test("sidebar metadata reads only layout projection and preserves original file bytes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "akk-sidebar-layout-"));
  const file = path.join(home, ".codex-global-state.json");
  const value = JSON.stringify({ credentials: "PRIVATE", "pinned-thread-ids": ["thread-one"],
    "local-projects": { one: { name: "Project", rootPaths: ["/workspace"], instructions: "PRIVATE" } },
    "electron-persisted-atom-state": { "flat-project-sidebar-preferences-v1": { mode: "project" }, drafts: "PRIVATE" } });
  try {
    await fs.writeFile(file, value);
    const before = await fs.stat(file);
    const result = await readDesktopSidebarMetadata(home);
    assert.equal(result.available, true); assert.equal(result.mode, "project");
    assert.deepEqual(result.pinnedIds, ["thread-one"]);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
    assert.equal(await fs.readFile(file, "utf8"), value);
    assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
    await fs.writeFile(file, "{broken");
    assert.equal((await readDesktopSidebarMetadata(home)).failureReason, "invalid");
    await fs.unlink(file);
    assert.equal((await readDesktopSidebarMetadata(home)).failureReason, "missing");
    await fs.writeFile(file, "");
    await fs.truncate(file, 16 * 1024 * 1024 + 1);
    assert.equal((await readDesktopSidebarMetadata(home)).failureReason, "oversized");
    await fs.unlink(file);
    await fs.mkdir(file);
    const unreadable = await readDesktopSidebarMetadata(home);
    assert.equal(unreadable.failureReason, "unreadable");
    assert.equal(JSON.stringify(unreadable).includes(home), false, "diagnostics never expose local paths or raw filesystem errors");
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("sidebar parsing retains explicit root aliases and flags unimplemented cloud/custom layouts", () => {
  const result = parseDesktopSidebarMetadata({
    "local-projects": { p: { name: "Project", rootPaths: ["/workspace", "relative"],
      rootPathAliases: [{ alias: "/alias" }], pathAlias: "/other-alias" } },
    "thread-project-assignments": { remote: { projectKind: "remote", projectId: "remote-project" } },
    "electron-persisted-atom-state": {
      "flat-project-sidebar-preferences-v1": { mode: "project" },
      "sidebar-custom-sections-v3": { account: { sections: [{ itemKeys: ["codex:thread:local:thread-one"] }] } },
      "chatgpt-sidebar-state-v2": { account: { pinnedConversations: ["cloud-one"] } }
    }
  }, "/fixture");
  assert.deepEqual(result.projects.p.roots, ["/workspace", "/alias", "/other-alias"]);
  assert.deepEqual(result.customSectionThreadIds, ["thread-one"]);
  assert.deepEqual(result.assignments, { remote: { projectId: "remote-project", hostId: "non-local" } });
  assert.equal(result.limitations.length, 3);
  assert.equal(JSON.stringify(result).includes("account"), false);
});

test("sidebar owner storage selects only the active account and preserves native live-atom precedence", () => {
  const owner = "a".repeat(64), other = "b".repeat(64);
  const raw = {
    "electron-renderer-content-owner": owner,
    ["electron-owner-atoms:" + owner]: {
      "flat-project-sidebar-preferences-v1": { mode: "project" },
      "sidebar-collapsed-sections-v1": { chats: true }, credentials: "PRIVATE_OWNER"
    },
    ["electron-owner-atoms:" + other]: { "flat-project-sidebar-preferences-v1": { mode: "recent" } },
    "electron-persisted-atom-state": { "sidebar-collapsed-sections-v1": { chats: false }, drafts: "PRIVATE_DRAFT" },
    "thread-workspace-root-hints": { stale: "/stale" },
    ["electron-owner-value:thread-workspace-root-hints:" + owner]: { selected: "/selected" },
    ["electron-owner-value:thread-workspace-root-hints:" + other]: { other: "/other" }
  };
  const layout = parseDesktopSidebarMetadata(raw, "/fixture");
  assert.equal(layout.mode, "project");
  assert.equal(layout.collapsed.chats, false, "native live atoms overlay the saved owner bank");
  assert.deepEqual(layout.rootHints, { selected: "/selected" });
  assert.doesNotMatch(JSON.stringify(layout), /PRIVATE|stale|other|electron-owner|aaaa/u);
  for (const [marker, mode, hints] of [[other, "recent", { other: "/other" }],
    [undefined, undefined, { stale: "/stale" }], ["c".repeat(64), undefined, {}]] as const) {
    const selected = parseDesktopSidebarMetadata({ ...raw, "electron-renderer-content-owner": marker }, "/fixture");
    assert.equal(selected.mode, mode);
    assert.deepEqual(selected.rootHints, hints);
  }
  for (const marker of [null, {}, "unrecognized-owner"]) {
    const invalid = parseDesktopSidebarMetadata({ ...raw, "electron-renderer-content-owner": marker }, "/fixture");
    assert.equal(invalid.available, false);
    assert.deepEqual(invalid.projects, {});
  }
  for (const saved of [null, [], 1]) {
    const invalid = parseDesktopSidebarMetadata({ ...raw, ["electron-owner-atoms:" + owner]: saved }, "/fixture");
    assert.equal(invalid.available, false);
    assert.deepEqual(invalid.rootHints, {});
  }
});
