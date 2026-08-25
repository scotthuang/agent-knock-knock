import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import {
  isArrowFunction,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isNewExpression,
  isVariableStatement
} from "typescript/unstable/ast";
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

test("native slash messages fail before terminal selector discovery", async () => {
  let terminalScans = 0;
  let processScans = 0;
  class RecordingTerminalProvider extends StaticTerminalControlProvider {
    override async listTerminals() {
      terminalScans += 1;
      return super.listTerminals();
    }
  }
  const dependencies = {
    terminalControlProviderRegistry: createTerminalControlProviderRegistry([
      new RecordingTerminalProvider()
    ]),
    terminalProcessSource: {
      async listProcessSnapshots() {
        processScans += 1;
        return [];
      }
    } satisfies TerminalProcessSource,
    runtimeLog: () => undefined
  };

  for (const scenario of [
    {
      command: "send",
      options: {
        conversation: "terminal:v2:tmux:codex:missing:0.0:4242",
        message: "/clear"
      },
      nativeCommand: "/clear"
    },
    {
      command: "send",
      options: { turn: "   ", message: "/clear" },
      nativeCommand: "/clear"
    },
    {
      command: "respond",
      options: { turn: "only", message: "/status" },
      nativeCommand: "/status"
    }
  ]) {
    await assert.rejects(
      executeCliCommand(scenario.command, scenario.options, dependencies),
      new RegExp(
        `ordinary send/respond cannot invoke native slash command \\${scenario.nativeCommand}`,
        "u"
      )
    );
  }

  assert.equal(terminalScans, 0);
  assert.equal(processScans, 0);
});

test("cli-core AST remains a stable facade without owned state machines", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const sourcePath = path.join(root, "src/cli-core.ts");
  const source = fs.readFileSync(sourcePath, "utf8");
  const declaration = fs.readFileSync(
    path.join(root, "dist/src/cli-core.d.ts"),
    "utf8"
  );
  const api = new TypeScriptApi({ cwd: root });
  const configPath = path.join(root, "tsconfig.json");
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] })
      .getProject(configPath);
    assert.ok(project, "TypeScript project is available");
    const sourceFile = project.program.getSourceFile(sourcePath);
    assert.ok(sourceFile, "cli-core AST is available");
    const functions = sourceFile.statements
      .filter(isFunctionDeclaration)
      .map((statement) => statement.name?.getText(sourceFile));
    assert.deepEqual(functions, [
      "terminalWriterMutationLocks",
      "terminalWriterStateMutationLocks",
      "withTerminalDispatchStateScope",
      "terminalDispatchCapabilityRepositories",
      "parseCliCommand",
      "executeCliCommand",
      "dispatchCliCommand",
      "preflightStoreWriter",
      "terminalRuntime",
      "createTerminalControlProvider",
      "createTerminalProcessSource",
      "loadClaudeAgentRows",
      "createRuntimeTerminalAgentRegistry",
      "createTerminalAgentBridge",
      "withTerminalBridgeSubmission",
      "managedSessionStoreDirForConversation",
      "agentVersionForRunningProcess",
      "cliEntryPath",
      "printVersion",
      "runTranscript",
      "isStoreMutationLockTimeout",
      "loadConversationFromOptions",
      "statusStoreSelection",
      "storeDirFromOptions",
      "parseArgs",
      "toCamelCase",
      "usage"
    ]);
    assert.deepEqual(
      sourceFile.statements.filter(isClassDeclaration),
      [],
      "cli-core must not own application state classes"
    );
    const topLevelFunctionVariables = sourceFile.statements
      .filter(isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .filter((declaration) => declaration.initializer && (
        isArrowFunction(declaration.initializer) ||
        isFunctionExpression(declaration.initializer)
      ))
      .map((declaration) => declaration.name.getText(sourceFile));
    assert.deepEqual(topLevelFunctionVariables, []);
    const topLevelSetVariables = sourceFile.statements
      .filter(isVariableStatement)
      .flatMap((statement) => statement.declarationList.declarations)
      .filter((declaration) =>
        declaration.initializer &&
        isNewExpression(declaration.initializer) &&
        declaration.initializer.expression.getText(sourceFile) === "Set"
      )
      .map((declaration) => declaration.name.getText(sourceFile));
    assert.deepEqual(topLevelSetVariables, [
      "SESSION_SELECTOR_COMMANDS",
      "STORE_MUTATION_COMMANDS"
    ], "cli-core may own only stable CLI routing sets");
  } finally {
    api.close();
  }
  for (const symbol of [
    "FINAL_DEFERRED_TRANSFER_STATUSES",
    "TERMINAL_BRIDGE_SUPERSEDE_STATUSES",
    "TERMINAL_DISPATCH_RELEASE_STATUSES",
    "ACTIVE_TERMINAL_DISPATCH_STATUSES",
    "RECOVERABLE_TERMINAL_DISPATCH_STATUSES",
    "SESSION_SEND_BLOCKING_STATUSES"
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b(?:const|let|var)\\s+${symbol}\\b`, "u"),
      `${symbol} must remain in its canonical policy owner`
    );
  }
  const preflightStart = source.indexOf("function preflightStoreWriter");
  const preflightEnd = source.indexOf("function terminalRuntime", preflightStart);
  const preflight = source.slice(preflightStart, preflightEnd);
  assert.ok(
    preflight.indexOf('commandName === "delegate"') >= 0 &&
      preflight.indexOf('commandName === "delegate"') <
        preflight.indexOf("assertStoreWriterCompatible"),
    "user-priority delegate must bypass the global Store writer preflight"
  );

  for (const symbol of [
    "assertSafeTerminalSend",
    "assertTurnBindingCurrent",
    "migratedTerminalTurnMatchesSessionBinding",
    "openClawYieldNextAction",
    "loadCodexTerminalContexts",
    "classifyProcessFailure",
    "isRemoteCompactStreamDisconnect",
    "isProcessAlive",
    "isZombieProcess",
    "isActiveStatus",
    "isWaitingForAgent"
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`\\b(?:function|class)\\s+${symbol}\\b`, "u"),
      `${symbol} must remain in its canonical owner`
    );
  }
  assert.match(
    declaration,
    /export type CliCommandOptions = Record<string, unknown>;/u
  );
  assert.doesNotMatch(declaration, /\bany\b/u);
});
