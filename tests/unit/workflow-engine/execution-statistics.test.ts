/**
 * Per-version duration statistics: the sample is the runs stamped with the version, the asking
 * run and runs of other versions stay out, unstamped runs are counted but never sampled, and the
 * service refreshes its cache when a run of the version changes.
 */

import { describe, expect, test } from "@jest/globals";
import {
  computeVersionStatistics,
  InMemoryRepository,
  ProgressStatisticsService,
  type ExecutionVisit,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const T = 1_700_000_000_000;

function graph(): WorkflowGraph {
  return {
    id: "wf",
    metadata: { name: "Stats", version: "3.0.0", description: "Statistics fixture" },
    variableRegistry: {
      current_step: { type: "number", description: "cursor", default: 1 },
      total_steps: { type: "number", description: "total", default: 2 },
    },
    progress: {
      nodes: [
        { id: "plan", label: "Plan", content: { summary: "Plan" } },
        {
          id: "execute",
          label: "Execute",
          content: { summary: "Execute" },
          list: { current: "current_step", total: "total_steps" },
        },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "plan", connections: { default: "plan-it" } },
      {
        id: "plan-it",
        type: "agent-directive",
        progressNodeId: "plan",
        directive: "Plan",
        completionCondition: "Planned",
        connections: { success: "do" },
        connectionLabels: { success: "planned" },
      },
      {
        id: "do",
        type: "agent-directive",
        progressNodeId: "execute",
        directive: "Do",
        completionCondition: "Done",
        inputSchema: { type: "object", properties: {}, globalInputs: ["current_step"] },
        connections: { success: "end" },
      },
      { id: "end", type: "end", progressNodeId: "execute" },
    ],
  };
}

/** A completed run: plan took `planMs`, then two execute passes of `unitMs[0]` and `unitMs[1]`. */
function run(
  executionId: string,
  version: string | null,
  planMs: number,
  unitMs: [number, number],
  updatedAt = T,
): WorkflowExecution {
  let clock = T;
  const visit = (seq: number, nodeId: string, exitKey: string | null, ms: number, changes = {}) => {
    const entry: ExecutionVisit = {
      seq,
      nodeId,
      exitKey,
      changes,
      waited: nodeId !== "start" && nodeId !== "end",
      enteredAt: clock,
      leftAt: clock + ms,
    };
    clock += ms;
    return entry;
  };
  return {
    executionId,
    workflowId: "wf",
    userId: "user",
    currentNodeId: null,
    waitingForInputNodeId: null,
    globalContext: {
      variables: { current_step: 3, total_steps: 2 },
      nodeStates: {},
      executionId,
      workflowId: "wf",
      userId: "user",
    },
    status: "completed",
    revision: 3,
    workflowVersion: version,
    createdAt: T,
    updatedAt,
    completedAt: updatedAt,
    visits: [
      visit(0, "start", "default", 0, { current_step: 1 }),
      visit(1, "plan-it", "success", planMs),
      visit(2, "do", "success", unitMs[0], { current_step: 2 }),
      visit(3, "do", "success", unitMs[1], { current_step: 3 }),
      visit(4, "end", null, 0),
    ],
  };
}

describe("computeVersionStatistics", () => {
  test("three runs of one version give the median and sample count; another version and an unstamped run stay out", () => {
    const executions = [
      run("a", "3.0.0", 1_000, [200, 400]),
      run("b", "3.0.0", 3_000, [600, 800]),
      run("c", "3.0.0", 2_000, [1_000, 1_200]),
      run("old", "2.9.0", 90_000, [90_000, 90_000]),
      run("unstamped", null, 90_000, [90_000, 90_000]),
    ];
    const stats = computeVersionStatistics(graph(), "3.0.0", executions, { now: T });
    expect(stats).toMatchObject({
      workflowId: "wf",
      workflowVersion: "3.0.0",
      sampledRuns: 3,
      versionNotRecorded: 1,
    });
    const plan = stats.blocks.find((block) => block.blockId === "plan")!;
    expect(plan.run).toMatchObject({ sampleCount: 3, medianMs: 2_000, minMs: 1_000, maxMs: 3_000 });
    expect(plan.pass).toMatchObject({ sampleCount: 3, medianMs: 2_000 });
    expect(plan.typicalPasses).toBe(1);
    const execute = stats.blocks.find((block) => block.blockId === "execute")!;
    expect(execute.pass).toMatchObject({ sampleCount: 6, medianMs: 700 });
    expect(execute.run).toMatchObject({ sampleCount: 3, medianMs: 1_400 });
    expect(execute.typicalPasses).toBe(2);
    expect(execute.items.map((item) => [item.index, item.sampleCount, item.medianMs])).toEqual([
      [0, 3, 600],
      [1, 3, 800],
    ]);
  });

  test("the asking run is excluded from its own sample", () => {
    const executions = [run("a", "3.0.0", 1_000, [200, 400]), run("b", "3.0.0", 3_000, [600, 800])];
    const withoutA = computeVersionStatistics(graph(), "3.0.0", executions, {
      excludeExecutionId: "a",
      now: T,
    });
    expect(withoutA.sampledRuns).toBe(1);
    expect(withoutA.blocks[0].run.medianMs).toBe(3_000);
  });

  test("a run still running is not sampled, whatever it has recorded so far", () => {
    const running = run("live", "3.0.0", 1_000, [200, 400]);
    running.status = "running";
    running.completedAt = undefined;
    const stats = computeVersionStatistics(graph(), "3.0.0", [running], { now: T });
    expect(stats.sampledRuns).toBe(0);
    expect(stats.blocks[0].pass.sampleCount).toBe(0);
  });

  test("runs without timestamps contribute no samples", () => {
    const bare = run("bare", "3.0.0", 1_000, [200, 400]);
    bare.visits = bare.visits!.map(({ enteredAt: _e, leftAt: _l, ...visit }) => visit);
    const stats = computeVersionStatistics(graph(), "3.0.0", [bare], { now: T });
    expect(stats.sampledRuns).toBe(1);
    expect(
      stats.blocks.every((block) => block.pass.sampleCount === 0 && block.pass.medianMs === null),
    ).toBe(true);
  });
});

describe("ProgressStatisticsService", () => {
  test("holds a bounded number of aggregates: the oldest key is evicted, a re-read key stays", async () => {
    ProgressStatisticsService.resetCache();
    const repository = new InMemoryRepository();
    const definition = graph();
    await repository.saveWorkflow(definition, "user", "public");
    await repository.saveExecution(run("a", "3.0.0", 1_000, [200, 400], T));
    const service = new ProgressStatisticsService(repository);
    // 300 distinct asking runs: only the newest 256 keys survive.
    for (let index = 0; index < 300; index += 1) {
      await service.forVersion("wf", definition, "3.0.0", {
        userId: "user",
        excludeExecutionId: `ask-${index}`,
      });
    }
    expect(ProgressStatisticsService.cacheSize()).toBe(256);
    const kept = await service.forVersion("wf", definition, "3.0.0", {
      userId: "user",
      excludeExecutionId: "ask-299",
    });
    // The newest key was cached (same object back); the oldest was evicted (recomputed object).
    expect(
      await service.forVersion("wf", definition, "3.0.0", {
        userId: "user",
        excludeExecutionId: "ask-299",
      }),
    ).toBe(kept);
    const first = await service.forVersion("wf", definition, "3.0.0", {
      userId: "user",
      excludeExecutionId: "ask-0",
    });
    expect(first).not.toBe(kept);
    expect(ProgressStatisticsService.cacheSize()).toBe(256);
  });

  test("samples one user's completed runs only: another user's runs and a running run stay out and do not touch the cache", async () => {
    ProgressStatisticsService.resetCache();
    const repository = new InMemoryRepository();
    const definition = graph();
    await repository.saveWorkflow(definition, "user", "public");
    await repository.saveExecution(run("mine", "3.0.0", 1_000, [200, 400], T));
    const theirs = run("theirs", "3.0.0", 9_000, [9_000, 9_000], T);
    theirs.userId = "someone-else";
    await repository.saveExecution(theirs);
    const service = new ProgressStatisticsService(repository);
    const mine = await service.forVersion("wf", definition, "3.0.0", { userId: "user", now: T });
    expect(mine.sampledRuns).toBe(1);
    expect(mine.blocks[0].run.medianMs).toBe(1_000);
    const others = await service.forVersion("wf", definition, "3.0.0", {
      userId: "someone-else",
      now: T,
    });
    expect(others.sampledRuns).toBe(1);
    expect(others.blocks[0].run.medianMs).toBe(9_000);
    // A run of mine that is still stepping neither enters the sample nor invalidates the cache.
    const live = run("live", "3.0.0", 5, [5, 5], T + 50);
    live.status = "running";
    live.completedAt = undefined;
    await repository.saveExecution(live);
    expect(await service.forVersion("wf", definition, "3.0.0", { userId: "user", now: T })).toBe(
      mine,
    );
  });

  test("serves the aggregate through the repository and refreshes it when a run of the version changes", async () => {
    ProgressStatisticsService.resetCache();
    const repository = new InMemoryRepository();
    const definition = graph();
    await repository.saveWorkflow(definition, "user", "public");
    await repository.saveExecution(run("a", "3.0.0", 1_000, [200, 400], T));
    await repository.saveExecution(run("z", null, 5, [5, 5], T));
    const service = new ProgressStatisticsService(repository);
    const first = await service.forVersion("wf", definition, "3.0.0", { userId: "user", now: T });
    expect(first).toMatchObject({ sampledRuns: 1, versionNotRecorded: 1 });
    expect(first.blocks[0].run.medianMs).toBe(1_000);
    // Unchanged state: the cached aggregate is returned as is.
    expect(
      await service.forVersion("wf", definition, "3.0.0", { userId: "user", now: T + 1 }),
    ).toBe(first);
    // A new run of the version changes the summary: the aggregate is recomputed.
    await repository.saveExecution(run("b", "3.0.0", 3_000, [600, 800], T + 10));
    const second = await service.forVersion("wf", definition, "3.0.0", {
      userId: "user",
      now: T + 20,
    });
    expect(second).not.toBe(first);
    expect(second.sampledRuns).toBe(2);
    expect(second.blocks[0].run.medianMs).toBe(2_000);
  });
});
