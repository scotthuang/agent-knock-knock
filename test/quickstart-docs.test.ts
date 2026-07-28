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
  const acpx = read("docs/quickstart-managed-acpx.md");

  assert.match(
    tmux,
    /agent-knock-knock install-openclaw --workspace "\$PWD" --default-agent codex --mode tmux --verify/u
  );
  assert.match(tmux, /agent-knock-knock doctor --mode tmux/u);
  assert.match(tmux, /tmux new-session -s akk-work -c "\$PWD" codex/u);
  assert.deepEqual(
    parseAkkCommand("send codex: inspect this repository and summarize it"),
    {
      action: "send",
      conversationId: "codex",
      message: "inspect this repository and summarize it"
    }
  );

  assert.match(
    acpx,
    /agent-knock-knock install-openclaw --workspace "\$PWD" --default-agent codex --mode acpx --verify/u
  );
  assert.match(acpx, /agent-knock-knock doctor --mode acpx/u);
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

  for (const guide of [tmux, acpx]) {
    assert.doesNotMatch(guide, /<conversation-id>|<terminal-controlled-id>/u);
  }
});

test("root README links both packaged guides and exposes chat-side doctor", () => {
  const readme = read("README.md");

  assert.match(readme, /docs\/quickstart-tmux\.md/u);
  assert.match(readme, /docs\/quickstart-managed-acpx\.md/u);
  assert.match(readme, /\/akk doctor \[tmux\|acpx\|all\]/u);
});

function read(relativePath: string): string {
  return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
}
