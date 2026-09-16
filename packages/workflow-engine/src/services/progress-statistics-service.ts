/**
 * Serves per-version duration statistics with a cache that a newly finished run of that version
 * refreshes: the sample is one user's completed runs of the version (a public workflow is run by
 * many users, and one user's runs — their list item titles among them — are not another's
 * statistics); the cache key is the workflow, the version, the user and the excluded run; the
 * entry is valid while the repository's summary of that sample (completed count, latest
 * completion, unstamped count) is unchanged, so stepping runs do not invalidate it and a request
 * never scans the executions twice for the same state.
 */

import type { IDataRepository } from "../interfaces/data-repository.js";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import {
  computeVersionStatistics,
  type WorkflowVersionStatistics,
} from "../utils/execution-statistics.js";

interface CacheEntry {
  signature: string;
  value: WorkflowVersionStatistics;
}

/** Entries kept per process; the oldest is evicted past this, so memory stays flat under uptime. */
const CACHE_LIMIT = 256;

export class ProgressStatisticsService {
  private static readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly repository: IDataRepository) {}

  /**
   * Statistics of one definition version over `userId`'s completed runs; `excludeExecutionId`
   * leaves the asking run out.
   */
  async forVersion(
    workflowId: string,
    workflow: WorkflowGraph,
    workflowVersion: string,
    options: { userId: string; excludeExecutionId?: string; now?: number },
  ): Promise<WorkflowVersionStatistics> {
    const summary = await this.repository.summarizeExecutionsByWorkflowVersion(
      workflowId,
      workflowVersion,
      options.userId,
    );
    const key = `${workflowId}@${workflowVersion}|${options.userId}|${options.excludeExecutionId ?? ""}`;
    const signature = `${summary.count}:${summary.lastCompletedAt ?? 0}:${summary.unstamped}`;
    const cached = ProgressStatisticsService.cache.get(key);
    if (cached && cached.signature === signature) {
      // Re-insert so the entry becomes the newest (insertion order is the eviction order).
      ProgressStatisticsService.cache.delete(key);
      ProgressStatisticsService.cache.set(key, cached);
      return cached.value;
    }
    const executions = await this.repository.listExecutionsByWorkflowVersion(
      workflowId,
      workflowVersion,
      options.userId,
    );
    const value = computeVersionStatistics(workflow, workflowVersion, executions, {
      excludeExecutionId: options.excludeExecutionId,
      now: options.now,
      workflowId,
    });
    // The listing holds stamped runs only; the unstamped count comes from the summary.
    value.versionNotRecorded = summary.unstamped;
    ProgressStatisticsService.cache.delete(key);
    ProgressStatisticsService.cache.set(key, { signature, value });
    while (ProgressStatisticsService.cache.size > CACHE_LIMIT) {
      const oldest = ProgressStatisticsService.cache.keys().next().value;
      if (oldest === undefined) break;
      ProgressStatisticsService.cache.delete(oldest);
    }
    return value;
  }

  /** Test seam: how many aggregates are held. */
  static cacheSize(): number {
    return ProgressStatisticsService.cache.size;
  }

  /** Test seam: forget every cached aggregate. */
  static resetCache(): void {
    ProgressStatisticsService.cache.clear();
  }
}
