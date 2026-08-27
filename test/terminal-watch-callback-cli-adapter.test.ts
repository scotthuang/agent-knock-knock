import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalWatchCallbackCliAdapter,
  resolveTerminalWatchOpenClawCallback,
  type TerminalWatchTransportDeliveryInput
} from "../src/terminal-watch-callback-cli-adapter.js";
import { createCallbackEnvelope } from "../src/callback-transport.js";

function transportDelivery(): TerminalWatchTransportDeliveryInput {
  const callback = resolveTerminalWatchOpenClawCallback({
    openclaw_session: "agent:main:transport",
    openclaw_bin: "/opt/openclaw-transport"
  });
  return {
    route: callback.route,
    context: callback.context,
    envelope: createCallbackEnvelope({
      route: callback.route,
      deliveryId: "terminal-watch-notification-transport",
      idempotencyKey:
        "agent-knock-knock:terminal-watch:watch-transport:notification-1",
      source: {
        kind: "terminal_watch",
        watch_id: "terminal-watch-transport",
        terminal_id: "terminal:v2:transport"
      },
      event: {
        id: "terminal-watch-notification-transport",
        type: "completed",
        body: "bounded host-neutral callback body",
        requires_response: true
      }
    }),
    attempt: { number: 2, id: "attempt-transport-2" }
  };
}

test("Terminal Watch callback uses one deterministic chat.send delivery", () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const adapter = createTerminalWatchCallbackCliAdapter({
    environment: () => ({ PATH: "/test/bin", OPENCLAW_GATEWAY_TOKEN: "secret" }),
    spawnSync(command, args, options) {
      calls.push({ command, args, env: options.env });
      const params = JSON.parse(String(args[4]));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "started"
        }),
        stderr: ""
      };
    }
  });

  adapter.deliver({
    watchId: "watch:v1:00000000-0000-4000-8000-000000000001",
    idempotencyKey: "agent-knock-knock:terminal-watch:watch-1:completion-1",
    event: "completed",
    agent: "codex",
    terminalId: "terminal:v1:tmux:%1",
    openclawSession: "agent:main:main",
    openclawBin: "/opt/openclaw",
    detail: "exact Codex task_complete observed",
    completionText: "Implemented the requested change."
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "/opt/openclaw");
  assert.deepEqual(calls[0]?.args.slice(0, 3), [
    "gateway",
    "call",
    "chat.send"
  ]);
  const params = JSON.parse(String(calls[0]?.args[4]));
  assert.equal(params.sessionKey, "agent:main:main");
  assert.equal(params.deliver, true);
  assert.match(params.message, /exact task anchor in the terminal selected by the user/u);
  assert.match(params.message, /Implemented the requested change/u);
  assert.equal(calls[0]?.env.OPENCLAW_GATEWAY_TOKEN, "secret");
});

test("Terminal Watch approval callback forbids automatic approval", () => {
  let message = "";
  const adapter = createTerminalWatchCallbackCliAdapter({
    spawnSync(_command, args) {
      const params = JSON.parse(String(args[4]));
      message = params.message;
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "in_flight"
        }),
        stderr: ""
      };
    }
  });
  adapter.deliver({
    watchId: "watch:v1:00000000-0000-4000-8000-000000000002",
    idempotencyKey: "agent-knock-knock:terminal-watch:watch-2:approval-1",
    event: "approval_required",
    agent: "claude",
    terminalId: "terminal:v1:tmux:%2",
    openclawSession: "agent:main:main"
  });
  assert.match(message, /human to inspect and decide in the named live TUI/u);
  assert.match(message, /Do not call any AKK approval tool or action/u);
  assert.match(message, /do not send approval keys/u);
  assert.doesNotMatch(message, /use only the terminal row's current AKK approval action/u);
});

