import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONNECTOR_VERSION,
  SUPPORTED_DSH_VERSIONS,
} from "../src/constants.js";
import {
  Config,
  apply,
  assertSupportedDeepSeekHarness,
  createDeepSeekHarnessManifestResolver,
  type DeepSeekHarnessManifestResolver,
  inject,
  loadSupportedDeepSeekHarnessRuntime,
  name,
} from "../src/index.js";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("exports the DSH plugin contract", () => {
  assert.equal(name, "agent-knock-knock-deepseek-harness");
  assert.deepEqual(inject, ["agents", "commands", "tools"]);
  assert.equal(typeof Config, "function");
  assert.equal(typeof apply, "function");
});

test("declares a standalone bundle and the reviewed DSH compatibility set", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package-lock.json"), "utf8"),
  );
  const supportedRange = SUPPORTED_DSH_VERSIONS.join(" || ");
  assert.equal(manifest.version, CONNECTOR_VERSION);
  assert.equal(lock.version, CONNECTOR_VERSION);
  assert.equal(lock.packages[""].version, CONNECTOR_VERSION);
  assert.deepEqual(lock.packages[""].peerDependencies, manifest.peerDependencies);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-agent"], supportedRange);
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-commands"], supportedRange);
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-llm"], supportedRange);
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-tools"], supportedRange);
  assert.equal(manifest.dependencies["@scotthuang/agent-knock-knock"], "0.12.22");

  const patch = fs.readFileSync(path.join(packageDirectory, "cordis.patch.yml"), "utf8");
  assert.match(patch, /@scotthuang\/agent-knock-knock-deepseek-harness/u);
  assert.doesNotMatch(patch, /akk-bind/u);
});

for (const version of SUPPORTED_DSH_VERSIONS) {
  test(`accepts one exact launcher-owned DeepSeek Harness ${version} package set`, () => {
    assert.equal(
      assertSupportedDeepSeekHarness(fakeHarnessResolver({ launcherVersion: version })),
      version,
    );
  });
}

