import fs from "node:fs";
import path from "node:path";

export function defaultStoreDir(workspace = process.cwd()) {
  return path.join(workspace, ".agent-knock-knock", "conversations");
}

export function defaultLogDir(workspace = process.cwd()) {
  return defaultStoreDir(workspace);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function pathsForConversation(conversationId, storeDir = defaultStoreDir()) {
  const conversationDir = path.join(storeDir, conversationId);
  return {
    storeDir,
    logDir: storeDir,
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function pathsForConversationDir(conversationDir) {
  return {
    storeDir: path.dirname(conversationDir),
    logDir: path.dirname(conversationDir),
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function logPathForStatePath(statePath) {
  if (path.basename(statePath) === "state.json") {
    return path.join(path.dirname(statePath), "events.ndjson");
  }

  return statePath.replace(/\.state\.json$/, ".ndjson");
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
  assertAppendableEventLog(logPath);
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function assertAppendableEventLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return true;
  }

  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  for (const [index, line] of lines.entries()) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`event log is not valid NDJSON at line ${index + 1}: ${error.message}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.event !== "string") {
      throw new Error(`event log line ${index + 1} is not an event object`);
    }
  }

  return true;
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