test("Terminal Watch callback rejects malformed or mismatched acknowledgements", () => {
  const malformed = createTerminalWatchCallbackCliAdapter({
    spawnSync: () => ({ status: 0, stdout: "not-json", stderr: "" })
  });
  assert.throws(
    () => malformed.deliver({
      watchId: "watch:v1:00000000-0000-4000-8000-000000000003",
      idempotencyKey: "agent-knock-knock:terminal-watch:watch-3:failure-1",
      event: "failed",
      agent: "codex",
      terminalId: "terminal:v1:tmux:%3",
      openclawSession: "agent:main:main"
    }),
    /malformed JSON/u
  );

  const mismatch = createTerminalWatchCallbackCliAdapter({
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ runId: "wrong", status: "started" }),
      stderr: ""
    })
  });
  assert.throws(
    () => mismatch.deliver({
      watchId: "watch:v1:00000000-0000-4000-8000-000000000004",
      idempotencyKey: "agent-knock-knock:terminal-watch:watch-4:timeout-1",
      event: "timed_out",
      agent: "claude",
      terminalId: "terminal:v1:tmux:%4",
      openclawSession: "agent:main:main"
    }),
    /does not match/u
  );

  const rejected = createTerminalWatchCallbackCliAdapter({
    spawnSync: (_command, args) => {
      const params = JSON.parse(String(args[4]));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "error"
        }),
        stderr: ""
      };
    }
  });
  assert.throws(
    () => rejected.deliver({
      watchId: "terminal-watch-00000000-0000-4000-8000-000000000005",
      idempotencyKey:
        "agent-knock-knock:terminal-watch:watch-5:cancelled-1",
      event: "cancelled",
      agent: "codex",
      terminalId: "terminal:v1:tmux:%5",
      openclawSession: "agent:main:main"
    }),
    /was not accepted: error/u
  );
});

test("Terminal Watch transport delivers a host-neutral envelope through its trusted profile context", () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const adapter = createTerminalWatchCallbackCliAdapter({
    now: () => new Date("2026-08-23T01:02:03.000Z"),
    spawnSync(command, args) {
      calls.push({ command, args });
      const params = JSON.parse(String(args[4]));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "started"
        }),
        stderr: ""
      };
    }
  });

  const input = transportDelivery();
  assert.equal(input.route.transport, "openclaw_gateway_v1");
  assert.equal(input.route.profile_id, "legacy-openclaw-cli");
  assert.deepEqual(input.route.capabilities, { wake: true, respond: false });
  assert.doesNotMatch(JSON.stringify(input.route), /openclaw-transport/u);
  const outcome = adapter.deliverTransport?.(input);
  assert.deepEqual(outcome, {
    disposition: "accepted",
    accepted_at: "2026-08-23T01:02:03.000Z",
    acceptance_id: input.envelope.idempotency_key,
    evidence: { status: "started" }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/opt/openclaw-transport");
  const params = JSON.parse(String(calls[0].args[4]));
  assert.equal(params.sessionKey, input.route.controller_session_id);
  assert.equal(params.message, input.envelope.event.body);
  assert.equal(params.idempotencyKey, input.envelope.idempotency_key);
});

test("Terminal Watch transport treats an invalid acknowledgement as uncertain", () => {
  const adapter = createTerminalWatchCallbackCliAdapter({
    now: () => new Date("2026-08-23T01:02:03.000Z"),
    spawnSync: () => ({ status: 0, stdout: "not-json", stderr: "" })
  });
  assert.deepEqual(adapter.deliverTransport?.(transportDelivery()), {
    disposition: "uncertain",
    error_code: "openclaw_chat_send_ack_uncertain",
    observed_at: "2026-08-23T01:02:03.000Z"
  });
});

test("Terminal Watch transport rejects route drift before invoking OpenClaw", () => {
  let calls = 0;
  const adapter = createTerminalWatchCallbackCliAdapter({
    spawnSync: () => {
      calls += 1;
      return { status: 0, stdout: "{}", stderr: "" };
    }
  });
  const input = transportDelivery();
  const drifted = {
    ...input,
    route: {
      ...input.route,
      controller_session_id: "agent:other:session"
    }
  };
  assert.deepEqual(adapter.deliverTransport?.(drifted), {
    disposition: "permanent_failure",
    error_code: "callback_envelope_route_mismatch"
  });
  assert.equal(calls, 0);
});
