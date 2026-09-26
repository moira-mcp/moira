/**
 * What every notification of a run is framed with: the flow's name, the run's task note, the run
 * page, and the run's progress as of the sending node. One implementation for the
 * `user-notification` node, the deprecated `telegram-notification` node and the lock PIN message.
 *
 * The run is read as of the node that sends: inside an executor cycle that is the live run (the
 * persisted state plus what the cycle changed before this node — a plan the agent just submitted,
 * an item it just finished, a note it just set); elsewhere the persisted run.
 */

import type { IDataRepository } from "../interfaces/data-repository.js";
import type { ExecutionContext, WorkflowExecution, WorkflowGraph } from "../types/index.js";
import type { ExecutionProgress } from "../utils/execution-progress-contract.js";
import {
  boundListLine,
  planListLines,
  waitingActorLine,
  type PlanListMode,
} from "../utils/execution-progress-lists.js";
import { projectExecutionRun } from "../utils/execution-run-projection.js";
import { withInFlightPause } from "../utils/execution-visits.js";
import {
  composeNotification,
  notificationHeading,
  runPageUrl,
  textEscaper,
  type NotificationFormat,
} from "../utils/notification-text.js";

export interface NotificationFrame {
  flowName: string;
  note: string | null;
  url: string;
  graph: WorkflowGraph | null;
  /** The run as of the sending node, before its in-flight visit; null for an unsaved inline run. */
  run: WorkflowExecution | null;
  /** The run projected with the sending node in flight; null without a progress definition. */
  progress: ExecutionProgress | null;
}

/**
 * Resolve the frame. Lookups that fail leave their part at its fallback — the workflow id for the
 * name, no note, no progress — because a notification is still worth sending without them.
 */
export async function resolveNotificationFrame(
  repository: IDataRepository,
  context: ExecutionContext,
  nodeId: string,
  liveRun?: () => WorkflowExecution,
): Promise<NotificationFrame> {
  const userId = context.userId || "system";
  const frame: NotificationFrame = {
    flowName: context.workflowId || "Workflow",
    note: null,
    url: runPageUrl(context),
    graph: null,
    run: null,
    progress: null,
  };
  try {
    const workflow = await repository.getWorkflow(context.workflowId, userId);
    if (workflow?.metadata?.name) frame.flowName = workflow.metadata.name;
  } catch {
    // The workflow id is an intentional non-secret fallback for the name.
  }
  try {
    frame.run = liveRun ? liveRun() : await repository.getExecution(context.executionId);
    frame.note = frame.run?.note ?? null;
    frame.graph = await repository.getWorkflowGraph(context.workflowId, userId);
    if (frame.graph?.progress && frame.run) {
      frame.progress = projectExecutionRun(
        frame.graph,
        withInFlightPause(frame.graph, frame.run, nodeId),
      );
    }
  } catch {
    // Without the run the heading keeps the flow name and the message goes without the plan.
  }
  return frame;
}

/** The delivered text: the heading, the author's message, the plan by `planList`, the actor. */
export function frameNotification(
  frame: NotificationFrame,
  body: string,
  options: { format?: NotificationFormat; planList?: PlanListMode; limit: number },
): string {
  const escape = textEscaper(options.format);
  const mode = options.planList ?? "progress";
  return composeNotification({
    heading: notificationHeading(frame.flowName, frame.note, frame.url, options.format),
    body,
    planList: (budget) => {
      if (mode === "full") return planListLines(frame.progress, budget, escape);
      if (mode === "none") return [];
      const line = boundListLine(frame.progress, escape);
      return line && line.length <= budget ? [line] : [];
    },
    waitingLine: waitingActorLine(frame.progress, escape),
    limit: options.limit,
  });
}
