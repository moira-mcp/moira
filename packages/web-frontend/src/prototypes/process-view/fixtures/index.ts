import type { ProcessProjection } from "../model";
import { QUICK_TASK_PROJECTION } from "./quick-task";
import { SDF_PROJECTION } from "./software-development-flow";

export type FixtureId = "quick-task" | "software-development-flow";

export const FIXTURES: Record<FixtureId, ProcessProjection> = {
  "quick-task": QUICK_TASK_PROJECTION,
  "software-development-flow": SDF_PROJECTION,
};

export const DEFAULT_FIXTURE: FixtureId = "quick-task";

export function isFixtureId(value: string | null | undefined): value is FixtureId {
  return value === "quick-task" || value === "software-development-flow";
}
