#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { normalizeAcpxOutput } from "../src/acpx-output.js";
import {
  applyMessageToConversation,
  createConversation,
  createMessage,
  extractStructuredMessage
} from "../src/protocol.js";
import {
  appendEvent,
  defaultStoreDir,
  messageEvent,
  pathsForConversation,
  rawExchangeEvent,
  saveState
} from "../src/store.js";

const args = parseArgs(process.argv.slice(2));
const managerSession = args.managerSession ?? "akk-manager-weather";
const developerSession = args.developerSession ?? "akk-developer-weather";
const storeDir = args.storeDir ?? args.logDir ?? defaultStoreDir(process.cwd());
const location = args.location ?? "广州";
const dryRun = Boolean(args.dryRun);
const timeoutMs = Number(args.timeoutMs ?? 45000);
const runner = args.runner ?? "claude-cli";
const scenario = args.scenario ?? "weather";

const conversation = createConversation({
  userRequest: `请查询今天${location}的天气，并把结果交付给 OpenClaw manager。`,
  claudeSession: developerSession,
  workspace: process.cwd()
});
const paths = pathsForConversation(conversation.conversation_id, storeDir);

let state = {
  ...conversation,
  store_dir: paths.storeDir,
  conversation_dir: paths.conversationDir,
  event_log_path: paths.logPath,
  state_path: paths.statePath,
  manager_session: managerSession,
  developer_session: developerSession,
  status: "running"
};

appendEvent(paths.logPath, {
  ts: new Date().toISOString(),
  conversation_id: state.conversation_id,
  event: "conversation_created",
  mode: "two-claude-simulation",
  runner,
  manager_session: managerSession,
  developer_session: developerSession,
  location,
  scenario,
  dry_run: dryRun
});
saveState(paths.statePath, state);

if (!dryRun && runner === "acpx") {
  run("acpx", ["claude", "sessions", "new", "--name", managerSession], { allowFailure: true, timeoutMs });
  run("acpx", ["claude", "sessions", "new", "--name", developerSession], { allowFailure: true, timeoutMs });
}

const taskBody = scenario === "architecture-questions"
  ? "你是 Developer Claude。请模拟一个开发任务：为一个新项目选择数据存储和 API 风格。你必须先提出两个会影响架构的 question，每次只问一个问题；收到 Manager answer 后再问下一个。第二个 answer 后，输出 done，总结最终架构选择。"
  : `你是 Developer Claude。请查询今天${location}的天气，给出温度、天气状况、降水/湿度/风力等可获得信息，并说明信息来源。若不能联网，请明确说明失败原因。请只输出一个 JSON message，type 为 done 或 blocked。`;

const taskMessage = createMessage({
  conversation: state,
  from: "openclaw",
  to: "claude-code",
  type: "task",
  body: taskBody
});
state = applyAndLog(state, taskMessage);

if (scenario === "architecture-questions") {
  runArchitectureQuestionsScenario();
} else {
  runWeatherScenario();
}

process.stdout.write(JSON.stringify({
  conversation_id: state.conversation_id,
  status: state.status,
  log_path: paths.logPath,
  state_path: paths.statePath,
  conversation_dir: paths.conversationDir,
  manager_session: managerSession,
  developer_session: developerSession,
  runner,
  scenario
}, null, 2));
process.stdout.write("\n");

function runWeatherScenario() {
  const developerPrompt = `${developerProtocolPrompt()}

Return exactly one JSON object matching this schema:
{
  "from": "claude-code",
  "to": "openclaw",
  "type": "done" | "blocked",
  "requires_response": false for done, true for blocked,
  "body": "weather result or failure reason"
}

Task message:
${JSON.stringify(taskMessage)}

Use available tools or knowledge to answer today's weather for ${location}. If live lookup is unavailable, say so clearly.`;

  const developerResponse = dryRun
    ? '{"from":"claude-code","to":"openclaw","type":"blocked","body":"[dry-run] Developer Claude would check weather and return a structured done/blocked message."}'
    : callClaude({ session: developerSession, prompt: developerPrompt, timeoutMs, runner });

  appendRawExchange({
    conversationId: state.conversation_id,
    from: "openclaw",
    to: "claude-code",
    round: 1,
    prompt: developerPrompt,
    response: developerResponse
  });

  const developerMessage = structuredMessageFromResponse({
    response: developerResponse,
    defaultFrom: "claude-code",
    defaultTo: "openclaw"
  });
  state = applyAndLog(state, developerMessage);

  const managerPrompt = `${managerProtocolPrompt()}

Review Developer Claude's result and return exactly one concise final delivery summary in Chinese.

Conversation state:
${JSON.stringify(state)}

Developer response:
${developerResponse}`;

  const managerResponse = dryRun
    ? "[dry-run] Manager Claude would summarize the final delivery for the user."
    : callClaude({ session: managerSession, prompt: managerPrompt, timeoutMs, runner });

  if (/runner failed|timed out|timeout|API Error/i.test(managerResponse)) {
    markFailed();
  } else if (developerMessage.type === "blocked") {
    markFailed();
  }

  appendRawExchange({
    conversationId: state.conversation_id,
    from: "claude-code",
    to: "openclaw",
    round: state.response_rounds_used,
    prompt: managerPrompt,
    response: managerResponse,
    type: "manager_final"
  });

  closeConversation(managerResponse.trim());
}

