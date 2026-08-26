import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeAgentRow,
  runAgentCliInProcess
} from "./agent-cli-fixtures.js";
import {
  legacyManagedSessionBindingToken,
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  createTerminalEndpointRef,
  tmuxTerminalRouteKey
} from "../src/terminal-control-ref.js";
import {
  listManagedSessions,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

for (const claudeVersion of ["2.1.218", "2.1.226"] as const) {
  test(`Claude ${claudeVersion} native status inspection is snapshot-bound, modal-safe, and Store immutable`, async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-claude-native-inspect-")
  );
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const screenPath = path.join(tempDir, "screen.txt");
  const agentsPath = path.join(tempDir, "claude-agents.json");
  const callsPath = path.join(tempDir, "tmux-calls.ndjson");
  const target = "claude-native:0.0";
  const panePid = 78_000;
  const claudePid = 78_001;
  const nativeThreadId = "40ce9ddb-6de3-45d1-be57-7684808712a0";
  const startedAt = 1784870000000;
  const terminalId = `terminal:v2:tmux:claude:${target}:${claudePid}`;
  const initialScreen = claudeIdleScreen();
  const composerScreen = claudeSlashComposerScreen();
  const panelScreen = claudeStatusPanel(
    nativeThreadId,
    workspace,
    claudeVersion
  );
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: "claude-native",
    window: 0,
    pane: 0,
    panePid,
    currentCommand: claudeVersion,
    currentPath: workspace,
    capabilities: [
      "screen_status",
      "send_keys",
      "terminal_approval",
      "durable_completion",
      "terminal_cancel"
    ]
  };
  const endpointKey = "default-server-route";
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey: "pane-id:%1"
    },
    route: {
      routeKey: tmuxTerminalRouteKey(endpointKey, target),
      label: target,
      currentCommand: claudeVersion,
      currentPath: workspace
    },
    processAnchorPid: panePid,
    capabilities: terminalControl.capabilities,
    providerRef: terminalControl
  });

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(screenPath, initialScreen);
    const agentRows = [
      claudeAgentRow(claudePid, nativeThreadId, workspace)
    ];
    fs.writeFileSync(agentsPath, JSON.stringify(agentRows));
    writeFastClaudeRuntime({
      fakeBinDir,
      callsPath,
      screenPath,
      agentsPath,
      workspace,
      panePid,
      claudePid,
      claudeVersion
    });

    ensureStoreWritable(storeDir);
    const now = new Date("2026-08-09T08:00:00.000Z");
    const session = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-claude-native-inspect",
      agent: "claude",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: claudePid,
        nativeThreadId,
        processUuid: `claude-pid:${claudePid}:started:${startedAt}`,
        evidence: "claude_agents_exact_pid",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    const expectedBindingToken = managedSessionBindingToken(session);
    const legacyBindingToken = legacyManagedSessionBindingToken(session);
    assert.notEqual(expectedBindingToken, legacyBindingToken);
    const commonArgs = [
      "--store-dir",
      storeDir,
      "--workspace",
      workspace,
      "--agent-versions-json",
      JSON.stringify({ [claudePid]: claudeVersion })
    ];
    const environment = {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    };

    const listed = await runAgentCliInProcess(["list", "--all", ...commonArgs], environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const row = JSON.parse(listed.stdout).terminals.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(row, listed.stdout);
    assert.equal(row.native_inspection.status, "supported");
    assert.equal(row.native_inspection.agentVersion, claudeVersion);
    assert.equal(
      row.native_inspection.behaviorProfile,
      `claude-code-${claudeVersion}-native-status`
    );
    assert.equal(row.lifecycle_binding_token, expectedBindingToken);
    assert.equal(
      row.available_actions.native_inspect.arguments.expected_binding_token,
      expectedBindingToken
    );

    const storeBefore = directorySnapshot(storeDir);
    const nativeInspectArgs = (
      token: string,
      runtimeArgs = commonArgs
    ) => [
      "native-inspect",
      "--terminal",
      terminalId,
      "--inspection",
      "status",
      "--expected-binding-token",
      token,
      ...runtimeArgs
    ];

    const stale = await runAgentCliInProcess(
      nativeInspectArgs("stale-binding-token"),
      environment
    );
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /binding changed after it was listed/u);

    for (const [label, unsafeScreen, expectedError] of [
      [
        "busy",
        "❯ inspect the repository\n\n✻ Working… (12s · 312 tokens)\n  esc to interrupt",
        /not at a verified idle prompt/u
      ],
      [
        "multiline draft",
        "────────────────\n❯ \n  human draft continuation\n────────────────\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
        /not at a verified idle prompt|composer contains input/u
      ],
      [
        "approval",
        claudeApprovalScreen(),
        /not at a verified idle prompt/u
      ]
    ] as const) {
      fs.writeFileSync(screenPath, unsafeScreen);
      const rejected = await runAgentCliInProcess(
        nativeInspectArgs(expectedBindingToken),
        environment
      );
      assert.equal(rejected.status, 1, `${label}: ${rejected.stdout}`);
      assert.match(rejected.stderr, expectedError, label);
    }

    const unverifiedArgs = commonArgs.map((argument) =>
      argument === JSON.stringify({ [claudePid]: claudeVersion })
        ? JSON.stringify({ [claudePid]: "2.1.227" })
        : argument
    );
    fs.writeFileSync(screenPath, initialScreen);
    const unverified = await runAgentCliInProcess(
      ["list", "--all", ...unverifiedArgs],
      environment
    );
    assert.equal(unverified.status, 0, unverified.stderr || unverified.stdout);
    const unverifiedRow = JSON.parse(unverified.stdout).terminals.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.equal(unverifiedRow.native_inspection.status, "supported");
    assert.equal(
      unverifiedRow.native_inspection.versionCompatibility,
      "unverified"
    );
    assert.match(
      unverifiedRow.native_inspection.compatibilityWarning,
      /not been regression-tested/u
    );
    assert.match(
      unverifiedRow.available_actions.native_inspect.compatibility_warning,
      /not been regression-tested/u
    );

    const ambiguousIdentity = await runAgentCliInProcess(
      nativeInspectArgs(expectedBindingToken),
      {
        ...environment,
        AKK_TEST_CLAUDE_AGENTS_JSON: JSON.stringify([
          ...agentRows,
          { ...agentRows[0] }
        ])
      }
    );
    assert.equal(ambiguousIdentity.status, 1, ambiguousIdentity.stdout);
    assert.match(
      ambiguousIdentity.stderr,
      /agents identity, cwd, or idle state changed/u
    );

    const activeElsewhere = await runAgentCliInProcess(
      nativeInspectArgs(expectedBindingToken),
      {
        ...environment,
        AKK_TEST_CLAUDE_AGENTS_JSON: JSON.stringify([
          ...agentRows,
          claudeAgentRow(claudePid + 10, nativeThreadId, workspace)
        ])
      }
    );
    assert.equal(activeElsewhere.status, 1, activeElsewhere.stdout);
    assert.match(activeElsewhere.stderr, /already active in another claude process/u);
    assert.deepEqual(terminalInputCalls(callsPath), []);

    const inspected = await runAgentCliInProcess(nativeInspectArgs(legacyBindingToken), {
      ...environment,
      AKK_TEST_TMUX_COMPOSER_AFTER_LITERAL: composerScreen,
      AKK_TEST_TMUX_COMPOSER_AFTER_ENTER: panelScreen,
      AKK_TEST_TMUX_COMPOSER_AFTER_ESCAPE: initialScreen,
      AKK_TEST_CLAUDE_AGENTS_DIALOG_JSON: JSON.stringify([{
        ...agentRows[0],
        status: "waiting",
        waitingFor: "dialog open"
      }]),
      AKK_TEST_CLAUDE_AGENTS_IDLE_JSON: JSON.stringify(agentRows)
    });
    assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
    const result = JSON.parse(inspected.stdout);
    assert.equal(result.status, "observed");
    assert.equal(result.agent, "claude");
    assert.equal(result.agent_version, claudeVersion);
    assert.equal(
      result.behavior_profile,
      `claude-code-${claudeVersion}-native-status`
    );
    assert.equal(result.native_thread_id, nativeThreadId);
    assert.equal(result.terminal_submission.command, "/status");
    assert.equal(result.terminal_submission.enter_count, 1);
    assert.equal(
      result.terminal_submission.materialization.stableForMs >= 80,
      true
    );
    assert.deepEqual(result.terminal_dismissal, {
      keys: ["Escape"],
      dismiss_count: 1,
      restored_idle: true
    });
    assert.equal(result.store_mutation, false);
    for (const key of [
      "session_created",
      "turn_created",
      "receipt_created",
      "monitor_created",
      "callback_created"
    ]) {
      assert.equal(result[key], false, key);
    }
    assert.equal(
      result.native_status.fields.find(
        (field: { name: string }) => field.name === "Auth token"
      ).value,
      "[REDACTED]"
    );
    assert.deepEqual(
      terminalInputCalls(callsPath).map((call) => call.args.at(-1)),
      ["/status", "C-m", "Escape"]
    );
    assert.deepEqual(directorySnapshot(storeDir), storeBefore);
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listManagedSessions(storeDir).length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  });
}

