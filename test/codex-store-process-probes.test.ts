import assert from "node:assert/strict";
import test from "node:test";
import { CodexStoreAdapter } from "../src/codex-store-adapter.js";
import { cliExecutionMemoAsync, runCliCommandExecution } from "../src/cli-runtime-context.js";

test("Codex async rollout inspection fences each lsof observation with fresh process births", async () => {
  const calls: string[] = [];
  let birth = "Tue Aug 4 14:15:13 2026";
  const adapter = new CodexStoreAdapter({
    codexHome: "/unused-codex-home",
    async runCommand(command, args) {
      calls.push(command);
      assert.ok(args.includes("4242"));
      return { status: 0, stderr: "", stdout: command === "ps" ? `${birth}\n` : "p4242\n" };
    }
  });
  const first = await adapter.inspectOpenRootRolloutInventoryForPid(4242, "/repo");
  birth = "Tue Aug 4 14:16:13 2026";
  const second = await adapter.inspectOpenRootRolloutInventoryForPid(4242, "/repo");
  assert.deepEqual(calls, ["ps", "lsof", "ps", "ps", "lsof", "ps"]);
  assert.notEqual(first.processUuid, second.processUuid);
  assert.equal(second.processBirth, birth);
});

test("Codex async rollout inspection rejects PID reuse and failed descriptor observations", async t => {
  for (const fault of ["pid_reused", "descriptor_unavailable"] as const) {
    await t.test(fault, async () => {
      let births = 0;
      const adapter = new CodexStoreAdapter({
        async runCommand(command) {
          if (command === "ps") {
            births += 1;
            return { status: 0, stderr: "", stdout: `birth-${births}\n` };
          }
          return fault === "descriptor_unavailable"
            ? { status: 1, stdout: "", stderr: "descriptor probe failed" }
            : { status: 0, stdout: "p4242\n", stderr: "" };
        }
      });
      await assert.rejects(adapter.inspectOpenRootRolloutInventoryForPid(4242),
        fault === "pid_reused" ? /incarnation changed/u : /descriptor probe failed/u);
    });
  }
});

test("read-only Codex inventory memo shares adapters within one command but never reuses mutation probes", async () => {
  let probes = 0;
  const options = {
    codexHome: "/unused-codex-home",
    async runCommand(command: string) {
      probes += 1;
      return { status: 0, stderr: "", stdout: command === "ps" ? "stable-birth\n" : "p4242\n" };
    }
  };
  const createDiscovery = () => new CodexStoreAdapter({ ...options,
    memoizeOpenRootInventory: (key, observe) =>
      cliExecutionMemoAsync("codex-list-open-root-inventory", key, observe)
  });
  await runCliCommandExecution("list", {}, { runtimeLog() {} }, async () => {
    const [first, second] = await Promise.all([
      createDiscovery().inspectOpenRootRolloutInventoryForPid(4242, "/repo"),
      createDiscovery().inspectOpenRootRolloutInventoryForPid(4242, "/repo")
    ]);
    assert.equal(probes, 3);
    first.processBirth = "consumer-mutated";
    assert.equal(second.processBirth, "stable-birth");
    await createDiscovery().resolveActiveSessionIdentityForPid(4242, "/repo");
    assert.equal(probes, 3);
    await new CodexStoreAdapter(options).inspectOpenRootRolloutInventoryForPid(4242, "/repo");
    assert.equal(probes, 6, "execution preflight does not opt into discovery memoization");
    await createDiscovery().inspectOpenRootRolloutInventoryForPid(4242, "/other-repo");
    assert.equal(probes, 9, "workspace constraints cannot borrow another snapshot");
  });
  await runCliCommandExecution("list", {}, { runtimeLog() {} }, async () => {
    await createDiscovery().inspectOpenRootRolloutInventoryForPid(4242, "/repo");
  });
  assert.equal(probes, 12, "a later command performs a new fenced observation");
});
