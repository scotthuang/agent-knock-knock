import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("importing the CLI core does not inspect argv, emit output, or exit", () => {
  const coreUrl = new URL("../src/cli-core.js", import.meta.url).href;
  const probe = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `
process.argv = [process.execPath, "import-probe", "--help"];
const originalWrite = process.stdout.write.bind(process.stdout);
let captured = "";
process.stdout.write = (chunk) => {
  captured += String(chunk);
  return true;
};
await import(${JSON.stringify(`${coreUrl}?side-effect-probe`)});
process.stdout.write = originalWrite;
originalWrite(JSON.stringify({ captured, exitCode: process.exitCode ?? 0 }));
`
  ], { encoding: "utf8" });

  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout), {
    captured: "",
    exitCode: 0
  });
});
