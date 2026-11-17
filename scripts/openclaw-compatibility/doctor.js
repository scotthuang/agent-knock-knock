import assert from "node:assert/strict";
import {
  safeName
} from "./command-runtime.js";
import {
  gatewayCall,
  delay
} from "./gateway.js";

export async function verifyAkkDoctorCommand({
  env,
  host,
  port,
  token,
  version,
  workspace
}) {
  const suffix = safeName(version);
  const sessionKey = `agent:main:akk-command-${suffix}`;
  const runId = `akk-command-${suffix}-1`;
  const baseline = gatewayCall({
    env, host, method: "chat.history", params: { sessionKey, limit: 20 },
    port, token, workspace
  });
  assert.equal(baseline.sessionKey, sessionKey);
  assert.equal((baseline.messages ?? []).some((message) =>
    message?.role === "assistant" && /AKK doctor:/u.test(messageText(message))), false,
  "the command must produce a fresh reply in its isolated session");
  const started = gatewayCall({
    env,
    host,
    method: "chat.send",
    params: {
      sessionKey,
      message: "/akk doctor",
      deliver: false,
      idempotencyKey: runId
    },
    port,
    token,
    workspace
  });
  assert.equal(started.status, "started");
  assert.equal(started.runId, runId);
  // Older chat.history omits active-run state. Use the exact native run's
  // terminal receipt instead of treating absent fields or idle as completion.
  const settled = gatewayCall({
    env, host, method: "agent.wait", params: { runId, timeoutMs: 10_000 },
    port, token, workspace
  });
  assert.equal(settled.runId, runId);
  assert.equal(settled.status, "ok", "/akk doctor must complete its exact native run");
  assert.equal(settled.error ?? null, null);

  let history;
  let assistant;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    history = gatewayCall({
      env,
      host,
      method: "chat.history",
      params: {
        sessionKey,
        limit: 20
      },
      port,
      token,
      workspace
    });
    assistant = (history.messages ?? []).find((message) => {
      const text = messageText(message);
      return message?.role === "assistant" &&
        /AKK doctor: (?:ready|needs attention)/u.test(text) &&
        /Gateway: healthy/u.test(text);
    });
    if (
      assistant &&
      (!history.sessionInfo || history.sessionInfo.hasActiveRun === false)
    ) {
      break;
    }
    await delay(500);
  }

  assert.equal(history?.sessionKey, sessionKey);
  // Legacy plugin commands bypass the model and need not persist a user row.
  // If the Host does persist one, it must still be our exact command.
  const userMessages = (history?.messages ?? []).filter((message) => message?.role === "user");
  for (const message of userMessages) assert.equal(messageText(message), "/akk doctor");
  assert.notEqual(assistant, undefined, "/akk doctor must return a reply");
  const text = messageText(assistant);
  assert.match(text, /OpenClaw package: ready/u);
  assert.match(text, /Gateway: healthy/u);
  assert.equal(assistant.model, "gateway-injected");
  assert.equal(assistant.provider, "openclaw");
  assert.equal(assistant.usage?.input ?? 0, 0);
  assert.equal(assistant.usage?.output ?? 0, 0);
  assert.equal(assistant.usage?.totalTokens ?? 0, 0);
  if (history.sessionInfo) {
    assert.equal(history.sessionInfo.hasActiveRun, false,
      "/akk doctor run must settle after its injected reply");
  }
  return {
    completion_source: "agent.wait",
    exact_run_verified: true,
    fresh_reply_verified: true,
    user_command_in_history: userMessages.length > 0,
    history_run_state_available: history.sessionInfo != null
  };
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .map((block) => typeof block?.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}
