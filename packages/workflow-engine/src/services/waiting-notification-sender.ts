/**
 * The one sender of «waiting for you» notifications.
 *
 * Execution writers queue a row in the transaction that puts a run into a person's wait (a step
 * marked `humanGate`, or the agent's question). This sender — run by the MCP server only, on a timer
 * like the attempt maintenance — delivers due rows through the person's communication channels and
 * records the outcome in the row. It drops a row whose wait is no longer current, keeps agent
 * questions at least `questionPauseMs` apart, and, when it sends a gate's notification, queues the
 * gate's single reminder due after its `remindAfter` — dropped like any row if the wait ends first.
 * (A gate with `notify: off` sends its own first message; the queue holds only its reminder, queued
 * by the writer.) Time comes from the injected clock, so tests drive it.
 */

import { createLogger, type ExecutionNotificationRepository } from "@mcp-moira/shared";
import type { ExecutionNotificationRow } from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import type { AgentDirectiveNode } from "../types/graph-nodes.js";
import { humanGateRemindAfterMs } from "../utils/human-gate.js";
import { notificationHeading, runPageUrl } from "../utils/notification-text.js";
import { projectExecutionRun } from "../utils/execution-run-projection.js";
import type { UserCommunicationService } from "./user-communication.js";
import { getActiveUserCommunicationService } from "./user-communication-provider.js";

export interface WaitingNotificationSenderOptions {
  now?: () => number;
  intervalMs?: number;
  /** Minimum time between two notifications about the agent's questions on one run. */
  questionPauseMs?: number;
  communication?: UserCommunicationService;
}

const BATCH_SIZE = 50;
/** The communication service's rate window: a rate-limited row is retried after it. */
const RATE_LIMIT_RETRY_MS = 60_000;
/** A row whose handling failed is set aside this long before the next try. */
const FAILED_ROW_RETRY_MS = 5 * 60_000;
const MAX_BATCHES_PER_TICK = 20;

/** Ten minutes: a second question sooner than this waits for its turn. */
export const AGENT_QUESTION_NOTIFICATION_PAUSE_MS = 10 * 60_000;

export class WaitingNotificationSender {
  private readonly logger = createLogger({ component: "WaitingNotificationSender" });
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly questionPauseMs: number;
  private readonly communication: UserCommunicationService;
  private running = false;

  constructor(
    private readonly repository: IDataRepository,
    private readonly queue: ExecutionNotificationRepository,
    options: WaitingNotificationSenderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.questionPauseMs = options.questionPauseMs ?? AGENT_QUESTION_NOTIFICATION_PAUSE_MS;
    this.communication = options.communication ?? getActiveUserCommunicationService();
  }

