export const SEMANTIC_PRIVATE_AUTHORITY_OFFER_TTL_MS = 10 * 60 * 1000;
export const SEMANTIC_PRIVATE_AUTHORITY_OFFER_LIMIT = 512;
export const SEMANTIC_APPROVAL_AUTHORITY_KIND = "approval";
export const SEMANTIC_INTERACTION_AUTHORITY_KIND = "interaction";
export const SEMANTIC_INTERACTION_AUTHORITY_SUBJECT_KINDS = [
  "managed_turn",
  "terminal_watch"
] as const;

export type SemanticInteractionAuthoritySubjectKind =
  typeof SEMANTIC_INTERACTION_AUTHORITY_SUBJECT_KINDS[number];

export interface SemanticPrivateAuthorityTarget {
  type: string;
  id: string;
}

export interface SemanticPrivateAuthorityOfferKey {
  sessionKey: string;
  sessionId: string;
  kind: string;
  target: SemanticPrivateAuthorityTarget;
}

export interface SemanticPrivateAuthorityOfferPayload
  extends Readonly<Record<string, unknown>> {
  readonly args?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly invalidated?: boolean;
}

interface StoredPrivateAuthorityOffer {
  expiresAtMs: number;
  payload: SemanticPrivateAuthorityOfferPayload;
}

interface PrivateAuthorityOfferStore {
  entries: Map<string, StoredPrivateAuthorityOffer>;
}

const storesByApi = new WeakMap<object, PrivateAuthorityOfferStore>();

export function semanticApprovalAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  target: SemanticPrivateAuthorityTarget
): SemanticPrivateAuthorityOfferKey {
  return {
    sessionKey,
    sessionId,
    kind: SEMANTIC_APPROVAL_AUTHORITY_KIND,
    target
  };
}

/**
 * Legacy managed-Turn overload retained while callers migrate to the explicit
 * subject-aware form below.
 */
export function semanticInteractionAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  turnId: string,
  interactionId: string
): SemanticPrivateAuthorityOfferKey;
export function semanticInteractionAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  subjectKind: SemanticInteractionAuthoritySubjectKind,
  subjectId: string,
  interactionId: string
): SemanticPrivateAuthorityOfferKey;
export function semanticInteractionAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  subjectKindOrTurnId: SemanticInteractionAuthoritySubjectKind | string,
  subjectIdOrInteractionId: string,
  explicitInteractionId?: string
): SemanticPrivateAuthorityOfferKey {
  const legacyManagedTurn = explicitInteractionId === undefined;
  const subjectKind = legacyManagedTurn
    ? "managed_turn"
    : interactionAuthoritySubjectKind(subjectKindOrTurnId);
  const subjectId = exactNonBlank(
    legacyManagedTurn ? subjectKindOrTurnId : subjectIdOrInteractionId,
    "interaction subject id"
  );
  const interactionId = exactNonBlank(
    legacyManagedTurn ? subjectIdOrInteractionId : explicitInteractionId,
    "interaction id"
  );
  return {
    sessionKey,
    sessionId,
    kind: SEMANTIC_INTERACTION_AUTHORITY_KIND,
    target: {
      type: "interaction_subject",
      id: JSON.stringify([subjectKind, subjectId, interactionId])
    }
  };
}

export function semanticManagedTurnInteractionAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  turnId: string,
  interactionId: string
): SemanticPrivateAuthorityOfferKey {
  return semanticInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    "managed_turn",
    turnId,
    interactionId
  );
}

export function semanticTerminalWatchInteractionAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  watchId: string,
  interactionId: string
): SemanticPrivateAuthorityOfferKey {
  return semanticInteractionAuthorityOfferKey(
    sessionKey,
    sessionId,
    "terminal_watch",
    watchId,
    interactionId
  );
}

/**
 * Invalidates every interaction response offer previously displayed for one
 * exact subject in one exact controller conversation. Status uses this as a
 * refresh boundary before it publishes at most one offer from the new
 * snapshot, so an old interaction id cannot remain actionable for the rest of
 * its TTL after the terminal UI disappears or changes.
 */
