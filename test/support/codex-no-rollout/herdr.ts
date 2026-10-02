import assert from "node:assert/strict";
import fs from "node:fs";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  type HerdrWireRequest
} from "../../../src/herdr-terminal-control-provider.js";
import {
  type NoRolloutFixture,
  successfulCommand
} from "./model.js";
import {
  runInProcessTmux
} from "./tmux.js";

export function fixtureHerdrResponse(
  request: HerdrWireRequest,
  result: Record<string, unknown>
): Record<string, unknown> {
  return { id: request.id, result };
}

export function createFixtureHerdrProvider(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  nowMs: () => number
): HerdrTerminalControlProvider {
  const control = fixture.terminalControl;
  assert.equal(control.kind, "herdr");
  const sessionList = JSON.stringify({
    sessions: [{
      name: control.session,
      default: true,
      running: true,
      socket_path: control.socketPath,
      session_dir: control.sessionDir
    }]
  });
  return new HerdrTerminalControlProvider({
    command: "herdr-fixture",
    runCommand: (_command, args) =>
      args[0] === "--version"
        ? successfulCommand(`herdr ${HERDR_EXACT_VERSION}\n`)
        : successfulCommand(sessionList),
    statSocket: () => ({
      device: "1",
      inode: "7001",
      ctimeNs: "1000000",
      ownerUid: 501
    }),
    inspectTtyViewport: (shellPid) => {
      fixture.ttyViewportInspectionPids.push(shellPid);
      return fixture.ttyViewportColumns === null
        ? undefined
        : {
            columns: fixture.ttyViewportColumns,
            rows: fixture.ttyViewportRows
          };
    },
    request: async (_socketPath, request) => {
      if (request.method === "ping") {
        return fixtureHerdrResponse(request, {
          type: "pong",
          version: HERDR_EXACT_VERSION,
          protocol: HERDR_EXACT_PROTOCOL,
          capabilities: {
            live_handoff: true,
            detached_server_daemon: true
          }
        });
      }
      if (request.method === "session.snapshot") {
        return fixtureHerdrResponse(request, {
          type: "session_snapshot",
          snapshot: {
            version: HERDR_EXACT_VERSION,
            protocol: HERDR_EXACT_PROTOCOL,
            panes: [{
              pane_id: control.paneId,
              terminal_id: control.terminalId,
              workspace_id: control.workspaceId,
              tab_id: control.tabId,
              cwd: control.currentPath,
              focused: true,
              agent_status: null,
              revision: 1
            }],
            ...(fixture.viewportColumns === null
              ? {}
              : {
                  layouts: [{
                    workspace_id: control.workspaceId,
                    tab_id: control.tabId,
                    zoomed: fixture.viewportZoomed,
                    ...(fixture.viewportFocusedPaneId
                      ? { focused_pane_id: fixture.viewportFocusedPaneId }
                      : {}),
                    ...(fixture.viewportAreaColumns === undefined ||
                      fixture.viewportAreaRows === undefined
                      ? {}
                      : {
                          area: {
                            x: 0,
                            y: 0,
                            width: fixture.viewportAreaColumns,
                            height: fixture.viewportAreaRows
                          }
                        }),
                    panes: [{
                      pane_id: control.paneId,
                      focused: fixture.viewportPaneFocused,
                      rect: {
                        x: 0,
                        y: 0,
                        width: fixture.viewportColumns,
                        height: fixture.viewportRows
                      }
                    }],
                    splits: []
                  }]
                })
          }
        });
      }
      if (request.method === "pane.process_info") {
        return fixtureHerdrResponse(request, {
          type: "pane_process_info",
          process_info: {
            pane_id: control.paneId,
            shell_pid: control.panePid,
            foreground_process_group_id: fixture.codexPid,
            foreground_processes: [{
              pid: fixture.codexPid,
              name: "codex",
              argv0: "codex",
              argv: ["codex", "--yolo"],
              cmdline: "codex --yolo",
              cwd: control.currentPath
            }]
          }
        });
      }
      if (request.method === "pane.read") {
        const screen = fs.readFileSync(fixture.screenPath, "utf8");
        const preserveEscapes = request.params.source === "visible" &&
          request.params.format === "ansi";
        return fixtureHerdrResponse(request, {
          type: "pane_read",
          read: {
            pane_id: control.paneId,
            workspace_id: control.workspaceId,
            tab_id: control.tabId,
            source: request.params.source,
            format: request.params.format,
            text: preserveEscapes
              ? screen
              : screen.replace(/\u001b\[[0-9;]*m/gu, ""),
            revision: 1,
            truncated: false
          }
        });
      }
      if (request.method === "pane.send_input") {
        const text = typeof request.params.text === "string"
          ? request.params.text
          : undefined;
        const keys = Array.isArray(request.params.keys)
          ? request.params.keys
          : [];
        if (
          text !== undefined &&
          env.AKK_TEST_TMUX_TEXT_FAILURE === "1" &&
          text !== "/status"
        ) {
          fs.appendFileSync(
            fixture.tmuxCallsPath,
            `${JSON.stringify({
              args: ["send-keys", "-t", fixture.target, "-l", text],
              at: nowMs()
            })}\n`
          );
          return {
            id: request.id,
            error: {
              code: "pane_send_failed",
              message: "injected Herdr text failure before input"
            }
          };
        }
        const result = text !== undefined
          ? runInProcessTmux(
              fixture,
              env,
              ["send-keys", "-t", fixture.target, "-l", text],
              nowMs()
            )
          : keys.includes("ctrl+u")
            ? runInProcessTmux(
                fixture,
                env,
                ["send-keys", "-t", fixture.target, "C-u"],
                nowMs()
              )
          : keys.includes("enter")
            ? runInProcessTmux(
                fixture,
                env,
                ["send-keys", "-t", fixture.target, "C-m"],
                nowMs()
              )
            : successfulCommand();
        if (result.status !== 0) {
          throw new Error(result.stderr || "fixture Herdr input failed");
        }
        return fixtureHerdrResponse(request, { type: "ok" });
      }
      throw new Error(`unexpected fixture Herdr request ${request.method}`);
    }
  });
}
