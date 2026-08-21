/**
 * Deterministic three-way reconciliation for resources managed by a bundle.
 *
 * The module deliberately knows nothing about workflows, databases, files, or
 * deployment modes. Adapters supply canonical states and persist the selected
 * result after the complete set has been planned.
 */

export type ManagedResourceState<T> =
  | { lifecycle: "absent" }
  | { lifecycle: "deleted"; content: T }
  | { lifecycle: "present"; content: T };

export type ReconciliationClassification =
  | "first-install"
  | "first-adoption"
  | "baseline-missing"
  | "unchanged"
  | "upstream-only"
  | "user-only"
  | "converged"
  | "conflict";

export interface ReconciliationDecision<T> {
  classification: ReconciliationClassification;
  previous: ManagedResourceState<T> | null;
  current: ManagedResourceState<T>;
  incoming: ManagedResourceState<T>;
  selected: "current" | "incoming" | null;
  advanceBaseline: boolean;
  unresolved: boolean;
}

export type ManagedStateEquals<T> = (
  left: ManagedResourceState<T>,
  right: ManagedResourceState<T>,
) => boolean;

/** Compare lifecycle first and content only for states that carry content. */
export function managedStateEquals<T>(
  left: ManagedResourceState<T>,
  right: ManagedResourceState<T>,
  contentEquals: (left: T, right: T) => boolean = (a, b) => JSON.stringify(a) === JSON.stringify(b),
): boolean {
  if (left.lifecycle !== right.lifecycle) return false;
  if (left.lifecycle === "absent" || right.lifecycle === "absent") return true;
  return contentEquals(left.content, right.content);
}

/**
 * Apply the ordinary three-way merge table without side effects.
 *
 * A missing baseline is intentionally not treated as permission to overwrite:
 * only an absent database row or exact current/incoming equality can be safely
 * adopted on first encounter.
 */
export function reconcileManagedResource<T>(
  previous: ManagedResourceState<T> | null,
  current: ManagedResourceState<T>,
  incoming: ManagedResourceState<T>,
  equals: ManagedStateEquals<T> = managedStateEquals,
): ReconciliationDecision<T> {
  if (previous === null) {
    if (current.lifecycle === "absent") {
      return {
        classification: "first-install",
        previous,
        current,
        incoming,
        selected: "incoming",
        advanceBaseline: true,
        unresolved: false,
      };
    }
    if (equals(current, incoming)) {
      return {
        classification: "first-adoption",
        previous,
        current,
        incoming,
        selected: "current",
        advanceBaseline: true,
        unresolved: false,
      };
    }
    return {
      classification: "baseline-missing",
      previous,
      current,
      incoming,
      selected: null,
      advanceBaseline: false,
      unresolved: true,
    };
  }

  const currentMatchesPrevious = equals(current, previous);
  const incomingMatchesPrevious = equals(incoming, previous);
  const currentMatchesIncoming = equals(current, incoming);

  if (currentMatchesPrevious && incomingMatchesPrevious) {
    return {
      classification: "unchanged",
      previous,
      current,
      incoming,
      selected: "current",
      advanceBaseline: false,
      unresolved: false,
    };
  }
  if (currentMatchesPrevious) {
    return {
      classification: "upstream-only",
      previous,
      current,
      incoming,
      selected: "incoming",
      advanceBaseline: true,
      unresolved: false,
    };
  }
  if (incomingMatchesPrevious) {
    return {
      classification: "user-only",
      previous,
      current,
      incoming,
      selected: "current",
      advanceBaseline: false,
      unresolved: false,
    };
  }
  if (currentMatchesIncoming) {
    return {
      classification: "converged",
      previous,
      current,
      incoming,
      selected: "current",
      advanceBaseline: true,
      unresolved: false,
    };
  }
  return {
    classification: "conflict",
    previous,
    current,
    incoming,
    selected: null,
    advanceBaseline: false,
    unresolved: true,
  };
}
