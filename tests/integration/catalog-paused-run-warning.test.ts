import { beforeAll, beforeEach, describe, expect, test } from "@jest/globals";
import {
  getDatabase,
  getSqliteInstance,
  getWorkflowMutationService,
  installCatalogEntries,
  UserRepository,
  user,
  WorkflowReconciliationRepository,
  type CatalogEntry,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  UniversalGraphExecutor,
  wouldInvalidatePausedRun,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const OWNER = "catalog-warning-owner";

/**
 * A deploy that changes one node of a workflow two runs are paused in, one on that node and one
 * elsewhere. The warning must name the first and not the second — a warning that named both would be
 * right whenever anything breaks, which is the wrong state that looks similar.
 */
function entry(slug: string, version: string, firstDirective: string): CatalogEntry {
  return {
    id: `${OWNER}-${slug}`,
    slug,
    owner: OWNER,
    visibility: "private",
    isSystemOwner: false,
    filePath: `memory://${OWNER}/${slug}.json`,
    graph: {
      metadata: { name: slug, version, description: "paused-run warning fixture" },
      nodes: [
        { id: "start", type: "start", connections: { default: "first" } },
        {
          id: "first",
          type: "agent-directive",
          directive: firstDirective,
          completionCondition: "Done",
          connections: { success: "second" },
        },
        {
          id: "second",
          type: "agent-directive",
          directive: "Do the later work",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    },
  };
}

function attemptIdOf(presentation: string): string {
  return presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1];
}

describe("warning about paused runs a catalog update would invalidate", () => {
  let deps: {
    userRepo: UserRepository;
    mutationService: ReturnType<typeof getWorkflowMutationService>;
    wouldInvalidatePausedRun: (input: {
      incomingGraph: WorkflowGraph;
      nodeId: string;
      boundContinuationDigest: string | null;
    }) => boolean;
  };

  beforeAll(async () => {
    const db = getDatabase();
    const now = new Date().toISOString();
    await db
      .insert(user)
      .values({
        id: OWNER,
        email: `${OWNER}@test.com`,
        name: OWNER,
        handle: OWNER,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    deps = {
      userRepo: new UserRepository(db),
      mutationService: getWorkflowMutationService(),
      // The same function the deploy path injects, not a copy of it.
      wouldInvalidatePausedRun,
    };
  });

  beforeEach(() => {
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM managedWorkflowBaseline WHERE ownerId = ?").run(OWNER);
    sqlite.prepare("DELETE FROM workflowReconciliationConflict WHERE ownerId = ?").run(OWNER);
    sqlite.prepare("DELETE FROM workflow WHERE userId = ?").run(OWNER);
  });

  /** Install a workflow and leave one run paused on `first` and one on `second`. */
  async function twoPausedRuns(slug: string) {
    await installCatalogEntries([entry(slug, "1.0.0", "Do the work")], deps);
    const workflowId = new WorkflowReconciliationRepository(getSqliteInstance()).findWorkflow(
      OWNER,
      [slug],
    )!.id;

    const repository = new DatabaseRepository();
    const graph = (await repository.getWorkflowGraph(workflowId, OWNER))!;
    const executor = new UniversalGraphExecutor(repository);

    const onFirst = await executor.startWorkflow(graph, undefined, OWNER);
    await executor.executeStep(onFirst, undefined, undefined, {
      userId: OWNER,
      createPresentation: true,
    });

    const onSecond = await executor.startWorkflow(graph, undefined, OWNER);
    const firstPresentation = await executor.executeStep(onSecond, undefined, undefined, {
      userId: OWNER,
      createPresentation: true,
    });
    await executor.executeStep(onSecond, {}, undefined, {
      userId: OWNER,
      attemptId: attemptIdOf(firstPresentation),
    });

    return { workflowId, onFirst, onSecond, repository, executor };
  }

  test("names the run paused on the changed node and not the one paused elsewhere", async () => {
    const slug = `warning-changed-node-${Date.now()}`;
    const { workflowId, onFirst, onSecond, repository, executor } = await twoPausedRuns(slug);

    const result = await installCatalogEntries(
      [entry(slug, "2.0.0", "Do entirely different work")],
      deps,
    );

    expect(result.pausedRunImpact.evaluated).toBe(true);
    expect(result.pausedRunImpact.invalidated).toEqual([
      { owner: OWNER, slug, workflowId, executionId: onFirst, nodeId: "first", reason: "replaced" },
    ]);

    // The warning is checked against what actually happens, not only against itself.
    const namedAttempt = (await repository.getCurrentExecutionAttempt(onFirst, OWNER))!;
    await expect(
      executor.executeStep(onFirst, {}, undefined, {
        userId: OWNER,
        attemptId: namedAttempt.attemptId,
      }),
    ).rejects.toThrow(/ATTEMPT_STALE/);

    const unnamedAttempt = (await repository.getCurrentExecutionAttempt(onSecond, OWNER))!;
    const advanced = await executor.executeStep(onSecond, {}, undefined, {
      userId: OWNER,
      attemptId: unnamedAttempt.attemptId,
    });
    expect(advanced).toContain("completed");
  });

  test("names every paused run of a workflow the update removes, as unrecoverable", async () => {
    const slug = `warning-removal-${Date.now()}`;
    const { workflowId, onFirst, onSecond } = await twoPausedRuns(slug);

    // A catalog that no longer contains the flow: the loader plans its removal.
    const result = await installCatalogEntries([], deps);

    expect(result.pausedRunImpact.invalidated).toEqual(
      expect.arrayContaining([
        {
          owner: OWNER,
          slug,
          workflowId,
          executionId: onFirst,
          nodeId: "first",
          reason: "removed",
        },
        {
          owner: OWNER,
          slug,
          workflowId,
          executionId: onSecond,
          nodeId: "second",
          reason: "removed",
        },
      ]),
    );
    // Both, not one: a removal takes every paused run with it, wherever each is paused.
    expect(result.pausedRunImpact.invalidated).toHaveLength(2);
  });

  test("reports the impact before anything is applied, not after", async () => {
    const slug = `warning-before-apply-${Date.now()}`;
    await twoPausedRuns(slug);
    const sqlite = getSqliteInstance();
    const storedDirective = () => {
      const row = sqlite
        .prepare("SELECT graph FROM workflow WHERE userId = ? AND slug = ?")
        .get(OWNER, slug) as { graph: string } | undefined;
      const graph = JSON.parse(row!.graph) as WorkflowGraph;
      return (graph.nodes.find((node) => node.id === "first") as { directive?: string }).directive;
    };
    let directiveWhenWarned: string | undefined;

    await installCatalogEntries([entry(slug, "2.0.0", "Do entirely different work")], {
      ...deps,
      log: (message) => {
        if (message.includes("unable to continue")) directiveWhenWarned = storedDirective();
      },
    });

    // The operator is told while the stored definition is still the old one, so the list is a
    // decision rather than a description of damage already done.
    expect(directiveWhenWarned).toBe("Do the work");
    expect(storedDirective()).toBe("Do entirely different work");
  });

  test("names nothing when the update changes only catalog metadata", async () => {
    const slug = `warning-metadata-only-${Date.now()}`;
    const { onFirst, repository, executor } = await twoPausedRuns(slug);

    const result = await installCatalogEntries([entry(slug, "2.0.0", "Do the work")], deps);

    expect(result.pausedRunImpact).toEqual({ evaluated: true, invalidated: [] });

    const attempt = (await repository.getCurrentExecutionAttempt(onFirst, OWNER))!;
    const advanced = await executor.executeStep(onFirst, {}, undefined, {
      userId: OWNER,
      attemptId: attempt.attemptId,
    });
    expect(advanced).toContain("Do the later work");
  });

  test("a caller that supplies no judgement is told nothing was evaluated", async () => {
    const slug = `warning-not-evaluated-${Date.now()}`;
    await twoPausedRuns(slug);

    const result = await installCatalogEntries([entry(slug, "2.0.0", "Do different work")], {
      userRepo: deps.userRepo,
      mutationService: deps.mutationService,
    });

    // Distinct from an empty list: silence must never be mistaken for a clean check.
    expect(result.pausedRunImpact).toEqual({ evaluated: false, invalidated: [] });
  });
});
