# Codex delivery diagnostics

Send errors distinguish `backend_precheck`, `fallback_scan` and `rpc_dispatch`.
They retain the decoded target thread, dispatch certainty, fallback result and,
when available, the RPC method and numeric code. Native RPC responses still
discard their raw error message and `data`: neither prompts nor private backend
paths are copied into the diagnostics. Only known method/reason names, bounded
thread IDs and numeric RPC codes are projected.

Thrown errors expose `diagnostics`; CLI error text includes the same JSON because
some Hosts only forward `error.message`. Failures returned through durable Send
receipts expose `send_diagnostics` and `send_recovery_actions`, including on replay.
These additions do not change acceptance, retry, route pinning or fallback rules.

Example: an unavailable backend with no verified fallback:

```json
{
  "stage": "fallback_scan",
  "target_thread_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "dispatch_state": "not_sent",
  "fallback": "no_match",
  "reason": "thread_not_loaded",
  "recent_list_match": "matched",
  "recent_list_observed_at": "2026-10-31T01:00:00.000Z"
}
```

The recovery text asks the caller to refresh List and copy its `conversation_id`
verbatim, restoring the original thread in Codex first if necessary. An
`unknown` or `accepted` dispatch instead asks the caller to check the existing
task receipt/Watch and not resend blindly. A read or subscription failure before
task submission remains `not_sent` at the Send boundary, even if the subscription
RPC itself had an uncertain acknowledgement.

Example: a mistyped ID rejected during a read:

```json
{
  "stage": "backend_precheck",
  "target_thread_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa",
  "dispatch_state": "not_sent",
  "fallback": "not_checked",
  "reason": "rpc_error",
  "rpc_method": "thread/read",
  "rpc_code": -32602,
  "recent_list_match": "no_match",
  "recent_list_observed_at": "2026-10-31T01:00:00.000Z"
}
```

The error says that the supplied ID's decoded thread does not match any session
in that recent List inventory. This is a correction clue, not proof that an ID
never existed. No nearest match is selected automatically. With no complete,
recent inventory for the same Store and home, the match is `not_checked` and the
error does not claim a mismatch. No extra RPC discovery is performed on failure.

## List health

```json
{
  "backend": "loaded",
  "fallback": "no_match",
  "check_depth": "discovery",
  "observed_at": "2026-10-31T01:00:00.000Z",
  "last_failure": null,
  "recovery_actions": []
}
```

This is a healthy backend-only route. `fallback` describes exact identity
evidence, not terminal input readiness. `not_checked` covers native-only List or
an unavailable terminal scan. Snapshot checks are still limited to existing
explicit/ambiguous-group reads; ordinary List adds no full Send preflight or
subscription. A failed optional history read reports `backend: check_failed`
while retaining its last successful `discovery` depth. Failed backend discovery
remains in the existing scan diagnostics; it does not manufacture historical rows.

`last_failure` is an independently timestamped diagnostic observation. It can
coexist with a currently loaded backend and never revokes an action. Healthy
observations do not erase an unknown submission's reminder to inspect its receipt.
Normal capability and action guards still perform all authorization at dispatch.

## Advisory cache and compatibility

Recent inventories and failures live outside the Store, under
`<store-parent>/routing-diagnostics/<SHA256-of-store-path>/`. Records are scoped
by hashes of home/thread, written atomically as private files, and ignored after
24 hours. Inventory contents are only thread hashes (at most 10,000), not home
paths, conversation titles or prompts. Incomplete discovery invalidates negative
membership hints. Missing, corrupt or unwritable cache data cannot fail a command
or authorize/reject/reroute a send. Concurrent writes are advisory observations,
not a delivery ledger. These files may be removed without affecting task state.

No new UUID regex or fixed 36-character constraint is imposed. The existing
contract accepts bounded opaque thread identifiers, including non-UUID IDs, and
supports contract-compatible newer backends. A length-only constraint would
also narrow that contract. Exact recent-inventory comparison catches the
reported dropped-character case without introducing that compatibility break.
