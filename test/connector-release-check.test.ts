import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const {
  checkAllConnectorsOffline,
  checkConnectorRelease,
  runConnectorReleaseCheckCli,
} = await import(
  pathToFileURL(
    path.join(repositoryRoot, "scripts", "connector-release-check.js"),
  ).href
) as typeof import("../scripts/connector-release-check.js");

test("root and connector packages expose one shared offline and release gate", () => {
  const rootManifest = readJson(path.join(repositoryRoot, "package.json"));
  const piManifest = readJson(
    path.join(repositoryRoot, "connectors", "pi", "package.json"),
  );
  const deepseekManifest = readJson(
    path.join(repositoryRoot, "connectors", "deepseek-harness", "package.json"),
  );
  assert.equal(
    rootManifest.scripts["connectors:verify"],
    "node scripts/connector-release-check.js --offline --all",
  );
  assert.equal(
    rootManifest.scripts["pi:release:check"],
    "npm --prefix connectors/pi run release:check",
  );
  assert.equal(
    rootManifest.scripts["deepseek:release:check"],
    "npm --prefix connectors/deepseek-harness run release:check",
  );
  assert.equal(piManifest.scripts["release:check"], "node scripts/release-check.mjs");
  assert.equal(
    deepseekManifest.scripts["release:check"],
    "node scripts/release-check.mjs",
  );
  for (const connector of ["pi", "deepseek-harness"]) {
    const wrapper = fs.readFileSync(
      path.join(repositoryRoot, "connectors", connector, "scripts", "release-check.mjs"),
      "utf8",
    );
    assert.match(wrapper, /runConnectorReleaseCheckCli/u);
    assert.doesNotMatch(wrapper, /spawnSync|npm publish|git status/u);
  }
});

test("offline connector parity validates both independent package versions without network", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner();

  const reports = checkAllConnectorsOffline({
    repoRoot: fixture.root,
    runner,
  });

  assert.deepEqual(
    reports.map((report) => ({
      connector: report.connector,
      version: report.version,
      mode: report.mode,
      distTag: report.distTag,
    })),
    [
      {
        connector: "deepseek-harness",
        version: "0.1.0-rc.4",
        mode: "offline",
        distTag: "next",
      },
      {
        connector: "pi",
        version: "0.2.0",
        mode: "offline",
        distTag: "latest",
      },
    ],
  );
  assert.equal(reports[0]?.skillSha256, reports[1]?.skillSha256);
  assert.deepEqual(
    runner.calls.map((call) => `${call.command} ${call.arguments.join(" ")}`),
    [
      "npm run typecheck",
      "npm run test:fast",
      "npm run pack:check",
      "npm run typecheck",
      "npm run test:fast",
      "npm run pack:check",
    ],
  );
  assert.equal(runner.calls.some((call) => call.command === "git"), false);
  assert.equal(
    runner.calls.some((call) => call.command === "npm" && call.arguments[0] === "view"),
    false,
  );
});

test("repository parity rejects constants, lock, dependency, and Skill drift before commands", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner();
  const packageDirectory = path.join(fixture.root, "connectors", "pi");
  fs.writeFileSync(
    path.join(packageDirectory, "src", "constants.ts"),
    'export const CONNECTOR_NAME = "agent-knock-knock-pi";\n' +
      'export const CONNECTOR_PACKAGE = "@scotthuang/agent-knock-knock-pi";\n' +
      'export const CONNECTOR_VERSION = "9.9.9";\n',
  );
  const manifestPath = path.join(packageDirectory, "package.json");
  const manifest = readJson(manifestPath);
  manifest.dependencies["@scotthuang/agent-knock-knock"] = "workspace:*";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(packageDirectory, "skills", "agent-knock-knock", "SKILL.md"),
    "drift\n",
  );

  assert.throws(
    () => checkConnectorRelease({
      connector: "pi",
      repoRoot: fixture.root,
      offline: true,
      runner,
    }),
    (error: unknown) => {
      assert.match(String(error), /CONNECTOR_VERSION must match/u);
      assert.match(String(error), /package lock dependencies must match/u);
      assert.match(String(error), /dependency must be one exact supported SemVer/u);
      assert.match(String(error), /uses non-publishable specifier workspace:\*/u);
      assert.match(String(error), /Skill artifacts[\s\S]*drifted/u);
      return true;
    },
  );
  assert.equal(runner.calls.length, 0);
});

test("release check proves clean synchronized main and unused npm and repository tags", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner();

  const report = checkConnectorRelease({
    connector: "deepseek-harness",
    repoRoot: fixture.root,
    runner,
  });

  assert.equal(report.mode, "release-check");
  assert.equal(report.repositoryTag, "deepseek-harness-v0.1.0-rc.4");
  assert.equal(report.distTag, "next");
  assert.equal(report.published, false);
  assert.ok(runner.calls.some((call) =>
    call.command === "git" && call.arguments.join(" ") ===
      "show-ref --verify --quiet refs/tags/deepseek-harness-v0.1.0-rc.4"));
  assert.ok(runner.calls.some((call) =>
    call.command === "git" && call.arguments.join(" ") ===
      "ls-remote --exit-code --tags origin refs/tags/deepseek-harness-v0.1.0-rc.4"));
  assert.ok(runner.calls.some((call) =>
    call.command === "npm" && call.arguments.join(" ") ===
      "view @scotthuang/agent-knock-knock-deepseek-harness@0.1.0-rc.4 version --json"));
  assert.equal(
    runner.calls.some((call) => call.command === "npm" && call.arguments[0] === "publish"),
    false,
  );
});

