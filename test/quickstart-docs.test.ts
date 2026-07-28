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

test("five-minute guides use implemented installer, doctor, and selector contracts", () => {
  const tmux = read("docs/quickstart-tmux.md");

  assert.match(
    tmux,
    /agent-knock-knock install-openclaw --workspace "\$PWD" --default-agent codex --verify/u
  );
  assert.match(tmux, /agent-knock-knock doctor/u);
  assert.match(tmux, /tmux new-session -s akk-work -c "\$PWD" codex/u);
  assert.deepEqual(
    parseAkkCommand("send codex: inspect this repository and summarize it"),
    {
      action: "send",
      conversationId: "codex",
      message: "inspect this repository and summarize it"
    }
  );

  assert.deepEqual(parseAkkCommand("codex inspect this repository and summarize it"), {
    action: "delegate",
    agent: "codex",
    request: "inspect this repository and summarize it"
  });
  const followUp = parseAkkCommand("send only: run the tests and explain any failures");
  assert.deepEqual(followUp, {
    action: "send",
    conversationId: "only",
    message: "run the tests and explain any failures"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(followUp, {}),
    [
      "send",
      "--conversation",
      "only",
      "--message",
      "run the tests and explain any failures",
      "--background",
      "--openclaw-session",
      "agent:main:main",
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main"
    ]
  );

  assert.doesNotMatch(tmux, /<conversation-id>|<terminal-controlled-id>/u);
});

test("root README links the canonical tmux guide and exposes chat-side doctor", () => {
  const readme = read("README.md");

  assert.match(readme, /docs\/quickstart-tmux\.md/u);
  assert.match(readme, /\/akk doctor/u);
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}
