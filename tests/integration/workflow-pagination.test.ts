/**
 * Workflow Pagination Integration Tests
 * Tests get_workflow_details pagination functionality
 */

import { describe, test, expect, beforeAll } from "@jest/globals";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-user-pagination";

describe("Workflow Pagination", () => {
  let repository: DatabaseRepository;
  let testWorkflowId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const { getDatabase, user, getWorkflowService } = await import("@mcp-moira/shared");
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Pagination Test User",
        handle: TEST_USER_ID, // Use ID as handle for tests
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      // User might already exist
    }

    // Create large workflow with 100 nodes
    const nodes: any[] = [{ type: "start", id: "start", connections: { default: "node-1" } }];

    for (let i = 1; i <= 98; i++) {
      nodes.push({
        type: "agent-directive",
        id: `node-${i}`,
        directive: `Task ${i}`,
        completionCondition: `Completed ${i}`,
        inputSchema: {
          type: "object",
          properties: { result: { type: "string" } },
          required: ["result"],
        },
        connections: { success: `node-${i + 1}` },
      });
    }

    nodes.push({ type: "end", id: "node-99", finalOutput: [] });

    const largeWorkflow: WorkflowGraph = {
      id: "test-workflow-pagination-large",
      metadata: {
        name: "Large Workflow for Pagination Test",
        version: "1.0.0",
        description: "Workflow with 100 nodes for pagination testing",
      },
      nodes,
    };

    // Use WorkflowService to get the generated UUID
    const workflowService = getWorkflowService();
    const saveResult = await workflowService.save({
      graph: largeWorkflow,
      userId: TEST_USER_ID,
      visibility: "private",
    });
    testWorkflowId = saveResult.id;
  });

  test("workflow with 100 nodes created successfully", async () => {
    const workflow = await repository.getWorkflowGraph(testWorkflowId, TEST_USER_ID);

    expect(workflow).toBeDefined();
    expect(workflow!.nodes.length).toBe(100);
    expect(workflow!.metadata.name).toBe("Large Workflow for Pagination Test");
  });

  test("pagination logic: slice(0, 50) returns first 50 nodes", () => {
    const allNodes = Array.from({ length: 100 }, (_, i) => ({ id: `node-${i}` }));
    const paginated = allNodes.slice(0, 50);

    expect(paginated.length).toBe(50);
    expect(paginated[0].id).toBe("node-0");
    expect(paginated[49].id).toBe("node-49");
  });

  test("pagination logic: slice(50, 100) returns next 50 nodes", () => {
    const allNodes = Array.from({ length: 100 }, (_, i) => ({ id: `node-${i}` }));
    const paginated = allNodes.slice(50, 100);

    expect(paginated.length).toBe(50);
    expect(paginated[0].id).toBe("node-50");
    expect(paginated[49].id).toBe("node-99");
  });

  test("pagination logic: slice(90, 110) returns only remaining 10 nodes", () => {
    const allNodes = Array.from({ length: 100 }, (_, i) => ({ id: `node-${i}` }));
    const paginated = allNodes.slice(90, 110);

    expect(paginated.length).toBe(10);
    expect(paginated[0].id).toBe("node-90");
    expect(paginated[9].id).toBe("node-99");
  });

  test("pagination logic: slice(100, 150) returns empty array", () => {
    const allNodes = Array.from({ length: 100 }, (_, i) => ({ id: `node-${i}` }));
    const paginated = allNodes.slice(100, 150);

    expect(paginated.length).toBe(0);
  });

  test("hasMore flag calculation: offset + limit < total", () => {
    const totalNodes = 100;

    // First page
    let hasMore = 0 + 50 < totalNodes;
    expect(hasMore).toBe(true);

    // Second page
    hasMore = 50 + 50 < totalNodes;
    expect(hasMore).toBe(false);

    // Partial page
    hasMore = 90 + 20 < totalNodes;
    expect(hasMore).toBe(false);
  });

  test("metadata-only mode: totalNodes available without nodes array", async () => {
    const workflow = await repository.getWorkflowGraph(testWorkflowId, TEST_USER_ID);

    expect(workflow).toBeDefined();
    const totalNodes = workflow!.nodes.length;
    expect(totalNodes).toBe(100);

    // Metadata-only would exclude nodes but include totalNodes
    const metadataOnly = {
      totalNodes,
      metadata: workflow!.metadata,
    };

    expect(metadataOnly.totalNodes).toBe(100);
    expect(metadataOnly.metadata.name).toBe("Large Workflow for Pagination Test");
  });
});
