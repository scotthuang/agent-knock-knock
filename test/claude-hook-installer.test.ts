import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_HOOK_EVENT_NAMES,
  extractClaudeTokenjuiceLaunchers,
  installClaudeHooks,
  loadTrustedClaudeTokenjuiceLaunchers,
  mergeClaudeHookSettings
} from "../src/claude-hook-installer.js";

const EXECUTABLE = "/opt/agent-knock-knock/bin/agent-knock-knock";

test("loads only an executable absolute Tokenjuice launcher from trusted Claude settings", (t) => {
  const root = temporaryDirectory(t);
  const launcher = path.join(root, "tokenjuice");
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: `${launcher} claude-code-pre-tool-use --wrap-launcher '${launcher}'`
        }]
      }]
    }
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  assert.deepEqual(extractClaudeTokenjuiceLaunchers(settings), [launcher]);
  assert.deepEqual(loadTrustedClaudeTokenjuiceLaunchers(settingsPath), [{
    configuredPath: launcher,
    canonicalPath: fs.realpathSync(launcher)
  }]);
  assert.deepEqual(extractClaudeTokenjuiceLaunchers({
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: "tokenjuice claude-code-pre-tool-use --wrap-launcher ./tokenjuice"
        }]
      }]
    }
  }), []);
});

test("installs the six official Claude lifecycle hooks using exec form", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, ".claude", "settings.json");
  const result = installClaudeHooks({ executablePath: EXECUTABLE, settingsPath });

  assert.equal(result.changed, true);
  assert.equal(result.written, true);
  assert.equal(result.created, true);
  assert.equal(result.backupPath, undefined);
  assert.deepEqual(result.addedEvents, [...CLAUDE_HOOK_EVENT_NAMES]);
  assert.deepEqual(result.summary, { addedCount: 6, existingCount: 0, warningCount: 0 });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);

  const settings = readJson(settingsPath);
  const hooks = objectValue(settings.hooks);
  assert.deepEqual(objectValue(arrayValue(hooks.SessionStart)[0]), {
    matcher: "startup|resume|clear|compact|fork",
    hooks: [{ type: "command", command: EXECUTABLE, args: ["claude-hook"], timeout: 10 }]
  });
  assert.deepEqual(objectValue(arrayValue(hooks.UserPromptSubmit)[0]), {
    hooks: [{ type: "command", command: EXECUTABLE, args: ["claude-hook"], timeout: 10 }]
  });
  assert.deepEqual(objectValue(arrayValue(hooks.PermissionRequest)[0]), {
    matcher: "*",
    hooks: [{
      type: "command",
      command: EXECUTABLE,
      args: ["claude-hook"],
      timeout: 600,
      statusMessage: "Waiting for Agent Knock Knock approval..."
    }]
  });
  assert.deepEqual(objectValue(arrayValue(hooks.Stop)[0]), {
    hooks: [{ type: "command", command: EXECUTABLE, args: ["claude-hook"], timeout: 10 }]
  });
  assert.deepEqual(objectValue(arrayValue(hooks.StopFailure)[0]), {
    matcher: "rate_limit|authentication_failed|oauth_org_not_allowed|billing_error|invalid_request|model_not_found|server_error|max_output_tokens|unknown",
    hooks: [{ type: "command", command: EXECUTABLE, args: ["claude-hook"], timeout: 10 }]
  });
  assert.deepEqual(objectValue(arrayValue(hooks.Notification)[0]), {
    matcher: "permission_prompt|idle_prompt|agent_needs_input|agent_completed",
    hooks: [{ type: "command", command: EXECUTABLE, args: ["claude-hook"], timeout: 10 }]
  });
});

test("preserves settings, tokenjuice, and sibling hooks while creating a recoverable backup", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "settings.json");
  const original = {
    env: { ANTHROPIC_API_KEY: "private-test-value" },
    model: "opus",
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: "/Users/test/.tokenjuice/bin/tokenjuice",
          args: ["claude-hook"]
        }]
      }],
      Stop: [{
        hooks: [{ type: "command", command: "/opt/existing/notifier", timeout: 30 }]
      }]
    },
    permissions: { allow: ["Read"] }
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, { mode: 0o644 });

  const result = installClaudeHooks({
    executablePath: EXECUTABLE,
    settingsPath,
    now: () => new Date("2026-07-23T03:04:05.678Z")
  });

  assert.equal(result.backupPath, `${settingsPath}.bak.2026-07-23T03-04-05-678Z`);
  assert.deepEqual(readJson(result.backupPath!), original);
  assert.equal(fs.statSync(result.backupPath!).mode & 0o777, 0o600);
  const installed = readJson(settingsPath);
  assert.deepEqual(installed.env, original.env);
  assert.deepEqual(installed.model, original.model);
  assert.deepEqual(installed.permissions, original.permissions);
  const hooks = objectValue(installed.hooks);
  assert.deepEqual(hooks.PreToolUse, original.hooks.PreToolUse);
  const stopGroups = arrayValue(hooks.Stop);
  assert.equal(stopGroups.length, 2);
  assert.deepEqual(objectValue(stopGroups[0]), original.hooks.Stop[0]);
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
});

