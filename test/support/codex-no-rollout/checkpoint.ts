import fs from "node:fs";
import path from "node:path";
import {
  type NoRolloutFixture,
  type FixtureMutableCheckpoint
} from "./model.js";
import {
  test
} from "./test-registration.js";

export function rewriteSnapshotLockOwners(
  directory: string,
  deadPid: number
): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteSnapshotLockOwners(entryPath, deadPid);
      continue;
    }
    if (!entry.isFile() || !/\.(?:lock|reclaim)$/u.test(entry.name)) {
      continue;
    }
    const contents = fs.readFileSync(entryPath, "utf8").trim();
    try {
      const owner = JSON.parse(contents) as Record<string, unknown>;
      if (owner.pid === process.pid) {
        fs.writeFileSync(
          entryPath,
          `${JSON.stringify({ ...owner, pid: deadPid })}\n`,
          "utf8"
        );
      }
    } catch {
      if (Number(contents) === process.pid) {
        fs.writeFileSync(entryPath, `${deadPid}\n`, "utf8");
      }
    }
  }
}

export function restoreDirectorySnapshot(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  const sourceEntries = new Map(
    fs.readdirSync(source, { withFileTypes: true }).map((entry) => [
      entry.name,
      entry
    ])
  );
  for (const destinationEntry of fs.readdirSync(destination, {
    withFileTypes: true
  })) {
    if (!sourceEntries.has(destinationEntry.name)) {
      fs.rmSync(path.join(destination, destinationEntry.name), {
        recursive: true,
        force: true
      });
    }
  }
  for (const [name, sourceEntry] of sourceEntries) {
    const sourcePath = path.join(source, name);
    const destinationPath = path.join(destination, name);
    const destinationStat = (() => {
      try {
        return fs.lstatSync(destinationPath);
      } catch {
        return undefined;
      }
    })();
    if (sourceEntry.isDirectory()) {
      if (destinationStat && !destinationStat.isDirectory()) {
        fs.rmSync(destinationPath, { recursive: true, force: true });
      }
      restoreDirectorySnapshot(sourcePath, destinationPath);
      continue;
    }
    if (sourceEntry.isFile() && destinationStat?.isFile()) {
      const sourceStat = fs.statSync(sourcePath);
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(destinationPath, sourceStat.mode);
      fs.utimesSync(destinationPath, sourceStat.atime, sourceStat.mtime);
      continue;
    }
    if (destinationStat) {
      fs.rmSync(destinationPath, { recursive: true, force: true });
    }
    fs.cpSync(sourcePath, destinationPath, {
      recursive: sourceEntry.isDirectory(),
      preserveTimestamps: true
    });
  }
}

export function fixtureMutableCheckpoint(
  fixture: NoRolloutFixture
): FixtureMutableCheckpoint {
  return {
    activeNativeThreadId: fixture.activeNativeThreadId,
    activeRolloutPath: fixture.activeRolloutPath,
    ...(fixture.appendAcceptanceOnProbe === undefined
      ? {}
      : { appendAcceptanceOnProbe: fixture.appendAcceptanceOnProbe }),
    ...(fixture.deferredAcceptanceRequest === undefined
      ? {}
      : { deferredAcceptanceRequest: fixture.deferredAcceptanceRequest }),
    ...(fixture.openRootRollouts === undefined
      ? {}
      : {
          openRootRollouts: fixture.openRootRollouts.map((candidate) => ({
            ...candidate
          }))
        }),
    ...(fixture.acceptanceNativeThreadIdsOnEnter === undefined
      ? {}
      : {
          acceptanceNativeThreadIdsOnEnter:
            [...fixture.acceptanceNativeThreadIdsOnEnter]
        }),
    ...(fixture.additionalOpenRootNativeThreadIdsOnEnter === undefined
      ? {}
      : {
          additionalOpenRootNativeThreadIdsOnEnter:
            [...fixture.additionalOpenRootNativeThreadIdsOnEnter]
        }),
    clockMs: fixture.clockMs,
    runtimeLogCount: fixture.runtimeLogs.length,
    ttyViewportInspectionCount: fixture.ttyViewportInspectionPids.length
  };
}

export function restoreFixtureMutableCheckpoint(
  fixture: NoRolloutFixture,
  checkpoint: FixtureMutableCheckpoint
): void {
  fixture.activeNativeThreadId = checkpoint.activeNativeThreadId;
  fixture.activeRolloutPath = checkpoint.activeRolloutPath;
  if (checkpoint.appendAcceptanceOnProbe === undefined) {
    delete fixture.appendAcceptanceOnProbe;
  } else {
    fixture.appendAcceptanceOnProbe = checkpoint.appendAcceptanceOnProbe;
  }
  if (checkpoint.deferredAcceptanceRequest === undefined) {
    delete fixture.deferredAcceptanceRequest;
  } else {
    fixture.deferredAcceptanceRequest = checkpoint.deferredAcceptanceRequest;
  }
  fixture.openRootRollouts = checkpoint.openRootRollouts?.map((candidate) => ({
    ...candidate
  }));
  fixture.acceptanceNativeThreadIdsOnEnter =
    checkpoint.acceptanceNativeThreadIdsOnEnter === undefined
      ? undefined
      : [...checkpoint.acceptanceNativeThreadIdsOnEnter];
  fixture.additionalOpenRootNativeThreadIdsOnEnter =
    checkpoint.additionalOpenRootNativeThreadIdsOnEnter === undefined
      ? undefined
      : [...checkpoint.additionalOpenRootNativeThreadIdsOnEnter];
  fixture.clockMs = checkpoint.clockMs;
  fixture.runtimeLogs.length = checkpoint.runtimeLogCount;
  fixture.ttyViewportInspectionPids.length =
    checkpoint.ttyViewportInspectionCount;
}
