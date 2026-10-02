// Stable support surface; fixtures, providers and process boundaries have separate owners.
export {
  binPath,
  LIVE_PROCESS_BIRTH,
  STALE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  EXTERNAL_THREAD_ID,
  SECOND_EXTERNAL_THREAD_ID,
  FIRST_NATIVE_TURN_ID,
  FIXTURE_TMUX_PANE_ID,
  SIMULATED_DEAD_CLI_PID,
  CODEX_TEST_COMPOSER_FOOTER,
  codexTestComposerScreen,
  processUuid,
  InProcessCliExit,
  inProcessFixtures,
  successfulCommand,
  errorMessage
} from "./codex-no-rollout/model.js";
export type {
  NoRolloutFixture,
  CliTestResult,
  FixtureMutableCheckpoint,
  CapturedInProcessExit
} from "./codex-no-rollout/model.js";
export {
  test,
  codexNoRolloutTestDefinitions
} from "./codex-no-rollout/test-registration.js";
export type {
  CodexNoRolloutTestDefinition
} from "./codex-no-rollout/test-registration.js";
export {
  createNoRolloutFixture
} from "./codex-no-rollout/fixture.js";
export {
  persistStatusCardSession,
  persistExactEndedRolloutSession,
  persistDetachedRolloutCompanion,
  persistConflictSession
} from "./codex-no-rollout/sessions.js";
export {
  listFixtureTerminal,
  deferredForegroundSendAction,
  assertTerminalUserExplicitSendAction,
  deferredForegroundSendArgs,
  userExplicitDeferredForegroundSendArgs,
  seedStatusCardManagedApproval,
  approvalKeyCalls,
  codexApprovalScreen,
  soleDeferredForegroundTransfer,
  taskInputCalls,
  assertSingleTaskInput,
  persistedCodexV3AcceptanceAnchor,
  assertRecoveredTurnBlocksDuplicate
} from "./codex-no-rollout/foreground.js";
export {
  readSoleTerminalDispatchLedger,
  soleTerminalDispatchLedgerPath,
  seedResolvedHistoricalDispatchAndStatusCard,
  materializePreparedDeferredLedgerWithoutTurnState,
  assertExactDeferredZeroInputAbortLedger,
  assertResolvedSameUuidDeferredTransfer,
  reconcileArguments
} from "./codex-no-rollout/dispatch.js";
export {
  persistBlockingTurn,
  persistLegacyV1UncertainTurn,
  persistReleasedCandidateSourceTurns,
  persistUnresolvedTransition,
  persistUnresolvedDispatchLedger
} from "./codex-no-rollout/turns.js";
export {
  rewriteSnapshotLockOwners,
  restoreDirectorySnapshot,
  fixtureMutableCheckpoint,
  restoreFixtureMutableCheckpoint
} from "./codex-no-rollout/checkpoint.js";
export {
  runCli,
  runCliCrashCheckpoint,
  runCliSubprocess,
  spawnFixtureNodeEval,
  inProcessDependencies,
  waitForFixtureConversation,
  waitForProcessExit
} from "./codex-no-rollout/cli.js";
export {
  fixtureHerdrResponse,
  createFixtureHerdrProvider
} from "./codex-no-rollout/herdr.js";
export {
  fixtureProcessSnapshots,
  createFixtureCodexAdapter,
  fixtureCodexOpenRootInventory,
  createFixtureLifecycleProvider
} from "./codex-no-rollout/codex.js";
export {
  runInProcessTmux
} from "./codex-no-rollout/tmux.js";
export {
  writeFakeTmux,
  writeFakeProcessTools,
  writeFakeSqlite
} from "./codex-no-rollout/fake-executables.js";
export {
  readTmuxCalls,
  appendNativeAcceptance,
  enableFixtureCandidateInventory,
  ensureFixtureCandidateRollout,
  appendFixtureCompletion
} from "./codex-no-rollout/rollouts.js";
