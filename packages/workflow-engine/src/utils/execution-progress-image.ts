import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import { projectExecutionProgress } from "./execution-progress.js";
import { renderExecutionProgressPng } from "./execution-progress-renderer.js";
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
  return async function renderExecutionProgressImage(
    workflow: WorkflowGraph,
    execution: WorkflowExecution,
    options: ProgressVisualOptions = {},
  ): Promise<RenderedExecutionProgressImage | null> {
    const progress = projectExecutionProgress(workflow, execution);
    if (!progress) return null;
    const { png, model } = await renderer(progress, options);
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