test("a second install is idempotent and creates no additional backup", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "settings.json");
  const first = installClaudeHooks({ executablePath: EXECUTABLE, settingsPath });
  const firstContents = fs.readFileSync(settingsPath, "utf8");
  const second = installClaudeHooks({ executablePath: EXECUTABLE, settingsPath });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.written, false);
  assert.equal(second.backupPath, undefined);
  assert.deepEqual(second.existingEvents, [...CLAUDE_HOOK_EVENT_NAMES]);
  assert.deepEqual(second.summary, { addedCount: 0, existingCount: 6, warningCount: 0 });
  assert.equal(fs.readFileSync(settingsPath, "utf8"), firstContents);
  assert.equal(fs.readdirSync(root).filter((name) => name.includes(".bak.")).length, 0);
});

test("deduplicates only exact executable and claude-hook args and preserves variants", () => {
  const exactButCustom = {
    type: "command",
    command: EXECUTABLE,
    args: ["claude-hook"],
    timeout: 42
  };
  const differentArgs = {
    type: "command",
    command: EXECUTABLE,
    args: ["other-hook"],
    timeout: 10
  };
  const sibling = { type: "command", command: "/opt/sibling", args: ["claude-hook"] };
  const merged = mergeClaudeHookSettings({
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [differentArgs, sibling] }],
      Stop: [{ matcher: "ignored", hooks: [exactButCustom, sibling] }]
    }
  }, EXECUTABLE);

  assert.equal(merged.changed, true);
  assert.deepEqual(merged.existingEvents, ["Stop"]);
  assert.ok(merged.addedEvents.includes("SessionStart"));
  assert.equal(merged.warnings.length, 2);
  const hooks = objectValue(merged.settings.hooks);
  const sessionGroups = arrayValue(hooks.SessionStart);
  assert.equal(sessionGroups.length, 2);
  assert.deepEqual(objectValue(sessionGroups[0]).hooks, [differentArgs, sibling]);
  const stopGroups = arrayValue(hooks.Stop);
  assert.equal(stopGroups.length, 1);
  assert.deepEqual(objectValue(stopGroups[0]).hooks, [exactButCustom, sibling]);
});

test("dry-run returns a non-sensitive summary without touching settings or backups", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "settings.json");
  const secret = "must-not-appear-in-result";
  const original = `${JSON.stringify({ env: { API_TOKEN: secret } }, null, 2)}\n`;
  fs.writeFileSync(settingsPath, original, { mode: 0o600 });

  const result = installClaudeHooks({ executablePath: EXECUTABLE, settingsPath, dryRun: true });

  assert.equal(result.changed, true);
  assert.equal(result.written, false);
  assert.equal(result.created, false);
  assert.equal(result.backupPath, undefined);
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".bak.")), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("dry-run for a missing file does not create its parent directory", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "missing", ".claude", "settings.json");
  const result = installClaudeHooks({ executablePath: EXECUTABLE, settingsPath, dryRun: true });

  assert.equal(result.changed, true);
  assert.equal(result.written, false);
  assert.equal(result.created, false);
  assert.equal(fs.existsSync(path.dirname(settingsPath)), false);
});

test("fails closed for invalid JSON without including file contents in the error", (t) => {
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "settings.json");
  const secret = "private-invalid-json-value";
  fs.writeFileSync(settingsPath, `{\"token\":\"${secret}\"`, { mode: 0o600 });

  assert.throws(
    () => installClaudeHooks({ executablePath: EXECUTABLE, settingsPath }),
    (error: unknown) => {
      assert.match(String(error), /Claude settings JSON is invalid/u);
      assert.equal(String(error).includes(secret), false);
      return true;
    }
  );
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".bak.")), false);
});

test("rejects relative executables and non-array target hook sections without overwriting", (t) => {
  assert.throws(
    () => mergeClaudeHookSettings({}, "agent-knock-knock"),
    /must be absolute/u
  );
  const root = temporaryDirectory(t);
  const settingsPath = path.join(root, "settings.json");
  const original = `${JSON.stringify({ hooks: { Stop: { unexpected: true } } }, null, 2)}\n`;
  fs.writeFileSync(settingsPath, original, { mode: 0o600 });

  assert.throws(
    () => installClaudeHooks({ executablePath: EXECUTABLE, settingsPath }),
    /hooks\.Stop must be an array/u
  );
  assert.equal(fs.readFileSync(settingsPath, "utf8"), original);
  assert.equal(fs.readdirSync(root).some((name) => name.includes(".bak.")), false);
});

function temporaryDirectory(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-hook-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}
