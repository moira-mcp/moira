import { createLogger, executionMutationAttemptsTotal } from "@mcp-moira/shared";
import type { IDataRepository } from "../interfaces/data-repository.js";

export interface ExecutionAttemptMaintenanceOptions {
  now?: () => number;
  reconcileIntervalMs?: number;
  cleanupIntervalMs?: number;
}

export class ExecutionAttemptMaintenance {
  private readonly logger = createLogger({ component: "ExecutionAttemptMaintenance" });
  private readonly now: () => number;
  private readonly reconcileIntervalMs: number;
  private readonly cleanupIntervalMs: number;

  constructor(
    private readonly repository: IDataRepository,
    options: ExecutionAttemptMaintenanceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? 10_000;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 10 * 60_000;
  }

  async start(): Promise<() => void> {
    await this.reconcile();
    await this.cleanup();
    const reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) =>
        this.logger.error("Attempt reconciliation failed", error),
      );
    }, this.reconcileIntervalMs);
    const cleanupTimer = setInterval(() => {
      void this.cleanup().catch((error) =>
        this.logger.error("Attempt receipt cleanup failed", error),
      );
    }, this.cleanupIntervalMs);
    reconcileTimer.unref?.();
    cleanupTimer.unref?.();
    return () => {
      clearInterval(reconcileTimer);
      clearInterval(cleanupTimer);
    };
  }

  private async reconcile(): Promise<void> {
    const counts = await this.repository.reconcileExpiredExecutionAttempts(this.now());
    if (counts.start > 0) {
      executionMutationAttemptsTotal.inc(
        { operation: "start", outcome: "outcome_unknown" },
        counts.start,
      );
    }
    if (counts.step > 0) {
      executionMutationAttemptsTotal.inc(
        { operation: "step", outcome: "outcome_unknown" },
        counts.step,
      );
    }
    if (counts.start + counts.step > 0) {
      this.logger.warn("Fenced expired workflow mutation attempts", counts);
    }
  }

  private async cleanup(): Promise<void> {
    const count = await this.repository.cleanupExecutionAttempts(this.now());
    if (count > 0) this.logger.info("Removed expired workflow mutation receipts", { count });
  }
}
