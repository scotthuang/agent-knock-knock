import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildAkkCommandCliArgs,
  parseAkkCommand
} from "../src/openclaw-plugin-helpers.js";

const packageRoot = path.resolve(
  path.dirname(new URL("../src/cli.js", import.meta.url).pathname),
  "../.."
);

test("five-minute guide uses the unique-idle and explicit-selector contracts", () => {
  const tmux = read("docs/quickstart-tmux.md");

  assert.match(
    tmux,
    /agent-knock-knock install-openclaw --workspace "\$PWD" --verify/u
  );
  assert.doesNotMatch(tmux, /defaultAgent|--default-agent/u);
  assert.match(tmux, /agent-knock-knock doctor/u);
  assert.match(tmux, /tmux new-session -s akk-work -c "\$PWD" codex/u);
  assert.match(tmux, /AKK does not launch coding agents/u);
  assert.match(tmux, /exactly one eligible idle pane/u);
  assert.match(tmux, /\/akk <selector>: <message>/u);
  assert.doesNotMatch(tmux, /\/akk send\b/u);

  assert.deepEqual(
    parseAkkCommand("inspect this repository and summarize it"),
    {
      action: "delegate",
      request: "inspect this repository and summarize it"
    }
  );
  assert.deepEqual(
    parseAkkCommand("codex: inspect this repository and summarize it"),
    {
      action: "send",
      conversationId: "codex",
      message: "inspect this repository and summarize it"
    }
  );

  const targeted = parseAkkCommand("@a1b2c3d4: run the tests and explain any failures");
  assert.deepEqual(targeted, {
    action: "send",
    conversationId: "@a1b2c3d4",
    message: "run the tests and explain any failures"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(targeted, {
      workspace: "/work/project"
    }),
    [
      "send",
      "--conversation",
      "@a1b2c3d4",
      "--message",
      "run the tests and explain any failures",
      "--background",
      "--workspace",
      "/work/project",
      "--openclaw-session",
      "agent:main:main",
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main"
    ]
  );
});

test("README and bundled skill keep advanced commands in their workflows", () => {
  const readme = read("README.md");
  const skill = read("templates/openclaw-skills/agent-knock-knock/SKILL.md");
  const usage = markdownSection(readme, "## Usage", "## Configuration");
  const routing = markdownSection(
    skill,
    "## Chat Routing",
    "## Starting and Reusing Work"
  );

  assert.match(readme, /docs\/quickstart-tmux\.md/u);
  assert.match(readme, /\/akk doctor/u);

  for (const coreCommand of [
    "/akk <task>",
    "/akk <selector>: <message>",
    "/akk list",
    "/akk status",
    "/akk cancel"
  ]) {
    assert.match(usage, new RegExp(escapeRegex(coreCommand), "u"));
    assert.match(routing, new RegExp(escapeRegex(coreCommand), "u"));
  }

  for (const advancedCommand of [
    "/akk doctor",
    "/akk approve",
    "/akk renew",
    "/akk retry-callback",
    "/akk close"
  ]) {
    assert.doesNotMatch(usage, new RegExp(escapeRegex(advancedCommand), "u"));
    assert.doesNotMatch(routing, new RegExp(escapeRegex(advancedCommand), "u"));
  }

  for (const document of [readme, skill]) {
    assert.doesNotMatch(document, /defaultAgent|--default-agent/u);
    assert.doesNotMatch(document, /\/akk send\b|\/akk describe\b/u);
    assert.match(
      document,
      /\/akk approve @a1b2c3d4 --expected-approval-fingerprint <fresh-fingerprint>/u
    );
  }
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}

function markdownSection(
  document: string,
  startHeading: string,
  endHeading: string
): string {
  const start = document.indexOf(startHeading);
  const end = document.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `missing heading: ${startHeading}`);
  assert.notEqual(end, -1, `missing heading: ${endHeading}`);
  return document.slice(start, end);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
