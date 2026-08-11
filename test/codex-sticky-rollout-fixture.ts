import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import { CodexStoreAdapter } from "../src/codex-store-adapter.js";
import type { CodexThreadRow } from "../src/codex-session-provider.js";
import {
  listManagedSessions,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable } from "../src/store.js";
import type {
  TerminalControlRef,
  TerminalProcessSnapshot
} from "../src/terminal-agent-adapter.js";
import {
  MutableRecordingTerminalProvider,
  MutableTerminalProcessSource,
  VirtualClock,
  runInProcessCli,
  terminalCliDependencies,
  type InProcessCliResult
} from "./in-process-cli-fixtures.js";

const THREAD_COLUMNS = [
  "id",
  "cwd",
  "rollout_path",
  "updated_at_ms",
  "archived",
  "source",
  "cli_version",
  "model_provider"
] as const;

interface LifecycleThreadRow extends CodexThreadRow {
  source: "cli";
  cli_version: string;
  model_provider?: string;
}

export const STICKY_THREAD_IDS = {
  a: "11111111-1111-4111-8111-111111111111",
  b: "22222222-2222-4222-8222-222222222222",
  wrong: "33333333-3333-4333-8333-333333333333",
  c: "44444444-4444-4444-8444-444444444444",
  unknown: "55555555-5555-4555-8555-555555555555"
} as const;

const CODEX_STATUS_COMPOSER = [
  "Ready",
  "› /status",
  "  /status  show current session configuration and token usage"
].join("\n");

interface StickyRolloutFixtureOptions {
  exactStatusProbe?: boolean;
}

