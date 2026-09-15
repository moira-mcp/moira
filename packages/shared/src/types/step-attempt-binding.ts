/**
 * The binding of a paused step attempt: what must still hold for that attempt to be usable against
 * the current workflow definition.
 *
 * Four places compare a persisted attempt with a freshly computed candidate — the executor's
 * re-presentation check, the persistence claim, the persistence re-presentation refresh, and the
 * in-memory repository that doubles for both. They all decide here, so the binding cannot be
 * narrowed or widened in three of them and left behind in the fourth. That has happened before: a
 * catalog deploy killed every paused run of the updated flow because one of these comparisons still
 * covered the whole definition.
 *
 * `continuationDigest` is a digest of the run's continuation surface, computed by the workflow
 * engine. `null` means the attempt carries no continuation binding — a start attempt, or a step
 * attempt persisted before the binding existed — and never matches, so such an attempt is stale.
 */
export interface StepAttemptBinding {
  executionRevision: number | null;
  nodeId: string | null;
  workflowId: string;
  continuationDigest: string | null;
}

/**
 * Whether the persisted attempt is bound to the same continuation as the candidate, ignoring the
 * execution revision. Callers that also require the same revision compare it themselves: the
 * re-presentation refresh path deliberately accepts a revision difference and repairs it.
 */
export function stepAttemptContinuationMatches(
  persisted: StepAttemptBinding,
  candidate: StepAttemptBinding,
): boolean {
  return (
    persisted.nodeId === candidate.nodeId &&
    persisted.workflowId === candidate.workflowId &&
    persisted.continuationDigest !== null &&
    persisted.continuationDigest === candidate.continuationDigest
  );
}

/** Whether the persisted attempt is usable as-is: same continuation and same execution revision. */
export function stepAttemptBindingMatches(
  persisted: StepAttemptBinding,
  candidate: StepAttemptBinding,
): boolean {
  return (
    persisted.executionRevision === candidate.executionRevision &&
    stepAttemptContinuationMatches(persisted, candidate)
  );
}
