import fs from "node:fs";
import path from "node:path";
import {
  NATIVE_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  FIXTURE_TMUX_PANE_ID,
  CODEX_TEST_COMPOSER_FOOTER,
  codexTestComposerScreen
} from "./model.js";

export function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  pendingInputPath: string;
  materializedPath: string;
  processBirthPath: string;
  rolloutPath: string;
  codexVersion: "0.146.0" | "0.147.0";
  target: string;
  panePid: number;
  workspace: string;
  viewportColumns: number | null;
  viewportRows: number;
}): void {
  const statusPopup = options.codexVersion === "0.147.0"
    ? "Ready\n› /status\n\n" +
      "  /status      show current session configuration and token usage\n" +
      "  /statusline  configure which items appear in the status line\n"
    : "Ready\n› /status\n\n" +
      "  /status  show current session configuration and token usage\n";
  const fakeTmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args, at: Date.now() }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-birth\t0\t0\t${options.panePid}\tcodex\t${options.workspace}` +
      `\t\t${FIXTURE_TMUX_PANE_ID}\n`
  )});
} else if (args[0] === "display-message") {
  if (args.at(-1) !== "#{pane_width}x#{pane_height}") throw new Error("unexpected viewport format");
  process.stdout.write(${JSON.stringify(
    options.viewportColumns === null
      ? ""
      : `${options.viewportColumns}x${options.viewportRows}\n`
  )});
} else if (args[0] === "capture-pane") {
  const screen = fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8");
  process.stdout.write(
    args.includes("-e")
      ? screen
      : screen.replace(/\\u001b\\[[0-9;]*m/g, "")
  );
} else if (args[0] === "send-keys" && args.includes("-l")) {
  if (
    process.env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
    args.at(-1) !== "/status"
  ) {
    process.stderr.write("injected tmux text failure");
    process.exitCode = 1;
  } else {
    fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, args.at(-1));
    if (args.at(-1) === "/status") {
      fs.writeFileSync(${JSON.stringify(options.screenPath)},
        ${JSON.stringify(statusPopup)});
      const driftedProcessBirth =
        process.env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT;
      if (driftedProcessBirth) {
        fs.writeFileSync(
          ${JSON.stringify(options.processBirthPath)},
          driftedProcessBirth
        );
      }
    } else {
      const text = String(args.at(-1) ?? "");
      const [first = "", ...continuation] = text.split("\\n");
      fs.writeFileSync(
        ${JSON.stringify(options.screenPath)},
        [
          "Ready",
          "› " + first,
          ...continuation.map((row) => "  " + row),
          ${JSON.stringify(CODEX_TEST_COMPOSER_FOOTER)}
        ].join("\\n")
      );
    }
  }
} else if (args[0] === "send-keys" && args.at(-1) === "C-u") {
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  fs.writeFileSync(
    ${JSON.stringify(options.screenPath)},
    ${JSON.stringify(codexTestComposerScreen())}
  );
} else if (args[0] === "send-keys" && args.at(-1) === "C-m") {
  const pendingInput = fs.existsSync(${JSON.stringify(options.pendingInputPath)})
    ? fs.readFileSync(${JSON.stringify(options.pendingInputPath)}, "utf8")
    : "";
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  if (pendingInput === "/status") {
    const statusSession = process.env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
      ? ${JSON.stringify(`${NATIVE_THREAD_ID.slice(0, 10)}...`)}
      : ${JSON.stringify(NATIVE_THREAD_ID)};
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, ${JSON.stringify(
      `/status\n╭──────────────────────────────────────────────────╮\n` +
      `│ OpenAI Codex (v${options.codexVersion})                       │\n` +
      `│ Session: `
    )} + statusSession + ${JSON.stringify(
      ` │\n│ Account: private@example.com                 │\n` +
      `╰──────────────────────────────────────────────────╯\n` +
      codexTestComposerScreen()
    )});
  } else {
    if (process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
      fs.writeFileSync(
        ${JSON.stringify(options.processBirthPath)},
        process.env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
      );
    }
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
    const rolloutPath = ${JSON.stringify(options.rolloutPath)};
    if (rolloutPath && pendingInput) {
      const turnId = ${JSON.stringify(FIRST_NATIVE_TURN_ID)};
      if (!fs.existsSync(rolloutPath)) {
        fs.mkdirSync(require("node:path").dirname(rolloutPath), {
          recursive: true,
          mode: 0o700
        });
        fs.writeFileSync(rolloutPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "session_meta",
          payload: {
            id: ${JSON.stringify(NATIVE_THREAD_ID)},
            cwd: ${JSON.stringify(options.workspace)},
            originator: "codex-tui",
            source: "cli",
            cli_version: ${JSON.stringify(options.codexVersion)}
          }
        }) + "\\n", { mode: 0o600 });
      }
      if (process.env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE !== "1") {
        const records = [
          {
            timestamp: "2026-08-06T00:00:01.000Z",
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId }
          },
          {
            timestamp: "2026-08-06T00:00:01.010Z",
            type: "response_item",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: pendingInput }],
              internal_chat_message_metadata_passthrough: { turn_id: turnId }
            }
          }
        ];
        fs.appendFileSync(
          rolloutPath,
          records.map((record) => JSON.stringify(record)).join("\\n") + "\\n"
        );
      }
    }
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
}
`, { mode: 0o755 });
}

