import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const {
  CANONICAL_SKILL_PATH,
  CONNECTOR_SKILL_ARTIFACTS,
  resolveRepositoryArtifactPath,
  synchronizeConnectorSkills
} = await import(
  pathToFileURL(
    path.join(repoRoot, "scripts", "sync-connector-skills.js")
  ).href
) as typeof import("../scripts/sync-connector-skills.js");

test("connector Skill sync creates exact artifacts and is idempotent", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () => synchronizeConnectorSkills({ repoRoot: fixture.root, check: true }),
    /deepseek-harness\/skills.* is missing[\s\S]*pi\/skills.* is missing/u
  );

  const created = synchronizeConnectorSkills({ repoRoot: fixture.root });
  assert.equal(created.mode, "sync");
  assert.deepEqual(
    created.artifacts.map((artifact) => artifact.status),
    ["created", "created"]
  );
  const expectedHash = createHash("sha256")
    .update(fixture.canonical)
    .digest("hex");
  assert.equal(created.canonical.sha256, expectedHash);

  const before = artifactStats(fixture.root);
  assert.ok(before.every((stat) => stat.mode === 0o640n));
  for (const artifact of CONNECTOR_SKILL_ARTIFACTS) {
    assert.deepEqual(
      fs.readFileSync(path.join(fixture.root, artifact.path)),
      fixture.canonical
    );
  }

  const repeated = synchronizeConnectorSkills({ repoRoot: fixture.root });
  assert.deepEqual(
    repeated.artifacts.map((artifact) => artifact.status),
    ["unchanged", "unchanged"]
  );
  assert.deepEqual(artifactStats(fixture.root), before);
  assert.doesNotThrow(() => synchronizeConnectorSkills({
    repoRoot: fixture.root,
    check: true
  }));
  for (const artifact of CONNECTOR_SKILL_ARTIFACTS) {
    const directory = path.dirname(path.join(fixture.root, artifact.path));
    assert.equal(
      fs.readdirSync(directory).some((entry) => entry.endsWith(".tmp")),
      false
    );
  }
});

test("connector selection repairs only its fixed artifact", (t) => {
  const fixture = createFixture(t, { createArtifacts: true });
  const pi = CONNECTOR_SKILL_ARTIFACTS.find(
    (artifact) => artifact.connector === "pi"
  )!;
  const deepseek = CONNECTOR_SKILL_ARTIFACTS.find(
    (artifact) => artifact.connector === "deepseek-harness"
  )!;
  fs.writeFileSync(path.join(fixture.root, pi.path), "pi drift\n");
  fs.writeFileSync(path.join(fixture.root, deepseek.path), "dsh drift\n");
  const piDrift = fs.readFileSync(path.join(fixture.root, pi.path));
  const deepseekDrift = fs.readFileSync(path.join(fixture.root, deepseek.path));

  assert.throws(
    () => synchronizeConnectorSkills({
      repoRoot: fixture.root,
      check: true,
      connector: "pi"
    }),
    /connectors\/pi\/skills.* is drifted/u
  );
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, pi.path)), piDrift);
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.root, deepseek.path)),
    deepseekDrift
  );
  const result = synchronizeConnectorSkills({
    repoRoot: fixture.root,
    connector: "pi"
  });
  assert.deepEqual(result.artifacts.map((artifact) => artifact.status), [
    "updated"
  ]);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, pi.path)),
    fixture.canonical);
  assert.equal(
    fs.readFileSync(path.join(fixture.root, deepseek.path), "utf8"),
    "dsh drift\n"
  );
  assert.throws(
    () => synchronizeConnectorSkills({ repoRoot: fixture.root, connector: "x" }),
    /unknown connector x/u
  );
});

