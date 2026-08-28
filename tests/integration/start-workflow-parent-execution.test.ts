/**
 * Start Workflow parentExecutionId Tests (Step 1 feature #321)
 * Tests required parentExecutionId field with "none" and UUID validation
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { and, desc, eq } from "drizzle-orm";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { auditLog, ConflictError, getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-parent-execution";

const testWorkflow: WorkflowGraph = {
  id: "test-parent-execution-workflow",
  metadata: {
    name: "Parent Execution Test",
    version: "1.0.0",
    description: "For testing parentExecutionId",
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "step" } },
    {
      id: "step",
      type: "agent-directive",
      directive: "Test step",
      completionCondition: "Done",
      connections: { success: "end" },
      inputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
    },
    { id: "end", type: "end" },
  ],
};

describe("Start Workflow parentExecutionId Tests", () => {
  let repository: DatabaseRepository;
  let testWorkflowId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Parent Execution Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }

    const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: testWorkflow,
        overwrite: true,
      });
    });
    testWorkflowId = createResult.data.workflowId;
  });

  afterAll(async () => {
    try {
      await repository.deleteWorkflow(testWorkflowId, TEST_USER_ID);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("parentExecutionId = 'none'", () => {
    test("accepts 'none' for standalone workflows", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toContain("Process ID:");
    });

    test("standalone workflow has no parent in context", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(result.success).toBe(true);
      // Extract process ID
      const match = result.data?.match(/Process ID: ([a-f0-9-]+)/);
      expect(match).toBeDefined();
    });
  });

  describe("parentExecutionId = valid UUID", () => {
    test("accepts valid UUID that exists", async () => {
      // First create a parent execution
      const parentResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "none",
        });
      });

      expect(parentResult.success).toBe(true);
      const parentMatch = parentResult.data?.match(/Process ID: ([a-f0-9-]+)/);
      expect(parentMatch).toBeDefined();
      const parentId = parentMatch![1];

      // Now start child with parent reference
      const childResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: parentId,
        });
      });

      expect(childResult.success).toBe(true);
      expect(childResult.data).toContain("Process ID:");
    });

    test("session set-parent attaches, replaces, detaches, and keeps same-value retries idempotent", async () => {
      const startStandalone = async () => {
        const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
          startWorkflow({ workflowId: testWorkflowId, parentExecutionId: "none" }),
        );
        const processId = result.data?.match(/Process ID: ([a-f0-9-]+)/)?.[1];
        if (!processId) throw new Error("process ID missing from fixture start");
        return processId;
      };
      const parentId = await startStandalone();
      const replacementParentId = await startStandalone();
      const childId = await startStandalone();
      const child = await repository.getExecution(childId);
      if (!child) throw new Error("child fixture missing");

      const attached = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        getSessionInfo({
          action: "set-parent",
          executionId: childId,
          parentExecutionId: parentId,
          expectedRevision: child.revision,
        }),
      );

      expect(attached.success).toBe(true);
      expect((attached.data as { parentExecutionId: string }).parentExecutionId).toBe(parentId);
      expect((await repository.getExecution(childId))?.revision).toBe(child.revision + 1);

      const sameValue = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        getSessionInfo({
          action: "set-parent",
          executionId: childId,
          parentExecutionId: parentId,
          expectedRevision: child.revision,
        }),
      );
      expect(sameValue.success).toBe(true);
      expect((sameValue.data as { revision: number }).revision).toBe(child.revision + 1);

      const replaced = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        getSessionInfo({
          action: "set-parent",
          executionId: childId,
          parentExecutionId: replacementParentId,
          expectedRevision: child.revision + 1,
        }),
      );
      expect(replaced.success).toBe(true);
      expect((replaced.data as { parentExecutionId: string }).parentExecutionId).toBe(
        replacementParentId,
      );

      const detached = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        getSessionInfo({
          action: "set-parent",
          executionId: childId,
          parentExecutionId: "none",
          expectedRevision: child.revision + 2,
        }),
      );
      expect(detached.success).toBe(true);
      expect((detached.data as { parentExecutionId: null }).parentExecutionId).toBeNull();

      const [latestAudit] = await getDatabase()
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.resourceId, childId), eq(auditLog.action, "execution:update_context")),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1);
      expect(latestAudit).toBeDefined();
      expect(JSON.parse(latestAudit.metadata ?? "{}")).toMatchObject({
        action: "set-parent",
        parentExecutionId: null,
        revision: child.revision + 3,
      });
    });

    test("database full-save CAS rejects a stale snapshot without overwriting accepted state", async () => {
      const started = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        startWorkflow({ workflowId: testWorkflowId, parentExecutionId: "none" }),
      );
      const executionId = started.data?.match(/Process ID: ([a-f0-9-]+)/)?.[1];
      if (!executionId) throw new Error("execution fixture missing");
      const accepted = await repository.getExecution(executionId);
      const stale = await repository.getExecution(executionId);
      if (!accepted || !stale) throw new Error("execution snapshots missing");
      accepted.note = "accepted database state";
      await repository.saveExecution(accepted);
      stale.note = "stale database state";

      await expect(repository.saveExecution(stale)).rejects.toBeInstanceOf(ConflictError);
      expect(await repository.getExecution(executionId)).toMatchObject({
        note: "accepted database state",
        revision: accepted.revision,
      });
    });

    test("concurrent inverse parent changes cannot commit an ancestry cycle", async () => {
      const startStandalone = async () => {
        const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
          startWorkflow({ workflowId: testWorkflowId, parentExecutionId: "none" }),
        );
        const id = result.data?.match(/Process ID: ([a-f0-9-]+)/)?.[1];
        if (!id) throw new Error("execution fixture missing");
        return id;
      };
      const firstId = await startStandalone();
      const secondId = await startStandalone();
      const [first, second] = await Promise.all([
        repository.getExecution(firstId),
        repository.getExecution(secondId),
      ]);
      if (!first || !second) throw new Error("execution snapshots missing");

      const outcomes = await Promise.allSettled([
        repository.setExecutionParent(firstId, secondId, TEST_USER_ID, first.revision),
        repository.setExecutionParent(secondId, firstId, TEST_USER_ID, second.revision),
      ]);
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

      const storedFirst = await repository.getExecution(firstId);
      const storedSecond = await repository.getExecution(secondId);
      expect(
        storedFirst?.parentExecutionId === secondId && storedSecond?.parentExecutionId === firstId,
      ).toBe(false);
    });

    test("rejects a completed parent through the public start boundary", async () => {
      const parentResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        startWorkflow({ workflowId: testWorkflowId, parentExecutionId: "none" }),
      );
      const parentId = parentResult.data?.match(/Process ID: ([a-f0-9-]+)/)?.[1];
      if (!parentId) throw new Error("parent fixture missing");
      const parent = await repository.getExecution(parentId);
      if (!parent) throw new Error("parent execution missing");
      parent.status = "completed";
      parent.completedAt = Date.now();
      await repository.saveExecution(parent);

      const childResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
        startWorkflow({ workflowId: testWorkflowId, parentExecutionId: parentId }),
      );
      expect(childResult.success).toBe(false);
      expect(childResult.error).toContain("must be running");
    });
  });

  describe("parentExecutionId validation errors", () => {
    test("rejects invalid UUID format", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "not-a-valid-uuid",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("valid UUID");
      expect(result.error).toContain('"none"');
    });

    test("rejects UUID that does not exist", async () => {
      const fakeUuid = "12345678-1234-4123-8123-123456789abc";
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: fakeUuid,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
      expect(result.error).toContain('"none"');
    });

    test("rejects empty string", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("valid UUID");
    });

    test("rejects 'null' or 'undefined' strings", async () => {
      const result1 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "null",
        });
      });

      expect(result1.success).toBe(false);
      expect(result1.error).toContain("valid UUID");

      const result2 = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return startWorkflow({
          workflowId: testWorkflowId,
          parentExecutionId: "undefined",
        });
      });

      expect(result2.success).toBe(false);
      expect(result2.error).toContain("valid UUID");
    });
  });

  test("session reminder actions persist, filter, update, cancel, and preserve idempotency", async () => {
    const started = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      startWorkflow({ workflowId: testWorkflowId, parentExecutionId: "none" }),
    );
    const executionId = started.data?.match(/Process ID: ([a-f0-9-]+)/)?.[1];
    if (!executionId) throw new Error("execution fixture missing");
    let execution = await repository.getExecution(executionId);
    if (!execution) throw new Error("execution missing");
    const added = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      getSessionInfo({
        action: "add-reminder",
        executionId,
        expectedRevision: execution!.revision,
        reminderText: "Open PR",
        idempotencyKey: "pr",
      }),
    );
    expect(added.success).toBe(true);
    const addedData = added.data as { reminder: { id: string }; revision: number };
    const repeated = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      getSessionInfo({
        action: "add-reminder",
        executionId,
        expectedRevision: addedData.revision - 1,
        reminderText: "Open PR",
        idempotencyKey: "pr",
      }),
    );
    expect(repeated.data).toMatchObject({ changed: false, revision: addedData.revision });
    const listed = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      getSessionInfo({
        action: "reminders",
        executionId,
        reminderStatus: "active",
        search: "open",
      }),
    );
    expect((listed.data as { reminders: unknown[] }).reminders).toHaveLength(1);
    const updated = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      getSessionInfo({
        action: "update-reminder",
        executionId,
        expectedRevision: addedData.revision,
        reminderId: addedData.reminder.id,
        reminderText: "Open and review PR",
      }),
    );
    const updateData = updated.data as { revision: number };
    const removed = await runWithMCPContext({ userId: TEST_USER_ID }, async () =>
      getSessionInfo({
        action: "remove-reminder",
        executionId,
        expectedRevision: updateData.revision,
        reminderId: addedData.reminder.id,
      }),
    );
    expect(removed.success).toBe(true);
    execution = await repository.getExecution(executionId);
    expect(execution?.reminders).toEqual([
      expect.objectContaining({
        id: addedData.reminder.id,
        text: "Open and review PR",
        status: "cancelled",
      }),
    ]);
    const reminderAudits = (
      await getDatabase().select().from(auditLog).where(eq(auditLog.resourceId, executionId))
    ).filter((entry) => entry.metadata?.includes("reminder:"));
    expect(reminderAudits).not.toHaveLength(0);
    expect(reminderAudits.every((entry) => !entry.metadata?.includes("Open"))).toBe(true);
  });
});
