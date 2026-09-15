import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SkillRegistration } from "@deepseek-ai/dsh-skill";

const BUNDLED_SKILL_NAME = "agent-knock-knock";
const BUNDLED_SKILL_HEADER =
  /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n/u;
const UNSAFE_METADATA = /[\u0000-\u001f\u007f]/u;

export interface BundledAkkSkill {
  readonly document: string;
  readonly registration: SkillRegistration;
}

/** Load the generated package artifact and register its canonical metadata. */
export function loadBundledAkkSkill(): SkillRegistration {
  return loadBundledAkkSkillBundle().registration;
}

/** Load one byte-identical document for handshake and native registration. */
export function loadBundledAkkSkillBundle(): BundledAkkSkill {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, "..", "skills", BUNDLED_SKILL_NAME, "SKILL.md"),
    path.resolve(
      moduleDirectory,
      "..",
      "..",
      "skills",
      BUNDLED_SKILL_NAME,
      "SKILL.md",
    ),
  ];
  const skillPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!skillPath) {
    throw new Error(
      "agent-knock-knock-deepseek-harness is missing its bundled agent-knock-knock skill",
    );
  }
  const document = fs.readFileSync(skillPath, "utf8");
  return Object.freeze({
    document,
    registration: parseBundledAkkSkill(document, skillPath),
  });
}

/** @internal Strict parser for the two-field canonical Skill frontmatter. */
export function parseBundledAkkSkill(
  document: string,
  skillPath: string,
): SkillRegistration {
  const match = BUNDLED_SKILL_HEADER.exec(document);
  if (!match) return invalidHeader();
  const [header, name, description] = match;
  if (
    name !== BUNDLED_SKILL_NAME ||
    !validMetadataLine(description)
  ) {
    return invalidHeader();
  }
  const content = document.slice(header.length).trim();
  if (!content) {
    throw new Error(
      "agent-knock-knock-deepseek-harness found an empty bundled skill",
    );
  }
  return Object.freeze({
    name,
    description,
    source: "bundled",
    content,
    path: skillPath,
    resourceBase: {
      kind: "directory" as const,
      path: path.dirname(skillPath),
    },
    invocation: {
      modelInvocable: true,
      userInvocable: true,
    },
  });
}

function validMetadataLine(value: string | undefined): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    !UNSAFE_METADATA.test(value);
}

function invalidHeader(): never {
  throw new Error(
    "agent-knock-knock-deepseek-harness found an invalid bundled skill header",
  );
}
