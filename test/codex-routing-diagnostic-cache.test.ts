import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexRoutingDiagnosticCache } from "../src/codex-routing-diagnostic-cache.js";

test("recent List correction hints are scoped, expire, and invalidate negative matches after incomplete scans", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-routing-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let time = new Date("2026-10-31T01:00:00Z");
  const cache = createCodexRoutingDiagnosticCache(path.join(root, "store"), () => time);
  assert.deepEqual(cache.listMatch("/home-one", "opaque-thread"), { recent_list_match: "not_checked" });
  cache.rememberList("/home-one", ["opaque-thread"], true);
  assert.equal(cache.listMatch("/home-one", "opaque-thread").recent_list_match, "matched");
  assert.equal(cache.listMatch("/home-one", "typo-thread").recent_list_match, "no_match");
  assert.equal(cache.listMatch("/home-two", "opaque-thread").recent_list_match, "not_checked");
  const other = createCodexRoutingDiagnosticCache(path.join(root, "other-store"), () => time);
  assert.equal(other.listMatch("/home-one", "opaque-thread").recent_list_match, "not_checked");
  cache.rememberList("/home-one", [], false);
  assert.equal(cache.listMatch("/home-one", "opaque-thread").recent_list_match, "not_checked");
  cache.rememberList("/home-one", [], true);
  assert.equal(cache.listMatch("/home-one", "opaque-thread").recent_list_match, "no_match");
  time = new Date("2026-11-01T01:00:01Z");
  assert.equal(cache.listMatch("/home-one", "opaque-thread").recent_list_match, "not_checked");
});

test("diagnostic storage is optional and persists only allowlisted failure context", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-routing-diagnostics-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = createCodexRoutingDiagnosticCache(path.join(root, "store"), () => new Date("2026-10-31T01:00:00Z"));
  cache.rememberFailure("/home", "thread", { stage: "rpc_dispatch", target_thread_id: "thread", dispatch_state: "unknown",
    fallback: "not_checked", reason: "rpc_error", rpc_method: "turn/start", rpc_code: -32000,
    message: "SECRET_PROMPT", data: { path: "/private/path" } } as any);
  assert.equal(cache.lastFailure("/home", "thread")?.rpc_method, "turn/start");
  assert.equal(cache.lastFailure("/another-home", "thread"), null);
  for (const filename of fs.readdirSync(path.join(root, "routing-diagnostics"), { recursive: true })) {
    const file = path.join(root, "routing-diagnostics", String(filename));
    if (fs.statSync(file).isFile()) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /SECRET|\/private/);
  }
  fs.writeFileSync(path.join(root, "not-a-directory"), "block cache creation");
  const unavailable = createCodexRoutingDiagnosticCache(path.join(root, "not-a-directory", "store"), () => new Date());
  assert.doesNotThrow(() => unavailable.rememberList("/home", ["thread"], true));
  assert.equal(unavailable.listMatch("/home", "thread").recent_list_match, "not_checked");
});