function claudeIdleScreen(): string {
  return [
    "────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────",
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
  ].join("\n");
}

function claudeSlashComposerScreen(): string {
  return [
    "────────────────────────────────────────────────",
    "❯ /status",
    "────────────────────────────────────────────────",
    "/status                       Show Claude Code status including version, model, account, API",
    "                              connectivity, and tool statuses",
    "/statusline                   Set up Claude Code's status line UI",
    "/ide                          Manage IDE integrations and show status",
    "/usage                        Show session cost, plan usage, and activity stats"
  ].join("\n");
}

function claudeStatusPanel(
  nativeThreadId: string,
  cwd: string,
  version: string
): string {
  return [
    "────────────────────────────────────────────────",
    "  Settings  Status   Config   Usage   Stats",
    "",
    `  Version:             ${version}`,
    `  Session ID:          ${nativeThreadId}`,
    ...(version === "2.1.226"
      ? ["  Session kind:        interactive"]
      : []),
    `  cwd:                 ${cwd}`,
    "  Auth token:          ANTHROPIC_AUTH_TOKEN",
    "  Anthropic base URL:  https://api.example.com/anthropic",
    "",
    "  Model:               claude-sonnet",
    "  MCP servers:         all connected",
    "  Setting sources:     User settings",
    "",
    "  Esc to cancel"
  ].join("\n");
}

