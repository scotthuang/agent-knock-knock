import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executeCliCommand,
  parseCliCommand
} from "../src/cli-core.js";
import {
  createTerminalControlProviderRegistry,
  StaticTerminalControlProvider
} from "../src/terminal-control-provider.js";
import type { TerminalProcessSource } from "../src/terminal-process-source.js";

test("CLI command execution returns output and exit status without process globals", async () => {
  const originalExitCode = process.exitCode;
  const helpOutput: string[] = [];
  const unknownOutput: string[] = [];
  try {
    const parsed = parseCliCommand(["--help"]);
    assert.deepEqual(parsed, { command: "--help", options: {} });

    const [help, unknown] = await Promise.all([
      executeCliCommand(parsed.command, parsed.options, {
        stdout: (text) => helpOutput.push(text),
        runtimeLog: () => undefined,
        cwd: "/virtual/help"
      }),
      executeCliCommand("not-a-command", {}, {
        stdout: (text) => unknownOutput.push(text),
        runtimeLog: () => undefined,
        cwd: "/virtual/unknown"
      })
    ]);

    assert.equal(help.exitCode, 0);
    assert.equal(unknown.exitCode, 1);
    assert.match(help.stdout, /^Usage:/u);
    assert.equal(help.stdout, helpOutput.join(""));
    assert.equal(unknown.stdout, unknownOutput.join(""));
    assert.equal(process.exitCode, originalExitCode);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("CLI command execution uses scoped terminal and process dependencies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cli-core-"));
  let terminalScans = 0;
  let processScans = 0;
  class RecordingTerminalProvider extends StaticTerminalControlProvider {
    override async listTerminals() {
      terminalScans += 1;
      return super.listTerminals();
    }
  }
  const terminalProvider = new RecordingTerminalProvider();
  const terminalProcessSource: TerminalProcessSource = {
    async listProcessSnapshots() {
      processScans += 1;
      return [];
    }
  };

  try {
    const result = await executeCliCommand("list", {
      all: true,
      noApprovalScan: true,
      storeDir: path.join(root, "store")
    }, {
      terminalControlProviderRegistry:
        createTerminalControlProviderRegistry([terminalProvider]),
      terminalProcessSource,
      runtimeLog: () => undefined
    });
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(processScans, 1);
    assert.ok(terminalScans > 0);
    assert.equal(output.terminal_scan.active_count, 0);
    assert.deepEqual(output.terminals, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
