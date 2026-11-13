import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { configuredTestConcurrency } from "./test-tier-utils.js";

// Keep both connector gates on the existing repository concurrency policy.
// Pass the option to node itself: NODE_OPTIONS does not allow this flag.
const directory = path.resolve(".test-dist/test");
const files = fs.readdirSync(directory).filter((name) => name.endsWith(".test.js"))
  .sort().map((name) => path.join(directory, name));
if (files.length === 0) throw new Error("No compiled connector fast tests found");
const concurrency = configuredTestConcurrency();
process.stdout.write(`Connector fast tier: ${files.length} files, concurrency=${concurrency}\n`);
const result = spawnSync(process.execPath,
  ["--test", `--test-concurrency=${concurrency}`, ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
