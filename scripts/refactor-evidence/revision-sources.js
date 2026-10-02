import fs from "node:fs";
import path from "node:path";
import {
  spawnSync
} from "node:child_process";
import {
  fail,
  readRepositoryFile
} from "./common.js";

function checkedGit(repoRoot, args, operation) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    fail(`${operation} failed${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "");
}

function resolveCommit(repoRoot, revision) {
  const resolved = checkedGit(
    repoRoot,
    ["rev-parse", "--verify", `${revision}^{commit}`],
    `git revision resolution for ${revision}`
  ).trim();
  if (!/^[0-9a-f]{40,64}$/u.test(resolved)) {
    fail(`git returned an invalid commit id for ${revision}`);
  }
  return resolved;
}

function decodeNulPaths(output) {
  return output.split("\0").filter(Boolean);
}

export function readCommitSummaryAndPaths(repoRoot, commit) {
  const recordSeparator = "\0\0\n";
  const output = checkedGit(
    repoRoot,
    [
      "show",
      "--format=%H%x00%s%x00",
      "--name-only",
      "-z",
      "--no-renames",
      commit,
      "--"
    ],
    `reading immutable summary and changed paths for ${commit}`
  );
  const separatorIndex = output.indexOf(recordSeparator);
  if (separatorIndex < 0 ||
      output.indexOf(recordSeparator, separatorIndex + recordSeparator.length) >= 0) {
    fail(`git returned an invalid summary/path boundary for ${commit}`);
  }
  const header = output.slice(0, separatorIndex).split("\0");
  if (header.length !== 2 || !/^[0-9a-f]{40,64}$/u.test(header[0])) {
    fail(`git returned an invalid immutable summary for ${commit}`);
  }
  return {
    commit: header[0],
    subject: header[1],
    paths: decodeNulPaths(
      output.slice(separatorIndex + recordSeparator.length)
    ).sort()
  };
}

function readRevisionBlobs(repoRoot, revision, repositoryPaths) {
  if (repositoryPaths.some((repositoryPath) => /[\r\n]/u.test(repositoryPath))) {
    fail("revision evidence paths must not contain line breaks");
  }
  const result = spawnSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot,
    input: `${repositoryPaths.map((repositoryPath) =>
      `${revision}:${repositoryPath}`).join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim();
    fail(`batch reading test sources at ${revision} failed${
      detail ? `: ${detail}` : ""
    }`);
  }
  const output = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? "");
  let offset = 0;
  const sources = repositoryPaths.map((repositoryPath) => {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      fail(`git cat-file omitted the header for ${repositoryPath}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/u.exec(header);
    if (!match) {
      fail(`git cat-file returned an invalid header for ${repositoryPath}`);
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      fail(`git cat-file returned an invalid size for ${repositoryPath}`);
    }
    const sourceStart = headerEnd + 1;
    const sourceEnd = sourceStart + size;
    if (sourceEnd >= output.length || output[sourceEnd] !== 0x0a) {
      fail(`git cat-file returned a truncated blob for ${repositoryPath}`);
    }
    offset = sourceEnd + 1;
    return {
      path: repositoryPath,
      source: output.subarray(sourceStart, sourceEnd).toString("utf8")
    };
  });
  if (offset !== output.length) {
    fail(`git cat-file returned unexpected trailing evidence at ${revision}`);
  }
  return sources;
}

function walkTypeScriptTests(repoRoot, directory = "test") {
  const absoluteDirectory = path.join(repoRoot, directory);
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true })
    .flatMap((entry) => {
      const repositoryPath = `${directory}/${entry.name}`;
      if (entry.isDirectory()) {
        return walkTypeScriptTests(repoRoot, repositoryPath);
      }
      return entry.isFile() && entry.name.endsWith(".ts")
        ? [repositoryPath]
        : [];
    })
    .sort();
}

export function revisionTestSources(repoRoot, revision) {
  const resolved = resolveCommit(repoRoot, revision);
  const paths = decodeNulPaths(checkedGit(
    repoRoot,
    ["ls-tree", "-r", "--name-only", "-z", resolved, "--", "test"],
    `test source discovery at ${resolved}`
  )).filter((repositoryPath) => repositoryPath.endsWith(".ts"));
  return {
    revision: resolved,
    sources: readRevisionBlobs(repoRoot, resolved, paths)
  };
}

export function worktreeTestSources(repoRoot) {
  return walkTypeScriptTests(repoRoot).map((repositoryPath) => ({
    path: repositoryPath,
    source: readRepositoryFile(repoRoot, repositoryPath)
  }));
}
