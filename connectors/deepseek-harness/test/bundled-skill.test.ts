import assert from "node:assert/strict";
import test from "node:test";

import { parseBundledAkkSkill } from "../src/bundled-skill.js";

const skillPath = "/package/skills/agent-knock-knock/SKILL.md";

test("parses canonical Skill metadata instead of duplicating its description", () => {
  const skill = parseBundledAkkSkill([
    "---",
    "name: agent-knock-knock",
    "description: Description supplied by the canonical artifact.",
    "---",
    "",
    "# Agent Knock Knock",
    "",
    "Canonical body.",
    "",
  ].join("\n"), skillPath);

  assert.equal(skill.name, "agent-knock-knock");
  assert.equal(
    skill.description,
    "Description supplied by the canonical artifact.",
  );
  assert.equal(skill.content, "# Agent Knock Knock\n\nCanonical body.");
  assert.equal(skill.path, skillPath);
  assert.deepEqual(skill.resourceBase, {
    kind: "directory",
    path: "/package/skills/agent-knock-knock",
  });
  assert.deepEqual(skill.invocation, {
    modelInvocable: true,
    userInvocable: true,
  });
});

for (const invalid of [
  "---\nname: another-skill\ndescription: Description.\n---\n\nBody.",
  "---\ndescription: Description.\nname: agent-knock-knock\n---\n\nBody.",
  "---\nname: agent-knock-knock\ndescription: Description.\nextra: field\n---\n\nBody.",
  "---\nname: agent-knock-knock\ndescription:  padded\n---\n\nBody.",
  "---\r\nname: agent-knock-knock\r\ndescription: Description.\r\n---\r\n\r\nBody.",
]) {
  test("rejects a non-canonical bundled Skill header", () => {
    assert.throws(
      () => parseBundledAkkSkill(invalid, skillPath),
      /invalid bundled skill header/u,
    );
  });
}

test("rejects an empty canonical Skill body", () => {
  assert.throws(
    () => parseBundledAkkSkill(
      "---\nname: agent-knock-knock\ndescription: Description.\n---\n\n",
      skillPath,
    ),
    /empty bundled skill/u,
  );
});
