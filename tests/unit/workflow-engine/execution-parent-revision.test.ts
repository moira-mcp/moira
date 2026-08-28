import { describe, expect, test } from "@jest/globals";
import { ConflictError, ValidationError } from "@mcp-moira/shared";
import { InMemoryRepository } from "../../../packages/workflow-engine/src/storage/in-memory-repository.js";
import type { WorkflowExecution } from "../../../packages/workflow-engine/src/types/base-types.js";

function execution(
  executionId: string,
  userId = "owner",
  overrides: Partial<WorkflowExecution> = {},
): WorkflowExecution {
  return {
    executionId,
    workflowId: "workflow",
    userId,
    currentNodeId: "step",
    waitingForInputNodeId: "step",
    globalContext: { variables: {}, nodeStates: {}, executionId, workflowId: "workflow", userId },
    status: "running",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("execution revision and parent recovery", () => {
  test("same-owner parent can be attached, replaced, detached, and repeated idempotently", async () => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(execution("parent"));
    await repository.saveExecution(execution("replacement"));
    await repository.saveExecution(execution("child"));

    const updated = await repository.setExecutionParent("child", "parent", "owner", 0);

    expect(updated.parentExecutionId).toBe("parent");
    expect(updated.revision).toBe(1);
    await expect(
      repository.setExecutionParent("child", "parent", "owner", 0),
    ).resolves.toMatchObject({ parentExecutionId: "parent", revision: 1 });
    await expect(
      repository.setExecutionParent("child", "replacement", "owner", 1),
    ).resolves.toMatchObject({ parentExecutionId: "replacement", revision: 2 });
    await expect(repository.setExecutionParent("child", null, "owner", 2)).resolves.toMatchObject({
      parentExecutionId: null,
      revision: 3,
    });
  });

  test.each([
    ["foreign parent", execution("parent", "other")],
    ["completed parent", execution("parent", "owner", { status: "completed" })],
  ])("rejects %s without changing the child", async (_name, parent) => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(parent);
    await repository.saveExecution(execution("child"));

    await expect(
      repository.setExecutionParent("child", "parent", "owner", 0),
    ).rejects.toBeInstanceOf(ValidationError);
    const child = await repository.getExecution("child");
    expect(child?.parentExecutionId).toBeUndefined();
    expect(child?.revision).toBe(0);
  });

  test("rejects a parent cycle and a stale revision", async () => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(execution("child"));
    await repository.saveExecution(execution("parent", "owner", { parentExecutionId: "child" }));
    await expect(
      repository.setExecutionParent("child", "parent", "owner", 0),
    ).rejects.toBeInstanceOf(ValidationError);

    const freshRepository = new InMemoryRepository();
    await freshRepository.saveExecution(execution("parent"));
    await freshRepository.saveExecution(execution("child"));
    const child = await freshRepository.getExecution("child");
    if (!child) throw new Error("child fixture missing");
    child.note = "newer";
    await freshRepository.saveExecution(child);
    await expect(
      freshRepository.setExecutionParent("child", "parent", "owner", 0),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("a stale full save cannot overwrite a newer execution snapshot", async () => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(execution("execution"));
    const first = await repository.getExecution("execution");
    const stale = await repository.getExecution("execution");
    if (!first || !stale) throw new Error("execution fixture missing");

    first.note = "accepted";
    await repository.saveExecution(first);
    stale.note = "stale";

    await expect(repository.saveExecution(stale)).rejects.toBeInstanceOf(ConflictError);
    expect((await repository.getExecution("execution"))?.note).toBe("accepted");
    expect((await repository.getExecution("execution"))?.revision).toBe(1);
  });

  test("a stale in-memory context mutation cannot overwrite a newer step snapshot", async () => {
    const repository = new InMemoryRepository();
    await repository.saveExecution(execution("execution"));
    const newer = await repository.getExecution("execution");
    if (!newer) throw new Error("execution fixture missing");
    newer.globalContext.variables.accepted = "newer";
    await repository.saveExecution(newer);

    await expect(
      repository.updateExecutionContext("execution", { variables: { accepted: "stale" } }, 0),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await repository.getExecution("execution"))?.globalContext.variables.accepted).toBe(
      "newer",
    );
  });
});