export class StickyRolloutFixture {
  readonly tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-sticky-in-process-")
  );
  readonly workspace = path.join(this.tempDir, "workspace");
  readonly storeDir = path.join(this.tempDir, "store");
  readonly runtimeDir = path.join(this.tempDir, "runtime");
  readonly codexHome = path.join(this.tempDir, ".codex");
  readonly sessionsDir = path.join(
    this.codexHome,
    "sessions",
    "2026",
    "08",
    "06"
  );
  readonly target = "tmux-sticky-rollout:0.0";
  readonly panePid = 73_000;
  readonly codexPid = 73_001;
  readonly processBirth = "Thu Aug  6 11:00:00 2026";
  readonly terminalId =
    `terminal:v2:tmux:codex:${this.target}:${this.codexPid}`;
  readonly executablePath =
    "/opt/akk-test/releases/0.146.0-aarch64-apple-darwin/bin/codex";
  readonly sourceSessionId = "session-codex-sticky-rollout-source";
  readonly clock = new VirtualClock("2026-08-06T03:00:00.000Z");
  readonly terminalControl: TerminalControlRef;
  readonly provider: MutableRecordingTerminalProvider;
  readonly processSource: MutableTerminalProcessSource;
  readonly adapter: CodexStoreAdapter;
  readonly rows: LifecycleThreadRow[];
  readonly rolloutPaths: Record<"a" | "b" | "c" | "unknown", string>;

  activeThreadId: string = STICKY_THREAD_IDS.a;
  statusCount = 0;
  clearCount = 0;
  wrongNextStatus = false;
  draftAfterNextStatus = false;
  blankRowsAfterNextStatus = false;
  sourceBindingToken: string;
  private readonly exactStatusProbe: boolean;
  private statusProbePending = false;

  constructor(options: StickyRolloutFixtureOptions = {}) {
    this.exactStatusProbe = options.exactStatusProbe === true;
    fs.mkdirSync(this.workspace, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.codexHome, "state_1.sqlite"), "", {
      mode: 0o600
    });
    this.rolloutPaths = {
      a: path.join(
        this.sessionsDir,
        `rollout-2026-08-06T00-00-00-${STICKY_THREAD_IDS.a}.jsonl`
      ),
      b: path.join(
        this.sessionsDir,
        `rollout-2026-08-06T00-01-00-${STICKY_THREAD_IDS.b}.jsonl`
      ),
      c: path.join(
        this.sessionsDir,
        `rollout-2026-08-06T00-02-00-${STICKY_THREAD_IDS.c}.jsonl`
      ),
      unknown: path.join(
        this.sessionsDir,
        `rollout-2026-08-06T00-03-00-${STICKY_THREAD_IDS.unknown}.jsonl`
      )
    };
    this.writeRollout("a", "0.140.0");
    this.rows = [
      this.threadRow("a", "0.140.0", 1_786_000_000_000),
      this.threadRow("b", "0.146.0", 1_786_000_060_000),
      this.threadRow("c", "0.146.0", 1_786_000_120_000),
      this.threadRow("unknown", "0.146.0", 1_786_000_180_000)
    ];

    this.terminalControl = {
      kind: "tmux",
      target: this.target,
      session: "tmux-sticky-rollout",
      window: 0,
      pane: 0,
      panePid: this.panePid,
      currentCommand: "codex",
      currentPath: this.workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    };
    this.provider = new MutableRecordingTerminalProvider({
      panes: [{
        kind: "tmux",
        target: this.target,
        session: "tmux-sticky-rollout",
        window: 0,
        pane: 0,
        panePid: this.panePid,
        currentCommand: "codex",
        currentPath: this.workspace,
        ...(this.exactStatusProbe
          ? { columns: 100, rows: 30 }
          : {})
      }],
      screens: { [this.target]: "Ready\n› " },
      hooks: {
        sendText: async ({ text }) => this.onSendText(text),
        sendKeys: async ({ keys }) => this.onSendKeys(keys)
      }
    });
    const snapshots: TerminalProcessSnapshot[] = [
      {
        pid: this.panePid,
        ppid: 1,
        command: "zsh",
        cwd: this.workspace,
        elapsed: "00:10"
      },
      {
        pid: this.codexPid,
        ppid: this.panePid,
        command: this.executablePath,
        cwd: this.workspace,
        elapsed: "00:09"
      }
    ];
    this.processSource = new MutableTerminalProcessSource(snapshots);
    this.adapter = new CodexStoreAdapter({
      codexHome: this.codexHome,
      runCommand: (command, args) => this.runCodexInspection(command, args),
      runSqliteThreadQuery: async (request) => {
        let rows = [...this.rows];
        if (request.nativeThreadId) {
          rows = rows.filter((row) => row.id === request.nativeThreadId);
        }
        if (request.filters) {
          rows = rows.filter((row) =>
            (!request.filters?.cwd ||
              path.resolve(String(row.cwd)) === path.resolve(request.filters.cwd)) &&
            (!request.filters?.source || row.source === request.filters.source) &&
            (request.filters?.archived === undefined ||
              Boolean(row.archived) === request.filters.archived) &&
            (!request.filters?.modelProvider ||
              row.model_provider === request.filters.modelProvider)
          );
        }
        rows.sort((left, right) =>
          Number(right.updated_at_ms ?? 0) - Number(left.updated_at_ms ?? 0)
        );
        return {
          columns: [...THREAD_COLUMNS],
          rows: rows.slice(0, request.maxSessions)
        };
      },
      sleep: this.clock.sleep
    });

    ensureStoreWritable(this.storeDir);
    const rollout = this.rolloutIdentity("a", "12u");
    const now = this.clock.now();
    const source = saveManagedSession(this.storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: this.sourceSessionId,
      agent: "codex",
      workspace: this.workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId: this.terminalId,
        terminalControl: this.terminalControl,
        pid: this.codexPid,
        nativeThreadId: STICKY_THREAD_IDS.a,
        processUuid:
          `codex-pid:${this.codexPid}:birth:${this.processBirth}`,
        processBirth: this.processBirth,
        rollout,
        evidence: "codex_rollout_fd",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    this.sourceBindingToken = managedSessionBindingToken(source);
  }

  cleanup(): void {
    fs.rmSync(this.tempDir, { recursive: true, force: true });
  }

  setScreen(screen: string): void {
    this.provider.setScreen(this.target, screen);
  }

  writeRollout(
    key: "a" | "b" | "c" | "unknown",
    version = "0.146.0"
  ): void {
    const nativeThreadId = STICKY_THREAD_IDS[key];
    fs.writeFileSync(this.rolloutPaths[key], `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: this.workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: version
      }
    })}\n`, { mode: 0o600 });
  }

  rolloutIdentity(key: "a" | "b" | "c" | "unknown", fd?: string) {
    const realPath = fs.realpathSync(this.rolloutPaths[key]);
    const stat = fs.statSync(realPath);
    return {
      fd: fd ?? ({ a: "12u", b: "13u", c: "14u", unknown: "15u" }[key]),
      device: String(stat.dev),
      inode: String(stat.ino),
      path: realPath
    };
  }

  literalInputs(): string[] {
    return this.provider.literalInputs();
  }

  async run(args: readonly string[]): Promise<InProcessCliResult> {
    return runInProcessCli(args, terminalCliDependencies({
      terminalProvider: this.provider,
      processSource: this.processSource,
      clock: this.clock,
      env: {
        ...process.env,
        AKK_RUNTIME_DIR: this.runtimeDir,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
        AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
      },
      overrides: {
        cwd: this.workspace,
        codexLocalSessionAdapter: this.adapter,
        codexThreadLifecycleProvider: this.adapter,
        agentVersionForRunningProcess: () => "0.146.0",
        codexProcessBirthForPid: () => this.processBirth
      }
    }));
  }

  async action(args: readonly string[]): Promise<InProcessCliResult> {
    return this.run([
      ...args,
      "--store-dir",
      this.storeDir,
      "--codex-home",
      this.codexHome
    ]);
  }

  async newThread(options: { requireRestorable?: boolean } = {}) {
    const bound = listManagedSessions(this.storeDir)
      .find((session) => session.status === "bound");
    if (!bound) {
      throw new Error("sticky fixture expected one bound Session");
    }
    return this.action([
      "new-thread",
      "--terminal",
      this.terminalId,
      "--expected-binding-token",
      managedSessionBindingToken(bound),
      ...(options.requireRestorable ? ["--require-restorable-origin"] : [])
    ]);
  }

  async listResumable() {
    return this.action([
      "list-resumable-threads",
      "--terminal",
      this.terminalId
    ]);
  }

  async send(sessionId: string, message: string) {
    return this.action([
      "send",
      "--session",
      sessionId,
      "--message",
      message,
      "--background",
      "--disable-terminal-bridge-monitor"
    ]);
  }

  async close(turnId: string, reason = "sticky fixture cleanup") {
    return this.action([
      "close",
      "--turn",
      turnId,
      "--reason",
      reason
    ]);
  }

  private threadRow(
    key: "a" | "b" | "c" | "unknown",
    version: string,
    updatedAtMs: number
  ): LifecycleThreadRow {
    return {
      id: STICKY_THREAD_IDS[key],
      cwd: this.workspace,
      rollout_path: this.rolloutPaths[key],
      updated_at_ms: updatedAtMs,
      archived: 0,
      source: "cli",
      cli_version: version
    };
  }

  private onSendText(text: string): void {
    if (text === "/status") {
      if (this.exactStatusProbe) {
        this.statusProbePending = true;
        this.setScreen(CODEX_STATUS_COMPOSER);
      } else {
        this.materializeStatusPanel();
      }
      return;
    }
    if (text === "/clear") {
      this.clearCount += 1;
      this.activeThreadId = this.clearCount >= 2
        ? STICKY_THREAD_IDS.c
        : STICKY_THREAD_IDS.b;
      this.setScreen("Cleared\n› ");
      return;
    }
    if (text.startsWith("/resume ")) {
      this.activeThreadId = text.slice("/resume ".length).trim().toLowerCase();
      this.setScreen("Resumed\n› ");
      return;
    }
    if (this.activeThreadId === STICKY_THREAD_IDS.b &&
        !fs.existsSync(this.rolloutPaths.b)) {
      this.writeRollout("b");
    } else if (this.activeThreadId === STICKY_THREAD_IDS.c &&
               !fs.existsSync(this.rolloutPaths.c)) {
      this.writeRollout("c");
    }
    this.setScreen("Working\n");
  }

  private onSendKeys(keys: readonly string[]): void {
    if (
      this.exactStatusProbe &&
      this.statusProbePending &&
      keys.includes("C-m")
    ) {
      this.statusProbePending = false;
      this.materializeStatusPanel();
    }
  }

  private materializeStatusPanel(): void {
    this.statusCount += 1;
    const nativeThreadId = this.wrongNextStatus
      ? STICKY_THREAD_IDS.wrong
      : this.activeThreadId;
    const draft = this.draftAfterNextStatus;
    const blankRows = this.blankRowsAfterNextStatus;
    this.wrongNextStatus = false;
    this.draftAfterNextStatus = false;
    this.blankRowsAfterNextStatus = false;
    this.setScreen(
      `/status\nprobe-${this.statusCount}\nSession: ${nativeThreadId}` +
      (draft
        ? "\n› unsent lifecycle draft\ngpt-5.4 default · 100% left"
        : `\n› ${blankRows ? "\n".repeat(30) : ""}`)
    );
  }

  private runCodexInspection(command: string, args: string[]) {
    if (command === "ps" && args.includes("lstart=")) {
      return {
        status: 0,
        stdout: `${this.processBirth}\n`,
        stderr: ""
      };
    }
    if (command === "lsof") {
      let stdout = `p${this.codexPid}\n`;
      for (const key of ["a", "b", "c", "unknown"] as const) {
        if (!fs.existsSync(this.rolloutPaths[key])) {
          continue;
        }
        const identity = this.rolloutIdentity(key);
        // lsof reports the descriptor's lexical path. The adapter then proves
        // both that path and its realpath stay inside CODEX_HOME/sessions.
        stdout += `f${identity.fd}\ntREG\nD${identity.device}\n` +
          `i${identity.inode}\nn${this.rolloutPaths[key]}\n`;
      }
      return { status: 0, stdout, stderr: "" };
    }
    return {
      status: 1,
      stdout: "",
      stderr: `unexpected fixture command: ${command} ${args.join(" ")}`
    };
  }
}

export function resumeActionCliArgs(
  argumentsValue: Record<string, string>
): string[] {
  return [
    "--terminal",
    argumentsValue.terminal_id,
    "--native-thread",
    argumentsValue.native_thread_id,
    "--expected-binding-token",
    argumentsValue.expected_binding_token,
    "--candidate-token",
    argumentsValue.candidate_token
  ];
}
