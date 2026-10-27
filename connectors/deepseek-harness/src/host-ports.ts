import { createHash } from "node:crypto";
import fs from "node:fs";

import type { Agent } from "@deepseek-ai/dsh-agent";

import { canonicalDirectoryPath, type DurableRouteRecord, type SessionIdentity } from "./callback-authority.js";

export interface DshRecoveryHostPorts {
  sessionIdentity(agent: Agent): SessionIdentity;
  restoreAgent(route: DurableRouteRecord): Promise<Agent>;
  flush(agent: Agent): Promise<boolean>;
  findOwnMessage(agent: Agent, messageId: string): Promise<boolean>;
}
export interface DshRecoveryHost extends DshRecoveryHostPorts {
  readonly profileDirectory: string;
  readonly storeDirectory: string;
  observeSessionIdentity(sessionId: string): Promise<SessionIdentity>;
}
interface ServicesContext {
  get?(name: string): unknown;
}
interface AgentLookup { get(id: Agent["id"]): Agent | undefined }
interface SessionObservation {
  readonly header: unknown;
  readonly inheritedEventCount: number;
  readonly events: readonly unknown[];
  readonly cursor: number;
  [Symbol.dispose](): void;
}
interface SessionQuery {
  observeSession(id: string, options: { projectionMode: "none" }): Promise<SessionObservation>;
}
interface SessionController {
  resolveAgent(id: string): Promise<{ agent?: Agent; error?: unknown }>;
}
interface SessionStore {
  get(id: Agent["id"]): unknown;
  flush(session: unknown): Promise<boolean>;
}

/** Older Hosts keep their existing live-only route behavior when ports are absent. */
export function createDshRecoveryHostPorts(ctx: ServicesContext, storeDirectory: string): DshRecoveryHost | undefined {
  const profile = service(ctx, "profileContext");
  const agents = service(ctx, "agents");
  const controller = service(ctx, "sessionController");
  const query = service(ctx, "sessionQuery");
  const sessions = service(ctx, "sessions");
  if (!record(profile) || typeof profile.dir !== "string" ||
      !method(agents, "get") || !method(controller, "resolveAgent") ||
      !method(query, "observeSession") || !method(sessions, "flush") || !method(sessions, "get")) return undefined;
  const profileDirectory = fs.realpathSync(profile.dir);
  if (!fs.statSync(profileDirectory).isDirectory()) throw new Error("DSH recovery profile is not a directory");
  const live = agents as unknown as AgentLookup;
  const sessionController = controller as unknown as SessionController;
  const sessionQuery = query as unknown as SessionQuery;
  const sessionStore = sessions as unknown as SessionStore;
  const assertLive = (agent: Agent): void => {
    if (live.get(agent.id) !== agent || sessionStore.get(agent.id) !== agent.session) {
      throw new Error("DSH callback recovery requires the exact live Agent and Session");
    }
  };
  const observe = async <T>(id: string, read: (value: SessionObservation) => T): Promise<T> => {
    const observation = await sessionQuery.observeSession(id, { projectionMode: "none" });
    if (!observation || typeof observation[Symbol.dispose] !== "function") throw new Error("DSH recovery observation is unavailable");
    try {
      if (sessionHeaderIdentity(observation.header).sessionId !== id) throw new Error("DSH recovery observation identity changed");
      return read(observation);
    } finally { observation[Symbol.dispose](); }
  };
  const flush = async (agent: Agent): Promise<boolean> => {
    assertLive(agent);
    const flushed = await sessionStore.flush(agent.session);
    assertLive(agent);
    return flushed === true;
  };
  return Object.freeze({
    profileDirectory,
    storeDirectory: canonicalDirectoryPath(storeDirectory),
    sessionIdentity(agent: Agent): SessionIdentity {
      assertLive(agent);
      const identity = sessionHeaderIdentity(agent.session.header);
      if (identity.sessionId !== String(agent.id)) throw new Error("DSH Agent and Session identity diverged");
      return identity;
    },
    async observeSessionIdentity(sessionId: string): Promise<SessionIdentity> {
      return observe(sessionId, (value) => sessionHeaderIdentity(value.header));
    },
    async restoreAgent(route: DurableRouteRecord): Promise<Agent> {
      const observed = await observe(route.sessionId, (value) => sessionHeaderIdentity(value.header));
      assertSameSession(observed, route);
      const resolved = await sessionController.resolveAgent(route.sessionId);
      if (!resolved.agent || resolved.error !== undefined) throw new Error("DSH authorized Session could not be restored");
      assertLive(resolved.agent);
      assertSameSession(sessionHeaderIdentity(resolved.agent.session.header), route);
      return resolved.agent;
    },
    flush,
    async findOwnMessage(agent: Agent, messageId: string): Promise<boolean> {
      assertLive(agent);
      if (!text(messageId)) throw new Error("DSH callback message identity is invalid");
      const expected = sessionHeaderIdentity(agent.session.header);
      // A negative answer is replay authority: require a durability barrier and
      // the complete own-event inventory, never infer absence from inbox state.
      if (!await flush(agent)) throw new Error("DSH callback recovery has no durability listener");
      const found = await observe(expected.sessionId, (observation) => {
        assertSameSession(sessionHeaderIdentity(observation.header), expected);
        const events = observation.events;
        const inherited = observation.inheritedEventCount;
        if (!Array.isArray(events) || !Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length ||
            observation.cursor !== events.length - 1) {
          throw new Error("DSH callback recovery event inventory is incomplete");
        }
        let matched = false;
        for (let index = 0; index < events.length; index += 1) {
          const event = events[index];
          if (!record(event) || event.seq !== index) throw new Error("DSH callback recovery event inventory is incomplete");
          if (index < inherited) continue;
          const data = event.data;
          if (event.type === "agent/inbox/spliced" && (!record(data) || !Array.isArray(data.inserted)) ||
              event.type === "user/message" && !record(data)) throw new Error("DSH callback recovery admission event is invalid");
          const candidates = event.type === "user/message" ? [data]
            : event.type === "agent/inbox/spliced" && record(data) && Array.isArray(data.inserted) ? data.inserted : [];
          for (const candidate of candidates) {
            if (!record(candidate) || candidate.id !== messageId) continue;
            if (!record(candidate.source) || candidate.source.kind !== "agent-knock-knock") {
              throw new Error("DSH callback message identity belongs to another producer");
            }
            matched = true;
          }
        }
        return matched;
      });
      assertLive(agent);
      return found;
    },
  });
}

