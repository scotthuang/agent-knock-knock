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
    assert.equal((await readDesktopSidebarMetadata(home)).available, false);
    await fs.unlink(file);
    assert.equal((await readDesktopSidebarMetadata(home)).available, false);
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
