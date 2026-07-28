import test from "node:test";
import assert from "node:assert/strict";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  parseAkkCommand,
  resolvePluginStoreDir
} from "../src/openclaw-plugin-helpers.js";

test("bare /akk task leaves agent unset so plugin defaultAgent is used", () => {
  assert.deepEqual(
    parseAkkCommand("inspect the configured workspace"),
    {
      action: "delegate",
      request: "inspect the configured workspace"
    }
  );
});

test("explicit /akk agent aliases remain explicit", () => {
  assert.deepEqual(
    parseAkkCommand("claude review the API"),
    {
      action: "delegate",
      agent: "claude",
      request: "review the API"
    }
  );
  assert.deepEqual(
    parseAkkCommand("c check the diff"),
    {
      action: "delegate",
      agent: "codex",
      request: "check the diff"
    }
  );
});

test("/akk help lists the supported tmux executors", () => {
  const usage = akkUsageText();
  assert.match(usage, /\/akk codex <task>/);
  assert.match(usage, /\/akk claude <task>/);
  assert.match(usage, /\/akk doctor/);
});

test("/akk doctor uses the trusted plugin workspace and OpenClaw binary", () => {
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand("doctor"),
      {
        workspace: "/work/project",
        openclawBin: "/opt/openclaw/bin/openclaw"
      }
    ),
    [
      "doctor",
      "--workspace",
      "/work/project",
      "--openclaw-bin",
      "/opt/openclaw/bin/openclaw"
    ]
  );
  assert.throws(
    () => parseAkkCommand("doctor tmux"),
    /Usage: \/akk doctor/u
  );
});

test("/akk accepts selector-first follow-ups without long ids", () => {
  assert.deepEqual(
    parseAkkCommand("send latest: continue with the tests"),
    {
      action: "send",
      conversationId: "latest",
      message: "continue with the tests"
    }
  );
  assert.deepEqual(
    parseAkkCommand("send codex: review the diff"),
    {
      action: "send",
      conversationId: "codex",
      message: "review the diff"
    }
  );
  assert.deepEqual(parseAkkCommand("status"), {
    action: "status",
    conversationId: undefined
  });
  assert.deepEqual(
    buildAkkCommandCliArgs(parseAkkCommand("status"), {}),
    ["status"]
  );
});

test("/akk stateful commands consistently use the trusted plugin store", () => {
  const config = {
    storeDir: "/private/akk-store",
    idleTimeoutMinutes: 45
  };
  const commands = [
    "list",
    "status conversation-1",
    "describe conversation-1",
    "send conversation-1 continue",
    "approve conversation-1 --expected-approval-fingerprint approval-1",
    "cancel conversation-1",
    "renew conversation-1 20",
    "retry-callback conversation-1",
    "close conversation-1 done"
  ];

  for (const input of commands) {
    const args = buildAkkCommandCliArgs(parseAkkCommand(input), config);
    assert.ok(args, input);
    assert.deepEqual(
      args.slice(args.indexOf("--store-dir"), args.indexOf("--store-dir") + 2),
      ["--store-dir", "/private/akk-store"],
      input
    );
  }
});

test("/akk terminal send configures a real OpenClaw callback", () => {
  const args = buildAkkCommandCliArgs(
    parseAkkCommand("send terminal:v2:tmux:claude:work:0.1:1234 continue"),
    {
      storeDir: "/private/akk-store",
      openclawBin: "/opt/openclaw/bin/openclaw",
      agentTimeoutMinutes: 90,
      agentHardTimeoutMinutes: 600
    },
    { sessionKey: "agent:chat:current" }
  );

  assert.ok(args);
  assert.deepEqual(optionValue(args, "--gateway-method"), AKK_CALLBACK_METHOD);
  assert.deepEqual(optionValue(args, "--gateway-session"), "agent:chat:current");
  assert.deepEqual(optionValue(args, "--openclaw-session"), "agent:chat:current");
  assert.deepEqual(optionValue(args, "--openclaw-bin"), "/opt/openclaw/bin/openclaw");
  assert.deepEqual(optionValue(args, "--agent-timeout-minutes"), "90");
  assert.deepEqual(optionValue(args, "--agent-hard-timeout-minutes"), "600");
  assert.equal(args.includes("--background"), true);
});

test("/akk approve requires and forwards an exact approval fingerprint", () => {
  assert.throws(
    () => parseAkkCommand("approve conversation-1"),
    /expected-approval-fingerprint/u
  );
  assert.deepEqual(
    buildAkkCommandCliArgs(
      parseAkkCommand(
        "approve conversation-1 --expected-approval-fingerprint approval-1"
      ),
      { storeDir: "/private/akk-store" }
    ),
    [
      "approve",
      "--conversation",
      "conversation-1",
      "--expected-approval-fingerprint",
      "approval-1",
      "--store-dir",
      "/private/akk-store"
    ]
  );
});

function optionValue(args: string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

test("/akk list includes terminal-controlled and native sessions", () => {
  const text = formatAkkListCommandResult({
    delegated: [{
      conversation_id: "managed-1",
      agent: "claude",
      status: "idle",
      request: "Review the repository"
    }],
    terminal_controlled: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      agent: "codex",
      status: "active"
    }],
    native: [{
      id: "native:codex:5678",
      agent: "codex",
      status: "active"
    }]
  });

  assert.match(text, /AKK open sessions \(3\)/);
  assert.match(text, /managed-1/);
  assert.match(text, /terminal:v2:tmux:codex:work:0\.0:1234/);
  assert.match(text, /native:codex:5678/);
});

test("/akk list exposes the exact orphaned terminal dispatch recovery command", () => {
  const text = formatAkkListCommandResult({
    terminal_controlled: [{
      id: "terminal:v2:tmux:codex:work:0.0:1234",
      short_ref: "@terminal1",
      agent: "codex",
      status: "active",
      orphaned_terminal_dispatch: {
        message_id: "message-1",
        recovery:
          "/akk close terminal:v2:tmux:codex:work:0.0:1234 " +
          "--expected-message-id message-1"
      }
    }]
  });

  assert.match(
    text,
    /recovery: \/akk close terminal:v2:tmux:codex:work:0\.0:1234 --expected-message-id message-1/u
  );
});

test("/akk list prefers stable short references while JSON retains full ids", () => {
  const text = formatAkkListCommandResult({
    delegated: [{
      id: "managed-long-id",
      conversation_id: "managed-long-id",
      short_ref: "@0123456789",
      agent: "codex",
      status: "idle"
    }]
  });

  assert.match(text, /@0123456789/u);
  assert.doesNotMatch(text, /managed-long-id/u);
});

test("relative plugin storeDir resolves against the configured workspace", () => {
  assert.equal(
    resolvePluginStoreDir(
      {
        workspace: "/work/project",
        storeDir: ".akk"
      },
      "/gateway"
    ),
    "/work/project/.akk"
  );
  assert.equal(
    optionValue(
      buildAkkCommandCliArgs(
        parseAkkCommand("list"),
        {
          workspace: "/work/project",
          storeDir: ".akk"
        }
      )!,
      "--store-dir"
    ),
    "/work/project/.akk"
  );
});
