import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CONNECTOR_VERSION } from "../src/constants.js";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("Pi package installs the canonical AKK skill beside the extension", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
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

  assert.equal(manifest.version, CONNECTOR_VERSION);
  assert.deepEqual(manifest.pi.skills, ["./skills"]);
  assert.ok(manifest.files.includes("skills/**/*.md"));
  assert.equal(bundledSkill, canonicalSkill);
  assert.match(bundledSkill, /^---\nname: agent-knock-knock\n/u);
  assert.match(bundledSkill, /agent-knock-knock\/host-list-compact/u);
});