test("release state failures stop before package gates or publication", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner((call) => {
    if (call.command === "git" && call.arguments[0] === "status") {
      return { status: 0, stdout: " M package.json\n" };
    }
    if (call.command === "git" && call.arguments[0] === "show-ref") {
      return { status: 0 };
    }
    return undefined;
  });

  assert.throws(
    () => checkConnectorRelease({
      connector: "pi",
      repoRoot: fixture.root,
      runner,
    }),
    (error: unknown) => {
      assert.match(String(error), /git worktree is dirty/u);
      assert.match(String(error), /repository tag pi-v0\.2\.0 already exists locally/u);
      return true;
    },
  );
  assert.equal(
    runner.calls.some((call) => call.command === "npm"),
    false,
  );
});

test("an offline package gate failure stops before pack or any publication", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner((call) => {
    if (
      call.command === "npm" &&
      call.arguments[0] === "run" &&
      call.arguments[1] === "test:fast"
    ) {
      return { status: 1, stderr: "characterization failed" };
    }
    return undefined;
  });

  assert.throws(
    () => checkConnectorRelease({
      connector: "pi",
      repoRoot: fixture.root,
      offline: true,
      runner,
    }),
    /pi test:fast failed: characterization failed/u,
  );
  assert.deepEqual(
    runner.calls.filter((call) => call.command === "npm")
      .map((call) => call.arguments.join(" ")),
    ["run typecheck", "run test:fast"],
  );
});

test("npm registry ambiguity and existing versions fail closed", (t) => {
  const fixture = createFixture(t);
  const exists = fakeRunner((call) => {
    if (call.command === "npm" && call.arguments[0] === "view") {
      return { status: 0, stdout: '"0.2.0"\n' };
    }
    return undefined;
  });
  assert.throws(
    () => checkConnectorRelease({
      connector: "pi",
      repoRoot: fixture.root,
      runner: exists,
    }),
    /@scotthuang\/agent-knock-knock-pi@0\.2\.0 already exists on npm/u,
  );

  const ambiguous = fakeRunner((call) => {
    if (call.command === "npm" && call.arguments[0] === "view") {
      return { status: 1, stderr: "registry connection reset" };
    }
    return undefined;
  });
  assert.throws(
    () => checkConnectorRelease({
      connector: "pi",
      repoRoot: fixture.root,
      runner: ambiguous,
    }),
    /lookup failed for a reason other than not-found/u,
  );
});

test("publishing requires the exact version and uses its semantic npm dist-tag", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner();

  assert.throws(
    () => checkConnectorRelease({
      connector: "deepseek-harness",
      repoRoot: fixture.root,
      publish: true,
      runner,
    }),
    /publishing requires --confirm-version/u,
  );
  assert.throws(
    () => checkConnectorRelease({
      connector: "deepseek-harness",
      repoRoot: fixture.root,
      publish: true,
      confirmedVersion: "0.1.0-rc.5",
      runner,
    }),
    /confirmed version 0\.1\.0-rc\.5 does not match package version 0\.1\.0-rc\.4/u,
  );
  assert.equal(runner.calls.length, 0);

  const report = checkConnectorRelease({
    connector: "deepseek-harness",
    repoRoot: fixture.root,
    publish: true,
    confirmedVersion: "0.1.0-rc.4",
    runner,
  });
  assert.equal(report.mode, "publish");
  assert.equal(report.published, true);
  const publish = runner.calls.find((call) =>
    call.command === "npm" && call.arguments[0] === "publish");
  assert.deepEqual(publish?.arguments, [
    "publish",
    "--access",
    "public",
    "--tag",
    "next",
  ]);
  assert.equal(publish?.options.inherit, true);

  const stableRunner = fakeRunner();
  const stable = checkConnectorRelease({
    connector: "pi",
    repoRoot: fixture.root,
    publish: true,
    confirmedVersion: "0.2.0",
    runner: stableRunner,
  });
  assert.equal(stable.distTag, "latest");
  assert.equal(stable.repositoryTag, "pi-v0.2.0");
  assert.deepEqual(
    stableRunner.calls.find((call) =>
      call.command === "npm" && call.arguments[0] === "publish")?.arguments,
    ["publish", "--access", "public", "--tag", "latest"],
  );
});

