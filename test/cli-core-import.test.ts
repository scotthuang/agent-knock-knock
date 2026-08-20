import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

test("importing the CLI core does not inspect argv, emit output, or exit", async () => {
  const coreUrl = new URL("../src/cli-core.js", import.meta.url).href;
  const worker = new Worker(`
const { parentPort } = require("node:worker_threads");
(async () => {
process.argv = [process.execPath, "import-probe", "--help"];
const originalWrite = process.stdout.write.bind(process.stdout);
let captured = "";
process.stdout.write = (chunk) => {
  captured += String(chunk);
  return true;
};
await import(${JSON.stringify(`${coreUrl}?side-effect-probe`)});
process.stdout.write = originalWrite;
parentPort.postMessage({ captured, exitCode: process.exitCode ?? 0 });
})().catch((error) => {
  process.stderr.write(String(error && error.stack || error));
  process.exitCode = 1;
});
`, { eval: true, stdout: true, stderr: true });
  let stderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const probe = await new Promise<{ captured: string; exitCode: number }>(
    (resolve, reject) => {
      let message: { captured: string; exitCode: number } | undefined;
      worker.once("message", (value) => {
        message = value;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0 || message === undefined) {
          reject(new Error(
            `CLI core import worker exited ${code} without evidence: ${stderr}`
          ));
          return;
        }
        resolve(message);
      });
    }
  );

  assert.deepEqual(probe, {
    captured: "",
    exitCode: 0
  });
});
