#!/usr/bin/env node
import process from "node:process";
import {
  executeCliCommand,
  parseCliCommand
} from "./cli-core.js";

const { command, options } = parseCliCommand(process.argv.slice(2));

try {
  const result = await executeCliCommand(command, options, {
    stdout(text) {
      process.stdout.write(text);
    }
  });
  process.exitCode = result.exitCode;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  // Preserve the original CLI's immediate failure semantics. A command may
  // have opened handles before throwing; setting exitCode alone could leave a
  // broken invocation alive indefinitely.
  process.exit(1);
}
