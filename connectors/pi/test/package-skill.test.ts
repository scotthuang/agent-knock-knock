import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONNECTOR_PACKAGE,
  CONNECTOR_VERSION,
} from "../src/constants.js";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("Pi package installs the canonical AKK skill beside the extension", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package-lock.json"), "utf8"),
  );
  const bundledSkill = fs.readFileSync(
    path.join(packageDirectory, "skills", "agent-knock-knock", "SKILL.md"),
    "utf8",
  );
  const canonicalSkill = fs.readFileSync(
    path.resolve(
      packageDirectory,
      "..",
      "..",
      "templates",
      "openclaw-skills",
      "agent-knock-knock",
      "SKILL.md",
    ),
    "utf8",
  );

  assert.equal(manifest.name, CONNECTOR_PACKAGE);
  assert.equal(manifest.version, CONNECTOR_VERSION);
  assert.equal(lock.name, CONNECTOR_PACKAGE);
  assert.equal(lock.version, CONNECTOR_VERSION);
  assert.equal(lock.packages[""].name, CONNECTOR_PACKAGE);
  assert.equal(lock.packages[""].version, CONNECTOR_VERSION);
  for (const section of [
    "dependencies",
    "devDependencies",
    "engines",
    "peerDependencies",
  ]) {
    assert.deepEqual(lock.packages[""][section], manifest[section]);
  }
  assert.equal(
    lock.packages["node_modules/@scotthuang/agent-knock-knock"].version,
    manifest.dependencies["@scotthuang/agent-knock-knock"],
  );
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("skills/**/*.md"));
  assert.equal(bundledSkill, canonicalSkill);
  assert.equal(sha256(bundledSkill), sha256(canonicalSkill));
  assert.match(bundledSkill, /^---\nname: agent-knock-knock\n/u);
  assert.match(bundledSkill, /agent-knock-knock\/host-list-compact/u);
  assert.equal(
    manifest.scripts["skill:sync"],
    "node ../../scripts/sync-connector-skills.js --connector pi",
  );
  assert.equal(
    manifest.scripts["skill:check"],
    "node ../../scripts/sync-connector-skills.js --check --connector pi",
  );
  assert.equal(manifest.scripts["release:check"], "node scripts/release-check.mjs");

  const packed = spawnSync(
    process.execPath,
    [
      path.resolve(packageDirectory, "..", "..", "scripts", "verify-connector-skill-pack.js"),
      "--connector",
      "pi",
    ],
    { cwd: packageDirectory, encoding: "utf8" },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  assert.match(packed.stdout, /Verified pi packaged Skill: sha256=[0-9a-f]{64}/u);
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
