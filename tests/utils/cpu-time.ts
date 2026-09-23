/**
 * CPU time a piece of synchronous work consumes in this process.
 *
 * A test that proves an algorithm is bounded (no catastrophic regex backtracking, linear rather
 * than quadratic) measures the work itself, not how long the wall clock ran: under a loaded
 * machine the process waits for a CPU, and that wait says nothing about the algorithm. Jest runs
 * unit test files in separate worker processes, so another file's load is not counted here, while
 * backtracking or quadratic work still shows up in full.
 */
export function cpuTimeMs<T>(work: () => T): { result: T; cpuMs: number } {
  const started = process.cpuUsage();
  const result = work();
  const used = process.cpuUsage(started);
  return { result, cpuMs: (used.user + used.system) / 1000 };
}