export function invalidateSemanticInteractionAuthorityOffersForSubject(
  api: object,
  sessionKey: string,
  sessionId: string,
  subjectKind: SemanticInteractionAuthoritySubjectKind,
  subjectId: string,
  nowMs = Date.now()
): number {
  const exactApi = assertApi(api);
  const exactSessionKey = exactNonBlank(sessionKey, "sessionKey");
  const exactSessionId = exactNonBlank(sessionId, "sessionId");
  const exactSubjectKind = interactionAuthoritySubjectKind(subjectKind);
  const exactSubjectId = exactNonBlank(subjectId, "interaction subject id");
  assertNow(nowMs);
  const store = storesByApi.get(exactApi);
  if (!store) return 0;
  pruneExpiredOffers(store, nowMs);
  let invalidated = 0;
  for (const normalizedKey of store.entries.keys()) {
    if (
      normalizedInteractionOfferMatchesSubject(
        normalizedKey,
        exactSessionKey,
        exactSessionId,
        exactSubjectKind,
        exactSubjectId
      )
    ) {
      store.entries.delete(normalizedKey);
      invalidated += 1;
    }
  }
  return invalidated;
}

export function rememberSemanticPrivateAuthorityOffer(
  api: object,
  key: SemanticPrivateAuthorityOfferKey,
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
  while (store.entries.size >= SEMANTIC_PRIVATE_AUTHORITY_OFFER_LIMIT) {
    const oldest = store.entries.keys().next().value;
    if (typeof oldest !== "string") break;
    store.entries.delete(oldest);
  }
  store.entries.set(normalizedKey, {
    expiresAtMs: nowMs + SEMANTIC_PRIVATE_AUTHORITY_OFFER_TTL_MS,
    payload: cloneAndFreezePayload(storedPayload)
  });
}

export function peekSemanticPrivateAuthorityOffer<
  Payload extends SemanticPrivateAuthorityOfferPayload =
    SemanticPrivateAuthorityOfferPayload
>(
  api: object,
  key: SemanticPrivateAuthorityOfferKey,
  nowMs = Date.now()
): Payload | undefined {
  return readPrivateAuthorityOffer<Payload>(api, key, false, nowMs);
}

export function consumeSemanticPrivateAuthorityOffer<
  Payload extends SemanticPrivateAuthorityOfferPayload =
    SemanticPrivateAuthorityOfferPayload
>(
  api: object,
  key: SemanticPrivateAuthorityOfferKey,
  nowMs = Date.now()
): Payload | undefined {
  return readPrivateAuthorityOffer<Payload>(api, key, true, nowMs);
}

function readPrivateAuthorityOffer<
  Payload extends SemanticPrivateAuthorityOfferPayload
>(
  api: object,
  key: SemanticPrivateAuthorityOfferKey,
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
  key: SemanticPrivateAuthorityOfferKey
): string {
  const sessionKey = exactNonBlank(key?.sessionKey, "sessionKey");
  const sessionId = exactNonBlank(key?.sessionId, "sessionId");
  const kind = exactIdentifier(key?.kind, "kind");
  const targetType = exactIdentifier(key?.target?.type, "target.type");
  const targetId = exactNonBlank(key?.target?.id, "target.id");
  return JSON.stringify([sessionKey, sessionId, kind, targetType, targetId]);
}

function normalizedInteractionOfferMatchesSubject(
  normalizedKey: string,
  sessionKey: string,
  sessionId: string,
  subjectKind: SemanticInteractionAuthoritySubjectKind,
  subjectId: string
): boolean {
  try {
    const key = JSON.parse(normalizedKey) as unknown;
    if (
      !Array.isArray(key) ||
      key.length !== 5 ||
      key[0] !== sessionKey ||
      key[1] !== sessionId ||
      key[2] !== SEMANTIC_INTERACTION_AUTHORITY_KIND ||
      key[3] !== "interaction_subject" ||
      typeof key[4] !== "string"
    ) {
      return false;
    }
    const target = JSON.parse(key[4]) as unknown;
    return Array.isArray(target) &&
      target.length === 3 &&
      target[0] === subjectKind &&
      target[1] === subjectId &&
      typeof target[2] === "string";
  } catch {
    return false;
  }
}

function exactIdentifier(value: unknown, label: string): string {
  const text = exactNonBlank(value, label);
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(text)) {
    throw new Error(`private authority offer ${label} is invalid`);
  }
  return text;
}

function interactionAuthoritySubjectKind(
  value: unknown
): SemanticInteractionAuthoritySubjectKind {
  if (
    !SEMANTIC_INTERACTION_AUTHORITY_SUBJECT_KINDS.includes(
      value as SemanticInteractionAuthoritySubjectKind
    )
  ) {
    throw new Error(
      "private authority offer interaction subject kind is invalid"
    );
  }
  return value as SemanticInteractionAuthoritySubjectKind;
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
): SemanticPrivateAuthorityOfferPayload {
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
  previous: SemanticPrivateAuthorityOfferPayload | undefined,
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
  previous: SemanticPrivateAuthorityOfferPayload | undefined,
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
