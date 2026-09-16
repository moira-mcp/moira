/**
 * Per-version duration statistics: what a block typically takes, over the runs that started on
 * one definition version. The sample is every execution stamped with that version and projected
 * onto the current process (block ids are the join key); executions without a stamp are counted
 * apart and never sampled, and the run asking about itself is left out so its own timing does
 * not move the typical value it is compared with. A measured pass is a closed pass with
 * timestamps; a run's block total is the sum of its measured passes. Per-item typical durations
 * come from passes attributed to a bound list item, by item position. Pure.
 */

import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { WorkflowExecution } from "../types/base-types.js";
import { projectExecutionRun } from "./execution-run-projection.js";

export interface DurationSample {
  sampleCount: number;
  medianMs: number | null;
  /** Lower and upper quartile: the spread around the median. */
  p25Ms: number | null;
  p75Ms: number | null;
  minMs: number | null;
  maxMs: number | null;
}

export interface BlockDurationStatistics {
  blockId: string;
  /** One measured pass through the block's working step. */
  pass: DurationSample;
  /** A run's whole time in the block (all its measured passes). */
  run: DurationSample;
  /** Median number of passes a run makes through the block. */
  typicalPasses: number | null;
  /** Per list-item position, when the block binds a list; empty when no pass was attributed. */
  items: Array<{ index: number; title: string | null } & DurationSample>;
}

export interface WorkflowVersionStatistics {
  workflowId: string;
  workflowVersion: string;
  /** Executions in the sample (stamped with the version, the asking run excluded). */
  sampledRuns: number;
  /** Executions of this workflow that carry no version stamp and are therefore not sampled. */
  versionNotRecorded: number;
  blocks: BlockDurationStatistics[];
  computedAt: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return Math.round(sorted[lower] * (1 - weight) + sorted[upper] * weight);
}

export function sample(values: readonly number[]): DurationSample {
  if (values.length === 0) {
    return { sampleCount: 0, medianMs: null, p25Ms: null, p75Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    sampleCount: sorted.length,
    medianMs: quantile(sorted, 0.5),
    p25Ms: quantile(sorted, 0.25),
    p75Ms: quantile(sorted, 0.75),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
  };
}

export interface ComputeStatisticsOptions {
  excludeExecutionId?: string;
  now?: number;
  /** Reported id; the graph's own id when omitted. */
  workflowId?: string;
}

/**
 * Compute the statistics of `workflowVersion` from `executions` (any of the workflow's runs;
 * the function selects the stamped ones itself and counts the unstamped).
 */
export function computeVersionStatistics(
  workflow: WorkflowGraph,
  workflowVersion: string,
  executions: readonly WorkflowExecution[],
  options: ComputeStatisticsOptions = {},
): WorkflowVersionStatistics {
  const now = options.now ?? Date.now();
  const blocks = workflow.progress?.nodes.map((node) => node.id) ?? [];
  const passSamples = new Map<string, number[]>(blocks.map((id) => [id, []]));
  const runSamples = new Map<string, number[]>(blocks.map((id) => [id, []]));
  const passCounts = new Map<string, number[]>(blocks.map((id) => [id, []]));
  const itemSamples = new Map<string, Map<number, { title: string | null; values: number[] }>>(
    blocks.map((id) => [id, new Map()]),
  );
  let sampledRuns = 0;
  let versionNotRecorded = 0;
  for (const execution of executions) {
    if (execution.executionId === options.excludeExecutionId) continue;
    if (!execution.workflowVersion) {
      versionNotRecorded += 1;
      continue;
    }
    if (execution.workflowVersion !== workflowVersion) continue;
    const projection = projectExecutionRun(workflow, execution, { now });
    if (!projection) continue;
    sampledRuns += 1;
    for (const node of projection.nodes) {
      const closed = node.timing.passes.filter((pass) => !pass.open && pass.durationMs !== null);
      if (closed.length === 0) continue;
      passSamples.get(node.id)?.push(...closed.map((pass) => pass.durationMs!));
      if (execution.status === "completed") {
        runSamples.get(node.id)?.push(closed.reduce((sum, pass) => sum + pass.durationMs!, 0));
        passCounts.get(node.id)?.push(closed.length);
      }
      const items = itemSamples.get(node.id);
      if (!items) continue;
      const perItem = new Map<number, number>();
      for (const pass of closed) {
        if (pass.itemIndex === null) continue;
        perItem.set(pass.itemIndex, (perItem.get(pass.itemIndex) ?? 0) + pass.durationMs!);
      }
      for (const [index, duration] of perItem) {
        const entry = items.get(index) ?? { title: null, values: [] };
        entry.values.push(duration);
        entry.title = node.list?.items?.[index]?.title ?? entry.title;
        items.set(index, entry);
      }
    }
  }
  return {
    workflowId: options.workflowId ?? workflow.id ?? "",
    workflowVersion,
    sampledRuns,
    versionNotRecorded,
    blocks: blocks.map((blockId) => {
      const counts = passCounts.get(blockId) ?? [];
      return {
        blockId,
        pass: sample(passSamples.get(blockId) ?? []),
        run: sample(runSamples.get(blockId) ?? []),
        typicalPasses: counts.length
          ? quantile(
              [...counts].sort((a, b) => a - b),
              0.5,
            )
          : null,
        items: [...(itemSamples.get(blockId) ?? new Map())]
          .sort(([a], [b]) => a - b)
          .map(([index, entry]) => ({ index, title: entry.title, ...sample(entry.values) })),
      };
    }),
    computedAt: now,
  };
}
