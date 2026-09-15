const MODEL_OPAQUE_AUTHORITY_FIELDS = new Set([
  "acceptanceevidence",
  "actionplan",
  "attemptoutcome",
  "callbackenvelope",
  "callbackroute",
  "candidaterollouts",
  "claudetranscriptanchor",
  "codexopenrootrolloutinventory",
  "codexrolloutacceptanceanchor",
  "challenge",
  "etag",
  "expectedapprovalfingerprint",
  "expectedcallbackconversationid",
  "expectedcallbackmessageid",
  "expectedcallbackopenclawsession",
  "expectedcallbacksessionid",
  "expectedcallbackturnid",
  "generationid",
  "gatewaymethod",
  "gatewaysession",
  "gatewayurl",
  "interactionauthority",
  "livenativethreadid",
  "nativesessiontakeover",
  "nonce",
  "openclawbin",
  "openclawsession",
  "ownersession",
  "processincarnation",
  "promptevidence",
  "proof",
  "selectionhandle",
  "selectionsnapshot",
  "selectionscope",
  "snapshotid",
  "sourcefileidentity"
]);

export function normalizeAkkModelFacingFieldName(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

export function isAkkModelFacingPrivateAuthorityField(key: string): boolean {
  const compact = normalizeAkkModelFacingFieldName(key);
  return compact.endsWith("token") ||
    compact.endsWith("fingerprint") ||
    compact.endsWith("hash") ||
    compact.endsWith("sha256") ||
    compact.endsWith("digest") ||
    compact.endsWith("revision") ||
    compact.endsWith("revisions") ||
    compact.endsWith("bindingid") ||
    compact.endsWith("bindingids") ||
    compact.endsWith("bindinggeneration") ||
    compact.endsWith("bindinggenerations") ||
    compact === "generation" ||
    MODEL_OPAQUE_AUTHORITY_FIELDS.has(compact);
}

export function isAkkModelFacingDiagnosticField(
  key: string | undefined
): boolean {
  if (!key) return false;
  const separated = key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  return /(?:^|[_-])(?:reasons?|errors?|warnings?|diagnostics?)$/u.test(
    separated
  ) || /(?:^|[_-])(?:error|warning|diagnostic)_message$/u.test(separated);
}
