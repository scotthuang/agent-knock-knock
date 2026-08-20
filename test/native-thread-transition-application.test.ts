import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import {
  isBinaryExpression,
  isCaseClause,
  isCatchClause,
  isConditionalExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionLikeDeclaration,
  isIfStatement,
  isWhileStatement,
  type FunctionLikeDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast";

import {
  createNativeThreadTransitionApplication,
  type CreateNativeThreadTransitionApplicationInput
} from "../src/native-thread-transition-application.js";
import type { NativeThreadLifecycleCliFacade } from
  "../src/native-thread-lifecycle-cli-adapter.js";
import type { TerminalAgentAdapter } from
  "../src/terminal-agent-adapter.js";
import type { ResolvedTerminalConversation } from
  "../src/terminal-agent-bridge.js";
import type { TerminalRuntimeCliAdapter } from
  "../src/terminal-runtime-cli-adapter.js";

const terminal: ResolvedTerminalConversation = {
  conversationId: "tmux:codex:akk:0.0:42",
  agent: "codex",
  pid: 42,
  legacy: false,
  adapter: {} as TerminalAgentAdapter,
  terminalControl: {
    kind: "tmux",
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    capabilities: ["send_keys"]
  }
};

function application(label: string, events: string[]) {
  const unexpected = (): never => {
    throw new Error(`unexpected ${label} transition port`);
  };
  const lifecycle = {
    resolveLifecycleTerminal: unexpected,
    queryPorts: unexpected,
    assertExclusive: unexpected,
    currentSnapshot: unexpected,
    lifecycleBindingTokens: unexpected,
    agentAdapter: unexpected,
    assertSameInspectionTerminal: unexpected
  } as unknown as NativeThreadLifecycleCliFacade;
  const runtime = {
    createBridge: () => {
      events.push(`${label}:bridge`);
      return {};
    },
    loadClaudeAgentRows: (observation) => {
      events.push(`${label}:rows:${String(observation?.required)}`);
      return [];
    },
    agentVersionForRunningProcess: () => {
      events.push(`${label}:version`);
      return label;
    }
  } as unknown as TerminalRuntimeCliAdapter;
  const input = {
    runtime: {
      now: () => new Date(0), nowMs: () => 0, pid: () => 1,
      cwd: () => "/workspace", sleep: async () => {
        events.push(`${label}:sleep`);
      },
      env: () => undefined, exit: unexpected, log: () => undefined,
      print: () => undefined,
      summarizeError: (error) => ({ length: String(error).length })
    },
    lifecycle: {
      facade: lifecycle,
      runtime: () => runtime,
      resolveIdentity: async () => {
        events.push(`${label}:identity`);
        return { sessionId: label, evidence: label };
      },
      runtimeForIdentity: () => ({ pid: 42 }),
      exactIdentity: (_terminal, identity) => identity,
      assertComposerReady: async () => undefined
    },
    state: {
      storeDir: unexpected, runtimeDir: unexpected, loadLedger: unexpected,
      reconcilePrepared: unexpected, reconcileIncarnation: unexpected,
      recordMatchesControl: unexpected, lifecycleLedger: {} as never,
      ordinaryOwnerStatus: unexpected, blockingTurns: unexpected,
      managedTurns: unexpected, hasUnresolvedTransition: unexpected,
      dispatchOwnership: unexpected
    },
    authority: {
      sessionClaimsTerminal: unexpected, conflictKind: unexpected,
      ownerIsInactive: unexpected, observeExternal: unexpected,
      recoverDeferred: unexpected, knownRoots: unexpected,
      codexProcessBirth: unexpected, processAlive: unexpected,
      workspaceMatches: unexpected
    },
    mutation: {
      locks: unexpected, authenticate: unexpected,
      loadSession: unexpected, saveSession: unexpected
    }
  } as unknown as CreateNativeThreadTransitionApplicationInput;
  assert.deepEqual(Object.keys(input), [
    "runtime", "lifecycle", "state", "authority", "mutation"
  ]);
  return createNativeThreadTransitionApplication(input);
}

test("transition verification ports stay factory-scoped under parallel use", async () => {
  const leftEvents: string[] = [];
  const rightEvents: string[] = [];
  const left = application("left", leftEvents)
    .verificationPorts({}, terminal);
  const right = application("right", rightEvents)
    .verificationPorts({}, terminal);
  assert.equal(left.runningVersion(), "left");
  assert.equal(right.runningVersion(), "right");
  left.createBridge();
  right.createBridge();
  left.loadClaudeAgentRows();
  right.loadClaudeAgentRows();
  await Promise.all([
    left.resolveIdentity("preferred", undefined, []),
    right.resolveIdentity("preferred", undefined, []),
    left.sleep(1),
    right.sleep(1)
  ]);
  assert.deepEqual(leftEvents, [
    "left:version", "left:bridge", "left:rows:true",
    "left:identity", "left:sleep"
  ]);
  assert.deepEqual(rightEvents, [
    "right:version", "right:bridge", "right:rows:true",
    "right:identity", "right:sleep"
  ]);
});

test("public boundaries are typed and cli-core owns no transition machine", () => {
  const declaration = fs.readFileSync(
    new URL("../src/native-thread-transition-application.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(declaration, /\bany\b|Record<[^>]*any/u);
  const core = fs.readFileSync(path.resolve("src/cli-core.ts"), "utf8");
  for (const name of [
    "assertTerminalLifecycleReady", "nativeThreadVerificationAdapterPorts",
    "assertLifecycleTargetHasExclusiveOwnership", "runNewThread",
    "runResumeThread", "runReconcileBinding",
    "freshLifecycleRecoveryTerminal", "nativeThreadLifecycleRecoveryPorts",
    "recoverLifecycleFenceBeforeMutationScoped",
    "reconcileLifecycleDispatchLedgerScoped",
    "nativeThreadTransitionSettlementPorts", "runNativeThreadTransition",
    "saveLifecycleTerminalDispatchLedger"
  ]) {
    assert.doesNotMatch(
      core,
      new RegExp(`(?:async )?function ${name}\\(`, "u")
    );
  }
  assert.match(core, /nativeThreadLifecycleFacade\.runNewThread\(options\)/u);
  assert.match(core, /nativeThreadLifecycleFacade\.runResumeThread\(options\)/u);
  assert.match(
    core,
    /nativeThreadLifecycleFacade\.runReconcileBinding\(options\)/u
  );
  assert.match(
    core,
    /terminalHandoffCliFacade\.observedExternalHandoffIdentity\(input\)/u
  );
  assert.match(
    core,
    /terminalHandoffCliFacade[\s\S]*?\.recoverDeferredCodexForegroundTransferWhileWriterLease\(input\)/u
  );
  assert.match(
    core,
    /assertVerifiedEmptyCodexTransportBoundary,[\s\S]*?= terminalHandoffCliFacade/u
  );
});

function approximateComplexity(
  root: FunctionLikeDeclaration,
  sourceFile: SourceFile
): number {
  let value = 1;
  const visit = (node: Node): void => {
    if (node !== root && isFunctionLikeDeclaration(node)) return;
    if (
      isIfStatement(node) || isConditionalExpression(node) ||
      isCatchClause(node) || isForStatement(node) ||
      isForInStatement(node) || isForOfStatement(node) ||
      isWhileStatement(node) || isDoStatement(node) || isCaseClause(node)
    ) {
      value += 1;
    }
    if (
      isBinaryExpression(node) &&
      ["&&", "||", "??"].includes(node.operatorToken.getText(sourceFile))
    ) {
      value += 1;
    }
    node.forEachChild(visit);
  };
  root.body?.forEachChild(visit);
  return value;
}

test("compiler AST keeps every application function below the hard gate", () => {
  const api = new TypeScriptApi({ cwd: process.cwd() });
  const configPath = path.resolve("tsconfig.json");
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] })
      .getProject(configPath);
    assert.ok(project, "TypeScript project is available");
    const sourceFile = project.program.getSourceFile(path.resolve(
      "src/native-thread-transition-application.ts"
    ));
    assert.ok(sourceFile, "transition application AST is available");
    const metrics: Array<{ line: number; span: number; complexity: number }> = [];
    const visit = (node: Node): void => {
      if (isFunctionLikeDeclaration(node) && node.body) {
        const line = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        ).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
        metrics.push({
          line,
          span: end - line + 1,
          complexity: approximateComplexity(node, sourceFile)
        });
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    assert.ok(metrics.length > 0);
    assert.equal(Math.max(...metrics.map((entry) => entry.span)), 445);
    assert.equal(Math.max(...metrics.map((entry) => entry.complexity)), 44);
    for (const metric of metrics) {
      assert.ok(metric.span < 500, `function at line ${metric.line} spans ${metric.span}`);
      assert.ok(
        metric.complexity < 50,
        `function at line ${metric.line} has complexity ${metric.complexity}`
      );
    }
  } finally {
    api.close();
  }
});

test("application bytes preserve mutation order and scoped recovery routes", () => {
  const source = fs.readFileSync(
    path.resolve("src/native-thread-transition-application.ts"),
    "utf8"
  );
  const transition = source.slice(source.indexOf(
    "async function runNativeThreadTransition("
  ));
  const orderedNeedles = [
    "prepareNativeThreadTransition({",
    'phase: "command_prepared"',
    'status: "transitioning"',
    'type: "dispatch_started"',
    'phase: "command_dispatching"',
    "await bridge.send(",
    'type: "submission_recorded"',
    'phase: "command_submitted"',
    "await settleVerifiedNativeThreadTransition({"
  ];
  let cursor = -1;
  for (const needle of orderedNeedles) {
    const next = transition.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${needle} follows its durable predecessor`);
    cursor = next;
  }
  assert.match(source, /nativeThreadTransitionResourceBoundOperation\(\{/u);
  assert.match(source, /authenticateLifecycleRecoveryResources\(scopes, resources\)/u);
  assert.match(
    source,
    /settleFailedNativeThreadTransition\([\s\S]*?scopes, resources, settlementPorts\)/u
  );
});
