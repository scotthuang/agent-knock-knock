import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultLogDir() {
  return path.join(os.homedir(), ".openclaw", "logs", "bidirectional");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathsForConversation(conversationId, logDir = defaultLogDir()) {
  return {
    logDir,
    logPath: path.join(logDir, `${conversationId}.ndjson`),
    statePath: path.join(logDir, `${conversationId}.state.json`)
  };
}

export function saveState(statePath, conversation) {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, `${JSON.stringify(conversation, null, 2)}\n`, "utf8");
}

export function loadState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function appendEvent(logPath, event) {
  ensureDir(path.dirname(logPath));
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function messageEvent(message) {
  return {
    ts: message.ts,
    conversation_id: message.conversation_id,
    event: "message",
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    round: message.round,
    body: message.body,
    message
  };
}

export function rawExchangeEvent({ conversationId, from, to, prompt, response, round, type = "raw_exchange" }) {
  return {
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    event: type,
    from,
    to,
    round,
    prompt,
    response
  };
}
