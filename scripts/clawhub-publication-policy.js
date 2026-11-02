// Acknowledged submission and public availability are separate outcomes.
// Unknown transport results never qualify as accepted and are never replayed.
export function clawhubSubmissionOutcome(publication, waitForPublication) {
  if (waitForPublication) return undefined;
  if (publication.state === "pending" && typeof publication.attemptId === "string" && publication.attemptId.length > 0) {
    return "accepted_pending";
  }
  return undefined;
}
