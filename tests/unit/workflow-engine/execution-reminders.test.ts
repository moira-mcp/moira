import { describe, expect, test } from "@jest/globals";
import { ConflictError, ValidationError } from "@mcp-moira/shared";
import { UniversalGraphExecutor } from "../../../packages/workflow-engine/src/core/universal-graph-executor.js";
import { InMemoryRepository } from "../../../packages/workflow-engine/src/storage/in-memory-repository.js";
import type { WorkflowGraph } from "../../../packages/workflow-engine/src/interfaces/core-interfaces.js";

const workflow: WorkflowGraph = {
  id: "reminder-workflow",
  metadata: { name: "Reminder", version: "1.0.0", description: "Reminder behavior" },
  nodes: [
    { id: "start", type: "start", connections: { default: "task" } },
    {
      id: "task",
      type: "agent-directive",
      directive: "Do work",
      completionCondition: "Done",
      inputSchema: {
        type: "object",
        properties: { done: { type: "boolean" } },
        required: ["done"],
        additionalProperties: false,
      },
      connections: { success: "end" },
    },
    { id: "end", type: "end" },
  ],
};

describe("execution reminders", () => {
  test("reminder added between step load and save survives completion", async () => {
    class ConcurrentReminderRepository extends InMemoryRepository {
      private reads = 0;
      override async getExecution(executionId: string) {
        this.reads += 1;
        if (this.reads === 2) {
          const current = await super.getExecution(executionId);
          if (!current) throw new Error("execution missing");
          await super.mutateExecutionReminder(executionId, "owner", current.revision, {
            action: "add",
            text: "concurrent follow-up",
          });
        }
        return super.getExecution(executionId);
      }
    }
    const repository = new ConcurrentReminderRepository();
    const executor = new UniversalGraphExecutor(repository);
    await repository.saveWorkflow(workflow, "owner");
    const executionId = await executor.startWorkflow(workflow, undefined, "owner");
    const intermediate = await executor.executeStep(executionId);
    expect(intermediate).not.toContain("concurrent follow-up");
    const completed = await executor.executeStep(executionId, { done: true });
    expect(completed).toContain("- concurrent follow-up");
    expect((await repository.getExecution(executionId))?.reminders).toEqual([
      expect.objectContaining({ text: "concurrent follow-up", status: "active" }),
    ]);
  });

  test.each([undefined, "parent-execution"])(
    "returns active reminders only at completion for parent %s",
    async (parentExecutionId) => {
      const repository = new InMemoryRepository();
      const executor = new UniversalGraphExecutor(repository);
      await repository.saveWorkflow(workflow, "owner");
      const executionId = await executor.startWorkflow(
        workflow,
        undefined,
        "owner",
        undefined,
        parentExecutionId,
      );
      const first = await executor.executeStep(executionId);
      expect(first).not.toContain("publish {{context.variables}}");
      let state = await repository.getExecution(executionId);
      if (!state) throw new Error("execution missing");
      await repository.mutateExecutionReminder(executionId, "owner", state.revision, {
        action: "add",
        text: "publish {{context.variables}}",
        idempotencyKey: "publish",
      });
      state = await repository.getExecution(executionId);
      if (!state) throw new Error("execution missing");
      await repository.mutateExecutionReminder(executionId, "owner", state.revision, {
        action: "add",
        text: "notify user",
      });

      const current = await executor.executeStep(executionId, {});
      expect(current).not.toContain("publish {{context.variables}}");
      const completed = await executor.executeStep(executionId, { done: true });
      expect(completed).toContain("**NEXT REQUESTED ACTIONS**");
      expect(completed).toContain("- publish {{context.variables}}");
      expect(completed).toContain("- notify user");
      expect(completed.includes("CONTINUATION REMINDER")).toBe(Boolean(parentExecutionId));
    },
  );

  test("add retry, update, cancellation and conflicts preserve exact siblings", async () => {
    const repository = new InMemoryRepository();
    const executor = new UniversalGraphExecutor(repository);
    await repository.saveWorkflow(workflow, "owner");
    const executionId = await executor.startWorkflow(workflow, undefined, "owner");
    let state = await repository.getExecution(executionId);
    if (!state) throw new Error("execution missing");
    const added = await repository.mutateExecutionReminder(executionId, "owner", state.revision, {
      action: "add",
      text: "first",
      idempotencyKey: "same",
    });
    const repeated = await repository.mutateExecutionReminder(
      executionId,
      "owner",
      added.revision - 1,
      { action: "add", text: "first", idempotencyKey: "same" },
    );
    expect(repeated).toMatchObject({ changed: false, revision: added.revision });
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", added.revision, {
        action: "add",
        text: "different",
        idempotencyKey: "same",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const updated = await repository.mutateExecutionReminder(executionId, "owner", added.revision, {
      action: "update",
      reminderId: added.reminder.id,
      text: "updated",
    });
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", added.revision, {
        action: "update",
        reminderId: added.reminder.id,
        text: "updated",
      }),
    ).resolves.toMatchObject({ changed: false, revision: updated.revision });
    const cancelled = await repository.mutateExecutionReminder(
      executionId,
      "owner",
      updated.revision,
      { action: "cancel", reminderId: added.reminder.id },
    );
    expect(cancelled.reminder).toMatchObject({ text: "updated", status: "cancelled" });
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", updated.revision, {
        action: "cancel",
        reminderId: added.reminder.id,
      }),
    ).resolves.toMatchObject({ changed: false, revision: cancelled.revision });
    state = await repository.getExecution(executionId);
    expect(state?.reminders).toHaveLength(1);
  });

  test("ownership, running state, stale writes and bounds reject without mutation", async () => {
    const repository = new InMemoryRepository();
    const executor = new UniversalGraphExecutor(repository);
    await repository.saveWorkflow(workflow, "owner");
    const executionId = await executor.startWorkflow(workflow, undefined, "owner");
    await expect(
      repository.mutateExecutionReminder(executionId, "other", 0, { action: "add", text: "x" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", 1, { action: "add", text: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", 0, {
        action: "add",
        text: "x".repeat(1001),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", 0, {
        action: "add",
        text: "x",
        idempotencyKey: "k".repeat(101),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const state = await repository.getExecution(executionId);
    if (!state) throw new Error("execution missing");
    state.reminders = Array.from({ length: 50 }, (_, index) => ({
      id: `r-${index}`,
      text: "x",
      status: "active" as const,
      createdAt: index,
      updatedAt: index,
    }));
    await repository.saveExecution(state);
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", state.revision, {
        action: "add",
        text: "overflow",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    state.status = "completed";
    await repository.saveExecution(state);
    await expect(
      repository.mutateExecutionReminder(executionId, "owner", state.revision, {
        action: "cancel",
        reminderId: "r-0",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
