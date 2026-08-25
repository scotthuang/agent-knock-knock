import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Config,
  apply,
  assertSupportedDeepSeekHarness,
  createDeepSeekHarnessManifestResolver,
  type DeepSeekHarnessManifestResolver,
  inject,
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

test("declares a standalone bundle and exact DSH compatibility", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
  );
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-agent"], "0.1.1-rc.2");
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-commands"], "0.1.1-rc.2");
  assert.equal(manifest.peerDependencies["@deepseek-ai/dsh-tools"], "0.1.1-rc.2");
  assert.equal(manifest.dependencies["@scotthuang/agent-knock-knock"], "0.12.16");

  const patch = fs.readFileSync(path.join(packageDirectory, "cordis.patch.yml"), "utf8");
  assert.match(patch, /@scotthuang\/agent-knock-knock-deepseek-harness/u);
  assert.doesNotMatch(patch, /akk-bind/u);
});

test("accepts one exact launcher-owned DeepSeek Harness rc.2 package set", () => {
  assert.doesNotThrow(() => assertSupportedDeepSeekHarness(
    fakeHarnessResolver(),
  ));
});

test("rejects an unsupported launcher before inspecting runtime packages", () => {
  let runtimeReads = 0;
  const resolver = fakeHarnessResolver({
    launcherVersion: "0.1.1-rc.1",
    onRuntimeRead: () => { runtimeReads += 1; },
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /@deepseek-ai\/dsh is 0\.1\.1-rc\.1/u,
  );
  assert.equal(runtimeReads, 0);
});

test("rejects a split launcher-owned DeepSeek Harness runtime package set", () => {
  const resolver = fakeHarnessResolver({
    versions: { "@deepseek-ai/dsh-tools": "0.1.1-rc.1" },
  });
  assert.throws(
    () => assertSupportedDeepSeekHarness(resolver),
    /@deepseek-ai\/dsh-tools is 0\.1\.1-rc\.1/u,
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
    writePackage(launcherDirectory, "@deepseek-ai/dsh", "0.1.1-rc.2");
    writePackage(connectorDirectory, "test-connector", "1.0.0");
    fs.mkdirSync(path.dirname(launcherEntry), { recursive: true });
    fs.writeFileSync(launcherEntry, "", "utf8");

    for (const packageName of [
      "@deepseek-ai/dsh-agent",
      "@deepseek-ai/dsh-commands",
      "@deepseek-ai/dsh-llm",
      "@deepseek-ai/dsh-tools",
    ]) {
      const hostVersion = packageName === "@deepseek-ai/dsh-llm"
        ? "0.1.1-rc.1"
        : "0.1.1-rc.2";
      writePackage(
        path.join(launcherDirectory, "node_modules", packageName),
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
      /@deepseek-ai\/dsh-llm is 0\.1\.1-rc\.1/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

function fakeHarnessResolver(options: {
  launcherVersion?: string;
  versions?: Readonly<Record<string, string>>;
  missing?: string;
  onRuntimeRead?: () => void;
} = {}): DeepSeekHarnessManifestResolver {
  return {
    launcherManifest: () => ({
      name: "@deepseek-ai/dsh",
      version: options.launcherVersion ?? "0.1.1-rc.2",
    }),
    runtimePackageManifest(packageName: string): unknown {
      options.onRuntimeRead?.();
      if (packageName === options.missing) throw new Error("package missing");
      return {
        name: packageName,
        version: options.versions?.[packageName] ?? "0.1.1-rc.2",
      };
    },
  };
}

function writePackage(
  directory: string,
  name: string,
  version: string,
): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    `${JSON.stringify({ name, version, main: "index.js" })}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(directory, "index.js"), "", "utf8");
}
