export const OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS = 10 * 60 * 1000;
export const OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT = 512;
export const OPENCLAW_APPROVAL_AUTHORITY_KIND = "approval";

export interface OpenClawPrivateAuthorityTarget {
  type: string;
  id: string;
}

export interface OpenClawPrivateAuthorityOfferKey {
  sessionKey: string;
  sessionId: string;
  kind: string;
  target: OpenClawPrivateAuthorityTarget;
}

export interface OpenClawPrivateAuthorityOfferPayload
  extends Readonly<Record<string, unknown>> {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly invalidated?: boolean;
}

interface StoredPrivateAuthorityOffer {
  expiresAtMs: number;
  payload: OpenClawPrivateAuthorityOfferPayload;
}

interface PrivateAuthorityOfferStore {
  entries: Map<string, StoredPrivateAuthorityOffer>;
}

const storesByApi = new WeakMap<object, PrivateAuthorityOfferStore>();

export function openClawApprovalAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  target: OpenClawPrivateAuthorityTarget
): OpenClawPrivateAuthorityOfferKey {
  return {
    sessionKey,
    sessionId,
    kind: OPENCLAW_APPROVAL_AUTHORITY_KIND,
    target
  };
}

export function rememberOpenClawPrivateAuthorityOffer(
  api: object,
  key: OpenClawPrivateAuthorityOfferKey,
  payload: Record<string, unknown>,
  nowMs = Date.now()
): void {
  const normalizedKey = privateAuthorityOfferKey(key);
  const store = privateAuthorityOfferStore(api);
  assertNow(nowMs);
  pruneExpiredOffers(store, nowMs);
  const previous = store.entries.get(normalizedKey)?.payload;
  const authorityChanged = privateAuthorityPayloadChanged(previous, payload);
  const merged = mergePrivateAuthorityPayload(previous, payload);
  const invalidated = authorityChanged || (
    previous?.invalidated === true
  );
  const storedPayload = {
    ...merged,
    ...(invalidated ? { invalidated: true } : {})
  };
  if (!invalidated) delete storedPayload.invalidated;
  store.entries.delete(normalizedKey);
  while (store.entries.size >= OPENCLAW_PRIVATE_AUTHORITY_OFFER_LIMIT) {
    const oldest = store.entries.keys().next().value;
    if (typeof oldest !== "string") break;
    store.entries.delete(oldest);
  }
  store.entries.set(normalizedKey, {
    expiresAtMs: nowMs + OPENCLAW_PRIVATE_AUTHORITY_OFFER_TTL_MS,
    payload: cloneAndFreezePayload(storedPayload)
  });
}

export function peekOpenClawPrivateAuthorityOffer<
  Payload extends OpenClawPrivateAuthorityOfferPayload =
    OpenClawPrivateAuthorityOfferPayload
>(
  api: object,
  key: OpenClawPrivateAuthorityOfferKey,
  nowMs = Date.now()
): Payload | undefined {
  return readPrivateAuthorityOffer<Payload>(api, key, false, nowMs);
}

export function consumeOpenClawPrivateAuthorityOffer<
  Payload extends OpenClawPrivateAuthorityOfferPayload =
    OpenClawPrivateAuthorityOfferPayload
>(
  api: object,
  key: OpenClawPrivateAuthorityOfferKey,
  nowMs = Date.now()
): Payload | undefined {
  return readPrivateAuthorityOffer<Payload>(api, key, true, nowMs);
}

function readPrivateAuthorityOffer<
  Payload extends OpenClawPrivateAuthorityOfferPayload
>(
  api: object,
  key: OpenClawPrivateAuthorityOfferKey,
  consume: boolean,
  nowMs: number
): Payload | undefined {
  assertNow(nowMs);
  const store = storesByApi.get(assertApi(api));
  if (!store) return undefined;
  const normalizedKey = privateAuthorityOfferKey(key);
  const offer = store.entries.get(normalizedKey);
  if (!offer) {
    pruneExpiredOffers(store, nowMs);
    return undefined;
  }
  if (offer.expiresAtMs <= nowMs) {
    store.entries.delete(normalizedKey);
    pruneExpiredOffers(store, nowMs);
    return undefined;
  }
  if (offer.payload.invalidated === true) {
    if (consume) store.entries.delete(normalizedKey);
    return undefined;
  }
  if (consume) store.entries.delete(normalizedKey);
  return offer.payload as Payload;
}

