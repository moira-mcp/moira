/**
 * A run projection without the parts that depend on the moment it was made: `projectedAt`, the
 * open pass's duration, and the statistics' computation time. Two projections of the same run
 * taken a few milliseconds apart are equal on everything else.
 */
export function withoutMoment<T extends Record<string, unknown>>(progress: T): T {
  const statistics = progress.statistics as Record<string, unknown> | null | undefined;
  return {
    ...progress,
    projectedAt: 0,
    ...(statistics ? { statistics: { ...statistics, computedAt: 0 } } : {}),
    nodes: (progress.nodes as Array<Record<string, unknown>>).map((node) => {
      const timing = node.timing as {
        passes: Array<Record<string, unknown>>;
        currentMs: number | null;
        totalMs: number | null;
      };
      return {
        ...node,
        timing: {
          ...timing,
          currentMs: timing.currentMs === null ? null : 0,
          totalMs: timing.currentMs === null ? timing.totalMs : 0,
          passes: timing.passes.map((pass) => (pass.open ? { ...pass, durationMs: 0 } : pass)),
        },
      };
    }),
  };
}
