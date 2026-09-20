import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import { projectExecutionRun } from "./execution-run-projection.js";
import { renderExecutionProgressPng } from "./execution-progress-renderer.js";
import type { WorkflowVersionStatistics } from "./execution-statistics.js";
import type { ProgressVisualOptions } from "./execution-progress-visual.js";

export interface RenderedExecutionProgressImage {
  buffer: Buffer;
  mimeType: "image/png";
  width: number;
  height: number;
  workflowVersion: string;
  executionRevision: number;
}

type PngRenderer = typeof renderExecutionProgressPng;

export function createExecutionProgressImageRenderer(
  renderer: PngRenderer = renderExecutionProgressPng,
) {
  /**
   * The progress picture of a run. `statistics` — the typical durations of the version the run
   * started on, as `ProgressStatisticsService.forVersion` returns them for the run's owner —
   * are drawn on the cards when given; without them the cards carry the run's own facts alone.
   */
  return async function renderExecutionProgressImage(
    workflow: WorkflowGraph,
    execution: WorkflowExecution,
    options: ProgressVisualOptions = {},
    statistics?: WorkflowVersionStatistics | null,
  ): Promise<RenderedExecutionProgressImage | null> {
    const progress = projectExecutionRun(workflow, execution);
    if (!progress) return null;
    const { png, model } = await renderer(progress, options, statistics);
    return {
      buffer: png,
      mimeType: "image/png",
      width: model.width,
      height: model.height,
      workflowVersion: progress.workflowVersion,
      executionRevision: progress.executionRevision,
    };
  };
}

export const renderExecutionProgressImage = createExecutionProgressImageRenderer();
