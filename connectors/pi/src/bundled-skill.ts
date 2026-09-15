import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_SKILL_PATH = path.join(
  "skills",
  "agent-knock-knock",
  "SKILL.md"
);

/** Load the exact generated Skill bytes that Pi advertises from its package. */
export function loadBundledAkkSkillDocument(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "..", BUNDLED_SKILL_PATH),
    path.resolve(moduleDirectory, "..", "..", BUNDLED_SKILL_PATH)
  ];
  const skillPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!skillPath) {
    throw new Error(
      "agent-knock-knock-pi is missing its bundled agent-knock-knock skill"
    );
  }
  const document = fs.readFileSync(skillPath, "utf8");
  if (document.length === 0) {
    throw new Error("agent-knock-knock-pi found an empty bundled skill");
  }
  return document;
}
