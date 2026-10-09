import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import {
  ExecutionRepository,
  WorkflowRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  metadataRevision,
  user,
} from "@mcp-moira/shared";
import type { WorkflowExecution, WorkflowGraph } from "@mcp-moira/workflow-engine";
import * as schema from "../../packages/shared/src/database/schema.js";
import {
  executionTaskTitles,
  withExecutionTaskTitles,
} from "../../packages/web-backend/src/utils/execution-task-titles.js";

const ownedUsers: string[] = [];
afterEach(async () => {
  jest.restoreAllMocks();
  for (const owner of ownedUsers.splice(0)) {
    await getDatabase()
      .delete(schema.workflowExecution)
      .where(eq(schema.workflowExecution.userId, owner));
    await getDatabase().delete(schema.workflow).where(eq(schema.workflow.userId, owner));
    await getDatabase().delete(user).where(eq(user.id, owner));
  }
});

describe("native summary and canonical heading generation", () => {
  test("keeps native page and headings in one snapshot despite renames and unrelated writes during discovery", async () => {
    const owner = `coherence-${randomUUID()}`;
    ownedUsers.push(owner);
    const now = Date.now();
    await getDatabase()
      .insert(user)
      .values({
        id: owner,
        handle: `coherence-${randomUUID().slice(0, 8)}`,
        email: `${owner}@example.test`,
        emailVerified: true,
        approvedAt: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
      });
    const graph: WorkflowGraph = {
      metadata: {
        name: "Independent flow name",
        description: "Native coherence fixture",
        version: "1.0.0",
      },
      variableRegistry: {
        topic: { type: "string", description: "Authored heading", default: "Legacy heading" },
      },
      progress: {
        title: "{{topic}}",
        nodes: [{ id: "work", label: "Work", content: { summary: "Perform the task" } }],
      },
      nodes: [
        { id: "start", type: "start", progressNodeId: "work", connections: { default: "task" } },
        {
          id: "task",
          type: "agent-directive",
          progressNodeId: "work",
          directive: "Perform the task",
          completionCondition: "Task done",
          connections: { success: "end" },
        },
        { id: "end", type: "end", progressNodeId: "work" },
      ],
    };
    const saved = await getWorkflowService().save({ graph, userId: owner, visibility: "private" });
    const executionId = randomUUID();
    const execution: WorkflowExecution = {
      executionId,
      workflowId: saved.id,
      userId: owner,
      status: "running",
      currentNodeId: "task",
      waitingForInputNodeId: "task",
      revision: 0,
      globalContext: {
        executionId,
        workflowId: saved.id,
        userId: owner,
        nodeStates: {},
        variables: { topic: "Legacy heading", unused: "private-context-sentinel" },
      },
      note: "Arbitrary diagnostic note",
      createdAt: now,
      updatedAt: now,
    };
    const repository = new ExecutionRepository(getDatabase());
    await repository.save(execution);
    const initial = await repository.updateExecutionTaskTitle(
      executionId,
      owner,
      0,
      metadataRevision(null),
      "Task A",
    );
    const detailSnapshot = await repository.get(executionId);
    if (!detailSnapshot) throw new Error("The detail snapshot was not stored");
    const sqlite = getSqliteInstance();
    expect(sqlite.name).not.toBe(":memory:");
    const connection = new Database(sqlite.name);
    try {
      const writer = new ExecutionRepository(drizzle(connection, { schema }));
      let unrelatedWrites = 0;
      const progressRead = ExecutionRepository.prototype.getManyForProgress;
      jest
        .spyOn(ExecutionRepository.prototype, "getManyForProgress")
        .mockImplementation(async function (this: ExecutionRepository, ...args) {
          const values = await progressRead.apply(this, args);
          expect(
            connection
              .prepare("UPDATE user SET updatedAt=? WHERE id=?")
              .run(`unrelated-${++unrelatedWrites}`, owner).changes,
          ).toBe(1);
          return values;
        });
      let reads = 0;
      let replacement:
        Awaited<ReturnType<ExecutionRepository["updateExecutionTaskTitle"]>> | undefined;
      const result = await withExecutionTaskTitles(async (db = getDatabase()) => {
        const page = await new ExecutionRepository(db).listSummaries({
          userId: owner,
          workflowId: saved.id,
          actorId: owner,
          limit: 1,
          offset: 0,
        });
        reads++;
        if (reads === 1) {
          expect(page.executions[0].taskIdentity).toEqual(initial.taskIdentity);
          replacement = await writer.updateExecutionTaskTitle(
            executionId,
            owner,
            0,
            initial.taskIdentityRevision,
            "Task B",
          );
        }
        return { ...page, limit: 1, offset: 0, wrapperFact: "retained" };
      });
      expect(reads).toBe(1);
      expect(unrelatedWrites).toBeGreaterThan(0);
      if (!replacement) throw new Error("The independent writer did not rename the execution");
      expect(result).toMatchObject({ total: 1, limit: 1, offset: 0, wrapperFact: "retained" });
      expect(result.executions).toHaveLength(1);
      expect(result.executions[0]).toMatchObject({
        executionId,
        taskTitle: "Task A",
        taskIdentity: initial.taskIdentity,
        revision: 0,
        note: "Arbitrary diagnostic note",
        stopCapability: { available: true, revision: 0 },
      });
      const latest = await withExecutionTaskTitles((db = getDatabase()) =>
        new ExecutionRepository(db).listSummaries({
          userId: owner,
          workflowId: saved.id,
          actorId: owner,
          limit: 1,
          offset: 0,
        }),
      );
      expect(latest.executions[0]).toMatchObject({
        taskTitle: "Task B",
        taskIdentity: replacement.taskIdentity,
      });
      expect(JSON.stringify(result)).not.toContain("private-context-sentinel");
      expect((await repository.get(executionId))?.globalContext).toEqual(execution.globalContext);

      // Direct full-state consumers keep the identity they loaded before the concurrent rename.
      const detailTitles = await executionTaskTitles([detailSnapshot]);
      expect(detailTitles.get(executionId)).toBe("Task A");
      expect(detailSnapshot.taskIdentity).toEqual(initial.taskIdentity);
      expect(metadataRevision(detailSnapshot.taskIdentity ?? null)).toBe(
        initial.taskIdentityRevision,
      );
      expect((await repository.get(executionId))?.taskIdentity).toEqual(replacement.taskIdentity);

      const legacySnapshots: WorkflowExecution[] = [];
      for (const variables of [{ topic: "Legacy A" }, {}]) {
        const legacyId = randomUUID();
        const legacyExecution: WorkflowExecution = {
          ...execution,
          executionId: legacyId,
          globalContext: {
            ...execution.globalContext,
            executionId: legacyId,
            variables,
          },
        };
        await repository.save(legacyExecution);
        const snapshot = await repository.get(legacyId);
        if (!snapshot) throw new Error("The legacy snapshot was not stored");
        legacySnapshots.push(snapshot);
        expect(
          await writer.updateContext(
            legacyId,
            { variables: { topic: "Legacy B" } },
            0,
            metadataRevision(snapshot.globalContext),
          ),
        ).toBe(true);
      }
      let defaultChanged = false;
      const workflowRead = WorkflowRepository.prototype.getManyForTaskTitles;
      jest
        .spyOn(WorkflowRepository.prototype, "getManyForTaskTitles")
        .mockImplementation(async function (this: WorkflowRepository, ...args) {
          const definitions = await workflowRead.apply(this, args);
          if (!defaultChanged) {
            expect(
              connection
                .prepare(
                  "UPDATE workflow SET graph=json_set(graph,'$.variableRegistry.topic.default','New default') WHERE id=?",
                )
                .run(saved.id).changes,
            ).toBe(1);
            defaultChanged = true;
          }
          return definitions;
        });
      const legacyTitles = await executionTaskTitles(legacySnapshots);
      expect(defaultChanged).toBe(true);
      expect(legacyTitles.get(legacySnapshots[0].executionId)).toBe("Legacy A");
      // A missing value belongs to the old snapshot and resolves from the flow default, never
      // from the newly stored Legacy B context.
      expect(legacyTitles.get(legacySnapshots[1].executionId)).toBe("Legacy heading");
      expect((await executionTaskTitles(legacySnapshots)).get(legacySnapshots[1].executionId)).toBe(
        "New default",
      );
      expect(legacySnapshots.map((snapshot) => snapshot.globalContext.variables)).toEqual([
        { topic: "Legacy A" },
        {},
      ]);
      for (const snapshot of legacySnapshots)
        expect((await repository.get(snapshot.executionId))?.globalContext.variables).toEqual({
          topic: "Legacy B",
        });
    } finally {
      connection.close();
    }
  });
});
