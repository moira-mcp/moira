/**
 * MCP Manage Workflow New Actions Integration Tests
 * Tests copy, clone-node, move-node, and removeConnections actions (Step 1 features)
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-manage-new-actions";

// Test workflow for copy/clone/move tests
const testWorkflow: WorkflowGraph = {
  id: "test-new-actions-workflow",
  metadata: {
    name: "Test New Actions Workflow",
    version: "1.0.0",
    description: "Workflow for testing new manage tool actions",
  },
  variableRegistry: {
    testVar: { type: "string", description: "Test variable", default: "value" },
  },
  nodes: [
    {
      id: "start",
      type: "start",
      connections: { default: "step-1" },
    },
    {
      id: "step-1",
      type: "agent-directive",
      directive: "First step directive",
      completionCondition: "Step 1 completed",
      connections: { success: "step-2" },
    },
    {
      id: "step-2",
      type: "agent-directive",
      directive: "Second step directive",
      completionCondition: "Step 2 completed",
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
      finalOutput: ["result"],
    },
  ],
};

describe("Manage Workflow New Actions Integration Tests", () => {
  let repository: DatabaseRepository;
  const createdWorkflows: string[] = [];
  // Track actual workflow IDs (UUIDs) for workflows created
  let testWorkflowId: string;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Manage New Actions Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }

    // Create test workflow and capture the actual workflow ID
    const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
      return manageWorkflow({
        action: "create",
        workflow: testWorkflow,
        overwrite: true,
      });
    });
    if (!createResult.success) {
      throw new Error(`Failed to create test workflow: ${createResult.error}`);
    }
    // The actual workflow ID is a UUID, not the original graph.id
    testWorkflowId = createResult.data.workflowId;
    createdWorkflows.push(testWorkflowId);
  });

  afterAll(async () => {
    // Cleanup test workflows
    for (const id of createdWorkflows) {
      try {
        await repository.deleteWorkflow(id, TEST_USER_ID);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe("copy action", () => {
    test("copies workflow with default name suffix", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "copy",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.workflowId).toBeDefined();
      expect(result.data.metadata.name).toContain("(copy)");

      // Track for cleanup
      createdWorkflows.push(result.data.workflowId);

      // Verify the copy exists and has correct properties
      const getResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: result.data.workflowId,
        });
      });

      expect(getResult.success).toBe(true);
      expect(getResult.data.visibility).toBe("private");
    });

    test("copies workflow with custom name", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "copy",
          workflowId: testWorkflowId,
          newName: "My Custom Copy",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.metadata.name).toBe("My Custom Copy");
      createdWorkflows.push(result.data.workflowId);
    });

    test("copied workflow has all nodes from source", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "copy",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(true);
      createdWorkflows.push(result.data.workflowId);

      // Get structure of copy
      const structureResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: result.data.workflowId,
        });
      });

      expect(structureResult.success).toBe(true);
      expect(structureResult.data.stats.totalNodes).toBe(4); // start, step-1, step-2, end
    });

    test("returns error for non-existent workflow", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "copy",
          workflowId: "non-existent-workflow",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("clone-node action", () => {
    test("clones node with auto-generated ID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "clone-node",
          workflowId: testWorkflowId,
          nodeId: "step-1",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.clonedNodeId).toBeDefined();
      expect(result.data.clonedNodeId).not.toBe("step-1");
      expect(result.data.clonedNodeId).toContain("step-1");
    });

    test("clones node with custom ID", async () => {
      const customId = `custom-clone-${Date.now()}`;
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "clone-node",
          workflowId: testWorkflowId,
          nodeId: "step-1",
          newId: customId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.clonedNodeId).toBe(customId);

      // Verify the node exists
      const nodeResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
          nodeId: customId,
        });
      });

      expect(nodeResult.success).toBe(true);
      expect(nodeResult.data.node.directive).toBe("First step directive");
    });

    test("returns error for non-existent node", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "clone-node",
          workflowId: testWorkflowId,
          nodeId: "non-existent-node",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("returns error for duplicate custom ID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "clone-node",
          workflowId: testWorkflowId,
          nodeId: "step-1",
          newId: "step-2", // Already exists
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("exists");
    });
  });

  describe("move-node action", () => {
    let moveTestWorkflowId: string;

    beforeAll(async () => {
      // Create a fresh workflow for move tests
      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: {
            id: `test-move-workflow-${Date.now()}`,
            metadata: {
              name: "Move Test Workflow",
              version: "1.0.0",
              description: "For testing move-node action",
            },
            nodes: [
              { id: "start", type: "start", connections: { default: "a" } },
              {
                id: "a",
                type: "agent-directive",
                directive: "Node A",
                completionCondition: "Done",
                connections: { success: "b" },
              },
              {
                id: "b",
                type: "agent-directive",
                directive: "Node B",
                completionCondition: "Done",
                connections: { success: "c" },
              },
              {
                id: "c",
                type: "agent-directive",
                directive: "Node C",
                completionCondition: "Done",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
          overwrite: true,
        });
      });
      moveTestWorkflowId = createResult.data.workflowId;
      createdWorkflows.push(moveTestWorkflowId);
    });

    test("moves node to new position in array", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "move-node",
          workflowId: moveTestWorkflowId,
          nodeId: "c",
          targetIndex: 1, // Move to second position (after start)
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.nodeId).toBe("c");
      expect(result.data.toIndex).toBe(1);
    });

    test("returns error for non-existent node", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "move-node",
          workflowId: moveTestWorkflowId,
          nodeId: "non-existent",
          targetIndex: 0,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("requires targetIndex parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "move-node",
          workflowId: moveTestWorkflowId,
          nodeId: "a",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("targetIndex");
    });
  });

  describe("edit action with removeConnections", () => {
    let editTestWorkflowId: string;

    beforeAll(async () => {
      // Create a fresh workflow for edit tests
      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: {
            id: `test-edit-connections-${Date.now()}`,
            metadata: {
              name: "Edit Connections Test Workflow",
              version: "1.0.0",
              description: "For testing removeConnections in edit action",
            },
            nodes: [
              { id: "start", type: "start", connections: { default: "step-1" } },
              {
                id: "step-1",
                type: "agent-directive",
                directive: "Step 1",
                completionCondition: "Done",
                connections: { success: "step-2", failure: "error" },
              },
              {
                id: "step-2",
                type: "agent-directive",
                directive: "Step 2",
                completionCondition: "Done",
                connections: { success: "end" },
              },
              {
                id: "error",
                type: "agent-directive",
                directive: "Error handler",
                completionCondition: "Done",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
          overwrite: true,
        });
      });
      editTestWorkflowId = createResult.data.workflowId;
      createdWorkflows.push(editTestWorkflowId);
    });

    test("removes specific connection from node", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: editTestWorkflowId,
          changes: {
            removeConnections: [{ nodeId: "step-1", connectionKey: "failure" }],
          },
        });
      });

      expect(result.success).toBe(true);

      // Verify connection was removed
      const nodeResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: editTestWorkflowId,
          nodeId: "step-1",
        });
      });

      expect(nodeResult.success).toBe(true);
      expect(nodeResult.data.node.connections.success).toBe("step-2");
      expect(nodeResult.data.node.connections.failure).toBeUndefined();
    });

    test("can remove multiple connections in one edit", async () => {
      // First add connections back
      await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: editTestWorkflowId,
          changes: {
            updateNodes: [
              {
                nodeId: "step-1",
                changes: {
                  connections: { success: "step-2", failure: "error", warning: "step-2" },
                },
              },
            ],
          },
        });
      });

      // Now remove multiple
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: editTestWorkflowId,
          changes: {
            removeConnections: [
              { nodeId: "step-1", connectionKey: "failure" },
              { nodeId: "step-1", connectionKey: "warning" },
            ],
          },
        });
      });

      expect(result.success).toBe(true);

      // Verify connections were removed
      const nodeResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: editTestWorkflowId,
          nodeId: "step-1",
        });
      });

      expect(nodeResult.success).toBe(true);
      expect(nodeResult.data.node.connections.success).toBe("step-2");
      expect(nodeResult.data.node.connections.failure).toBeUndefined();
      expect(nodeResult.data.node.connections.warning).toBeUndefined();
    });
  });

  // Step 4: CLI/MCP Parity - New actions
  describe("list-nodes action", () => {
    let listNodesTestWorkflowId: string;

    beforeAll(async () => {
      // Create a fresh workflow for list-nodes tests
      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: {
            id: `test-list-nodes-${Date.now()}`,
            metadata: {
              name: "List Nodes Test Workflow",
              version: "1.0.0",
              description: "For testing list-nodes action",
            },
            nodes: [
              { id: "start", type: "start", connections: { default: "step-1" } },
              {
                id: "step-1",
                type: "agent-directive",
                directive: "First step directive",
                completionCondition: "Done",
                connections: { success: "step-2" },
              },
              {
                id: "step-2",
                type: "agent-directive",
                directive: "Second step directive",
                completionCondition: "Done",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
          overwrite: true,
        });
      });
      listNodesTestWorkflowId = createResult.data.workflowId;
      createdWorkflows.push(listNodesTestWorkflowId);
    });

    test("returns compact node list", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "list-nodes",
          workflowId: listNodesTestWorkflowId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.nodeCount).toBe(4);
      expect(result.data.nodes).toHaveLength(4);
      // Check compact format
      const startNode = result.data.nodes.find((n: { id: string }) => n.id === "start");
      expect(startNode).toBeDefined();
      expect(startNode.type).toBe("start");
      expect(startNode.connections).toBeDefined();
    });

    test("filters by type", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "list-nodes",
          workflowId: listNodesTestWorkflowId,
          typeFilter: "agent-directive",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.nodeCount).toBe(2); // step-1 and step-2
      expect(result.data.nodes.every((n: { type: string }) => n.type === "agent-directive")).toBe(
        true,
      );
    });

    test("includes directive preview by default", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "list-nodes",
          workflowId: listNodesTestWorkflowId,
          includePreview: true,
        });
      });

      expect(result.success).toBe(true);
      const step1 = result.data.nodes.find((n: { id: string }) => n.id === "step-1");
      expect(step1.directivePreview).toBeDefined();
      expect(step1.directivePreview).toContain("First step");
    });
  });

  describe("get-nodes action (batch)", () => {
    test("retrieves multiple nodes at once", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-nodes",
          workflowId: testWorkflowId,
          nodeIds: ["step-1", "step-2"],
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.requestedCount).toBe(2);
      expect(result.data.foundCount).toBe(2);
      expect(result.data.nodes).toHaveLength(2);
    });

    test("reports not found nodes", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-nodes",
          workflowId: testWorkflowId,
          nodeIds: ["step-1", "non-existent", "step-2"],
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.foundCount).toBe(2);
      expect(result.data.notFound).toContain("non-existent");
    });

    test("requires nodeIds parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-nodes",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("nodeIds");
    });
  });

  describe("analyze-variables action", () => {
    test("analyzes variable sources and usages", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "analyze-variables",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.variableCount).toBeGreaterThanOrEqual(1);
      // testVar is declared in the variableRegistry
      expect(result.data.analysis.testVar).toBeDefined();
      expect(result.data.analysis.testVar.sources).toHaveLength(1);
      expect(result.data.analysis.testVar.sources[0].type).toBe("registry");
    });
  });

  describe("set-visibility action", () => {
    let visibilityTestWorkflowId: string;

    beforeAll(async () => {
      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: {
            id: `test-visibility-${Date.now()}`,
            metadata: {
              name: "Visibility Test Workflow",
              version: "1.0.0",
              description: "For testing visibility changes",
            },
            visibility: "private",
            nodes: [
              { id: "start", type: "start", connections: { default: "end" } },
              { id: "end", type: "end" },
            ],
          },
        });
      });
      visibilityTestWorkflowId = createResult.data.workflowId;
      createdWorkflows.push(visibilityTestWorkflowId);
    });

    test("changes visibility from private to public", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "set-visibility",
          workflowId: visibilityTestWorkflowId,
          visibility: "public",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.previousVisibility).toBe("private");
      expect(result.data.newVisibility).toBe("public");

      // Verify the change persisted
      const getResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get",
          workflowId: visibilityTestWorkflowId,
        });
      });

      expect(getResult.data.visibility).toBe("public");
    });

    test("changes visibility from public to private", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "set-visibility",
          workflowId: visibilityTestWorkflowId,
          visibility: "private",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.previousVisibility).toBe("public");
      expect(result.data.newVisibility).toBe("private");
    });

    test("requires visibility parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "set-visibility",
          workflowId: visibilityTestWorkflowId,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("visibility");
    });
  });

  describe("move-node with afterNodeId", () => {
    let afterNodeTestWorkflowId: string;

    beforeAll(async () => {
      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: {
            id: `test-after-node-${Date.now()}`,
            metadata: {
              name: "After Node Test Workflow",
              version: "1.0.0",
              description: "For testing afterNodeId in move-node",
            },
            nodes: [
              { id: "start", type: "start", connections: { default: "a" } },
              {
                id: "a",
                type: "agent-directive",
                directive: "A",
                completionCondition: "Done",
                connections: { success: "b" },
              },
              {
                id: "b",
                type: "agent-directive",
                directive: "B",
                completionCondition: "Done",
                connections: { success: "c" },
              },
              {
                id: "c",
                type: "agent-directive",
                directive: "C",
                completionCondition: "Done",
                connections: { success: "end" },
              },
              { id: "end", type: "end" },
            ],
          },
          overwrite: true,
        });
      });
      afterNodeTestWorkflowId = createResult.data.workflowId;
      createdWorkflows.push(afterNodeTestWorkflowId);
    });

    test("moves node after specified node ID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "move-node",
          workflowId: afterNodeTestWorkflowId,
          nodeId: "c",
          afterNodeId: "start",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.nodeId).toBe("c");
      // After start is index 1
      expect(result.data.toIndex).toBe(1);
    });

    test("returns error for non-existent afterNodeId", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "move-node",
          workflowId: afterNodeTestWorkflowId,
          nodeId: "a",
          afterNodeId: "non-existent",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("get-structure with graph and detailed", () => {
    test("returns flow visualization when graph=true", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: testWorkflowId,
          graph: true,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.flowVisualization).toBeDefined();
      expect(Array.isArray(result.data.flowVisualization)).toBe(true);
      expect(result.data.flowVisualization.length).toBeGreaterThan(0);
    });

    test("returns nodes preview when detailed=true", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: testWorkflowId,
          detailed: true,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.nodesPreview).toBeDefined();
      expect(Array.isArray(result.data.nodesPreview)).toBe(true);
      const step1 = result.data.nodesPreview.find((n: { id: string }) => n.id === "step-1");
      expect(step1?.directivePreview).toBeDefined();
    });
  });

  describe("search-nodes with includeVariables and snippetMode", () => {
    test("searches in variables when includeVariables=true", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "testVar",
          includeVariables: true,
        });
      });

      expect(result.success).toBe(true);
      // testVar is defined in initialData, should be found
      expect(result.data.resultCount).toBeGreaterThanOrEqual(1);
    });

    test("returns snippets in snippetMode", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "directive",
          snippetMode: true,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBeGreaterThanOrEqual(1);
      // Check that results have snippet field
      const nodeResults = result.data.results.filter((r: { type: string }) => r.type === "node");
      if (nodeResults.length > 0) {
        expect(nodeResults[0].snippet).toBeDefined();
      }
    });
  });
});
