import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  listDeferredForegroundTransfers
} from "../../../src/deferred-foreground-transfer.js";
import {
  listConversations
} from "../../../src/store.js";
import {
  type CommandResult
} from "../../../src/terminal-control-provider.js";
import {
  EXTERNAL_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  FIXTURE_TMUX_PANE_ID,
  codexTestComposerScreen,
  type NoRolloutFixture,
  successfulCommand
} from "./model.js";
import {
  appendNativeAcceptance,
  ensureFixtureCandidateRollout
} from "./rollouts.js";

export function runInProcessTmux(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  args: string[],
  nowMs: number
): CommandResult {
  fs.appendFileSync(
    fixture.tmuxCallsPath,
    `${JSON.stringify({ args, at: nowMs })}\n`
  );
  if (args[0] === "list-panes") {
    const injectDeferredIdentityDrift =
      env.AKK_TEST_DEFERRED_IDENTITY_DRIFT_BEFORE_TEXT === "1" &&
      listDeferredForegroundTransfers(fixture.storeDir).some(
        (transfer) =>
          transfer.status === "target_prepared" &&
          transfer.input_stage === "none"
      ) &&
      listConversations(fixture.storeDir).some((conversation) =>
        (conversation.native_session_takeover as Record<string, any> | undefined)
          ?.terminal_bridge_submission?.status === "prepared"
      );
    return successfulCommand(
      `${fixture.target.split(":")[0]}\t0\t0\t` +
      `${injectDeferredIdentityDrift
        ? Number(fixture.terminalControl.panePid) + 1
        : fixture.terminalControl.panePid}\tcodex\t` +
      `${fixture.terminalControl.currentPath}\t` +
      `\t${FIXTURE_TMUX_PANE_ID}\n`
    );
  }
  if (args[0] === "display-message") {
    assert.equal(args.at(-1), "#{pane_width}x#{pane_height}");
    return successfulCommand(
      fixture.viewportColumns === null
        ? ""
        : `${fixture.viewportColumns}x${fixture.viewportRows}\n`
    );
  }
  if (args[0] === "capture-pane") {
    const screen = fs.readFileSync(fixture.screenPath, "utf8");
    return successfulCommand(
      args.includes("-e")
        ? screen
        : screen.replace(/\u001b\[[0-9;]*m/gu, "")
    );
  }
  if (args[0] === "send-keys" && args.includes("-l")) {
    const text = String(args.at(-1) ?? "");
    if (env.AKK_TEST_TMUX_TEXT_FAILURE === "1" && text !== "/status") {
      return {
        status: 1,
        stdout: "",
        stderr: "injected tmux text failure"
      };
    }
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    fs.writeFileSync(pendingInputPath, text);
    if (text !== "/status") {
      fs.writeFileSync(fixture.screenPath, codexTestComposerScreen(text));
    }
    if (
      text !== "/status" &&
      env.AKK_TEST_MATERIALIZE_ROLLOUT_AFTER_TEXT === "1"
    ) {
      fs.writeFileSync(fixture.materializedPath, "ready");
      appendNativeAcceptance(
        fixture.activeRolloutPath,
        text,
        FIRST_NATIVE_TURN_ID,
        {
          nativeThreadId: fixture.activeNativeThreadId,
          workspace: String(fixture.terminalControl.currentPath),
          codexVersion: fixture.codexVersion,
          timestamp: new Date(nowMs).toISOString()
        }
      );
    }
    if (text === "/status") {
      fs.writeFileSync(
        fixture.screenPath,
        fixture.codexVersion === "0.147.0"
          ? "Ready\n› /status\n\n" +
            "  /status      show current session configuration and token usage\n" +
            "  /statusline  configure which items appear in the status line\n"
          : "Ready\n› /status\n\n" +
            "  /status  show current session configuration and token usage\n"
      );
      if (env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_NATIVE_INSPECT_PROCESS_BIRTH_AFTER_TEXT
        );
      }
    }
    return successfulCommand();
  }
  if (args[0] === "send-keys" && args.at(-1) === "C-u") {
    fs.writeFileSync(path.join(fixture.tempDir, "pending-input.txt"), "");
    fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
    return successfulCommand();
  }
  if (args[0] === "send-keys" && args.at(-1) === "C-m") {
    const pendingInputPath = path.join(fixture.tempDir, "pending-input.txt");
    const pendingInput = fs.existsSync(pendingInputPath)
      ? fs.readFileSync(pendingInputPath, "utf8")
      : "";
    fs.writeFileSync(pendingInputPath, "");
    if (pendingInput === "/status") {
      const statusSession = env.AKK_TEST_TRUNCATED_STATUS_CARD === "1"
        ? `${fixture.activeNativeThreadId.slice(0, 10)}...`
        : fixture.activeNativeThreadId;
      fs.writeFileSync(
        fixture.screenPath,
        `/status\n╭──────────────────────────────────────────────────╮\n` +
        `│ OpenAI Codex (v${fixture.codexVersion})                       │\n` +
        `│ Session: ${statusSession} │\n` +
        "│ Account: private@example.com                 │\n" +
        `╰──────────────────────────────────────────────────╯\n` +
        codexTestComposerScreen()
      );
    } else if (pendingInput === "/clear") {
      const nextRolloutPath = path.join(
        path.dirname(fixture.rolloutPath),
        `rollout-2026-08-06T01-00-00-${EXTERNAL_THREAD_ID}.jsonl`
      );
      fs.writeFileSync(nextRolloutPath, `${JSON.stringify({
        timestamp: "2026-08-06T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: EXTERNAL_THREAD_ID,
          cwd: fixture.terminalControl.currentPath,
          originator: "codex-tui",
          source: "cli",
          cli_version: fixture.codexVersion
        }
      })}\n`, { mode: 0o600 });
      fixture.activeNativeThreadId = EXTERNAL_THREAD_ID;
      fixture.activeRolloutPath = nextRolloutPath;
      fs.writeFileSync(fixture.materializedPath, "ready");
      fs.writeFileSync(
        fixture.screenPath,
        `New Codex thread ${EXTERNAL_THREAD_ID}\n` +
        codexTestComposerScreen()
      );
    } else {
      if (env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER) {
        fs.writeFileSync(
          fixture.processBirthPath,
          env.AKK_TEST_PROCESS_BIRTH_AFTER_ENTER
        );
      }
      fs.writeFileSync(fixture.materializedPath, "ready");
      if (
        env.AKK_TEST_SUPPRESS_NATIVE_ACCEPTANCE === "1" ||
        fixture.acceptanceNativeThreadIdsOnEnter?.length === 0
      ) {
        if (!fs.existsSync(fixture.activeRolloutPath)) {
          fs.mkdirSync(path.dirname(fixture.activeRolloutPath), {
            recursive: true,
            mode: 0o700
          });
          fs.writeFileSync(fixture.activeRolloutPath, `${JSON.stringify({
            timestamp: new Date(nowMs).toISOString(),
            type: "session_meta",
            payload: {
              id: fixture.activeNativeThreadId,
              cwd: fixture.terminalControl.currentPath,
              originator: "codex-tui",
              source: "cli",
              cli_version: fixture.codexVersion
            }
          })}\n`, { mode: 0o600 });
        }
      } else if (fixture.acceptanceNativeThreadIdsOnEnter) {
        for (const nativeThreadId of fixture.acceptanceNativeThreadIdsOnEnter) {
          const rolloutPath = ensureFixtureCandidateRollout(
            fixture,
            nativeThreadId,
            new Date(nowMs).toISOString()
          );
          appendNativeAcceptance(
            rolloutPath,
            pendingInput,
            FIRST_NATIVE_TURN_ID,
            {
              nativeThreadId,
              workspace: String(fixture.terminalControl.currentPath),
              codexVersion: fixture.codexVersion,
              timestamp: new Date(nowMs).toISOString()
            }
          );
        }
        fixture.activeNativeThreadId =
          fixture.acceptanceNativeThreadIdsOnEnter[0];
        fixture.activeRolloutPath = ensureFixtureCandidateRollout(
          fixture,
          fixture.activeNativeThreadId,
          new Date(nowMs).toISOString()
        );
      } else {
        appendNativeAcceptance(
          fixture.activeRolloutPath,
          pendingInput,
          FIRST_NATIVE_TURN_ID,
          {
            nativeThreadId: fixture.activeNativeThreadId,
            workspace: String(fixture.terminalControl.currentPath),
            codexVersion: fixture.codexVersion,
            timestamp: new Date(nowMs).toISOString()
          }
        );
      }
      for (const nativeThreadId of
        fixture.additionalOpenRootNativeThreadIdsOnEnter ?? []) {
        ensureFixtureCandidateRollout(
          fixture,
          nativeThreadId,
          new Date(nowMs).toISOString()
        );
      }
      fs.writeFileSync(fixture.screenPath, "Working\n");
    }
    return successfulCommand();
  }
  return successfulCommand();
}