function runArchitectureQuestionsScenario() {
  const steps = [
    {
      developerInstruction: "Ask your first architecture question. It must be about data storage. Return exactly one JSON object with type=question and requires_response=true.",
      managerInstruction: "Answer the first architecture question directly. Choose a pragmatic default for an MVP. Return exactly one JSON object with type=answer and requires_response=true."
    },
    {
      developerInstruction: "Based on the Manager answer, ask your second architecture question. It must be about API style. Return exactly one JSON object with type=question and requires_response=true.",
      managerInstruction: "Answer the second architecture question directly. Choose a pragmatic default for an MVP. Return exactly one JSON object with type=answer and requires_response=true."
    },
    {
      developerInstruction: "Based on both Manager answers, finish the simulated task. Return exactly one JSON object with type=done and requires_response=false, summarizing the final architecture choices.",
      managerInstruction: null
    }
  ];

  const transcript = [];

  for (const [index, step] of steps.entries()) {
    const developerPrompt = `${developerProtocolPrompt()}

Conversation transcript so far:
${JSON.stringify(transcript, null, 2)}

Current state:
${JSON.stringify(state)}

Task:
${taskMessage.body}

Instruction:
${step.developerInstruction}`;

    const developerResponse = dryRun
      ? dryRunDeveloperResponse(index)
      : callClaude({ session: developerSession, prompt: developerPrompt, timeoutMs, runner });

    appendRawExchange({
      conversationId: state.conversation_id,
      from: "openclaw",
      to: "claude-code",
      round: state.response_rounds_used,
      prompt: developerPrompt,
      response: developerResponse,
      type: `developer_step_${index + 1}`
    });

    const developerMessage = structuredMessageFromResponse({
      response: developerResponse,
      defaultFrom: "claude-code",
      defaultTo: "openclaw"
    });
    state = applyAndLog(state, developerMessage);
    transcript.push({ from: "developer", type: developerMessage.type, body: developerMessage.body });

    if (!step.managerInstruction) {
      continue;
    }

    const managerPrompt = `${managerProtocolPrompt()}

Conversation transcript so far:
${JSON.stringify(transcript, null, 2)}

Current state:
${JSON.stringify(state)}

Instruction:
${step.managerInstruction}`;

    const managerResponse = dryRun
      ? dryRunManagerResponse(index)
      : callClaude({ session: managerSession, prompt: managerPrompt, timeoutMs, runner });

    appendRawExchange({
      conversationId: state.conversation_id,
      from: "claude-code",
      to: "openclaw",
      round: state.response_rounds_used,
      prompt: managerPrompt,
      response: managerResponse,
      type: `manager_step_${index + 1}`
    });

    const managerMessage = structuredMessageFromResponse({
      response: managerResponse,
      defaultFrom: "openclaw",
      defaultTo: "claude-code"
    });
    state = applyAndLog(state, managerMessage);
    transcript.push({ from: "manager", type: managerMessage.type, body: managerMessage.body });
  }

  closeConversation("Architecture questions scenario completed.");
}

function structuredMessageFromResponse({ response, defaultFrom, defaultTo }) {
  return extractStructuredMessage({
    conversation: state,
    input: response,
    defaultFrom,
    defaultTo
  });
}

function appendRawExchange({ conversationId, from, to, prompt, response, round, type }) {
  appendEvent(paths.logPath, rawExchangeEvent({
    conversationId,
    from,
    to,
    prompt,
    response,
    round,
    type
  }));

  for (const event of normalizeAcpxOutput({ conversationId, from, to, round, output: response })) {
    appendEvent(paths.logPath, event);
  }
}

function applyAndLog(currentState, message) {
  appendEvent(paths.logPath, messageEvent(message));
  const nextState = applyMessageToConversation(currentState, message);
  saveState(paths.statePath, nextState);
  return nextState;
}