function claudeApprovalScreen(): string {
  return [
    " Bash command",
    "",
    "   pwd",
    "   Print the working directory",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don’t ask again for: pwd",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}

function terminalInputCalls(callsPath: string): Array<{ args: string[] }> {
  if (!fs.existsSync(callsPath)) {
    return [];
  }
  return fs.readFileSync(callsPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const [command, last] = line.split("\t");
      return { command, args: [command, last] };
    })
    .filter((call) => call.command === "send-keys");
}

function writeFastClaudeRuntime(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  agentsPath: string;
  workspace: string;
  panePid: number;
  claudePid: number;
  claudeVersion: string;
}): void {
  const tmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(tmux, `#!/bin/sh
command_name="$1"
last=""
for argument in "$@"; do last="$argument"; done
printf '%s\\t%s\\n' "$command_name" "$last" >> ${shellQuote(options.callsPath)}
case "$command_name" in
  list-panes)
    printf '%s\\n' ${shellQuote(`claude-native\t0\t0\t${options.panePid}\t${options.claudeVersion}\t${options.workspace}\t\t%1`)}
    ;;
  capture-pane)
    cat ${shellQuote(options.screenPath)}
    ;;
  send-keys)
    case " $* " in
      *" -l "*)
        if [ -n "$AKK_TEST_TMUX_COMPOSER_AFTER_LITERAL" ]; then
          printf '%s' "$AKK_TEST_TMUX_COMPOSER_AFTER_LITERAL" > ${shellQuote(options.screenPath)}
        fi
        ;;
    esac
    if [ "$last" = "C-m" ] && [ -n "$AKK_TEST_TMUX_COMPOSER_AFTER_ENTER" ]; then
      printf '%s' "$AKK_TEST_TMUX_COMPOSER_AFTER_ENTER" > ${shellQuote(options.screenPath)}
      printf '%s' "$AKK_TEST_CLAUDE_AGENTS_DIALOG_JSON" > ${shellQuote(options.agentsPath)}
    fi
    if [ "$last" = "Escape" ] && [ -n "$AKK_TEST_TMUX_COMPOSER_AFTER_ESCAPE" ]; then
      printf '%s' "$AKK_TEST_TMUX_COMPOSER_AFTER_ESCAPE" > ${shellQuote(options.screenPath)}
      printf '%s' "$AKK_TEST_CLAUDE_AGENTS_IDLE_JSON" > ${shellQuote(options.agentsPath)}
    fi
    ;;
esac
`);
  fs.chmodSync(tmux, 0o755);

  const ps = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(ps, `#!/bin/sh
case " $* " in
  *" lstart= "*) printf '%s\\n' 'Thu Aug  6 10:00:00 2026' ;;
  *)
    printf '%s\\n' \
      '  PID  PPID ELAPSED COMMAND' \
      '${options.panePid} 1 00:01 -zsh' \
      '${options.claudePid} ${options.panePid} 00:01 claude'
    ;;
esac
`);
  fs.chmodSync(ps, 0o755);

  const lsof = path.join(options.fakeBinDir, "lsof");
  fs.writeFileSync(lsof, `#!/bin/sh
printf '%s\\n' \
  'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME' \
  '-zsh ${options.panePid} me cwd DIR 1,18 64 122 ${options.workspace}' \
  'claude ${options.claudePid} me cwd DIR 1,18 64 123 ${options.workspace}'
`);
  fs.chmodSync(lsof, 0o755);

  const claude = path.join(options.fakeBinDir, "claude");
  fs.writeFileSync(claude, `#!/bin/sh
if [ -n "$AKK_TEST_CLAUDE_AGENTS_JSON" ]; then
  printf '%s' "$AKK_TEST_CLAUDE_AGENTS_JSON"
else
  cat ${shellQuote(options.agentsPath)}
fi
`);
  fs.chmodSync(claude, 0o755);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function directorySnapshot(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        snapshot[path.relative(root, absolute)] = fs.readFileSync(
          absolute,
          "base64"
        );
      }
    }
  };
  visit(root);
  return snapshot;
}
