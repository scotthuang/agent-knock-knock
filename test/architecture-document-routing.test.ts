import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".."
);

test("architecture index separates current truth from immutable history", () => {
  const index = read("docs/architecture/orchestration-refactor.md");
  const current = read("docs/architecture/current-architecture.md");
  const history = read(
    "docs/architecture/orchestration-refactor-history.md"
  );

  assert.ok(index.split("\n").length < 100);
  assert.match(index, /current-architecture\.md/u);
  assert.match(index, /orchestration-refactor-history\.md/u);
  assert.match(index, /only authoritative description/u);
  assert.match(history, /^# Historical Issue #126/mu);
  assert.match(history, /Immutable historical record/u);
  assert.match(history, /Snapshot: `main@ea592a8[^`]*` \/ `v0\.12\.11`/u);
  assert.match(current, /authoritative current architecture/u);
  assert.doesNotMatch(
    current,
    /(?:14|16) (?:registered OpenClaw )?tools|TerminalWatch` schema v2/u
  );
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}