export function writeFakeProcessTools(options: {
  fakeBinDir: string;
  materializedPath: string;
  materializeRolloutOnProbe?: number;
  processBirthPath: string;
  rolloutProbeCountPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
}): void {
  const fakePs = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(fakePs, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.processBirthPath)}, "utf8") + "\\n");
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)});
}
`, { mode: 0o755 });

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  fs.writeFileSync(fakeLsof, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.codexPid}\\nftxt\\nn${options.executablePath}\\n");
} else {
  const probeCountPath = ${JSON.stringify(options.rolloutProbeCountPath)};
  const probeCount = fs.existsSync(probeCountPath)
    ? Number(fs.readFileSync(probeCountPath, "utf8"))
    : 0;
  const nextProbeCount = probeCount + 1;
  fs.writeFileSync(probeCountPath, String(nextProbeCount));
  const materializeOnProbe = ${JSON.stringify(
    options.materializeRolloutOnProbe ?? null
  )};
  if (materializeOnProbe === nextProbeCount) {
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
  }
  if (fs.existsSync(${JSON.stringify(options.materializedPath)})) {
    const canonicalRolloutPath = fs.realpathSync(
      ${JSON.stringify(options.rolloutPath)}
    );
    const stat = fs.statSync(canonicalRolloutPath);
    process.stdout.write("p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn" + canonicalRolloutPath + "\\n");
  }
}
`, { mode: 0o755 });
}

export function writeFakeSqlite(options: {
  fakeBinDir: string;
  nativeThreadId: string;
  rolloutPath: string;
  workspace: string;
}): void {
  const columns = [
    "id",
    "cwd",
    "rollout_path",
    "updated_at_ms",
    "archived",
    "source",
    "cli_version"
  ].map((name) => ({ name }));
  const rows = [{
    id: options.nativeThreadId,
    cwd: options.workspace,
    rollout_path: options.rolloutPath,
    updated_at_ms: 1_786_000_000_000,
    archived: 0,
    source: "cli",
    cli_version: "0.146.0"
  }];
  fs.writeFileSync(path.join(options.fakeBinDir, "sqlite3"), `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const sql = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!sql || sql === "BEGIN;" || sql === "COMMIT;" || sql === ".quit") {
      continue;
    }
    if (sql === "pragma table_info(threads);") {
      process.stdout.write(${JSON.stringify(JSON.stringify(columns) + "\n")});
      continue;
    }
    const control = /^select '([^']+)' as "__akk_sqlite_control";$/u.exec(sql);
    if (control) {
      process.stdout.write(JSON.stringify([{
        __akk_sqlite_control: control[1]
      }]) + "\\n");
      continue;
    }
    if (sql.startsWith("select id")) {
      process.stdout.write(${JSON.stringify(JSON.stringify(rows) + "\n")});
      continue;
    }
    process.stderr.write("unexpected sqlite query: " + sql);
    process.exitCode = 1;
  }
});
process.stdin.resume();
`, { mode: 0o755 });
}
