/**
 * Execution retention cleanup.
 *
 * Bounds unbounded growth of the workflow execution table: periodically deletes
 * completed executions older than a configurable retention period
 * (`executions.retention_days` global setting). A value of 0 (the default)
 * disables cleanup — executions are kept forever, preserving prior behavior.
 *
 * Running executions are never deleted; a completed parent with a still-running
 * child is preserved (see ExecutionRepository.deleteCompletedOlderThan).
 */

import { createLogger } from "../logging/logger.js";
import type { ExecutionRepository } from "../database/repositories/execution-repository.js";
import type { GlobalSettingsService } from "./global-settings-service.js";

const RETENTION_SETTING_KEY = "executions.retention_days";
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class ExecutionRetentionService {
  private logger = createLogger({ component: "ExecutionRetention" });
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private executionRepo: ExecutionRepository,
    private globalSettingsService: GlobalSettingsService,
    private intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  /**
   * Resolve the configured retention in days (0 = disabled).
   */
  async getRetentionDays(): Promise<number> {
    const raw = await this.globalSettingsService.getValue<string>(RETENTION_SETTING_KEY);
    if (!raw) return 0;
    const days = parseInt(raw, 10);
    return Number.isFinite(days) && days > 0 ? days : 0;
  }

  /**
   * Run one cleanup pass. No-op when retention is disabled (0).
   * @returns number of executions deleted
   */
  async runOnce(now: Date = new Date()): Promise<number> {
    const days = await this.getRetentionDays();
    if (days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * MS_PER_DAY);
    const deleted = await this.executionRepo.deleteCompletedOlderThan(cutoff);
    if (deleted > 0) {
      this.logger.info("Execution retention cleanup deleted completed executions", {
        deleted,
        retentionDays: days,
        cutoff: cutoff.toISOString(),
      });
    }
    return deleted;
  }

  /**
   * Start the periodic cleanup loop. Idempotent. The timer is unref'd so it
   * never keeps the process alive on its own.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch((err) => {
        this.logger.error("Execution retention cleanup failed", err);
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic cleanup loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
