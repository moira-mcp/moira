/**
 * The annotated-workflow source of each fixture: the generated snapshot plus its authored nodes.
 * `deriveProjection` turns these into the same `ProcessProjection` the hand fixtures describe.
 */
import type { AnnotatedWorkflow, AuthoredNode } from "../model";
import type { FixtureId } from "./index";
import { QUICK_TASK_AUTHORED, SDF_AUTHORED } from "./authored";
import { QUICK_TASK_WORKFLOW, SDF_WORKFLOW } from "./workflows";

export const WORKFLOWS: Record<
  FixtureId,
  { workflow: AnnotatedWorkflow; authored: AuthoredNode[] }
> = {
  "quick-task": { workflow: QUICK_TASK_WORKFLOW, authored: QUICK_TASK_AUTHORED },
  "software-development-flow": { workflow: SDF_WORKFLOW, authored: SDF_AUTHORED },
};

export type SourceId = "fixture" | "derived";
export const DEFAULT_SOURCE: SourceId = "fixture";
export function isSourceId(value: string | null | undefined): value is SourceId {
  return value === "fixture" || value === "derived";
}
