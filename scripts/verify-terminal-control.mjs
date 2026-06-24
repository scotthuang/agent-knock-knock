#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CodexLocalSessionProvider } from "../dist/src/codex-local-session-provider.js";
import { CodexStoreAdapter } from "../dist/src/codex-store-adapter.js";
import {
  TmuxTerminalControlProvider,
  discoverTmuxSocketPaths,
  enrichActiveProcessesWithTerminalControl
} from "../dist/src/terminal-control-provider.js";

const args = parseArgs(process.argv.slice(2));
const packageRoot = args.packageRoot ? path.resolve(args.packageRoot) : undefined;

const modules = packageRoot
  ? await importPackageModules(packageRoot)
  : {
      CodexLocalSessionProvider,
      CodexStoreAdapter,
      TmuxTerminalControlProvider,
      discoverTmuxSocketPaths,
      enrichActiveProcessesWithTerminalControl
    };

const provider = new modules.CodexLocalSessionProvider(new modules.CodexStoreAdapter());
const active = await provider.listActiveSessions();
const terminalProvider = new modules.TmuxTerminalControlProvider();
const panes = await terminalProvider.listPanes();
const enriched = await modules.enrichActiveProcessesWithTerminalControl(active, terminalProvider);

const roots = rootActiveProcesses(enriched);
const terminalControlled = roots.filter((process) => process.terminalControl);
const native = roots.filter((process) => !process.terminalControl);
const targetPid = args.pid ? Number(args.pid) : undefined;
const target = targetPid ? enriched.find((process) => process.pid === targetPid) : undefined;

const result = {
  ok: terminalControlled.length > 0 && (!targetPid || Boolean(target?.terminalControl)),
  package_root: packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  node: process.execPath,
  env: {
    PATH: process.env.PATH,
    TMUX: process.env.TMUX,
    AKK_TMUX_SOCKET: process.env.AKK_TMUX_SOCKET
  },
  discovered_socket_paths: [
    ...new Set([
      ...modules.discoverTmuxSocketPaths("/private/tmp"),
      ...modules.discoverTmuxSocketPaths("/tmp")
    ])
  ],
  active_count: active.length,
  pane_count: panes.length,
  root_count: roots.length,
  native_count: native.length,
  terminal_controlled_count: terminalControlled.length,
  panes: panes.map((pane) => ({
    target: pane.target,
    socketPath: pane.socketPath,
    panePid: pane.panePid,
    currentCommand: pane.currentCommand,
    currentPath: pane.currentPath
  })),
  terminal_controlled: terminalControlled.map((process) => ({
    pid: process.pid,
    child_pids: childPidsForRoot(process, enriched),
    cwd: process.cwd,
    command: process.command,
    target: process.terminalControl?.target,
    socketPath: process.terminalControl?.socketPath,
    panePid: process.terminalControl?.panePid
  })),
  target_pid: targetPid
    ? {
        pid: targetPid,
        found: Boolean(target),
        terminal_controlled: Boolean(target?.terminalControl),
        process: target
          ? {
              pid: target.pid,
              ppid: target.ppid,
              cwd: target.cwd,
              command: target.command,
              terminalControl: target.terminalControl
            }
          : undefined
      }
    : undefined
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : 1;

async function importPackageModules(root) {
  const localSession = await import(pathToFileURL(path.join(root, "dist/src/codex-local-session-provider.js")));
  const store = await import(pathToFileURL(path.join(root, "dist/src/codex-store-adapter.js")));
  const terminal = await import(pathToFileURL(path.join(root, "dist/src/terminal-control-provider.js")));
  return {
    CodexLocalSessionProvider: localSession.CodexLocalSessionProvider,
    CodexStoreAdapter: store.CodexStoreAdapter,
    TmuxTerminalControlProvider: terminal.TmuxTerminalControlProvider,
    discoverTmuxSocketPaths: terminal.discoverTmuxSocketPaths,
    enrichActiveProcessesWithTerminalControl: terminal.enrichActiveProcessesWithTerminalControl
  };
}

function rootActiveProcesses(processes) {
  const pids = new Set(processes.map((process) => process.pid));
  const roots = processes.filter((process) => !process.ppid || !pids.has(process.ppid));
  const seenTerminalTargets = new Set();
  return roots.filter((process) => {
    const terminalTarget = process.terminalControl?.target;
    if (!terminalTarget) {
      return true;
    }
    if (seenTerminalTargets.has(terminalTarget)) {
      return false;
    }
    seenTerminalTargets.add(terminalTarget);
    return true;
  });
}

function childPidsForRoot(root, processes) {
  return processes
    .filter((candidate) => candidate.ppid === root.pid)
    .map((candidate) => candidate.pid);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-root") {
      parsed.packageRoot = argv[++index];
    } else if (arg === "--pid") {
      parsed.pid = argv[++index];
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}
