import type { FixtureId } from "../fixtures";
import { WORKFLOWS } from "../fixtures/derived";
import { simulateTrace, type RunTrace, type TraceScript } from "../trace";
import { QUICK_TASK_TRACES } from "./quick-task";
import { SDF_TRACES } from "./software-development-flow";

const SCRIPTS: Record<FixtureId, TraceScript[]> = {
  "quick-task": QUICK_TASK_TRACES,
  "software-development-flow": SDF_TRACES,
};

/** Simulated traces per workflow, computed once from the real annotated graph. */
export const TRACES: Record<FixtureId, RunTrace[]> = {
  "quick-task": SCRIPTS["quick-task"].map((s) =>
    simulateTrace("quick-task", WORKFLOWS["quick-task"].authored, s),
  ),
  "software-development-flow": SCRIPTS["software-development-flow"].map((s) =>
    simulateTrace("software-development-flow", WORKFLOWS["software-development-flow"].authored, s),
  ),
};

export function findTrace(fixtureId: FixtureId, traceId: string | null): RunTrace | null {
  if (!traceId) return null;
  return TRACES[fixtureId].find((t) => t.id === traceId) ?? null;
}
