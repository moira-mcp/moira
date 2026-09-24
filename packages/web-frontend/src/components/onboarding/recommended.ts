/**
 * The flows Moira recommends to someone new — the one place that knows which they are.
 *
 * Two groups. The learning examples teach how Moira runs a flow, one idea at a time: plain steps,
 * one choice, several paths; each exists in English and in Russian, and the reader is offered the
 * version in their interface language. The universal flows are the ready ones for everyday tasks
 * with no special logic: Quick Task, Robust Task and Todo List. Every entry is a bundled catalog
 * flow of the system owner, addressed as `moira/<slug>`; what each one does and when to pick it is
 * interface text (`onboarding.*` in the locales), not flow metadata.
 *
 * The learning examples open on the steps view: a newcomer meets the simplest picture first.
 */

import type { FlowViewMode } from "../flow/modes";

/** Handle of the owner of the bundled catalog. */
export const SYSTEM_HANDLE = "moira";

export type RecommendedKind = "example" | "universal";

export interface RecommendedFlow {
  /** Key of the entry's texts under `onboarding.<kind>s.<key>`. */
  key: string;
  kind: RecommendedKind;
  /** Catalog slug of the version for the reader's language. */
  slug: string;
  /** 1-based level of a learning example; null for a universal flow. */
  level: number | null;
}

const EXAMPLES = [
  { key: "simpleSteps", slug: "example-simple-steps" },
  { key: "oneChoice", slug: "example-one-choice" },
  { key: "severalPaths", slug: "example-several-paths" },
] as const;

const UNIVERSAL = [
  { key: "quickTask", slug: "quick-task" },
  { key: "robustTask", slug: "robust-task" },
  { key: "todoList", slug: "todo-list" },
] as const;

const RUSSIAN_SUFFIX = "-ru";

function isRussian(language: string | undefined): boolean {
  return (language ?? "").toLowerCase().startsWith("ru");
}

/** The recommended flows for a reader of this interface language, examples first. */
export function recommendedFlows(language: string | undefined): RecommendedFlow[] {
  const suffix = isRussian(language) ? RUSSIAN_SUFFIX : "";
  return [
    ...EXAMPLES.map((entry, index) => ({
      key: entry.key,
      kind: "example" as const,
      slug: `${entry.slug}${suffix}`,
      level: index + 1,
    })),
    ...UNIVERSAL.map((entry) => ({
      key: entry.key,
      kind: "universal" as const,
      slug: entry.slug,
      level: null,
    })),
  ];
}

const EXAMPLE_SLUGS = new Set(
  EXAMPLES.flatMap((entry) => [entry.slug, `${entry.slug}${RUSSIAN_SUFFIX}`]),
);

/** The view a flow opens on when the link names none. */
export function preferredFlowView(
  ownerHandle: string | undefined,
  slug: string | undefined,
): FlowViewMode | null {
  return ownerHandle === SYSTEM_HANDLE && slug && EXAMPLE_SLUGS.has(slug) ? "steps" : null;
}