test("rejects an unsupported launcher before inspecting runtime packages", () => {
  let runtimeReads = 0;
  const resolver = fakeHarnessResolver({
    launcherVersion: "0.1.2-alpha.0",
    onRuntimeRead: () => { runtimeReads += 1; },
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /@deepseek-ai\/dsh is 0\.1\.2-alpha\.0/u,
  );
  assert.equal(runtimeReads, 0);
});

test("rejects a split launcher-owned DeepSeek Harness runtime package set", () => {
  const resolver = fakeHarnessResolver({
    launcherVersion: "0.1.2-alpha.1",
    versions: { "@deepseek-ai/dsh-tools": "0.1.1-rc.2" },
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /coherent DeepSeek Harness 0\.1\.2-alpha\.1 package set; @deepseek-ai\/dsh-tools is 0\.1\.1-rc\.2/u,
  );
});

test("rejects a split launcher-owned DeepSeek Harness runtime anchor", () => {
  const resolver = fakeHarnessResolver({
    launcherVersion: "0.1.2-alpha.1",
    runtimeAnchorVersion: "0.1.1-rc.2",
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /coherent DeepSeek Harness 0\.1\.2-alpha\.1 package set; @deepseek-ai\/dsh-base is 0\.1\.1-rc\.2/u,
  );
});

test("rejects a launcher-owned DeepSeek Harness runtime package that is missing", () => {
  const resolver = fakeHarnessResolver({
    missing: "@deepseek-ai/dsh-commands",
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /could not verify @deepseek-ai\/dsh-commands: package missing/u,
  );
});

test("launcher resolution is not masked by connector checkout devDependencies", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-version-test-"));
  try {
    const launcherDirectory = path.join(temporary, "launcher");
    const connectorDirectory = path.join(temporary, "connector");
    const launcherEntry = path.join(launcherDirectory, "lib", "bin.js");
    writePackage(launcherDirectory, "@deepseek-ai/dsh", "0.1.2-alpha.1");
    writePackage(connectorDirectory, "test-connector", "1.0.0");
    fs.mkdirSync(path.dirname(launcherEntry), { recursive: true });
    fs.writeFileSync(launcherEntry, "", "utf8");
    const runtimeAnchorDirectory = path.join(
      launcherDirectory,
      "node_modules",
      "@deepseek-ai",
      "dsh-base",
    );
    writePackage(
      runtimeAnchorDirectory,
      "@deepseek-ai/dsh-base",
      "0.1.2-alpha.1",
    );

    for (const packageName of [
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-commands",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-tools",
    ]) {
      const hostVersion = packageName === "@deepseek-ai/dsh-llm"
        ? "0.1.1-rc.2"
        : "0.1.2-alpha.1";
      writePackage(
        path.join(runtimeAnchorDirectory, "node_modules", packageName),
        packageName,
        hostVersion,
      );
      writePackage(
        path.join(connectorDirectory, "node_modules", packageName),
        packageName,
        "0.1.1-rc.2",
      );
    }

    const requireFromConnector = createRequire(
      path.join(connectorDirectory, "package.json"),
    );
    const connectorLlm = JSON.parse(fs.readFileSync(
      requireFromConnector.resolve("@deepseek-ai/dsh-llm/package.json"),
      "utf8",
    ));
    assert.equal(connectorLlm.version, "0.1.1-rc.2");

    const resolver = createDeepSeekHarnessManifestResolver(launcherEntry);
    assert.throws(
      () => assertSupportedDeepSeekHarness(resolver),
      /@deepseek-ai\/dsh-llm is 0\.1\.1-rc\.2/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("loads runtime helpers from the launcher-owned set instead of connector devDependencies", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-runtime-test-"));
  try {
    const launcherDirectory = path.join(temporary, "launcher");
    const launcherEntry = path.join(launcherDirectory, "lib", "bin.js");
    writePackage(launcherDirectory, "@deepseek-ai/dsh", "0.1.2-alpha.1");
    fs.mkdirSync(path.dirname(launcherEntry), { recursive: true });
    fs.writeFileSync(launcherEntry, "", "utf8");
    const runtimeAnchorDirectory = path.join(
      launcherDirectory,
      "node_modules",
      "@deepseek-ai",
      "dsh-base",
    );
    writePackage(
      runtimeAnchorDirectory,
      "@deepseek-ai/dsh-base",
      "0.1.2-alpha.1",
    );

    for (const packageName of [
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-commands",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-tools",
    ]) {
      const hostBody = packageName === "@deepseek-ai/dsh-llm"
        ? "export function createUserMessage() { return 'host-alpha-llm'; }\n"
        : packageName === "@deepseek-ai/dsh-tools"
          ? "export function assertSupportedJsonSchema() { return 'host-alpha-tools'; }\n"
          : "";
      writePackage(
        path.join(runtimeAnchorDirectory, "node_modules", packageName),
        packageName,
        "0.1.2-alpha.1",
        hostBody,
      );
    }

    const requireFromConnector = createRequire(
      path.join(packageDirectory, "package.json"),
    );
    const connectorLlm = JSON.parse(fs.readFileSync(
      requireFromConnector.resolve("@deepseek-ai/dsh-llm/package.json"),
      "utf8",
    ));
    assert.equal(connectorLlm.version, "0.1.1-rc.2");

    const runtime = await loadSupportedDeepSeekHarnessRuntime(
      createDeepSeekHarnessManifestResolver(launcherEntry),
    );
    assert.equal(runtime.version, "0.1.2-alpha.1");
    assert.equal(
      (runtime.createUserMessage as unknown as () => string)(),
      "host-alpha-llm",
    );
    assert.equal(
      (runtime.assertSupportedJsonSchema as unknown as () => string)(),
      "host-alpha-tools",
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function fakeHarnessResolver(options: {
  launcherVersion?: string;
  runtimeAnchorVersion?: string;
  versions?: Readonly<Record<string, string>>;
  missing?: string;
  onRuntimeRead?: () => void;
} = {}): DeepSeekHarnessManifestResolver {
  return {
    launcherManifest: () => ({
      name: "@deepseek-ai/dsh",
      version: options.launcherVersion ?? "0.1.2-alpha.1",
    }),
    runtimeAnchorManifest: () => ({
      name: "@deepseek-ai/dsh-base",
      version: options.runtimeAnchorVersion ??
        options.launcherVersion ??
        "0.1.2-alpha.1",
    }),
    runtimePackageManifest(packageName: string): unknown {
      options.onRuntimeRead?.();
      if (packageName === options.missing) throw new Error("package missing");
      return {
        name: packageName,
        version: options.versions?.[packageName] ??
          options.launcherVersion ??
          "0.1.2-alpha.1",
      };
    },
    runtimePackageEntry(): string {
      throw new Error("runtime entry is not used by manifest-only tests");
    },
  };
}

function writePackage(
  directory: string,
  name: string,
  version: string,
  moduleBody = "",
): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version, type: "module", main: "index.js" })}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(directory, "index.js"), moduleBody, "utf8");
}
