/**
 * The revision snapshot: for every guide step, the revision its author gave it and a fingerprint of
 * what the step points at and says (its anchor and its English copy).
 *
 * A committed copy of the snapshot is compared with the current one by a unit test. When a step's
 * anchor or English text changes, the fingerprints differ and the test asks the author to decide
 * whether the change is a new revision — a control moved, or the copy means something new — before
 * refreshing the snapshot. A person who has seen the step at its old revision then sees it as new.
 */

import type { GuideDefinition } from "./types";

export interface StepSnapshot {
  revision: number;
  fingerprint: string;
}

/** FNV-1a over UTF-16 code units, as hex: stable, dependency-free, and good enough to see change. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The snapshot of every step, keyed `<guide>.<step>`, with copy read from the English locale. */
export function snapshotOf(
  guides: readonly GuideDefinition[],
  english: (key: string) => string | undefined,
): Record<string, StepSnapshot> {
  const snapshot: Record<string, StepSnapshot> = {};
  for (const guide of guides) {
    for (const step of guide.steps) {
      const prefix = `guides.${guide.id}.steps.${step.id}`;
      const content = JSON.stringify([
        step.anchor,
        english(`${prefix}.title`) ?? "",
        english(`${prefix}.body`) ?? "",
      ]);
      snapshot[`${guide.id}.${step.id}`] = { revision: step.revision, fingerprint: fnv1a(content) };
    }
  }
  return snapshot;
}

/** Read a dotted key out of a locale tree. */
export function localeLookup(tree: unknown): (key: string) => string | undefined {
  return (key) => {
    let current: unknown = tree;
    for (const part of key.split(".")) {
      if (!current || typeof current !== "object") return undefined;
      current = (current as Record<string, unknown>)[part];
    }
    return typeof current === "string" ? current : undefined;
  };
}
