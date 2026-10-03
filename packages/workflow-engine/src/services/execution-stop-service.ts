import {
  AuditAction,
  AuditRepository,
  getDatabase,
  logAuditEventDirect,
  activeExecutionsGauge,
  workflowExecutionsTotal,
  ValidationError,
  NotFoundError,
  type AuditContext,
} from "@mcp-moira/shared";
import type {
  ExecutionStopRequest,
  ExecutionStopResult,
} from "@mcp-moira/shared/execution-management";
import type { IDataRepository } from "../interfaces/data-repository.js";

export interface ExecutionStopEffects {
  audit(context: AuditContext & { source: "api" | "mcp" }): Promise<void>;
  stopped(workflowId: string): void;
}

/** One owner of the persisted stop and its changed-only effects, shared by HTTP and MCP. */
export class ExecutionStopService {
  constructor(
    private readonly repository: IDataRepository,
    private readonly effects: ExecutionStopEffects = {
      audit: (context) => logAuditEventDirect(new AuditRepository(getDatabase()), context),
      stopped: (workflowId) => {
        activeExecutionsGauge.dec();
        workflowExecutionsTotal.inc({ status: "stopped", workflow_id: workflowId });
      },
    },
  ) {}

  async stop(
    executionId: string,
    userId: string,
    input: ExecutionStopRequest,
    source: "api" | "mcp",
  ): Promise<ExecutionStopResult> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      throw new ValidationError("expectedRevision must be a non-negative safe integer");
    if (
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.trim().length > 500
    )
      throw new ValidationError("Stop reason must contain 1–500 characters");
    const reason = input.reason.trim();
    // This read supplies immutable workflow identity for effects, never a preflight authority veto.
    const [header] = await this.repository.getExecutionManagementHeaders([executionId]);
    if (!header) throw new NotFoundError("Execution not found");
    const result = await this.repository.stopExecution(
      executionId,
      userId,
      input.expectedRevision,
      reason,
    );
    if (result.changed) {
      this.effects.stopped(header.workflowId);
      await this.effects.audit({
        userId,
        action: AuditAction.EXECUTION_CANCEL,
        resource: "execution",
        resourceId: executionId,
        source,
        metadata: { reason, outcome: "stopped" },
      });
    }
    return {
      executionId,
      stopped: true,
      stopReason: reason,
      revision: result.revision,
      changed: result.changed,
      displayStatus: "stopped",
      stopCapability: { available: false, revision: result.revision, reason: "terminal" },
    };
  }
}
