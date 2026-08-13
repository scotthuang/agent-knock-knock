import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexLocalSessionAdapter } from "../src/codex-local-session-provider.js";
import type { CodexOpenRootRolloutInventory } from
  "../src/agent-session-provider.js";
import { createClaudeTerminalAgentAdapter } from
  "../src/claude-terminal-agent-adapter.js";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  type HerdrRequestOptions,
  type HerdrWireRequest
} from "../src/herdr-terminal-control-provider.js";
import { createConversation } from "../src/protocol.js";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  pathsForManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import {
  ensureStoreWritable,
  listConversations,
  pathsForConversation,
  saveState
} from "../src/store.js";
import {
  formatTerminalConversationId,
  createTerminalAgentAdapterRegistry,
  type TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
import { listDeferredForegroundTransfers } from
  "../src/deferred-foreground-transfer.js";
import { createTerminalControlProviderRegistry } from
  "../src/terminal-control-provider.js";
import {
  createTerminalEndpointRef,
  terminalEndpointFromControlRef,
  terminalLegacyRuntimeRoute
} from
  "../src/terminal-control-ref.js";
import {
  MutableRecordingTerminalProvider,
  MutableTerminalProcessSource,
  runInProcessCli,
  terminalCliDependencies,
  VirtualClock,
  type InProcessCliResult
} from "./in-process-cli-fixtures.js";

const NATIVE_A = "11111111-1111-4111-8111-111111111111";
const NATIVE_B = "22222222-2222-4222-8222-222222222222";
const NATIVE_C = "33333333-3333-4333-8333-333333333333";
const CLAUDE_COMPOSER_DIVIDER =
  "────────────────────────────────────────────────";

function claudeComposerScreen(text = ""): string {
  const rows = text.split("\n");
  return [
    "Ready",
    CLAUDE_COMPOSER_DIVIDER,
    `❯ ${rows[0] ?? ""}`,
    ...rows.slice(1).map((row) => `  ${row}`),
    CLAUDE_COMPOSER_DIVIDER,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
  ].join("\n");
}

function claudeHerdrClearedComposerScreen(): string {
  return [
    "Welcome back",
    "❯ /clear",
    "",
    CLAUDE_COMPOSER_DIVIDER,
    `❯\u00a0`,
    CLAUDE_COMPOSER_DIVIDER,
    "\u00a0 ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
  ].join("\n");
}

test("a terminal-scoped Codex send adopts an exact unknown human-switched thread", async () => {
  const fixture = createHandoffFixture({
    agent: "codex",
    codexTargetMode: "status_card_only"
  });
  try {
    const source = fixture.persistSession({
      sessionId: "session-human-codex-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });

    const listed = await fixture.listTerminal();
    assert.equal(listed.management_state, "conflict");
    assert.equal(
      listed.handoff_state,
      "external_handoff_adoptable",
      JSON.stringify(listed, null, 2)
    );
    assert.equal(
      listed.management_conflict?.kind,
      "live_external_thread_change"
    );
    assert.deepEqual(
      listed.available_actions?.send?.missing_required,
      ["request"]
    );
    assert.equal(
      listed.available_actions?.send?.arguments?.selector,
      fixture.terminalId
    );
    const expectedTerminalToken = String(
      listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);

    const sent = await fixture.sendToTerminal(
      "Continue in the human-selected Codex context.",
      {},
      expectedTerminalToken
    );
    assert.equal(sent.status, 0, fixture.debug(sent));
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, fixture.debug(sent));
    assert.notEqual(output.session_id, source.session_id);

    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 2);
    const sourceAfter = sessions.find((entry) =>
      entry.session_id === source.session_id
    );
    const targetAfter = sessions.find((entry) =>
      entry.session_id === output.session_id
    );
    assert.equal(sourceAfter?.status, "detached");
    assert.equal(sourceAfter?.binding?.native_thread_id, NATIVE_A);
    assert.equal(targetAfter?.status, "bound");
    assert.equal(targetAfter?.binding?.native_thread_id, NATIVE_B);
    assert.equal(targetAfter?.binding?.generation, 1);
    assert.equal(
      (targetAfter?.lineage as unknown as { created_by?: string })?.created_by,
      "human_observed"
    );

    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, targetAfter?.session_id);
    assert.equal(turns[0].native_thread_id, NATIVE_B);

    const transition = fixture.onlyTransition();
    const transitionRecord = transition as unknown as Record<string, unknown>;
    assert.equal(String(transition.operation), "adopt_external_thread");
    assert.equal(transitionRecord.origin, "human_observed");
    assert.equal(transitionRecord.terminal_input_sent, false);
    assert.equal(transition.source_session_id, source.session_id);
    assert.equal(transition.target_session_id, targetAfter?.session_id);
    assert.equal(transition.before_native_thread_id, NATIVE_A);
    assert.equal(transition.target_native_thread_id, NATIVE_B);
    assert.equal(transition.status, "committed");

    assert.equal(
      fixture.literalInputs().filter((input) =>
        input === "Continue in the human-selected Codex context."
      ).length,
      1
    );
    assert.equal(
      fixture.literalInputs().some((input) =>
        input === "/clear" || input.startsWith("/resume")
      ),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("a no-token exact terminal-scoped Claude send freshly adopts an unknown human-switched thread", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-human-claude-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 2
    });

    const sent = await fixture.sendToTerminal(
      "Continue in the human-selected Claude context."
    );
    assert.equal(sent.status, 0, fixture.debug(sent));
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, fixture.debug(sent));
    assert.notEqual(output.session_id, source.session_id);

    const sessions = listManagedSessions(fixture.storeDir);
    const sourceAfter = sessions.find((entry) =>
      entry.session_id === source.session_id
    );
    const targetAfter = sessions.find((entry) =>
      entry.session_id === output.session_id
    );
    assert.equal(sourceAfter?.status, "detached");
    assert.equal(sourceAfter?.binding?.native_thread_id, NATIVE_A);
    assert.equal(targetAfter?.status, "bound");
    assert.equal(targetAfter?.binding?.native_thread_id, NATIVE_B);
    assert.equal(targetAfter?.binding?.generation, 1);
    assert.equal(
      (targetAfter?.lineage as unknown as { created_by?: string })?.created_by,
      "human_observed"
    );
    assert.equal(listConversations(fixture.storeDir).length, 1);
    assert.equal(
      listConversations(fixture.storeDir)[0].session_id,
      targetAfter?.session_id
    );
    assert.equal(String(fixture.onlyTransition().operation),
      "adopt_external_thread");
    assert.deepEqual(fixture.literalInputs(), [
      "Continue in the human-selected Claude context."
    ]);
    assert.equal(fixture.enterCount(), 1);
  } finally {
    fixture.cleanup();
  }
});