test("connector Skill paths reject traversal and symbolic-link parents", (t) => {
  const fixture = createFixture(t);
  assert.throws(
    () => resolveRepositoryArtifactPath(
      fixture.root,
      "../outside/SKILL.md",
      "test artifact",
      { allowMissing: true }
    ),
    /normalized repository-relative path/u
  );
  assert.throws(
    () => resolveRepositoryArtifactPath(
      fixture.root,
      "/absolute/SKILL.md",
      "test artifact",
      { allowMissing: true }
    ),
    /normalized repository-relative path/u
  );

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akk-skill-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const piRoot = path.join(fixture.root, "connectors", "pi");
  fs.mkdirSync(piRoot, { recursive: true });
  fs.symlinkSync(outside, path.join(piRoot, "skills"), "dir");
  assert.throws(
    () => synchronizeConnectorSkills({ repoRoot: fixture.root, connector: "pi" }),
    /cannot traverse a symbolic link/u
  );
  assert.equal(fs.readdirSync(outside).length, 0);
});

test("connector Skill sync rejects symlinked sources and destinations", (t) => {
  const sourceFixture = createFixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "akk-skill-source-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const outsideSkill = path.join(outside, "SKILL.md");
  fs.writeFileSync(outsideSkill, sourceFixture.canonical);
  const canonicalPath = path.join(sourceFixture.root, CANONICAL_SKILL_PATH);
  fs.rmSync(canonicalPath);
  fs.symlinkSync(outsideSkill, canonicalPath);
  assert.throws(
    () => synchronizeConnectorSkills({ repoRoot: sourceFixture.root }),
    /canonical Skill cannot traverse a symbolic link/u
  );

  const destinationFixture = createFixture(t);
  const pi = CONNECTOR_SKILL_ARTIFACTS.find(
    (artifact) => artifact.connector === "pi"
  )!;
  const destinationPath = path.join(destinationFixture.root, pi.path);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.symlinkSync(outsideSkill, destinationPath);
  assert.throws(
    () => synchronizeConnectorSkills({
      repoRoot: destinationFixture.root,
      connector: "pi"
    }),
    /Skill artifact cannot traverse a symbolic link/u
  );
  assert.deepEqual(fs.readFileSync(outsideSkill), sourceFixture.canonical);
});

test("atomic Skill publication preserves the prior artifact on failure", (t) => {
  const fixture = createFixture(t, { createArtifacts: true });
  const pi = CONNECTOR_SKILL_ARTIFACTS.find(
    (artifact) => artifact.connector === "pi"
  )!;
  const targetPath = path.join(fs.realpathSync(fixture.root), pi.path);
  const prior = Buffer.from("prior complete artifact\n");
  fs.writeFileSync(targetPath, prior);
  let observedTemporaryPath: string | undefined;

  assert.throws(
    () => synchronizeConnectorSkills({
      repoRoot: fixture.root,
      connector: "pi",
      beforeRename({ temporaryPath, filePath }: {
        temporaryPath: string;
        filePath: string;
      }) {
        observedTemporaryPath = temporaryPath;
        assert.equal(filePath, targetPath);
        assert.deepEqual(fs.readFileSync(temporaryPath), fixture.canonical);
        assert.deepEqual(fs.readFileSync(targetPath), prior);
        throw new Error("simulated publication interruption");
      }
    }),
    /simulated publication interruption/u
  );
  assert.ok(observedTemporaryPath);
  assert.equal(fs.existsSync(observedTemporaryPath), false);
  assert.deepEqual(fs.readFileSync(targetPath), prior);
});

function createFixture(
  t: { after(callback: () => void): void },
  { createArtifacts = false }: { createArtifacts?: boolean } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-skill-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const canonical = Buffer.from(
    "---\nname: agent-knock-knock\ndescription: Fixture skill.\n---\n\n# Fixture\n"
  );
  const canonicalPath = path.join(root, CANONICAL_SKILL_PATH);
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, canonical, { mode: 0o640 });
  if (createArtifacts) {
    for (const artifact of CONNECTOR_SKILL_ARTIFACTS) {
      const artifactPath = path.join(root, artifact.path);
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, canonical);
    }
  }
  return { root, canonical };
}

function artifactStats(root: string) {
  return CONNECTOR_SKILL_ARTIFACTS.map((artifact) => {
    const stat = fs.statSync(path.join(root, artifact.path), { bigint: true });
    return {
      ino: stat.ino,
      mtimeNs: stat.mtimeNs,
      mode: stat.mode & 0o777n
    };
  });
}
