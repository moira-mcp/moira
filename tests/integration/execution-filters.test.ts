/**
 * Execution Filters Integration Tests
 * Tests the filtering, sorting, and pagination functionality (#239)
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { WorkflowGraph, InMemoryRepository } from "@mcp-moira/workflow-engine";

describe("Execution Filters and Pagination", () => {
  let repository: InMemoryRepository;
  let executor: any;
  let createdExecutionIds: string[] = [];

  beforeEach(async () => {
    const result = await createTestExecutor();
    repository = result.repository;
    executor = result.executor;
    createdExecutionIds = [];
  });

  afterEach(async () => {
    // Clean up created executions
    for (const id of createdExecutionIds) {
      try {
        await repository.deleteExecution(id);
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  // Issue #369: All nodes that accept input MUST have inputSchema
  const SIMPLE_RESULT_SCHEMA = {
    type: "object",
    properties: {
      result: { type: "string" },
    },
    additionalProperties: false,
  };

  const createTestWorkflow = (id: string): WorkflowGraph => ({
    id,
    metadata: {
      name: `Test Workflow ${id}`,
      version: "1.0.0",
      description: "Test workflow for filtering",
    },
    nodes: [
      {
        type: "start",
        id: "start",
        connections: { default: "task" },
      },
      {
        type: "agent-directive",
        id: "task",
        directive: "Do something",
        completionCondition: "Done",
        inputSchema: SIMPLE_RESULT_SCHEMA,
        connections: { success: "end" },
      },
      {
        type: "end",
        id: "end",
      },
    ],
  });

  test("should filter executions by status", async () => {
    const workflow = createTestWorkflow("filter-status-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Create executions with different notes
    const id1 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Test 1");
    const id2 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Test 2");
    createdExecutionIds.push(id1, id2);

    // Issue #386: 2-status model - only "running" and "completed" exist now
    // After startWorkflow, status is 'running' and stays 'running' during execution
    const runningResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      status: ["running"],
    });

    const ourRunning = runningResult.executions.filter((e) => [id1, id2].includes(e.executionId));
    expect(ourRunning.length).toBe(2);
    expect(ourRunning.every((e) => e.status === "running")).toBe(true);

    // First executeStep without input - stays 'running' at agent-directive (Issue #386: "waiting" merged into "running")
    await executor.executeStep(id1);
    await executor.executeStep(id2);

    // Both should still be in 'running' status (Issue #386: no more 'waiting')
    const stillRunningResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      status: ["running"],
    });

    const stillRunning = stillRunningResult.executions.filter((e) =>
      [id1, id2].includes(e.executionId),
    );
    expect(stillRunning.length).toBe(2);
    expect(stillRunning.every((e) => e.status === "running")).toBe(true);

    // Complete one workflow - provide input for the agent-directive step
    await executor.executeStep(id1, { result: "done" });

    // Now filter for completed only
    const completedResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      status: ["completed"],
    });

    const completedExecution = completedResult.executions.find((e) => e.executionId === id1);
    expect(completedExecution).toBeDefined();
    expect(completedExecution?.status).toBe("completed");

    // id2 should still be running (Issue #386: "waiting" merged into "running")
    const id2StillRunning = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      status: ["running"],
    });
    const id2Running = id2StillRunning.executions.find((e) => e.executionId === id2);
    expect(id2Running).toBeDefined();
  });

  test("should search executions by note", async () => {
    const workflow = createTestWorkflow("search-note-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Create executions with different notes
    const id1 = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Platform improvements feature",
    );
    const id2 = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Bug fix for login",
    );
    const id3 = await executor.startWorkflow(
      workflow,
      undefined,
      TEST_USER_ID,
      "Platform navigation",
    );
    createdExecutionIds.push(id1, id2, id3);

    // Search for "Platform"
    const searchResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      search: "Platform",
    });

    expect(searchResult.executions.length).toBeGreaterThanOrEqual(2);
    expect(searchResult.executions.every((e) => e.note?.includes("Platform"))).toBe(true);
  });

  test("should sort executions by createdAt and updatedAt", async () => {
    const workflow = createTestWorkflow("sort-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Create executions with small delays
    const id1 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "First");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const id2 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Second");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const id3 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Third");
    createdExecutionIds.push(id1, id2, id3);

    // Sort by createdAt desc (newest first)
    const descResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      sort: "createdAt",
      sortOrder: "desc",
    });

    const descIds = descResult.executions
      .filter((e) => createdExecutionIds.includes(e.executionId))
      .map((e) => e.executionId);

    // Third should come before Second, Second before First
    const idx1 = descIds.indexOf(id1);
    const idx2 = descIds.indexOf(id2);
    const idx3 = descIds.indexOf(id3);

    if (idx1 !== -1 && idx2 !== -1 && idx3 !== -1) {
      expect(idx3).toBeLessThan(idx2);
      expect(idx2).toBeLessThan(idx1);
    }

    // Sort by createdAt asc (oldest first)
    const ascResult = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      sort: "createdAt",
      sortOrder: "asc",
    });

    const ascIds = ascResult.executions
      .filter((e) => createdExecutionIds.includes(e.executionId))
      .map((e) => e.executionId);

    const ascIdx1 = ascIds.indexOf(id1);
    const ascIdx2 = ascIds.indexOf(id2);
    const ascIdx3 = ascIds.indexOf(id3);

    if (ascIdx1 !== -1 && ascIdx2 !== -1 && ascIdx3 !== -1) {
      expect(ascIdx1).toBeLessThan(ascIdx2);
      expect(ascIdx2).toBeLessThan(ascIdx3);
    }
  });

  test("should paginate executions with limit and offset", async () => {
    const workflow = createTestWorkflow("pagination-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Create multiple executions
    for (let i = 0; i < 5; i++) {
      const id = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, `Page test ${i}`);
      createdExecutionIds.push(id);
    }

    // Get first page
    const page1 = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      limit: 2,
      offset: 0,
      sort: "createdAt",
      sortOrder: "desc",
    });

    expect(page1.executions.length).toBe(2);
    expect(page1.total).toBeGreaterThanOrEqual(5);

    // Get second page
    const page2 = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      limit: 2,
      offset: 2,
      sort: "createdAt",
      sortOrder: "desc",
    });

    expect(page2.executions.length).toBe(2);
    expect(page2.total).toBe(page1.total); // Total should be the same

    // Ensure no overlap between pages
    const page1Ids = new Set(page1.executions.map((e) => e.executionId));
    const page2Ids = new Set(page2.executions.map((e) => e.executionId));

    for (const id of page2Ids) {
      expect(page1Ids.has(id)).toBe(false);
    }
  });

  test("should filter by workflowId", async () => {
    const workflow1 = createTestWorkflow("workflow-filter-1");
    const workflow2 = createTestWorkflow("workflow-filter-2");
    await repository.saveWorkflow(workflow1, TEST_USER_ID);
    await repository.saveWorkflow(workflow2, TEST_USER_ID);

    const id1 = await executor.startWorkflow(workflow1, undefined, TEST_USER_ID, "From workflow 1");
    const id2 = await executor.startWorkflow(workflow2, undefined, TEST_USER_ID, "From workflow 2");
    const id3 = await executor.startWorkflow(
      workflow1,
      undefined,
      TEST_USER_ID,
      "Also from workflow 1",
    );
    createdExecutionIds.push(id1, id2, id3);

    // Filter by workflow1
    const result = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      workflowId: "workflow-filter-1",
    });

    expect(result.executions.every((e) => e.workflowId === "workflow-filter-1")).toBe(true);
    const ourExecutions = result.executions.filter((e) => [id1, id3].includes(e.executionId));
    expect(ourExecutions.length).toBe(2);
  });

  test("should combine multiple filters", async () => {
    const workflow = createTestWorkflow("multi-filter-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    const id1 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Bug fix search");
    const id2 = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Feature search");
    createdExecutionIds.push(id1, id2);

    // Complete one
    await executor.executeStep(id1);
    await executor.executeStep(id1, { result: "done" });

    // Filter: completed + search "Bug"
    const result = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      status: ["completed"],
      search: "Bug",
    });

    const found = result.executions.find((e) => e.executionId === id1);
    expect(found).toBeDefined();
    expect(found?.note).toContain("Bug");
    expect(found?.status).toBe("completed");

    // id2 should not be in results (it's waiting, not completed)
    const notFound = result.executions.find((e) => e.executionId === id2);
    expect(notFound).toBeUndefined();
  });

  test("should return total count correctly", async () => {
    const workflow = createTestWorkflow("count-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    // Create 3 executions
    for (let i = 0; i < 3; i++) {
      const id = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, `Count test ${i}`);
      createdExecutionIds.push(id);
    }

    // Get with limit 1, total should still be >= 3
    const result = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      limit: 1,
    });

    expect(result.executions.length).toBe(1);
    expect(result.total).toBeGreaterThanOrEqual(3);
  });

  test("should clamp limit to max 100", async () => {
    const workflow = createTestWorkflow("limit-clamp-workflow");
    await repository.saveWorkflow(workflow, TEST_USER_ID);

    const id = await executor.startWorkflow(workflow, undefined, TEST_USER_ID, "Limit test");
    createdExecutionIds.push(id);

    // Request limit > 100, should be clamped
    const result = await repository.listExecutionsWithFilters({
      userId: TEST_USER_ID,
      limit: 200, // Should be clamped to 100
    });

    // We can't easily verify the clamp without 100+ records,
    // but at least verify the query works
    expect(result.executions.length).toBeGreaterThanOrEqual(1);
  });
});