test("Herdr Claude handoff uses the exact listed token and only one task input plus Enter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-human-herdr-claude-"));
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const claudeHome = path.join(root, ".claude");
  const socketPath = path.join(root, "herdr.sock");
  const paneId = "w1:p1";
  const terminalResourceId = "terminal-human-handoff";
  const target = `default:${paneId}`;
  const shellPid = 83_000;
  const agentPid = shellPid + 1;
  const claudeStartedAt = 1_786_339_200_000;
  const version = "2.1.226";
  const executable = `/Users/test/.local/share/claude/versions/${version}`;
  const request = "Continue in the human-selected Herdr Claude context.";
  const socketIdentity = {
    device: "1",
    inode: "83000",
    ctimeNs: "1786339200000000000",
    ownerUid: 501
  };
  const wireRequests: Array<{
    request: HerdrWireRequest;
    options?: HerdrRequestOptions;
  }> = [];
  let screen = claudeHerdrClearedComposerScreen();
  let pendingText = "";
  let revision = 0;

  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const envelope = (
    wireRequest: HerdrWireRequest,
    result: Record<string, unknown>
  ) => ({ id: wireRequest.id, result });
  const provider = new HerdrTerminalControlProvider({
    command: "herdr-test",
    runCommand: (_command, args) => {
      if (args.length === 1 && args[0] === "--version") {
        return {
          status: 0,
          stdout: `herdr ${HERDR_EXACT_VERSION}\n`,
          stderr: ""
        };
      }
      assert.deepEqual(args, ["session", "list", "--json"]);
      return {
        status: 0,
        stdout: JSON.stringify({
          sessions: [{
            name: "default",
            default: true,
            running: true,
            socket_path: socketPath,
            session_dir: root
          }]
        }),
        stderr: ""
      };
    },
    statSocket: () => socketIdentity,
    request: async (_socketPath, wireRequest, options) => {
      wireRequests.push({ request: wireRequest, options });
      switch (wireRequest.method) {
        case "ping":
          return envelope(wireRequest, {
            type: "pong",
            version: HERDR_EXACT_VERSION,
            protocol: HERDR_EXACT_PROTOCOL,
            capabilities: {
              live_handoff: true,
              detached_server_daemon: true
            }
          });
        case "session.snapshot":
          return envelope(wireRequest, {
            type: "session_snapshot",
            snapshot: {
              version: HERDR_EXACT_VERSION,
              protocol: HERDR_EXACT_PROTOCOL,
              panes: [{
                pane_id: paneId,
                terminal_id: terminalResourceId,
                workspace_id: "w1",
                tab_id: "w1:t1",
                cwd: workspace,
                focused: true,
                agent_status: null,
                revision
              }]
            }
          });
        case "pane.process_info":
          return envelope(wireRequest, {
            type: "pane_process_info",
            process_info: {
              pane_id: paneId,
              shell_pid: shellPid,
              foreground_process_group_id: agentPid,
              tty: null,
              foreground_processes: [{
                pid: agentPid,
                name: "claude",
                argv0: executable,
                argv: [executable],
                cmdline: executable,
                cwd: workspace
              }]
            }
          });
        case "pane.read":
          return envelope(wireRequest, {
            type: "pane_read",
            read: {
              pane_id: paneId,
              workspace_id: "w1",
              tab_id: "w1:t1",
              source: wireRequest.params.source,
              format: wireRequest.params.format,
              text: screen,
              revision,
              truncated: false
            }
          });
        case "pane.send_input": {
          if (typeof wireRequest.params.text === "string") {
            pendingText = wireRequest.params.text;
            screen = claudeComposerScreen(pendingText);
          } else if (
            Array.isArray(wireRequest.params.keys) &&
            wireRequest.params.keys.includes("enter")
          ) {
            pendingText = "";
            screen = "Working\n";
          }
          revision += 1;
          return envelope(wireRequest, { type: "ok" });
        }
        default:
          throw new Error(`unexpected Herdr method ${wireRequest.method}`);
      }
    }
  });
  const clock = new VirtualClock("2026-08-10T12:00:00.000Z");
  const processSource = new MutableTerminalProcessSource([
    {
      pid: shellPid,
      ppid: 1,
      elapsed: "00:10",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: agentPid,
      ppid: shellPid,
      elapsed: "00:09",
      command: executable,
      cwd: workspace
    }
  ]);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AKK_RUNTIME_DIR: runtimeDir,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
    AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted",
    TMUX: ""
  };
  const dependencies = {
    terminalControlProviderRegistry: createTerminalControlProviderRegistry([
      provider
    ]),
    terminalProcessSource: processSource,
    env: baseEnv,
    now: clock.now,
    monotonicNowMs: clock.nowMs,
    sleep: clock.sleep,
    sleepSync: clock.sleepSync,
    loadClaudeAgentRows: () => [{
      pid: agentPid,
      cwd: workspace,
      kind: "interactive",
      sessionId: NATIVE_B,
      startedAt: claudeStartedAt,
      status: "idle"
    }],
    agentVersionForRunningProcess: () => version,
    pid: agentPid + 500_000,
    runtimeLog() {}
  };

  try {
    const [endpoint] = await provider.listTerminals();
    assert.ok(endpoint);
    const terminalControl = provider.toControlRef(endpoint);
    const terminalId = formatTerminalConversationId({
      kind: "herdr",
      agent: "claude",
      target,
      pid: agentPid
    });
    ensureStoreWritable(storeDir);
    const now = clock.now();
    const source = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-human-herdr-claude-source",
      agent: "claude",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: agentPid,
        nativeThreadId: NATIVE_A,
        processUuid: `claude-pid:${agentPid}:started:${claudeStartedAt}`,
        evidence: "claude_agents_exact_pid",
        generation: 4,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    const storeArgs = [
      "--store-dir",
      storeDir,
      "--claude-home",
      claudeHome
    ];

    screen = claudeComposerScreen("Preserve this human-authored draft.");
    const draftListedResult = await runInProcessCli(
      ["list", ...storeArgs],
      dependencies
    );
    assert.equal(draftListedResult.status, 0, draftListedResult.stderr);
    const draftListed = JSON.parse(draftListedResult.stdout).terminals?.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(draftListed, draftListedResult.stdout);
    assert.equal(draftListed.handoff_state, "external_handoff_blocked");
    assert.equal(draftListed.available_actions?.send, undefined);
    assert.match(
      String(draftListed.handoff_blocked_reason),
      /composer is not an exact empty idle frame/iu
    );

    screen = ["Ready", "❯\u00a0"].join("\n");
    const unframedListedResult = await runInProcessCli(
      ["list", ...storeArgs],
      dependencies
    );
    assert.equal(unframedListedResult.status, 0, unframedListedResult.stderr);
    const unframedListed = JSON.parse(
      unframedListedResult.stdout
    ).terminals?.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(unframedListed, unframedListedResult.stdout);
    assert.equal(unframedListed.activity_state, "idle");
    assert.equal(unframedListed.handoff_state, "external_handoff_blocked");
    assert.equal(unframedListed.available_actions?.send, undefined);

    screen = claudeHerdrClearedComposerScreen();
    const listedResult = await runInProcessCli(
      ["list", ...storeArgs],
      dependencies
    );
    assert.equal(listedResult.status, 0, listedResult.stderr);
    const listed = JSON.parse(listedResult.stdout).terminals?.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(listed, listedResult.stdout);
    assert.equal(listed.handoff_state, "external_handoff_adoptable");
    assert.equal("_automated_input_composer_ready" in listed, false);
    assert.equal(listed.available_actions?.send?.arguments?.selector, terminalId);
    const expectedTerminalToken = String(
      listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);

    wireRequests.length = 0;
    const sent = await runInProcessCli([
      "send",
      "--conversation",
      terminalId,
      "--message",
      request,
      "--expected-terminal-token",
      expectedTerminalToken,
      "--background",
      ...storeArgs,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], dependencies);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true);
    assert.notEqual(output.session_id, source.session_id);

    const sessions = listManagedSessions(storeDir);
    const sourceAfter = sessions.find((entry) =>
      entry.session_id === source.session_id
    );
    const targetAfter = sessions.find((entry) =>
      entry.session_id === output.session_id
    );
    assert.equal(sourceAfter?.status, "detached");
    assert.equal(targetAfter?.status, "bound");
    assert.equal(targetAfter?.binding?.native_thread_id, NATIVE_B);
    assert.equal(targetAfter?.binding?.terminal_control.kind, "herdr");
    assert.equal(targetAfter?.lineage.created_by, "human_observed");
    const transitionRoot = nativeThreadTransitionsDir(storeDir);
    const transitionIds = fs.readdirSync(transitionRoot, {
      withFileTypes: true
    }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.equal(transitionIds.length, 1);
    assert.equal(
      String(loadNativeThreadTransition(storeDir, transitionIds[0]).operation),
      "adopt_external_thread"
    );

    const inputs = wireRequests.filter((entry) =>
      entry.request.method === "pane.send_input"
    );
    assert.deepEqual(inputs.map((entry) => entry.request.params), [
      { pane_id: paneId, text: request },
      { pane_id: paneId, keys: ["enter"] }
    ]);
    assert.equal(
      inputs.some((entry) =>
        JSON.stringify(entry.request.params).includes("/clear") ||
        JSON.stringify(entry.request.params).includes("/resume")
      ),
      false
    );
    assert.equal(
      inputs.some((entry) =>
        Array.isArray(entry.request.params.keys) &&
        entry.request.params.keys.some((key) =>
          ["Escape", "escape", "C-u"].includes(String(key))
        )
      ),
      false,
      "handoff must preserve human input instead of clearing the composer"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const agent of ["codex", "claude"] as const) {
  test(`${agent} human handoff preserves known detached history under v15 routing`, async () => {
    const fixture = createHandoffFixture({ agent });
    try {
      const source = fixture.persistSession({
        sessionId: `session-${agent}-known-source`,
        nativeThreadId: NATIVE_A,
        status: "bound",
        generation: 3
      });
      const target = fixture.persistSession({
        sessionId: `session-${agent}-known-target`,
        nativeThreadId: NATIVE_B,
        status: "detached",
        generation: 7
      });
      fixture.persistHistoricalTurn(source, `Historical ${agent} source A.`);
      fixture.persistHistoricalTurn(target, `Historical ${agent} target B.`);

      const expectedTerminalToken = agent === "codex"
        ? String((await fixture.listTerminal()).available_actions?.send
            ?.arguments?.expected_terminal_token ?? "")
        : undefined;
      if (agent === "codex") assert.ok(expectedTerminalToken);
      const sent = await fixture.sendToTerminal(
        `Continue the known ${agent} history selected by the human.`,
        {},
        expectedTerminalToken
      );
      assert.equal(sent.status, 0, fixture.debug(sent));
      const output = JSON.parse(sent.stdout);
      assert.equal(output.delivered, true, fixture.debug(sent));
      if (agent === "codex") {
        assert.notEqual(output.session_id, target.session_id);
      } else {
        assert.equal(output.session_id, target.session_id);
      }

      const sessions = listManagedSessions(fixture.storeDir);
      const sourceAfter = sessions.find((entry) =>
        entry.session_id === source.session_id
      );
      const targetAfter = sessions.find((entry) =>
        entry.session_id === target.session_id
      );
      const deliveredTarget = sessions.find((entry) =>
        entry.session_id === output.session_id
      );
      assert.equal(sourceAfter?.status, "detached");
      assert.equal(sourceAfter?.binding?.native_thread_id, NATIVE_A);
      assert.equal(deliveredTarget?.status, "bound");
      assert.equal(deliveredTarget?.binding?.native_thread_id, NATIVE_B);
      assert.equal(deliveredTarget?.lineage.created_by, "attach");
      assert.equal(listConversations(fixture.storeDir).length, 3);
      assert.equal(
        listConversations(fixture.storeDir).filter((turn) =>
          turn.session_id === source.session_id
        ).length,
        1
      );
      assert.equal(
        listConversations(fixture.storeDir).filter((turn) =>
          turn.session_id === target.session_id
        ).length,
        agent === "codex" ? 1 : 2
      );
      if (agent === "codex") {
        assert.equal(sessions.length, 3);
        assert.equal(targetAfter?.status, "detached");
        assert.equal(targetAfter?.binding?.generation, 7);
        assert.equal(
          targetAfter?.binding?.binding_id,
          target.binding?.binding_id
        );
        assert.equal(
          listConversations(fixture.storeDir).filter((turn) =>
            turn.session_id === output.session_id
          ).length,
          1
        );
        assert.equal(fixture.transitionCount(), 0);
        const transfers = listDeferredForegroundTransfers(fixture.storeDir);
        assert.equal(transfers.length, 1);
        assert.equal(transfers[0]?.status, "resolved");
        assert.equal(transfers[0]?.source_session_id, source.session_id);
        assert.equal(transfers[0]?.target_session_id, output.session_id);
      } else {
        assert.equal(sessions.length, 2);
        assert.equal(targetAfter?.status, "bound");
        assert.equal(targetAfter?.binding?.generation, 8);
        assert.notEqual(
          targetAfter?.binding?.binding_id,
          target.binding?.binding_id
        );
        const transition = fixture.onlyTransition();
        assert.equal(transition.source_session_id, source.session_id);
        assert.equal(transition.target_session_id, target.session_id);
        assert.equal(transition.target_expected_revision, target.revision);
        assert.equal(transition.status, "committed");
      }
    } finally {
      fixture.cleanup();
    }
  });
}

test("an explicit stale Session send never follows the terminal into the human-selected thread", async () => {
  const fixture = createHandoffFixture({ agent: "codex" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-explicit-old-codex",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const sourceBefore = JSON.stringify(source);

    const rejected = await fixture.sendToSession(
      source.session_id,
      "This must not be silently redirected to native thread B."
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      /rollout-backed managed Session|strict session_id|selector plus expected_terminal_token/iu
    );
    assert.equal(
      JSON.stringify(listManagedSessions(fixture.storeDir)[0]),
      sourceBefore
    );
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(fixture.transitionCount(), 0);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("a stale advertised terminal token cannot start human handoff adoption", async () => {
  const fixture = createHandoffFixture({ agent: "codex" });
  try {
    fixture.persistSession({
      sessionId: "session-stale-handoff-token",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const before = JSON.stringify(listManagedSessions(fixture.storeDir));

    const rejected = await fixture.sendToTerminal(
      "A stale list action must authorize no mutation.",
      {},
      "stale-terminal-token"
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(rejected.stderr, /terminal.*(?:token|identity).*changed|refresh/iu);
    assert.equal(JSON.stringify(listManagedSessions(fixture.storeDir)), before);
    assert.equal(fixture.transitionCount(), 0);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("a handoff send token rejects an alias or omitted selector before mutation", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-handoff-selector-fence",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const listed = await fixture.listTerminal();
    const expectedTerminalToken = String(
      listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);
    const sourceStatePath = pathsForManagedSession(
      source.session_id,
      fixture.storeDir
    ).statePath;
    const sourceBytes = fs.readFileSync(sourceStatePath);

    for (const selector of [fixture.terminalControl.target, undefined]) {
      const rejected = await fixture.sendToSelector(
        selector,
        "A snapshot token must require its exact full terminal selector.",
        expectedTerminalToken
      );
      assert.equal(rejected.status, 1, fixture.debug(rejected));
      assert.match(
        rejected.stderr,
        /exact terminal selector|expected-terminal-token|full terminal/iu
      );
      assert.deepEqual(fs.readFileSync(sourceStatePath), sourceBytes);
      assert.equal(listManagedSessions(fixture.storeDir).length, 1);
      assert.equal(listConversations(fixture.storeDir).length, 0);
      assert.equal(fixture.transitionCount(), 0);
      assert.deepEqual(fixture.literalInputs(), []);
      assert.equal(fixture.enterCount(), 0);
    }
  } finally {
    fixture.cleanup();
  }
});

for (const drift of ["source revision", "target snapshot"] as const) {
  test(`a listed handoff token rejects ${drift} drift without partial mutation`, async () => {
    const fixture = createHandoffFixture({ agent: "claude" });
    try {
      const source = fixture.persistSession({
        sessionId: `session-token-drift-source-${drift.replace(" ", "-")}`,
        nativeThreadId: NATIVE_A,
        status: "bound",
        generation: 2
      });
      const target = fixture.persistSession({
        sessionId: `session-token-drift-target-${drift.replace(" ", "-")}`,
        nativeThreadId: NATIVE_B,
        status: "detached",
        generation: 5
      });
      const listed = await fixture.listTerminal();
      assert.equal(listed.handoff_state, "external_handoff_adoptable");
      const expectedTerminalToken = String(
        listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
      );
      assert.ok(expectedTerminalToken);

      const selected = drift === "source revision" ? source : target;
      assert.equal(typeof selected.revision, "number");
      saveManagedSession(fixture.storeDir, {
        ...selected,
        updated_at: new Date(
          Date.parse(selected.updated_at) + 1_000
        ).toISOString()
      }, { expectedRevision: selected.revision as number });
      const sessionsBeforeSend = JSON.stringify(
        listManagedSessions(fixture.storeDir)
      );

      const rejected = await fixture.sendToTerminal(
        `Do not cross the drifted ${drift} snapshot.`,
        {},
        expectedTerminalToken
      );
      assert.equal(rejected.status, 1, fixture.debug(rejected));
      assert.match(rejected.stderr, /changed|refresh|revision|snapshot/iu);
      assert.equal(
        JSON.stringify(listManagedSessions(fixture.storeDir)),
        sessionsBeforeSend
      );
      assert.equal(listConversations(fixture.storeDir).length, 0);
      assert.equal(fixture.transitionCount(), 0);
      assert.deepEqual(fixture.literalInputs(), []);
      assert.equal(fixture.enterCount(), 0);
    } finally {
      fixture.cleanup();
    }
  });
}

test("an active source Turn exposes an exact supersede decision before handoff", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-active-human-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const oldTurn = fixture.persistBlockingTurn(source);
    const listed = await fixture.listTerminal();
    assert.equal(listed.handoff_state, "external_handoff_blocked");
    assert.equal(listed.available_actions?.send, undefined);
    assert.equal(
      listed.blocking_turns,
      undefined,
      "an active handoff source must never expose an unfenced generic close"
    );
    assert.match(
      String(listed.handoff_blocked_reason ?? ""),
      /snapshot-bound handoff_decision/u
    );
    const expectedHandoffToken = String(
      listed.handoff_decision?.choices?.take_over_current?.action?.arguments
        ?.expected_handoff_token ?? ""
    );
    assert.ok(expectedHandoffToken);
    assert.deepEqual(listed.handoff_decision, {
      kind: "active_turn_requires_decision",
      source_session_id: source.session_id,
      source_turn_id: oldTurn.conversation_id,
      live_native_thread_id: NATIVE_B,
      choices: {
        take_over_current: {
          action: {
            tool: "agent_knock_knock_close",
            arguments: {
              turn_id: oldTurn.conversation_id,
              reason: "superseded_by_human_context_switch",
              expected_handoff_token: expectedHandoffToken
            },
            requires_explicit_user_confirmation: true
          },
          after: "refresh list and use its follow-current send"
        },
        keep_source: {
          effect: "no Store or terminal mutation",
          after:
            "restore source native thread in the Codex/Claude TUI, then refresh list"
        }
      }
    });
    const closeAction = listed.handoff_decision.choices
      .take_over_current.action;
    assert.deepEqual(
      serializedCloseActionsForTurn(listed, oldTurn.conversation_id),
      [closeAction],
      "the complete serialized terminal row must expose only the token-fenced handoff close"
    );
    assert.equal(
      closeAction.arguments.expected_handoff_token,
      expectedHandoffToken
    );
    const closed = await fixture.closeTurn(
      closeAction.arguments.turn_id,
      closeAction.arguments.reason,
      closeAction.arguments.expected_handoff_token
    );
    assert.equal(closed.status, 0, fixture.debug(closed));
    const oldTurnAfterClose = listConversations(fixture.storeDir).find(
      (turn) => turn.conversation_id === oldTurn.conversation_id
    ) as Record<string, any> | undefined;
    assert.equal(oldTurnAfterClose?.status, "closed");
    assert.equal(
      oldTurnAfterClose?.close_reason,
      "superseded_by_human_context_switch"
    );
    assert.equal(
      oldTurnAfterClose?.disposition,
      "superseded_by_human_context_switch"
    );
    assert.equal(
      fixture.keyDispatches().flat().some((key) =>
        key === "C-c" || key === "Escape"
      ),
      false
    );

    const refreshed = await fixture.listTerminal();
    assert.equal(refreshed.handoff_state, "external_handoff_adoptable");
    const freshToken = String(
      refreshed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(freshToken);
    assert.notEqual(freshToken, expectedHandoffToken);

    const sent = await fixture.sendToTerminal(
      "Continue only after the human explicitly superseded the old Turn.",
      {},
      freshToken
    );
    assert.equal(sent.status, 0, fixture.debug(sent));
    assert.equal(JSON.parse(sent.stdout).delivered, true);
    assert.equal(fixture.transitionCount(), 1);
    assert.deepEqual(fixture.literalInputs(), [
      "Continue only after the human explicitly superseded the old Turn."
    ]);
    assert.equal(fixture.enterCount(), 1);
    assert.equal(
      fixture.keyDispatches().flat().some((key) =>
        key === "C-c" || key === "Escape"
      ),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("a generic close cached before a human thread switch cannot bypass the fresh handoff decision", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-cached-generic-close-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const oldTurn = fixture.persistBlockingTurn(source);
    fixture.setCurrentNativeThreadId(NATIVE_A);

    const beforeSwitch = await fixture.listTerminal();
    assert.equal(beforeSwitch.management_state, "managed");
    assert.equal(beforeSwitch.handoff_decision, undefined);
    const cachedClose = beforeSwitch.managed?.recent_turn
      ?.available_actions?.close;
    assert.equal(cachedClose?.tool, "agent_knock_knock_close");
    assert.equal(
      cachedClose?.arguments?.turn_id,
      oldTurn.conversation_id
    );
    assert.equal(
      cachedClose?.arguments?.expected_handoff_token,
      undefined,
      "the pre-switch generic close must not carry handoff authority"
    );

    fixture.setCurrentNativeThreadId(NATIVE_B);
    const sourcePaths = pathsForManagedSession(
      source.session_id,
      fixture.storeDir
    );
    const turnPaths = pathsForConversation(
      oldTurn.conversation_id,
      fixture.storeDir
    );
    const ledgerDir = path.join(
      fixture.root,
      "runtime",
      "terminal-dispatch"
    );
    const sourceBytes = snapshotDirectoryBytes(sourcePaths.directory);
    const turnBytes = snapshotDirectoryBytes(turnPaths.conversationDir);
    const ledgerBytes = snapshotDirectoryBytes(ledgerDir);

    const rejected = await fixture.closeTurn(
      cachedClose.arguments.turn_id,
      cachedClose.arguments.reason
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      /handoff|human context switch|expected-handoff-token|refresh/iu
    );
    assert.deepEqual(
      snapshotDirectoryBytes(sourcePaths.directory),
      sourceBytes,
      "a stale generic close must not mutate the source Session"
    );
    assert.deepEqual(
      snapshotDirectoryBytes(turnPaths.conversationDir),
      turnBytes,
      "a stale generic close must not mutate the source Turn or event log"
    );
    assert.deepEqual(
      snapshotDirectoryBytes(ledgerDir),
      ledgerBytes,
      "a stale generic close must not create or mutate a dispatch ledger"
    );
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
    assert.equal(fixture.transitionCount(), 0);

    const fresh = await fixture.listTerminal();
    const handoffClose = fresh.handoff_decision?.choices
      ?.take_over_current?.action;
    assert.equal(handoffClose?.tool, "agent_knock_knock_close");
    assert.equal(
      handoffClose?.arguments?.turn_id,
      oldTurn.conversation_id
    );
    assert.ok(handoffClose?.arguments?.expected_handoff_token);
    const closed = await fixture.closeTurn(
      handoffClose.arguments.turn_id,
      handoffClose.arguments.reason,
      handoffClose.arguments.expected_handoff_token
    );
    assert.equal(closed.status, 0, fixture.debug(closed));
    const oldTurnAfter = listConversations(fixture.storeDir).find(
      (turn) => turn.conversation_id === oldTurn.conversation_id
    );
    assert.equal(oldTurnAfter?.status, "closed");
    assert.equal(
      oldTurnAfter?.disposition,
      "superseded_by_human_context_switch"
    );
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("a cached generic close remains available as Store-only recovery after its terminal pane is gone", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-gone-terminal-close-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const turn = fixture.persistBlockingTurn(source);
    fixture.setCurrentNativeThreadId(NATIVE_A);

    const listed = await fixture.listTerminal();
    const cachedClose = listed.managed?.recent_turn
      ?.available_actions?.close;
    assert.equal(cachedClose?.tool, "agent_knock_knock_close");
    assert.equal(cachedClose?.arguments?.turn_id, turn.conversation_id);

    const sourcePaths = pathsForManagedSession(
      source.session_id,
      fixture.storeDir
    );
    const sourceBytes = snapshotDirectoryBytes(sourcePaths.directory);
    fixture.removeTerminalPane();

    const closed = await fixture.closeTurn(
      cachedClose.arguments.turn_id,
      cachedClose.arguments.reason
    );
    assert.equal(closed.status, 0, fixture.debug(closed));
    const turnAfter = listConversations(fixture.storeDir).find(
      (candidate) => candidate.conversation_id === turn.conversation_id
    );
    assert.equal(turnAfter?.status, "closed");
    assert.deepEqual(
      snapshotDirectoryBytes(sourcePaths.directory),
      sourceBytes,
      "Store-only recovery must not mutate the unavailable terminal's Session"
    );
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("a cached generic close does not treat agent process identity drift as terminal unavailability", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-close-process-drift-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const turn = fixture.persistBlockingTurn(source);
    fixture.setCurrentNativeThreadId(NATIVE_A);

    const listed = await fixture.listTerminal();
    const cachedClose = listed.managed?.recent_turn
      ?.available_actions?.close;
    assert.equal(cachedClose?.tool, "agent_knock_knock_close");

    const turnPaths = pathsForConversation(
      turn.conversation_id,
      fixture.storeDir
    );
    const turnBytes = snapshotDirectoryBytes(turnPaths.conversationDir);
    fixture.setAgentProcessIntegrityDrift();

    const rejected = await fixture.closeTurn(
      cachedClose.arguments.turn_id,
      cachedClose.arguments.reason
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(rejected.stderr, /no longer active|identity|process/iu);
    assert.deepEqual(
      snapshotDirectoryBytes(turnPaths.conversationDir),
      turnBytes,
      "process identity drift must reject before Turn or event-log mutation"
    );
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

for (const decisionDrift of [
  "source Turn revision",
  "live thread B to C",
  "live thread B back to A"
] as const) {
  test(`a take-over decision rejects stale ${decisionDrift} evidence without mutation`, async () => {
    const fixture = createHandoffFixture({ agent: "claude" });
    try {
      const source = fixture.persistSession({
        sessionId: `session-decision-${decisionDrift.replaceAll(" ", "-")}`,
        nativeThreadId: NATIVE_A,
        status: "bound",
        generation: 1
      });
      const oldTurn = fixture.persistBlockingTurn(source);
      const listed = await fixture.listTerminal();
      const action = listed.handoff_decision?.choices
        ?.take_over_current?.action;
      assert.equal(action?.tool, "agent_knock_knock_close");
      const expectedHandoffToken = String(
        action?.arguments?.expected_handoff_token ?? ""
      );
      assert.ok(expectedHandoffToken);

      if (decisionDrift === "source Turn revision") {
        const oldTurnState = listConversations(fixture.storeDir).find(
          (turn) => turn.conversation_id === oldTurn.conversation_id
        );
        assert.ok(oldTurnState);
        saveState(
          pathsForConversation(oldTurn.conversation_id, fixture.storeDir)
            .statePath,
          {
            ...oldTurnState,
            updated_at: new Date(
              Date.parse(oldTurnState.updated_at) + 1_000
            ).toISOString()
          }
        );
      } else {
        fixture.setCurrentNativeThreadId(
          decisionDrift === "live thread B to C" ? NATIVE_C : NATIVE_A
        );
      }
      const sessionsBeforeClose = JSON.stringify(
        listManagedSessions(fixture.storeDir)
      );
      const turnsBeforeClose = JSON.stringify(
        listConversations(fixture.storeDir)
      );
      const sourceStatePath = pathsForManagedSession(
        source.session_id,
        fixture.storeDir
      ).statePath;
      const turnStatePath = pathsForConversation(
        oldTurn.conversation_id,
        fixture.storeDir
      ).statePath;
      const sourceBytesBeforeClose = fs.readFileSync(sourceStatePath);
      const turnBytesBeforeClose = fs.readFileSync(turnStatePath);

      const rejected = await fixture.closeTurn(
        action.arguments.turn_id,
        action.arguments.reason,
        expectedHandoffToken
      );
      assert.equal(rejected.status, 1, fixture.debug(rejected));
      assert.match(rejected.stderr, /changed|stale|refresh|handoff/iu);
      assert.equal(
        JSON.stringify(listManagedSessions(fixture.storeDir)),
        sessionsBeforeClose
      );
      assert.equal(
        JSON.stringify(listConversations(fixture.storeDir)),
        turnsBeforeClose
      );
      assert.deepEqual(fs.readFileSync(sourceStatePath), sourceBytesBeforeClose);
      assert.deepEqual(fs.readFileSync(turnStatePath), turnBytesBeforeClose);
      assert.deepEqual(fixture.literalInputs(), []);
      assert.equal(fixture.enterCount(), 0);
      assert.equal(fixture.transitionCount(), 0);
    } finally {
      fixture.cleanup();
    }
  });
}

test("a take-over decision rejects B becoming active elsewhere without touching A", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-decision-target-active-elsewhere",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const oldTurn = fixture.persistBlockingTurn(source);
    const listed = await fixture.listTerminal();
    const action = listed.handoff_decision?.choices
      ?.take_over_current?.action;
    const expectedHandoffToken = String(
      action?.arguments?.expected_handoff_token ?? ""
    );
    assert.ok(expectedHandoffToken);

    fixture.addActiveOwnerForCurrentThread();
    const sourceStatePath = pathsForManagedSession(
      source.session_id,
      fixture.storeDir
    ).statePath;
    const turnStatePath = pathsForConversation(
      oldTurn.conversation_id,
      fixture.storeDir
    ).statePath;
    const sourceBytes = fs.readFileSync(sourceStatePath);
    const turnBytes = fs.readFileSync(turnStatePath);

    const rejected = await fixture.closeTurn(
      action.arguments.turn_id,
      action.arguments.reason,
      expectedHandoffToken
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(rejected.stderr, /active in another|already active|ownership/iu);
    assert.deepEqual(fs.readFileSync(sourceStatePath), sourceBytes);
    assert.deepEqual(fs.readFileSync(turnStatePath), turnBytes);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
    assert.equal(fixture.transitionCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

for (const callbackStatus of [
  "callback_pending",
  "callback_failed"
] as const) {
  test(`a ${callbackStatus} Turn with an exact resolved ledger can be superseded without input`, async () => {
    const fixture = createHandoffFixture({ agent: "claude" });
    try {
      const source = fixture.persistSession({
        sessionId: `session-handoff-${callbackStatus}`,
        nativeThreadId: NATIVE_A,
        status: "bound",
        generation: 1
      });
      const oldTurn = fixture.persistCallbackTurnWithResolvedLedger(
        source,
        callbackStatus
      );
      const rawBefore = JSON.parse(fs.readFileSync(
        pathsForConversation(oldTurn.conversation_id, fixture.storeDir)
          .statePath,
        "utf8"
      ));
      assert.equal(rawBefore.status, callbackStatus);

      const listed = await fixture.listTerminal();
      const action = listed.handoff_decision?.choices
        ?.take_over_current?.action;
      const expectedHandoffToken = String(
        action?.arguments?.expected_handoff_token ?? ""
      );
      assert.ok(expectedHandoffToken, JSON.stringify(listed, null, 2));
      const closed = await fixture.closeTurn(
        action.arguments.turn_id,
        action.arguments.reason,
        expectedHandoffToken
      );
      assert.equal(closed.status, 0, fixture.debug(closed));
      const output = JSON.parse(closed.stdout);
      assert.equal(output.closed, true);
      assert.equal(output.terminal_dispatch_resolved, true);
      const oldTurnAfter = listConversations(fixture.storeDir).find((turn) =>
        turn.conversation_id === oldTurn.conversation_id
      ) as Record<string, any> | undefined;
      assert.equal(oldTurnAfter?.status, "closed");
      assert.equal(
        oldTurnAfter?.disposition,
        "superseded_by_human_context_switch"
      );
      assert.equal(
        oldTurnAfter?.close_reason,
        "superseded_by_human_context_switch"
      );
      assert.deepEqual(fixture.literalInputs(), []);
      assert.equal(fixture.enterCount(), 0);
      assert.equal(fixture.transitionCount(), 0);
    } finally {
      fixture.cleanup();
    }
  });
}

test("a target native thread already bound in Store remains a blocked handoff", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  try {
    const source = fixture.persistSession({
      sessionId: "session-target-bound-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    fixture.persistSession({
      sessionId: "session-target-already-bound",
      nativeThreadId: NATIVE_B,
      status: "bound",
      generation: 3
    });
    const sourceTurn = fixture.persistBlockingTurn(source);
    const before = JSON.stringify(listManagedSessions(fixture.storeDir));

    const listed = await fixture.listTerminal();
    assert.equal(listed.handoff_state, "external_handoff_blocked");
    assert.equal(listed.available_actions?.send, undefined);
    assert.equal(listed.handoff_decision, undefined);
    assert.equal(
      listed.blocking_turns,
      undefined,
      "an ineligible target must not make the active source generically closable"
    );
    assert.deepEqual(
      serializedCloseActionsForTurn(listed, sourceTurn.conversation_id),
      [],
      "the complete serialized terminal row must not expose a close for an ineligible handoff source"
    );
    const rejected = await fixture.sendToTerminal(
      "Never adopt a target with a competing bound claim."
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      new RegExp(
        `still has unresolved Turn ${sourceTurn.conversation_id} \\(waiting_for_agent\\)`,
        "u"
      )
    );
    assert.equal(JSON.stringify(listManagedSessions(fixture.storeDir)), before);
    assert.deepEqual(
      listConversations(fixture.storeDir).map((turn) => turn.conversation_id),
      [sourceTurn.conversation_id]
    );
    assert.equal(fixture.transitionCount(), 0);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);
  } finally {
    fixture.cleanup();
  }
});

test("ambiguous source claims block automatic handoff before terminal input", async () => {
  const fixture = createHandoffFixture({ agent: "codex" });
  try {
    const sourceA = fixture.persistSession({
      sessionId: "session-ambiguous-human-a",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    fixture.persistSession({
      sessionId: "session-ambiguous-human-c",
      nativeThreadId: NATIVE_C,
      status: "bound",
      generation: 1
    });
    const sourceTurn = fixture.persistBlockingTurn(sourceA);
    const before = JSON.stringify(listManagedSessions(fixture.storeDir));
    const listed = await fixture.listTerminal();
    assert.equal(listed.handoff_state, "external_handoff_blocked");
    assert.equal(listed.available_actions?.send, undefined);
    assert.equal(listed.handoff_decision, undefined);
    assert.equal(
      listed.blocking_turns,
      undefined,
      "ambiguous handoff sources must not leak a generic close action"
    );
    assert.deepEqual(
      serializedCloseActionsForTurn(listed, sourceTurn.conversation_id),
      [],
      "the complete serialized terminal row must not expose a close for an ambiguous handoff source"
    );

    const rejected = await fixture.sendToTerminal(
      "Never guess which source claim should be detached."
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      new RegExp(
        `still has unresolved Turn ${sourceTurn.conversation_id} \\(waiting_for_agent\\)`,
        "u"
      )
    );
    assert.equal(JSON.stringify(listManagedSessions(fixture.storeDir)), before);
    assert.equal(fixture.transitionCount(), 0);
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("a human-selected native thread active in another process blocks adoption atomically", async () => {
  const fixture = createHandoffFixture({ agent: "codex" });
  try {
    fixture.persistSession({
      sessionId: "session-active-elsewhere-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });
    const listedBeforeOwner = await fixture.listTerminal();
    const expectedTerminalToken = String(
      listedBeforeOwner.available_actions?.send?.arguments
        ?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);
    fixture.addActiveOwnerForCurrentThread();
    const before = JSON.stringify(listManagedSessions(fixture.storeDir));

    const rejected = await fixture.sendToTerminal(
      "Do not steal B from its other live process.",
      {},
      expectedTerminalToken
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      /active in another codex process|already active|expected terminal token no longer authorizes|refresh AKK list/iu
    );
    assert.equal(JSON.stringify(listManagedSessions(fixture.storeDir)), before);
    assert.equal(fixture.transitionCount(), 0);
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("the bridge recaptures an exact draft after beforeEnter returns", async () => {
  const target = "bridge-draft-race:0.0";
  const request = "Keep this exact draft until Enter.";
  const provider = new MutableRecordingTerminalProvider({
    panes: [{
      kind: "tmux",
      target,
      session: "bridge-draft-race",
      window: 0,
      pane: 0,
      panePid: 84_000,
      currentCommand: "claude",
      currentPath: "/repo"
    }],
    screens: { [target]: claudeComposerScreen() },
    hooks: {
      sendText(operation, mutable) {
        mutable.setScreen(target, claudeComposerScreen(operation.text));
      }
    }
  });
  const [endpoint] = await provider.listTerminals();
  assert.ok(endpoint);
  const terminalControl = provider.toControlRef(endpoint, [
    "screen_status",
    "send_keys"
  ]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([
      createClaudeTerminalAgentAdapter()
    ]),
    terminalProvider: provider
  });

  await assert.rejects(
    bridge.send("claude", terminalControl, request, {
      requireExactComposerBeforeEnter: true,
      beforeEnter() {
        provider.setScreen(
          target,
          claudeComposerScreen("A human replaced the draft during authorization.")
        );
      }
    }),
    /composer was not exact|immediately before Enter/iu
  );
  assert.deepEqual(provider.literalInputs(), [request]);
  assert.equal(
    provider.keyDispatches().filter((keys) => keys.includes("C-m")).length,
    0
  );
});

test("Codex drift from B to C at the post-adoption pre-text fence starts no task input", async () => {
  const fixture = createHandoffFixture({
    agent: "codex",
    codexTargetMode: "status_card_only",
    codexTaskDrift: "before_task_text"
  });
  const request = "This task must never cross the B to C handoff race.";
  try {
    fixture.persistSession({
      sessionId: "session-codex-pre-text-drift-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });

    const listed = await fixture.listTerminal();
    const expectedTerminalToken = String(
      listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);
    const rejected = await fixture.sendToTerminal(
      request,
      {},
      expectedTerminalToken
    );
    assert.equal(rejected.status, 1, fixture.debug(rejected));
    assert.match(
      rejected.stderr,
      /thread changed|identity changed|expected terminal token no longer authorizes|refresh (?:AKK )?list/iu
    );
    assert.equal(fixture.driftTriggered(), true);
    assert.equal(
      fixture.literalInputs().filter((input) => input === request).length,
      0
    );
    assert.equal(fixture.enterCount(), 0);
    assert.equal(fixture.postDriftEnterCount(), 0);
    assert.equal(
      fixture.literalInputs().some((input) =>
        input === "/clear" || input.startsWith("/resume")
      ),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("Codex drift from B to C after task text never presses Enter and stays uncertain", async () => {
  const fixture = createHandoffFixture({
    agent: "codex",
    codexTargetMode: "status_card_only",
    codexTaskDrift: "after_task_text"
  });
  const request = "Leave this exact draft unsubmitted after B changes to C.";
  try {
    fixture.persistSession({
      sessionId: "session-codex-post-text-drift-source",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });

    const listed = await fixture.listTerminal();
    const expectedTerminalToken = String(
      listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
    );
    assert.ok(expectedTerminalToken);
    const uncertain = await fixture.sendToTerminal(
      request,
      {},
      expectedTerminalToken
    );
    assert.equal(uncertain.status, 0, fixture.debug(uncertain));
    const output = JSON.parse(uncertain.stdout);
    assert.equal(output.delivered, false);
    assert.equal(output.status, "submission_uncertain");
    assert.equal(output.do_not_retry, true);
    assert.equal(fixture.driftTriggered(), true);
    assert.equal(
      fixture.literalInputs().filter((input) => input === request).length,
      1
    );
    assert.equal(fixture.enterCount(), 0);
    assert.equal(fixture.postDriftEnterCount(), 0);
    assert.match(output.reason, /text|Enter|inspect|retry/iu);
  } finally {
    fixture.cleanup();
  }
});

for (const crashHook of [
  "AKK_TEST_EXIT_AFTER_DEFERRED_SOURCE_RESERVED",
  "AKK_TEST_EXIT_AFTER_DEFERRED_TARGET_PREPARED"
] as const) {
  test(`Codex follow-current recovers ${crashHook} without replaying task input`, async () => {
    const fixture = createHandoffFixture({
      agent: "codex",
      codexInitialNativeThreadId: NATIVE_A
    });
    const request = `Recover exactly once after ${crashHook}.`;
    const messageId = `message-${crashHook.toLowerCase()}`;
    try {
      fixture.persistSession({
        sessionId: `session-crash-${crashHook.toLowerCase()}`,
        nativeThreadId: NATIVE_A,
        status: "bound",
        generation: 1
      });

      const listed = await fixture.listTerminal();
      const expectedTerminalToken = String(
        listed.available_actions?.send?.arguments?.expected_terminal_token ?? ""
      );
      assert.ok(expectedTerminalToken);
      const crashed = await fixture.sendToTerminal(request, {
        [crashHook]: "1"
      }, expectedTerminalToken, messageId);
      assert.equal(
        crashed.status,
        86,
        fixture.debug(crashed)
      );
      assert.deepEqual(fixture.literalInputs(), []);
      assert.equal(fixture.enterCount(), 0);
      assert.equal(listConversations(fixture.storeDir).length, 0);
      assert.equal(fixture.transitionCount(), 0);
      assert.equal(listDeferredForegroundTransfers(fixture.storeDir).length, 1);

      const staleRecovery = await fixture.sendToTerminal(
        request,
        {},
        expectedTerminalToken,
        messageId
      );
      assert.equal(staleRecovery.status, 1, fixture.debug(staleRecovery));
      assert.match(
        staleRecovery.stderr,
        /fresh exact terminal token|expected terminal token no longer authorizes|refresh AKK list/iu
      );
      assert.deepEqual(fixture.literalInputs(), []);
      const refreshed = await fixture.listTerminal();
      const refreshedTerminalToken = String(
        refreshed.available_actions?.send?.arguments?.expected_terminal_token ??
          ""
      );
      assert.ok(refreshedTerminalToken);
      const recovered = await fixture.sendToTerminal(
        request,
        {},
        refreshedTerminalToken,
        messageId
      );
      assert.equal(recovered.status, 0, fixture.debug(recovered));
      const recoveredOutput = JSON.parse(recovered.stdout);
      assert.equal(recoveredOutput.delivered, true, fixture.debug(recovered));
      assert.equal(
        listDeferredForegroundTransfers(fixture.storeDir).some((transfer) =>
          transfer.status === "resolved" &&
          transfer.target_session_id === recoveredOutput.session_id
        ),
        true
      );
      assert.equal(
        fixture.literalInputs().filter((input) => input === request).length,
        1
      );
      assert.equal(
        fixture.literalInputs().some((input) =>
          input === "/clear" || input.startsWith("/resume")
        ),
        false
      );
      assert.equal(
        listManagedSessions(fixture.storeDir).filter((entry) =>
          entry.status === "bound" &&
          entry.binding?.native_thread_id === NATIVE_A
        ).length,
        1
      );

      const taskInputsBeforeReplay = fixture.literalInputs().filter(
        (input) => input === request
      ).length;
      const entersBeforeReplay = fixture.enterCount();
      const transfersBeforeReplay = listDeferredForegroundTransfers(
        fixture.storeDir
      ).length;
      const replayed = await fixture.sendToTerminal(
        request,
        {},
        undefined,
        messageId
      );
      assert.equal(replayed.status, 0, fixture.debug(replayed));
      assert.equal(
        fixture.literalInputs().filter((input) => input === request).length,
        taskInputsBeforeReplay
      );
      assert.equal(fixture.enterCount(), entersBeforeReplay);
      assert.equal(fixture.transitionCount(), 0);
      assert.equal(
        listDeferredForegroundTransfers(fixture.storeDir).length,
        transfersBeforeReplay
      );
    } finally {
      fixture.cleanup();
    }
  });
}

test("handoff recovers a transition-persisted pre-ledger crash without replay", async () => {
  const fixture = createHandoffFixture({ agent: "claude" });
  const request = "Recover the pre-ledger human handoff exactly once.";
  const messageId = "message-handoff-transition-before-ledger";
  try {
    fixture.persistSession({
      sessionId: "session-handoff-transition-before-ledger",
      nativeThreadId: NATIVE_A,
      status: "bound",
      generation: 1
    });

    const crashed = await fixture.sendToTerminal(request, {
      AKK_TEST_EXIT_AFTER_HANDOFF_TRANSITION_BEFORE_LEDGER: "1"
    }, undefined, messageId);
    assert.equal(crashed.status, 88, fixture.debug(crashed));
    assert.equal(fixture.transitionCount(), 1);
    assert.equal(fixture.onlyTransition().status, "prepared");
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.enterCount(), 0);

    const recovered = await fixture.sendToTerminal(
      request,
      {},
      undefined,
      messageId
    );
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(JSON.parse(recovered.stdout).delivered, true);
    assert.equal(fixture.onlyTransition().status, "committed");
    assert.equal(
      fixture.literalInputs().filter((input) => input === request).length,
      1
    );
    assert.equal(fixture.enterCount(), 1);

    const inputsBeforeReplay = fixture.literalInputs().length;
    const entersBeforeReplay = fixture.enterCount();
    const replayed = await fixture.sendToTerminal(
      request,
      {},
      undefined,
      messageId
    );
    assert.equal(replayed.status, 0, fixture.debug(replayed));
    assert.equal(fixture.literalInputs().length, inputsBeforeReplay);
    assert.equal(fixture.enterCount(), entersBeforeReplay);
    assert.equal(fixture.transitionCount(), 1);
  } finally {
    fixture.cleanup();
  }
});

type FixtureAgent = "codex" | "claude";

interface PersistSessionOptions {
  sessionId: string;
  nativeThreadId: string;
  status: "bound" | "detached";
  generation: number;
}

interface HandoffFixture {
  root: string;
  storeDir: string;
  terminalId: string;
  terminalControl: TerminalControlRef;
  persistSession(options: PersistSessionOptions): ManagedSessionState;
  listTerminal(): Promise<Record<string, any>>;
  sendToTerminal(
    message: string,
    env?: NodeJS.ProcessEnv,
    expectedTerminalToken?: string,
    messageId?: string
  ): Promise<InProcessCliResult>;
  sendToSelector(
    selector: string | undefined,
    message: string,
    expectedTerminalToken: string
  ): Promise<InProcessCliResult>;
  sendToSession(
    sessionId: string,
    message: string,
    env?: NodeJS.ProcessEnv
  ): Promise<InProcessCliResult>;
  closeTurn(
    turnId: string,
    reason: string | undefined,
    expectedHandoffToken?: string
  ): Promise<InProcessCliResult>;
  persistBlockingTurn(session: ManagedSessionState): ReturnType<
    typeof createConversation
  >;
  persistCallbackTurnWithResolvedLedger(
    session: ManagedSessionState,
    status: "callback_pending" | "callback_failed"
  ): ReturnType<typeof createConversation>;
  persistHistoricalTurn(session: ManagedSessionState, request: string): void;
  addActiveOwnerForCurrentThread(): void;
  setCurrentNativeThreadId(nativeThreadId: string): void;
  removeTerminalPane(): void;
  setAgentProcessIntegrityDrift(): void;
  literalInputs(): string[];
  keyDispatches(): string[][];
  enterCount(): number;
  driftTriggered(): boolean;
  postDriftEnterCount(): number;
  transitionCount(): number;
  onlyTransition(): ReturnType<typeof loadNativeThreadTransition>;
  debug(result: InProcessCliResult): string;
  cleanup(): void;
}

function committedTransitionExists(storeDir: string): boolean {
  const rootDir = nativeThreadTransitionsDir(storeDir);
  if (!fs.existsSync(rootDir)) {
    return false;
  }
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .some((entry) =>
      loadNativeThreadTransition(storeDir, entry.name).status === "committed"
    );
}

function foregroundHandoffReservationExists(storeDir: string): boolean {
  return committedTransitionExists(storeDir) ||
    listDeferredForegroundTransfers(storeDir).some((transfer) =>
      transfer.status !== "prepared"
    );
}

function serializedCloseActionsForTurn(
  terminalRow: Record<string, any>,
  turnId: string
): Array<Record<string, any>> {
  const matches: Array<Record<string, any>> = [];
  const serializedRow: unknown = JSON.parse(JSON.stringify(terminalRow));

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    const record = value as Record<string, any>;
    if (
      record.tool === "agent_knock_knock_close" &&
      record.arguments?.turn_id === turnId
    ) {
      matches.push(record);
    }
    for (const nested of Object.values(record)) {
      visit(nested);
    }
  };

  visit(serializedRow);
  return matches;
}

function snapshotDirectoryBytes(rootDir: string): Array<[string, string]> {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const snapshot: Array<[string, string]> = [];
  const visit = (directory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        snapshot.push([
          path.relative(rootDir, absolutePath),
          fs.readFileSync(absolutePath).toString("base64")
        ]);
      }
    }
  };
  visit(rootDir);
  return snapshot;
}

function createHandoffFixture({
  agent,
  codexTargetMode = "exact_rollout",
  codexTaskDrift,
  codexInitialNativeThreadId
}: {
  agent: FixtureAgent;
  codexTargetMode?: "exact_rollout" | "status_card_only";
  codexTaskDrift?: "before_task_text" | "after_task_text";
  codexInitialNativeThreadId?: string;
}): HandoffFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `akk-human-${agent}-`));
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, ".codex");
  const claudeHome = path.join(root, ".claude");
  const target = `human-${agent}:0.0`;
  const panePid = agent === "codex" ? 81_000 : 82_000;
  const agentPid = panePid + 1;
  const processBirth = "Mon Aug 10 12:00:00 2026";
  const claudeStartedAt = 1_786_339_200_000;
  const version = agent === "codex" ? "0.147.0" : "2.1.226";
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(claudeHome, { recursive: true });
  const rolloutPaths = new Map<string, string>();
  for (const nativeThreadId of [NATIVE_A, NATIVE_B, NATIVE_C]) {
    const rolloutPath = path.join(
      codexHome,
      `rollout-2026-08-10T12-00-00-${nativeThreadId}.jsonl`
    );
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-10T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: version
      }
    })}\n`, { mode: 0o600 });
    rolloutPaths.set(nativeThreadId, rolloutPath);
  }
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: `human-${agent}`,
    window: 0,
    pane: 0,
    panePid,
    currentCommand: agent,
    currentPath: workspace,
    capabilities: [
      "screen_status",
      "send_keys",
      "terminal_approval",
      "screen_completion",
      "durable_completion",
      "terminal_cancel"
    ]
  };
  createTerminalEndpointRef({
    ...terminalEndpointFromControlRef(terminalControl),
    providerRef: terminalControl
  });
  const terminalId =
    `terminal:v2:tmux:${agent}:${target}:${agentPid}`;
  const prompt = agent === "codex" ? "Ready\n› " : claudeComposerScreen();
  let resolverNativeThreadId = codexInitialNativeThreadId ?? (
    agent === "codex" && codexTargetMode === "status_card_only"
      ? NATIVE_A
      : NATIVE_B
  );
  let openRootNativeThreadId = codexInitialNativeThreadId ?? NATIVE_B;
  let pendingText = "";
  let statusProbeCount = 0;
  let driftTriggered = false;
  let operationIndexAtDrift: number | undefined;
  const codexStatusScreen = (nativeThreadId: string, marker: string) =>
    `/status\n╭────────────────────────────────────────────╮\n` +
    `│ OpenAI Codex (v${version})                 │\n` +
    `│ Session: ${nativeThreadId} │\n` +
    `│ Probe: ${marker}                              │\n` +
    "╰────────────────────────────────────────────╯\n› ";
  const initialScreen = agent === "codex" &&
      codexTargetMode === "status_card_only"
    ? codexStatusScreen(NATIVE_B, "initial")
    : prompt;
  const panes = [{
      kind: "tmux",
      target,
      session: `human-${agent}`,
      window: 0,
      pane: 0,
      panePid,
      currentCommand: agent,
      currentPath: workspace,
      columns: 100,
      rows: 30
    }] as const;
  const mutablePanes = panes.map((pane) => ({ ...pane }));
  const provider = new MutableRecordingTerminalProvider({
    panes: mutablePanes,
    screens: { [target]: initialScreen },
    hooks: {
      capture(_operation, mutable) {
        if (
          codexTaskDrift === "before_task_text" &&
          !driftTriggered &&
          foregroundHandoffReservationExists(storeDir)
        ) {
          driftTriggered = true;
          resolverNativeThreadId = NATIVE_C;
          openRootNativeThreadId = NATIVE_C;
          mutable.setScreen(
            target,
            codexStatusScreen(NATIVE_C, "drift-before-task-text")
          );
          operationIndexAtDrift = mutable.operations.length;
        }
        return undefined;
      },
      sendText(operation, mutable) {
        pendingText = operation.text;
        mutable.setScreen(
          target,
          agent === "codex"
            ? `${prompt}${operation.text}`
            : claudeComposerScreen(operation.text)
        );
        if (
          codexTaskDrift === "after_task_text" &&
          !driftTriggered &&
          !operation.text.startsWith("/")
        ) {
          driftTriggered = true;
          resolverNativeThreadId = NATIVE_C;
          openRootNativeThreadId = NATIVE_C;
          mutable.setScreen(
            target,
            codexStatusScreen(NATIVE_C, "drift-after-task-text")
          );
          operationIndexAtDrift = mutable.operations.length;
        }
      },
      sendKeys(operation, mutable) {
        if (operation.keys.includes("C-m")) {
          const submittedText = pendingText;
          if (
            agent === "codex" &&
            codexTargetMode === "status_card_only" &&
            !submittedText.startsWith("/")
          ) {
            resolverNativeThreadId = NATIVE_B;
          }
          pendingText = "";
          mutable.setScreen(
            target,
            agent === "codex" && submittedText === "/status"
              ? codexStatusScreen(NATIVE_B, String(++statusProbeCount))
              : "Working\n"
          );
        }
      }
    }
  });
  const executable = agent === "codex"
    ? `/opt/akk-test/releases/${version}/bin/codex`
    : `/Users/test/.local/share/claude/versions/${version}`;
  const processSource = new MutableTerminalProcessSource([
    {
      pid: panePid,
      ppid: 1,
      elapsed: "00:10",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: agentPid,
      ppid: panePid,
      elapsed: "00:09",
      command: executable,
      cwd: workspace
    }
  ]);
  const baseProcessSnapshots = [
    {
      pid: panePid,
      ppid: 1,
      elapsed: "00:10",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: agentPid,
      ppid: panePid,
      elapsed: "00:09",
      command: executable,
      cwd: workspace
    }
  ];
  processSource.setSnapshots(baseProcessSnapshots);
  let additionalOwnerPid: number | undefined;
  const codexIdentity = (nativeThreadId: string, pid = agentPid) => {
    const rolloutPath = rolloutPaths.get(nativeThreadId);
    assert.ok(rolloutPath);
    const stat = fs.statSync(rolloutPath);
    return {
      sessionId: nativeThreadId,
      processUuid: `codex-pid:${pid}:birth:${processBirth}`,
      processBirth,
      rollout: {
        fd: "12u",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(rolloutPath)
      },
      evidence: "codex_rollout_fd"
    };
  };
  const codexOpenRootInventory = (
    pid: number,
    cwd = workspace
  ): CodexOpenRootRolloutInventory => {
    const identity = codexIdentity(openRootNativeThreadId, pid);
    const rootIdentity = {
      ...identity,
      evidence: "codex_open_root_rollout" as const
    };
    const authority = {
      schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
      version: 1 as const,
      pid,
      processUuid: identity.processUuid,
      processBirth: identity.processBirth,
      cwd,
      roots: [rootIdentity] as [typeof rootIdentity]
    };
    return {
      ...authority,
      status: "resolved",
      inventoryFingerprint: createHash("sha256")
        .update(JSON.stringify(authority))
        .digest("hex")
    };
  };
  const codexAdapter: CodexLocalSessionAdapter = {
    async listThreadRows() {
      return [];
    },
    async readRollout(rolloutPath) {
      return fs.existsSync(rolloutPath)
        ? fs.readFileSync(rolloutPath, "utf8")
        : undefined;
    },
    async listProcessSnapshots() {
      return processSource.listProcessSnapshots();
    },
    async inspectOpenRootRolloutInventoryForPid(pid, cwd) {
      assert.ok(pid === agentPid || pid === additionalOwnerPid);
      return codexOpenRootInventory(pid, cwd);
    },
    async resolveActiveSessionIdentityForPid(pid) {
      return pid === agentPid || pid === additionalOwnerPid
        ? codexIdentity(resolverNativeThreadId, pid)
        : undefined;
    }
  };
  const clock = new VirtualClock("2026-08-10T12:00:00.000Z");
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AKK_RUNTIME_DIR: runtimeDir,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
    AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted",
    TMUX: ""
  };
  const dependencies = (env: NodeJS.ProcessEnv) => terminalCliDependencies({
    terminalProvider: provider,
    processSource,
    clock,
    env,
    overrides: {
      codexLocalSessionAdapter: codexAdapter,
      loadClaudeAgentRows: () => agent === "claude" ? [
        {
          pid: agentPid,
          cwd: workspace,
          kind: "interactive",
          sessionId: resolverNativeThreadId,
          startedAt: claudeStartedAt,
          status: "idle"
        },
        ...(additionalOwnerPid
          ? [{
              pid: additionalOwnerPid,
              cwd: workspace,
              kind: "interactive" as const,
              sessionId: resolverNativeThreadId,
              startedAt: claudeStartedAt + 1_000,
              status: "idle"
            }]
          : [])
      ] : [],
      agentVersionForRunningProcess: () => version,
      codexProcessBirthForPid: () => processBirth,
      // Imported executions share this Node process, but crash recovery must
      // observe the previous command owner as dead just as a real CLI restart
      // would. Keep the synthetic dispatcher outside the platform PID range
      // used by these terminal fixtures.
      pid: agentPid + 500_000
    }
  });
  const storeArgs = [
    "--store-dir",
    storeDir,
    ...(agent === "codex"
      ? ["--codex-home", codexHome]
      : ["--claude-home", claudeHome])
  ];
  const commonArgs = [
    ...storeArgs,
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
  const persistTurn = (
    session: ManagedSessionState,
    status: "idle" | "waiting_for_agent",
    request: string
  ): ReturnType<typeof createConversation> => {
    const now = clock.now();
    const conversation = createConversation({
      userRequest: request,
      sessionId: session.session_id,
      executorKind: agent,
      executorSession: `human-${agent}-${status}`,
      workspace,
      now
    });
    const paths = pathsForConversation(
      conversation.conversation_id,
      storeDir
    );
    saveState(paths.statePath, {
      ...conversation,
      status,
      ...(status === "idle" ? { idle_since: now.toISOString() } : {}),
      terminal_binding_id: session.binding?.binding_id,
      terminal_binding_generation: session.binding?.generation,
      native_thread_id: session.binding?.native_thread_id,
      native_session_takeover: {
        agent,
        terminal_agent_identity_protocol: 1,
        native_session_id: terminalId,
        terminal_agent_pid: agentPid,
        terminal_agent_session_id: session.binding?.native_thread_id,
        terminal_agent_process_uuid:
          session.binding?.native_process.process_uuid,
        terminal_agent_process_birth:
          session.binding?.native_process.process_birth,
        terminal_agent_rollout: session.binding?.native_process.rollout,
        terminal_agent_identity_evidence:
          session.binding?.native_process.evidence,
        source_cwd: workspace,
        strategy: "terminal_control",
        terminal_control: terminalControl,
        terminal_bridge: true
      },
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath,
      updated_at: now.toISOString()
    });
    return conversation;
  };
  ensureStoreWritable(storeDir);
  return {
    root,
    storeDir,
    terminalId,
    terminalControl,
    persistSession(options) {
      const now = clock.now();
      const identity = agent === "codex"
        ? codexIdentity(options.nativeThreadId)
        : {
            sessionId: options.nativeThreadId,
            processUuid:
              `claude-pid:${agentPid}:started:${claudeStartedAt}`,
            evidence: "claude_agents_exact_pid"
          };
      return saveManagedSession(storeDir, {
        schema: "agent-knock-knock/session",
        version: 1,
        session_id: options.sessionId,
        agent,
        workspace,
        status: options.status,
        binding: terminalBindingFrom({
          terminalId,
          terminalControl,
          pid: agentPid,
          nativeThreadId: options.nativeThreadId,
          processUuid: identity.processUuid,
          processBirth: "processBirth" in identity
            ? identity.processBirth
            : undefined,
          rollout: "rollout" in identity ? identity.rollout : undefined,
          evidence: identity.evidence,
          generation: options.generation,
          now
        }),
        lineage: { created_by: "attach" },
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        ...(options.status === "detached"
          ? { detached_at: now.toISOString() }
          : {})
      }, { expectedRevision: null });
    },
    async listTerminal() {
      const result = await runInProcessCli(
        ["list", ...storeArgs],
        dependencies(baseEnv)
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const parsed = JSON.parse(result.stdout);
      const terminal = parsed.terminals?.find(
        (entry: Record<string, unknown>) => entry.id === terminalId
      );
      assert.ok(terminal, result.stdout);
      return terminal;
    },
    sendToTerminal(message, env = {}, expectedTerminalToken, messageId) {
      const selectedEnv = { ...baseEnv, ...env };
      return runInProcessCli([
        "send",
        "--conversation",
        terminalId,
        "--message",
        message,
        ...(messageId ? ["--message-id", messageId] : []),
        "--background",
        ...(expectedTerminalToken
          ? ["--expected-terminal-token", expectedTerminalToken]
          : []),
        ...commonArgs
      ], dependencies(selectedEnv));
    },
    sendToSelector(selector, message, expectedTerminalToken) {
      return runInProcessCli([
        "send",
        ...(selector ? ["--conversation", selector] : []),
        "--message",
        message,
        "--expected-terminal-token",
        expectedTerminalToken,
        "--background",
        ...commonArgs
      ], dependencies(baseEnv));
    },
    sendToSession(sessionId, message, env = {}) {
      const selectedEnv = { ...baseEnv, ...env };
      return runInProcessCli([
        "send",
        "--session",
        sessionId,
        "--message",
        message,
        "--background",
        ...commonArgs
      ], dependencies(selectedEnv));
    },
    closeTurn(turnId, reason, expectedHandoffToken) {
      return runInProcessCli([
        "close",
        "--turn",
        turnId,
        ...(reason ? ["--reason", reason] : []),
        ...(expectedHandoffToken
          ? ["--expected-handoff-token", expectedHandoffToken]
          : []),
        ...storeArgs
      ], dependencies(baseEnv));
    },
    persistBlockingTurn(session) {
      return persistTurn(
        session,
        "waiting_for_agent",
        "This source Turn remains unresolved."
      );
    },
    persistCallbackTurnWithResolvedLedger(session, status) {
      const conversation = persistTurn(
        session,
        "waiting_for_agent",
        `Legacy ${status} Turn awaiting callback settlement.`
      );
      const statePath = pathsForConversation(
        conversation.conversation_id,
        storeDir
      ).statePath;
      const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const messageId = `message-${status}-${conversation.conversation_id}`;
      saveState(statePath, {
        ...current,
        status,
        callback_delivery: {
          status: status === "callback_pending" ? "pending" : "failed",
          message: {
            id: `callback-${messageId}`,
            type: "question"
          },
          final_status: "waiting_for_agent",
          created_at: clock.now().toISOString()
        },
        native_session_takeover: {
          ...current.native_session_takeover,
          terminal_bridge_message_id: messageId
        },
        updated_at: clock.now().toISOString()
      });
      const terminalKey = createHash("sha256")
        .update(JSON.stringify(terminalLegacyRuntimeRoute(terminalControl)))
        .digest("hex")
        .slice(0, 20);
      const ledgerDir = path.join(runtimeDir, "terminal-dispatch");
      fs.mkdirSync(ledgerDir, { recursive: true });
      fs.writeFileSync(
        path.join(
          ledgerDir,
          `terminal-dispatch-${terminalKey}.json`
        ),
        `${JSON.stringify({
          version: 1,
          terminal_key: terminalKey,
          terminal_control: {
            kind: terminalControl.kind,
            target: terminalControl.target,
            socket_path: terminalControl.socketPath ?? null,
            pane_pid: terminalControl.panePid,
            current_path: terminalControl.currentPath ?? null
          },
          status: "resolved",
          generation_id: messageId,
          conversation_id: conversation.conversation_id,
          session_id: session.session_id,
          turn_id: conversation.turn_id,
          message_id: messageId,
          native_thread_id: session.binding?.native_thread_id,
          binding_id: session.binding?.binding_id,
          binding_generation: session.binding?.generation,
          resolved_at: clock.now().toISOString(),
          reason: "callback transport already settled"
        })}\n`,
        { mode: 0o600 }
      );
      return conversation;
    },
    persistHistoricalTurn(session, request) {
      persistTurn(session, "idle", request);
    },
    addActiveOwnerForCurrentThread() {
      additionalOwnerPid = agentPid + 100;
      processSource.setSnapshots([
        ...baseProcessSnapshots,
        {
          pid: additionalOwnerPid,
          ppid: 1,
          elapsed: "00:05",
          command: executable,
          cwd: workspace
        }
      ]);
    },
    setCurrentNativeThreadId(nativeThreadId) {
      resolverNativeThreadId = nativeThreadId;
      openRootNativeThreadId = nativeThreadId;
      provider.setScreen(
        target,
        agent === "codex"
          ? codexStatusScreen(nativeThreadId, "manual-test-drift")
          : claudeComposerScreen()
      );
    },
    removeTerminalPane() {
      mutablePanes.length = 0;
    },
    setAgentProcessIntegrityDrift() {
      processSource.setSnapshots(baseProcessSnapshots.map((snapshot) =>
        snapshot.pid === agentPid
          ? { ...snapshot, command: "/usr/bin/sleep 999" }
          : snapshot
      ));
    },
    literalInputs: () => provider.literalInputs(),
    keyDispatches: () => provider.keyDispatches(),
    enterCount: () => provider.keyDispatches().filter((keys) =>
      keys.includes("C-m")
    ).length,
    driftTriggered: () => driftTriggered,
    postDriftEnterCount: () => operationIndexAtDrift === undefined
      ? 0
      : provider.operations.slice(operationIndexAtDrift).filter((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ).length,
    transitionCount() {
      const rootDir = nativeThreadTransitionsDir(storeDir);
      return fs.existsSync(rootDir)
        ? fs.readdirSync(rootDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory()).length
        : 0;
    },
    onlyTransition() {
      const rootDir = nativeThreadTransitionsDir(storeDir);
      const transitionIds = fs.readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
      assert.equal(transitionIds.length, 1);
      return loadNativeThreadTransition(storeDir, transitionIds[0]);
    },
    debug: (result) => JSON.stringify({
      result,
      sessions: listManagedSessions(storeDir),
      turns: listConversations(storeDir),
      operations: provider.operations
    }, null, 2),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}
