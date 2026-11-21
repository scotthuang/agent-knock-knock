import { registerHooks } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { createDesktopStateStore } from "../src/desktop-state-store.js";
import type { DesktopThreadIdentity } from "../src/desktop-types.js";
import type { DesktopQueueAdmission } from "../src/desktop-task-queue.js";

/** Replace only the Darwin process attestation in a test-specific ES-module instance.
 * The real endpoint, private AKK reservation, native protocol and receipt validation run normally. */
export async function fixtureWriter(target: DesktopThreadIdentity): Promise<typeof import("../src/desktop-queue-submit.js") & {
  storeDir: string;
  setOwner(fields?: object): void;
  reserve(watchId: string, admission: DesktopQueueAdmission, clientUserMessageId: string, prompt: string): void;
  repo: ReturnType<typeof createDesktopStateStore>;
}> {
  if (path.dirname(target.codexHome) !== fs.realpathSync("/tmp") || !/^akk-q-[a-zA-Z0-9]+$/u.test(path.basename(target.codexHome))) throw new Error("expected mock home");
  const ownerPath = path.join(target.codexHome, "mock-owner.json");
  const owner = { ownerId: "test-Darwin-writer", endpointId: "test-Darwin-endpoint", draft: "none_persisted", liveDraft: "unknown" };
  const setOwner = (fields = {}) => fs.writeFileSync(ownerPath, JSON.stringify({...owner, ...fields}), {mode: 0o600});
  setOwner();
  const stub = 'import fs from "node:fs"; export const verifyDesktopQueueOwner = (target) => {' +
    'if (target.codexHome !== ' + JSON.stringify(target.codexHome) + ') throw new Error("outside native fixture");' +
    'return Promise.resolve(JSON.parse(fs.readFileSync(' + JSON.stringify(ownerPath) + ',"utf8"))); }';
  const entry = new URL("../src/desktop-queue-submit.js", import.meta.url);
  entry.searchParams.set("mock-os", path.basename(target.codexHome));
  const hook = registerHooks({ resolve(specifier, context, next) {
    return specifier === "./desktop-queue-owner.js" && context.parentURL === entry.href
      ? { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true } : next(specifier, context);
  } });
  const port: typeof import("../src/desktop-queue-submit.js") = await import(entry.href).finally(() => hook.deregister());
  const storeDir = path.join(target.codexHome, "store");
  fs.mkdirSync(storeDir, { mode: 0o700 });
  const repo = createDesktopStateStore(storeDir, {acquire: () => () => {}});
  function reserve(watchId: string, admission: DesktopQueueAdmission, clientUserMessageId: string, prompt: string) {
    const now = new Date().toISOString();
    repo.save({
      schema: "agent-knock-knock/desktop-task", version: 1, revision: 1, id: watchId, watch_id: watchId,
      target, desktop_id: createDesktopConversationId(target), controller_session: "isolated-controller", kind: "send",
      status: "awaiting_acceptance", created_at: now, updated_at: now, deadline_at: new Date(Date.now()+60_000).toISOString(),
      send_intent: { message_id: watchId, client_user_message_id: clientUserMessageId, owner_client_id: admission.ownerId,
        baseline_turn_ids: [admission.baselineTurnId!], text: prompt, state: "reserved", dispatched_at: now,
        delivery_path: "native_thread_queue", queue_endpoint_id: admission.endpointId, queue_cwd: admission.cwd },
      pending_manual_count: 0, notifications: []
    }, null);
  }
  return { ...port, storeDir, setOwner, reserve, repo };
}