function privateAuthorityOfferStore(api: object): PrivateAuthorityOfferStore {
  const exactApi = assertApi(api);
  const existing = storesByApi.get(exactApi);
  if (existing) return existing;
  const created = { entries: new Map<string, StoredPrivateAuthorityOffer>() };
  storesByApi.set(exactApi, created);
  return created;
}

function privateAuthorityOfferKey(
  key: OpenClawPrivateAuthorityOfferKey
): string {
  const sessionKey = exactNonBlank(key?.sessionKey, "sessionKey");
  const sessionId = exactNonBlank(key?.sessionId, "sessionId");
  const kind = exactIdentifier(key?.kind, "kind");
  const targetType = exactIdentifier(key?.target?.type, "target.type");
  const targetId = exactNonBlank(key?.target?.id, "target.id");
  return JSON.stringify([sessionKey, sessionId, kind, targetType, targetId]);
}

function exactIdentifier(value: unknown, label: string): string {
  const text = exactNonBlank(value, label);
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(text)) {
    throw new Error(`private authority offer ${label} is invalid`);
  }
  return text;
}

function exactNonBlank(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`private authority offer ${label} must be exact and non-empty`);
  }
  return value;
}

function assertApi(api: object): object {
  if ((typeof api !== "object" || api === null) && typeof api !== "function") {
    throw new Error("private authority offer api must be an object");
  }
  return api;
}

function assertNow(nowMs: number): void {
  if (!Number.isFinite(nowMs)) {
    throw new Error("private authority offer clock must be finite");
  }
}

function pruneExpiredOffers(
  store: PrivateAuthorityOfferStore,
  nowMs: number
): void {
  for (const [key, offer] of store.entries) {
    if (offer.expiresAtMs <= nowMs) store.entries.delete(key);
  }
}

function cloneAndFreezePayload(
  payload: Record<string, unknown>
): OpenClawPrivateAuthorityOfferPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("private authority offer payload must be an object");
  }
  let cloned: Record<string, unknown>;
  try {
    cloned = structuredClone(payload);
  } catch {
    throw new Error("private authority offer payload must be structured-cloneable");
  }
  return deepFreeze(cloned, new WeakSet<object>());
}

function mergePrivateAuthorityPayload(
  previous: OpenClawPrivateAuthorityOfferPayload | undefined,
  update: Record<string, unknown>
): Record<string, unknown> {
  const definedUpdate = Object.fromEntries(
    Object.entries(update).filter(([, value]) => value !== undefined)
  );
  const previousArgs = isPlainRecord(previous?.args) ? previous.args : {};
  const updateArgs = isPlainRecord(definedUpdate.args)
    ? definedUpdate.args
    : undefined;
  return {
    ...(previous ?? {}),
    ...definedUpdate,
    ...(
      updateArgs
        ? { args: { ...previousArgs, ...updateArgs } }
        : Object.keys(previousArgs).length > 0
          ? { args: previousArgs }
          : {}
    )
  };
}

function privateAuthorityPayloadChanged(
  previous: OpenClawPrivateAuthorityOfferPayload | undefined,
  update: Record<string, unknown>
): boolean {
  if (!previous) return false;
  const nextFingerprint = update.fingerprint;
  if (
    nextFingerprint !== undefined &&
    previous.fingerprint !== undefined &&
    nextFingerprint !== previous.fingerprint
  ) {
    return true;
  }
  const previousArgs = isPlainRecord(previous.args) ? previous.args : {};
  const updateArgs = isPlainRecord(update.args) ? update.args : undefined;
  if (!updateArgs) return false;
  return Object.keys(previousArgs).length > 0 &&
    JSON.stringify(previousArgs) !== JSON.stringify(updateArgs);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<Value>(value: Value, seen: WeakSet<object>): Value {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) deepFreeze(nested, seen);
  return Object.freeze(value);
}
