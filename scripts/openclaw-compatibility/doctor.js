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
      history.sessionInfo?.hasActiveRun === false
    ) {
      break;
    }
    await delay(500);
  }

  assert.equal(history?.sessionKey, sessionKey);
  assert.equal(
    (history?.messages ?? []).some((message) =>
      message?.role === "user" && messageText(message) === "/akk doctor"
    ),
    true
  );
  assert.notEqual(assistant, undefined, "/akk doctor must return a reply");
  const text = messageText(assistant);
  assert.match(text, /OpenClaw package: ready/u);
  assert.match(text, /Gateway: healthy/u);
  assert.equal(assistant.model, "gateway-injected");
  assert.equal(assistant.provider, "openclaw");
  assert.equal(assistant.usage?.input ?? 0, 0);
  assert.equal(assistant.usage?.output ?? 0, 0);
  assert.equal(assistant.usage?.totalTokens ?? 0, 0);
  assert.equal(
    history.sessionInfo?.hasActiveRun,
    false,
    "/akk doctor run must settle after its injected reply"
  );
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