  start(): () => void {
    const timer = setInterval(() => {
      void this.tick().catch((error) =>
        this.logger.error("Waiting notification delivery failed", error),
      );
    }, this.intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** One pass: deliver what is due. Overlapping passes are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Drain what is due in batches, so a backlog cannot starve a fresh row; each row leaves the
      // pending set once handled (sent, dropped, or held to a later time).
      for (let batch = 0; batch < MAX_BATCHES_PER_TICK; batch++) {
        const due = this.queue.due(this.now(), BATCH_SIZE);
        for (const row of due) {
          try {
            await this.deliver(row);
          } catch (error) {
            // One row that cannot be handled must not stop everyone else's notifications: it is
            // set aside and tried again later.
            this.logger.error("Waiting notification could not be handled", {
              executionId: row.executionId,
              waitKey: row.waitKey,
              error: error instanceof Error ? error.message : String(error),
            });
            this.queue.hold(row.id, this.now() + FAILED_ROW_RETRY_MS);
          }
        }
        if (due.length < BATCH_SIZE) break;
      }
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: ExecutionNotificationRow): Promise<void> {
    if (!this.queue.holdsWait(row.executionId, row.waitKey)) {
      this.queue.markSuperseded(row.id);
      return;
    }
    if (row.waitKey.startsWith("agent:") && row.kind === "first") {
      const previous = this.queue.lastAgentQuestionSentAt(row.executionId, row.id);
      if (previous !== null && this.now() < previous + this.questionPauseMs) {
        this.queue.hold(row.id, previous + this.questionPauseMs);
        return;
      }
    }
    const loaded = await this.load(row.executionId);
    if (!loaded) {
      this.queue.markSuperseded(row.id);
      return;
    }
    const text = waitingNotificationText(loaded.graph, loaded.execution, row);
    if (text === null) {
      this.queue.markSuperseded(row.id);
      return;
    }
    let status = "all_failed";
    let channels: string[] = [];
    try {
      const result = await this.communication.deliver(
        { userId: loaded.execution.userId, text, format: "plain", purpose: "notification" },
        this.repository,
      );
      status = result.status;
      channels = result.channels
        .filter((channel) => channel.status === "delivered")
        .map((channel) => channel.channelId);
      // A person's channel budget is per minute: a notification refused only for the rate is tried
      // again after the window instead of being recorded as lost.
      if (
        result.deliveredChannels === 0 &&
        result.channels.some((channel) => channel.status === "rate_limited")
      ) {
        this.queue.hold(row.id, this.now() + RATE_LIMIT_RETRY_MS);
        return;
      }
    } catch (error) {
      this.logger.warn("Waiting notification could not be delivered", {
        executionId: row.executionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const sent = this.queue.markSent(row.id, this.now(), status, channels);
    // A gate with `remindAfter` gets its single reminder queued now, due after the pause; if the wait
    // ends first, the reminder is dropped when it comes due.
    if (sent && row.kind === "first" && row.waitKey.startsWith("gate:")) {
      const gate = gatedNode(loaded.graph, loaded.execution);
      const remindAfter = gate ? humanGateRemindAfterMs(gate.humanGate) : null;
      if (remindAfter !== null) {
        this.queue.enqueueReminder(row, this.now() + remindAfter, this.now());
      }
    }
  }

  private async load(
    executionId: string,
  ): Promise<{ execution: WorkflowExecution; graph: WorkflowGraph } | null> {
    const execution = await this.repository.getExecution(executionId);
    if (!execution) return null;
    const graph = await this.repository.getWorkflowGraph(execution.workflowId, execution.userId);
    return graph ? { execution, graph } : null;
  }
}

function gatedNode(
  graph: WorkflowGraph,
  execution: WorkflowExecution,
): (AgentDirectiveNode & { humanGate: NonNullable<AgentDirectiveNode["humanGate"]> }) | null {
  const node = graph.nodes.find((candidate) => candidate.id === execution.currentNodeId);
  if (!node || node.type !== "agent-directive") return null;
  const directive = node as AgentDirectiveNode;
  return directive.humanGate
    ? (directive as AgentDirectiveNode & {
        humanGate: NonNullable<AgentDirectiveNode["humanGate"]>;
      })
    : null;
}

/**
 * The notification text: the run's heading (flow · task, then the run link on its own line, as in
 * plain `user-notification` messages) and what the person is asked. Null when the run no longer
 * holds what the row is about.
 */
export function waitingNotificationText(
  graph: WorkflowGraph,
  execution: WorkflowExecution,
  row: Pick<ExecutionNotificationRow, "waitKey" | "kind">,
): string | null {
  const heading = notificationHeading(
    graph.metadata.name,
    execution.note,
    runPageUrl({ executionId: execution.executionId }),
    "plain",
  );
  const reminder = row.kind === "remind" ? "Reminder — " : "";
  if (row.waitKey.startsWith("agent:")) {
    const question = execution.awaitingUser;
    if (!question) return null;
    const lines = [`🙋 ${reminder}The agent is asking you: ${question.question}`];
    for (const option of question.options ?? []) lines.push(`• ${option}`);
    lines.push("Answer the agent in the chat.");
    return `${heading}\n\n${lines.join("\n")}`;
  }
  const gate = gatedNode(graph, execution);
  if (!gate) return null;
  let label = gate.humanGate.label?.trim();
  if (!label) {
    const progress = graph.progress ? projectExecutionRun(graph, execution) : null;
    label =
      progress?.waitingForUser?.source === "gate"
        ? progress.waitingForUser.label
        : graph.metadata.name;
  }
  return `${heading}\n\n🙋 ${reminder}Waiting for your decision: ${label}\nAnswer the agent in the chat.`;
}
