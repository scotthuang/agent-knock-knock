import assert from "node:assert/strict";
import test from "node:test";
const { clawhubSubmissionOutcome } = await import(new URL("../../scripts/clawhub-publication-policy.js", import.meta.url).href);

test("ClawHub acknowledgement may finish submission without claiming public availability", () => {
  assert.equal(clawhubSubmissionOutcome({ state: "pending", attemptId: "exact-attempt" }, false), "accepted_pending");
  assert.equal(clawhubSubmissionOutcome({ state: "pending", attemptId: "exact-attempt" }, true), undefined);
  for (const state of ["absent", "failed", "unknown", "published"]) {
    assert.equal(clawhubSubmissionOutcome({ state, attemptId: "exact-attempt" }, false), undefined);
  }
  for (const attemptId of [undefined, null, "", 1]) {
    assert.equal(clawhubSubmissionOutcome({ state: "pending", attemptId }, false), undefined);
  }
});