/** Immutable logical generation; log growth and format migration do not rename it. */
export function sessionHeaderIdentity(header: unknown): SessionIdentity {
  if (!record(header) || !text(header.id) || !Number.isSafeInteger(header.createdAt) ||
      (header.createdAt as number) < 0 || typeof header.isSeeded !== "boolean") throw new Error("DSH immutable Session header is invalid");
  for (const field of ["cwd", "parentSession", "agentPreset"] as const) {
    if (header[field] !== undefined && !text(header[field])) throw new Error("DSH immutable Session header is invalid");
  }
  if (header.origin !== undefined && header.origin !== "subagent") throw new Error("DSH immutable Session origin is invalid");
  if (header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || (header.delegationDepth as number) < 0)) {
    throw new Error("DSH immutable Session lineage is invalid");
  }
  const identity = [header.id, header.createdAt, header.cwd ?? null, header.parentSession ?? null,
    header.isSeeded, header.origin ?? null, header.delegationDepth ?? null, header.agentPreset ?? null];
  return Object.freeze({ sessionId: header.id, headerFingerprint: createHash("sha256").update(JSON.stringify(identity)).digest("hex") });
}
function assertSameSession(actual: SessionIdentity, expected: SessionIdentity): void {
  if (actual.sessionId !== expected.sessionId || actual.headerFingerprint !== expected.headerFingerprint) throw new Error("DSH authorized Session generation changed");
}
function service(ctx: ServicesContext, name: string): unknown {
  return typeof ctx.get === "function" ? ctx.get(name) : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function method(value: unknown, name: string): boolean {
  return record(value) && typeof value[name] === "function";
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 8192 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