test("CLI all-mode is offline-only and reports each connector without registry access", (t) => {
  const fixture = createFixture(t);
  const runner = fakeRunner();
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(runConnectorReleaseCheckCli({
    arguments_: ["--offline", "--all"],
    repoRoot: fixture.root,
    runner,
    stdout: { write(value: string) { stdout.push(value); } },
    stderr: { write(value: string) { stderr.push(value); } },
  }), 0);
  assert.match(stdout.join(""), /deepseek-harness.*0\.1\.0-rc\.4/u);
  assert.match(stdout.join(""), /pi.*0\.2\.0/u);
  assert.match(stdout.join(""), /registry, tags, and publish were not accessed/u);
  assert.equal(stderr.length, 0);

  assert.equal(runConnectorReleaseCheckCli({
    arguments_: ["--all"],
    repoRoot: fixture.root,
    runner,
    stdout: { write() {} },
    stderr: { write(value: string) { stderr.push(value); } },
  }), 1);
  assert.match(stderr.at(-1) ?? "", /--all is available only with --offline/u);
});

interface FakeCall {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly options: Readonly<Record<string, unknown>>;
}

function fakeRunner(
  override?: (call: FakeCall) =>
    | { status?: number | null; stdout?: string; stderr?: string; error?: Error }
    | undefined,
) {
  const calls: FakeCall[] = [];
  return {
    calls,
    run(command: string, arguments_: readonly string[], options: Record<string, unknown>) {
      const call = Object.freeze({
        command,
        arguments: Object.freeze([...arguments_]),
        options: Object.freeze({ ...options }),
      });
      calls.push(call);
      const overridden = override?.(call);
      if (overridden) return normalized(overridden);
      if (command === "git") {
        if (arguments_[0] === "branch") return normalized({ status: 0, stdout: "main\n" });
        if (arguments_[0] === "status") return normalized({ status: 0 });
        if (arguments_[0] === "rev-parse") {
          return normalized({ status: 0, stdout: "origin/main\n" });
        }
        if (arguments_[0] === "rev-list") {
          return normalized({ status: 0, stdout: "0\t0\n" });
        }
        if (arguments_[0] === "show-ref") return normalized({ status: 1 });
        if (arguments_[0] === "ls-remote") return normalized({ status: 2 });
      }
      if (command === "npm" && arguments_[0] === "view") {
        return normalized({ status: 1, stderr: "npm ERR! code E404\n" });
      }
      if (command === "npm") return normalized({ status: 0 });
      return normalized({ status: 127, stderr: "unexpected fake command" });
    },
  };
}

function normalized(result: {
  status?: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}) {
  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function createFixture(t: { after(callback: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-connector-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeJson(path.join(root, "package.json"), {
    name: "@scotthuang/agent-knock-knock",
    version: "0.13.3",
  });
  const skill = [
    "---",
    "name: agent-knock-knock",
    "description: Fixture connector Skill.",
    "---",
    "",
    "# Fixture",
    "",
  ].join("\n");
  const canonical = path.join(
    root,
    "templates",
    "openclaw-skills",
    "agent-knock-knock",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  fs.writeFileSync(canonical, skill);
  writeConnector(root, {
    connector: "deepseek-harness",
    packageName: "@scotthuang/agent-knock-knock-deepseek-harness",
    version: "0.1.0-rc.4",
    skill,
  });
  writeConnector(root, {
    connector: "pi",
    packageName: "@scotthuang/agent-knock-knock-pi",
    version: "0.2.0",
    skill,
  });
  return { root };
}

function writeConnector(
  root: string,
  options: {
    connector: string;
    packageName: string;
    version: string;
    skill: string;
  },
) {
  const packageDirectory = path.join(root, "connectors", options.connector);
  const dependencies = {
    "@scotthuang/agent-knock-knock": "0.13.3",
    ajv: "8.20.0",
  };
  const devDependencies = { typescript: "6.0.3" };
  const peerDependencies = { host: "*" };
  const engines = { node: ">=22.19.0" };
  const manifest = {
    name: options.packageName,
    version: options.version,
    license: "MIT",
    engines,
    dependencies,
    devDependencies,
    peerDependencies,
    scripts: {
      "skill:check":
        `node ../../scripts/sync-connector-skills.js --check --connector ${options.connector}`,
      "pack:check":
        "npm run build && npm run skill:check && " +
        `node ../../scripts/verify-connector-skill-pack.js --connector ${options.connector}`,
      "release:check": "node scripts/release-check.mjs",
    },
  };
  writeJson(path.join(packageDirectory, "package.json"), manifest);
  writeJson(path.join(packageDirectory, "package-lock.json"), {
    name: options.packageName,
    version: options.version,
    lockfileVersion: 3,
    packages: {
      "": manifest,
      "node_modules/@scotthuang/agent-knock-knock": {
        version: "0.13.3",
      },
    },
  });
  const constants = path.join(packageDirectory, "src", "constants.ts");
  fs.mkdirSync(path.dirname(constants), { recursive: true });
  fs.writeFileSync(
    constants,
    `export const CONNECTOR_NAME = "agent-knock-knock-${options.connector}";\n` +
      `export const CONNECTOR_PACKAGE = "${options.packageName}";\n` +
      `export const CONNECTOR_VERSION = "${options.version}";\n`,
  );
  const artifact = path.join(
    packageDirectory,
    "skills",
    "agent-knock-knock",
    "SKILL.md",
  );
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, options.skill);
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
