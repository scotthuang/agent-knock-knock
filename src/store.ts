import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage, Conversation } from "./protocol.js";

export function defaultStoreDir(_workspace = process.cwd()): string {
  return path.join(os.homedir(), ".agent-knock-knock", "conversations");
}

export function defaultLogDir(workspace = process.cwd()): string {
  return defaultStoreDir(workspace);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export interface ConversationPaths {
  storeDir: string;
  logDir: string;
  conversationDir: string;
  logPath: string;
  statePath: string;
}

export interface EventRecord {
  event: string;
  [key: string]: unknown;
}

export function pathsForConversation(conversationId: string, storeDir = defaultStoreDir()): ConversationPaths {
  const conversationDir = path.join(storeDir, conversationId);
  return {
    storeDir,
    logDir: storeDir,
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function pathsForConversationDir(conversationDir: string): ConversationPaths {
  return {
    storeDir: path.dirname(conversationDir),
    logDir: path.dirname(conversationDir),
    conversationDir,
    logPath: path.join(conversationDir, "events.ndjson"),
    statePath: path.join(conversationDir, "state.json")
  };
}

export function logPathForStatePath(statePath: string): string {
  if (path.basename(statePath) === "state.json") {
    return path.join(path.dirname(statePath), "events.ndjson");
  }

  return statePath.replace(/\.state\.json$/, ".ndjson");
}

export function saveState(statePath: string, conversation: Conversation): void {
  ensureDir(path.dirname(statePath));
  fs.writeFileSync(statePath, `${JSON.stringify(conversation, null, 2)}\n`, "utf8");
}

export function loadState(statePath: string): Conversation {
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as Conversation;
}

export function statePathForConversationId(conversationId: string, storeDir = defaultStoreDir()): string {
  return path.join(storeDir, conversationId, "state.json");
}

export function loadConversationById(conversationId: string, storeDir = defaultStoreDir()): Conversation {
  return loadState(statePathForConversationId(conversationId, storeDir));
}

export function listConversations(storeDir = defaultStoreDir()): Conversation[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }

  return fs.readdirSync(storeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(storeDir, entry.name, "state.json"))
    .filter((statePath) => fs.existsSync(statePath))
    .map((statePath) => {
      const conversation = loadState(statePath);
      return {
        ...conversation,
        state_path: conversation.state_path ?? statePath,
        event_log_path: conversation.event_log_path ?? logPathForStatePath(statePath),
        conversation_dir: conversation.conversation_dir ?? path.dirname(statePath)
      };
    })
    .sort((left: Conversation, right: Conversation) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
}

export function appendEvent(logPath: string, event: EventRecord): void {
  ensureDir(path.dirname(logPath));
  assertAppendableEventLog(logPath);
  fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, "utf8");
}

export function assertAppendableEventLog(logPath: string): true {
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
      throw new Error(`event log is not valid NDJSON at line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.event !== "string") {
      throw new Error(`event log line ${index + 1} is not an event object`);
    }
  }

  return true;
}

export function messageEvent(message: AgentMessage): EventRecord {
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

export function rawExchangeEvent({
  conversationId,
  from,
  to,
  prompt,
  response,
  round,
  type = "raw_exchange"
}: {
  conversationId: string;
  from: string;
  to: string;
  prompt: string;
  response: string;
  round: number;
  type?: string;
}): EventRecord {
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
