/** Cloud presentation supplies its URL resolver; the projection itself is owner-portable. */
import { runPageUrl } from "./notification-text.js";
import {
  projectExecutionRun as projectRun,
  projectExecutionRunSummary as projectSummary,
  projectExecutionProgress as projectProgress,
  resolveExecutionTaskTitle as resolveTitle,
} from "./execution-run-projection-core.js";
export * from "./execution-run-projection-core.js";

export const projectExecutionRun: typeof projectRun = (workflow, execution, options = {}) =>
  projectRun(workflow, execution, { resolveRunUrl: runPageUrl, ...options });
export const projectExecutionRunSummary: typeof projectSummary = (
  workflow,
  execution,
  options = {},
) => projectSummary(workflow, execution, { resolveRunUrl: runPageUrl, ...options });
export const projectExecutionProgress: typeof projectProgress = (
  workflow,
  execution,
  options = {},
) => projectProgress(workflow, execution, { resolveRunUrl: runPageUrl, ...options });
export const resolveExecutionTaskTitle: typeof resolveTitle = (
  workflow,
  execution,
  resolver = runPageUrl,
) => resolveTitle(workflow, execution, resolver);