function closeConversation(managerFinal) {
  appendEvent(paths.logPath, {
    ts: new Date().toISOString(),
    conversation_id: state.conversation_id,
    event: "conversation_closed",
    status: state.status,
    response_rounds_used: state.response_rounds_used,
    manager_final: managerFinal
  });
  saveState(paths.statePath, state);
}

function markFailed() {
  state = {
    ...state,
    status: "failed",
    updated_at: new Date().toISOString()
  };
  saveState(paths.statePath, state);
}

function developerProtocolPrompt() {
  return `You are Developer Claude in a two-Claude managed delegation test.

Role:
- You are the engineering implementation agent.
- OpenClaw/Manager owns product direction, requirements interpretation, acceptance criteria, and delivery tradeoffs.
- You own code changes, commands, tests, and implementation tactics.

Protocol:
- Ask question messages for ambiguous requirements, product behavior, UX, scope, acceptance criteria, architecture/risk/permission decisions, or engineering constraints that would require a product compromise.
- Do not silently narrow scope, degrade quality, accept a workaround, or change delivery standards because of an engineering problem. Ask OpenClaw/Manager first.
- Decide ordinary implementation details yourself when they do not affect product outcome.
- Follow OpenClaw/Manager's answer as the product decision.
- Use the fewest response-requiring rounds possible.
- Only messages with requires_response=true consume response rounds.
- Soft response limit: 50.
- Hard response limit: 100.
- At 30 response rounds, converge and choose the shortest completion path.
- At 40 response rounds, finish, degrade, or provide a failure reason within 10 response rounds.
- Return structured JSON when asked.`;
}

function managerProtocolPrompt() {
  return `You are Manager Claude simulating OpenClaw.

Role:
- You are the autonomous product manager, requirements owner, and final acceptance decision maker.
- Developer Claude owns engineering execution.
- You own product direction, requirements interpretation, acceptance criteria, delivery scope, UX behavior, and any compromise or degradation decision.

Protocol:
- Answer Developer Claude's question/blocker directly from the product and acceptance perspective.
- Do not ask the human user for process decisions.
- Avoid taking over implementation details unless they affect product outcome.
- Prefer small shippable scope when it still satisfies the user's intent.
- Track response rounds using requires_response=true messages.
- Soft response limit: 50.
- Hard response limit: 100.
- At 30 response rounds, require Developer Claude to converge and list remaining work.
- At 40 response rounds, warn Developer Claude to finish, degrade, or fail within 10 response rounds.
- At 50 response rounds, end by default unless completion is clearly near.
- At 100 response rounds, force termination.
- Return structured JSON when asked.`;
}

function dryRunDeveloperResponse(index) {
  const responses = [
    '{"from":"claude-code","to":"openclaw","type":"question","requires_response":true,"body":"MVP 数据存储应选择 SQLite 还是 Postgres？"}',
    '{"from":"claude-code","to":"openclaw","type":"question","requires_response":true,"body":"API 风格应选择 REST 还是 GraphQL？"}',
    '{"from":"claude-code","to":"openclaw","type":"done","requires_response":false,"body":"最终选择 SQLite + REST，适合 MVP 快速交付。"}'
  ];
  return responses[index];
}

function dryRunManagerResponse(index) {
  const responses = [
    '{"from":"openclaw","to":"claude-code","type":"answer","requires_response":true,"body":"选择 SQLite。MVP 单机开发和本地验证优先，后续可迁移 Postgres。"}',
    '{"from":"openclaw","to":"claude-code","type":"answer","requires_response":true,"body":"选择 REST。需求简单、调试直接、客户端生成和测试成本更低。"}'
  ];
  return responses[index];
}

function callClaude({ session, prompt, timeoutMs, runner }) {
  if (runner === "acpx") {
    const result = run("acpx", ["--approve-all", "claude", "-s", session, prompt], {
      timeoutMs,
      allowFailure: true
    });
    return responseText(result);
  }

  if (runner === "claude-cli") {
    const result = run("claude", ["-p", prompt, "--output-format", "text", "--no-session-persistence"], {
      timeoutMs,
      allowFailure: true
    });
    return responseText(result);
  }

  throw new Error(`unknown runner: ${runner}`);
}

function responseText(result) {
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status && result.status !== 0) {
    return `runner failed with status ${result.status}:\n${text}`;
  }

  return text || "runner returned no output";
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024 * 10
  });

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      return {
        status: 124,
        stdout: `${command} timed out after ${options.timeoutMs}ms`,
        stderr: `${command} timed out after ${options.timeoutMs}ms`
      };
    }

    throw result.error;
  }

  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(result.stderr || result.stdout || `${command} failed with status ${result.status}`);
  }

  return result;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }

    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}
