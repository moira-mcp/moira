/**
 * What every notification of a run is framed with: the flow's name, the run's task title, the run
 * page, and the run's progress as of the sending node. One implementation for the
 * `user-notification` node, the deprecated `telegram-notification` node and the lock PIN message.
 *
 * The run is read as of the node that sends: inside an executor cycle that is the live run (the
 * persisted state plus what the cycle changed before this node — a plan the agent just submitted,
 * an item it just finished); independently mutable task identity comes from the current stored run.
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
import {
  projectExecutionRun,
  resolveExecutionTaskTitle,
} from "../utils/execution-run-projection.js";
import { metadataRevision, ConflictError } from "@mcp-moira/shared";
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
  taskTitle: string | null;
  url: string;
  graph: WorkflowGraph | null;
  /** The run as of the sending node, before its in-flight visit; null for an unsaved inline run. */
  run: WorkflowExecution | null;
  /** The run projected with the sending node in flight; null without a progress definition. */
  progress: ExecutionProgress | null;
  /**
   * The sending node leads straight to an end node: the message is the run's last, so no plan item
   * is still in progress — unfinished items read as open.
   */
  closing: boolean;
}

/**
 * Resolve the frame. Lookups that fail leave their part at its fallback — the workflow id for the
 * name, no task title, no progress — because a notification is still worth sending without them.
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
    taskTitle: null,
    url: runPageUrl(context),
    graph: null,
    run: null,
    progress: null,
    closing: false,
  };
  try {
    const workflow = await repository.getWorkflow(context.workflowId, userId);
    if (workflow?.metadata?.name) frame.flowName = workflow.metadata.name;
  } catch {
    // The workflow id is an intentional non-secret fallback for the name.
  }
  try {
    frame.graph = await repository.getWorkflowGraph(context.workflowId, userId);
  } catch {
    // Independent task identity remains usable without the authored graph.
  }
  try {
    frame.run = await currentNotificationRun(repository, context, liveRun);
    frame.taskTitle = frame.run
      ? resolveExecutionTaskTitle(frame.graph ?? undefined, frame.run)
      : null;
    const sender = frame.graph?.nodes.find((node) => node.id === nodeId);
    const next = (sender?.connections as Record<string, string | undefined> | undefined)?.default;
    frame.closing = frame.graph?.nodes.find((node) => node.id === next)?.type === "end";
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
    heading: notificationHeading(frame.flowName, frame.taskTitle, frame.url, options.format),
    body,
    planList: (budget) => {
      const ended = frame.closing;
      if (mode === "full") return planListLines(frame.progress, budget, escape, { ended });
      if (mode === "none") return [];
      const line = boundListLine(frame.progress, escape, { ended });
      return line && line.length <= budget ? [line] : [];
    },
    waitingLine: waitingActorLine(frame.progress, escape),
    limit: options.limit,
  });
}

/** Keep the sending cycle's context and visits, but reconcile independently mutable identity. */
export async function currentNotificationRun(
  repository: IDataRepository,
  context: Pick<ExecutionContext, "executionId" | "workflowId" | "userId">,
  liveRun?: () => WorkflowExecution,
): Promise<WorkflowExecution | null> {
  const stored = await repository.getExecution(context.executionId);
  const live = liveRun?.();
  if (!stored) return live ?? null;
  const owned =
    stored.executionId === context.executionId &&
    stored.workflowId === context.workflowId &&
    stored.userId === context.userId;
  const source = live ?? stored;
  return { ...source, taskIdentity: owned ? (stored.taskIdentity ?? null) : null };
}

/** A picture and its caption use one current identity even when rendering yields to a rename. */
export async function prepareNotificationFrame<T>(
  repository: IDataRepository,
  context: ExecutionContext,
  nodeId: string,
  frame: NotificationFrame,
  render: (frame: NotificationFrame) => Promise<T>,
): Promise<{ frame: NotificationFrame; value: T }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const refresh = async () => {
      if (!frame.run) return;
      const run = await currentNotificationRun(
        repository,
        context,
        frame.run ? () => frame.run! : undefined,
      );
      if (run)
        frame = {
          ...frame,
          run,
          taskTitle: resolveExecutionTaskTitle(frame.graph ?? undefined, run),
          progress: frame.graph?.progress
            ? projectExecutionRun(frame.graph, withInFlightPause(frame.graph, run, nodeId))
            : null,
        };
    };
    await refresh();
    const before = metadataRevision(frame.run?.taskIdentity ?? null);
    const value = await render(frame);
    await refresh();
    if (before === metadataRevision(frame.run?.taskIdentity ?? null)) return { frame, value };
  }
  throw new ConflictError("Task identity changed while preparing notification");
}
