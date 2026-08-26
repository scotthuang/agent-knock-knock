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

test("ClawHub quickstarts reach a first task without a top-level workspace", () => {
  const tmux = read("docs/quickstart-tmux.md");
  const readme = read("README.md");
  const clawHubPreview = readme.split(/\r?\n/u).slice(0, 50).join("\n");

  for (const document of [tmux, clawHubPreview]) {
    assert.match(
      document,
      /openclaw plugins install clawhub:@scotthuang\/agent-knock-knock/u
    );
    assert.doesNotMatch(
      document,
      /openclaw config set plugins\.entries\.agent-knock-knock\.config\.workspace "\$\(pwd -P\)"/u
    );
    assert.match(document, /openclaw gateway restart/u);
    assert.match(document, /tmux new-session -s akk-work -c "\$\(pwd -P\)" codex/u);
    assert.match(document, /\/akk doctor/u);
    assert.match(document, /\/akk inspect this repository and summarize it/u);
  }
  for (const document of [tmux, readme]) {
    assert.doesNotMatch(
      document,
      /plugins\.entries\.agent-knock-knock\.config\.workspace|install-openclaw --workspace|doctor --workspace/u
    );
  }

  assert.doesNotMatch(tmux, /defaultAgent|--default-agent|ACPX/u);
  assert.match(tmux, /AKK reuses a coding agent that you start in tmux/u);
  assert.match(tmux, /exactly one send-ready coding-agent pane/u);
  assert.match(tmux, /\/akk <selector>: <message>/u);
  assert.match(tmux, /appears once in `terminals\[\]`/u);
  assert.match(tmux, /`managed\.current_turn`/u);
  assert.match(tmux, /`managed\.recent_turn`/u);
  assert.match(
    tmux,
    /refresh `\/akk list`[\s\S]*listed v22 `send` action[\s\S]*semantic IDs/u
  );
  assert.match(
    tmux,
    /`session_exact` action carries `session_id`[\s\S]*`terminal_follow_current`[\s\S]*actions carry `terminal_id`[\s\S]*never carries a selector[^.]*opaque token/u
  );
  assert.match(tmux, /`respond` action with its prefilled `turn_id`/u);
  assert.match(tmux, /\/akk threads <exact-terminal-id>/u);
  assert.match(tmux, /previous.*刚才那个/u);
  assert.match(tmux, /collision-safe `@short-id`/u);
  assert.match(
    tmux,
    /latest list shown in the same OpenClaw conversation incarnation/u
  );
  assert.match(tmux, /creates or activates an AKK Session but creates no Turn/u);
  assert.match(tmux, /multiple canonical roots/u);
  assert.match(tmux, /autoApprove\.rules\[\]\.workspaces/u);
  assert.match(readme, /multiple canonical workspace roots/u);
  assert.match(readme, /autoApprove\.rules\[\]\.workspaces/u);
  assert.match(tmux, /Direct `\/akk \.\.\.` commands work without changing the OpenClaw tool policy/u);
  assert.match(readme, /send a separate message/u);
  assert.doesNotMatch(tmux, /\/akk send\b/u);
  assert.ok(
    tmux.indexOf("openclaw plugins install clawhub:") <
      tmux.indexOf("npm install -g"),
    "the canonical ClawHub path must appear before the npm alternative"
  );

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
      selector: "codex",
      message: "inspect this repository and summarize it"
    }
  );

  const targeted = parseAkkCommand("@a1b2c3d4: run the tests and explain any failures");
  assert.deepEqual(targeted, {
    action: "send",
    selector: "@a1b2c3d4",
    message: "run the tests and explain any failures"
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(targeted, {
      workspace: "/legacy/project"
    }),
    [
      "send",
      "--session",
      "@a1b2c3d4",
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
});

test("README and bundled skill keep advanced commands in their workflows", () => {
  const readme = read("README.md");
  const skill = read("templates/openclaw-skills/agent-knock-knock/SKILL.md");
  const protocol = read("docs/bidirectional-agent-protocol.md");
  const quickstart = read("docs/quickstart-tmux.md");
  const changelog = read("CHANGELOG.md");
  const usage = markdownSection(readme, "## Usage", "## Configuration");
  const routing = markdownSection(
    skill,
    "## Chat Routing",
    "## Sessions and Turns"
  );

  assert.match(readme, /docs\/quickstart-tmux\.md/u);
  assert.match(readme, /\/akk doctor/u);

  for (const coreCommand of [
    "/akk <task>",
    "/akk <selector>: <message>",
    "/akk list",
    "/akk threads",
    "/akk new-thread",
    "/akk clear-thread",
    "/akk resume-thread",
    "/akk status",
    "/akk respond",
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
    assert.doesNotMatch(
      document,
      /`delegated\[\]`|`terminal_controlled\[\]`|`tasks\[\]`|akk_delegate/u
    );
    assert.match(document, /`terminals\[\]`/u);
    assert.match(document, /`managed\.current_turn`/u);
    assert.match(document, /`managed\.recent_turn`/u);
    assert.match(document, /`unavailable_managed_turns\[\]`/u);
    assert.match(document, /`session_id`/u);
    assert.match(document, /`turn_id`/u);
    assert.match(document, /`respond`/u);
    assert.doesNotMatch(document, /`expected_binding_token`/u);
    assert.match(document, /`native_thread_id`/u);
    assert.doesNotMatch(document, /`candidate_token`/u);
    assert.match(
      document,
      /`session_exact`[\s\S]*`terminal_follow_current`/u
    );
    assert.match(
      document,
      /complete exact inventory domain[\s\S]{0,400}PID and process birth[\s\S]{0,300}pre-submit byte offset/u
    );
    assert.match(
      document,
      /`\/clear` resume hint is advisory only[\s\S]{0,100}(?:never routing or acceptance authority|Under the terminal lock)/u
    );
    assert.match(
      document,
      /rollout-backed Codex row[\s\S]{0,120}advertises `terminal_follow_current`[\s\S]{0,80}not `session_exact`[\s\S]{0,200}(?:cached or direct `session_exact` attempt|cached strict Session attempt)[\s\S]{0,180}rejects before task text[\s\S]{0,100}never downgrades/u
    );
    assert.match(document, /status-card-only/u);
    assert.match(document, /manual (?:Codex )?`\/clear`/u);
    assert.match(
      document,
      /(?:complete exact inventory domain|complete open-rollout candidate inventory|complete set of exact Codex rollout candidates)/u
    );
    assert.match(document, /zero-UUID provisional/u);
    assert.match(
      document,
      /freshly listed semantic-ID action/u
    );
    assert.match(document, /exact (?:request acceptance|native acceptance)/u);
    assert.match(document, /at least 80 columns/u);
    assert.match(
      document,
      /ordinary (?:terminal-scoped )?task[\s\S]{0,160}(?:does not|so it does not) run `\/status`[\s\S]{0,120}(?:does not fail|or fail) merely because the pane is narrow/u
    );
    assert.match(
      document,
      /Until (?:that )?promotion commits[\s\S]*strict `session_id` send[\s\S]*`respond`[\s\S]*(?:managed `approve`|`approve`)[\s\S]*`cancel`[\s\S]*native lifecycle[\s\S]*(?:callback delivery|callback authority)[\s\S]*`native_inspect`/u
    );
    assert.match(
      document,
      /If (?:terminal )?delivery or (?:native )?acceptance is uncertain[\s\S]{0,100}(?:does not retry|do not retry automatically)/u
    );
    assert.match(
      document,
      /[Tt]erminal-scoped (?:manual )?(?:Codex )?approval/u
    );
    assert.match(
      document,
      /(?:private approval fence|confirmation offer private|prompt-scoped)/iu
    );
    assert.match(
      document,
      /exact unredacted (?:approval )?(?:region|prompt region)[\s\S]{0,400}(?:whole-screen digest|whole terminal capture digest)[\s\S]{0,160}diagnostic only/iu
    );
    assert.match(
      document,
      /output[\s\S]{0,80}outside (?:that region|the (?:approval )?(?:prompt )?region)[\s\S]{0,400}(?:without invalidating|may continue scrolling)/iu
    );
    assert.match(
      document,
      /change (?:inside|within) the (?:exact )?region[\s\S]{0,240}(?:secret|command)[\s\S]{0,300}(?:zero (?:approval )?keys|sends zero keys)/iu
    );
    assert.match(document, /never (?:available to|participates? in) auto-?approv/iu);
    assert.match(
      document,
      /(?:released[- ]owner|dispatch owner is already released|released predecessor Turn history|frozen predecessor history)/iu
    );
    assert.match(document, /(?:must not|mustn.t|do not) be retried blindly/u);
    assert.match(document, /creates no (?:AKK )?Turn/u);
    assert.match(document, /previous/u);
    assert.match(document, /snapshot/ui);
    assert.match(document, /Do not(?: ask AKK to)? send `\/clear`/u);
    assert.doesNotMatch(document, /`follow_up`/u);
    assert.match(
      document,
      /first attach[\s\S]{0,200}explicitly named by the user/ui
    );
    assert.match(
      document,
      /(?:prefilled[^.\n]*unmanaged raw-terminal row|unmanaged raw-terminal row[^.\n]*prefilled)[^.\n]*`terminal_id`/ui
    );
    assert.match(
      document,
      /(?:terminal-scoped (?:manual )?Codex approval|raw[- ](?:terminal|status))[\s\S]*prefill(?:ed|s)?(?: with)?(?: its(?: exact)?| the exact)? `terminal_id`/ui
    );
    assert.match(document, /never construct[\s\S]*guess/ui);
    assert.doesNotMatch(
      document,
      /expected_approval_fingerprint|--expected-approval-fingerprint/u
    );
    assert.match(
      document,
      /(?:managed )?`approve\(\{turn_id\}\)`|`approve\(\{terminal_id\}\)`/u
    );
  }
  assert.match(readme, /v22 `action_contracts`/u);
  assert.match(
    readme,
    /`terminal_user_explicit`[\s\S]*exact live physical terminal\/process[\s\S]*scanned, non-blocked approval state/u
  );
  assert.match(
    readme,
    /Composer visibility, stability, or exactness[\s\S]*`C-u`[\s\S]*paste window[\s\S]*Enter exactly once/u
  );
  assert.match(readme, /Composer observation cannot veto Enter/u);
  assert.match(
    readme,
    /unmanaged work[\s\S]*best-effort[\s\S]*no callback[\s\S]*Watch/u
  );
  assert.match(skill, /v22 `action_contracts`/u);
  assert.match(readme, /current writer protocol is 5/u);
  assert.match(
    readme,
    /Upgrading protocol 1 or 2[\s\S]*atomically publishing protocol 5/u
  );
  assert.match(
    readme,
    /Protocols 3 and 4 already have Session authority[\s\S]*manifest-only writer fence with no data migration/u
  );
  assert.match(
    readme,
    /If `previous` is present, use only its exact prefilled (?:semantic-ID )?action for a natural-language “刚才那个” request/u
  );
  assert.match(
    skill,
    /A top-level `previous` block, when present, is the only authority for a “previous\/刚才那个” request/u
  );
  assert.match(
    skill,
    /For “previous” \/ “刚才那个”[^\n]*`previous\.available_actions\.resume_thread`[^\n]*use that exact (?:semantic-ID )?action(?: and|;) never substitute the newest row/u
  );
  assert.match(
    readme,
    /number and short-ID resume forms[^.]*displayed snapshot[^.]*neither is a durable identity or model authority/iu
  );
  for (const document of [readme, protocol, quickstart]) {
    assert.match(document, /five(?:-| )minute(?:s)?/u);
    assert.match(document, /complete(?: native thread)? UUID/u);
  }
  assert.match(readme, /candidate-set[^.]*changes/u);
  assert.match(quickstart, /candidate change/u);
  assert.match(
    protocol,
    /replaced or changed transcript\/rollout cannot be resumed under stale metadata/u
  );
  assert.match(
    protocol,
    /revalidates the entire ordered candidate set, terminal dispatch generation, process, workspace, and binding before input/u
  );
  assert.match(
    changelog,
    /ordinary sends to an existing AKK Session target its `session_id`/u
  );
  assert.match(
    changelog,
    /unmanaged row may prefill its own `selector`[\s\S]*`conversation_id`/u
  );
  assert.match(changelog, /## 0\.10\.0 - 2026-08-06/u);
  assert.match(changelog, /Publish the v5 list\/action contract/u);
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
