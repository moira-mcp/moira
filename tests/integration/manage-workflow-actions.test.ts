/**
 * MCP Manage Workflow Actions Integration Tests
 * Tests get-structure, get-node, search-nodes, validate actions
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { manageWorkflow } from "../../packages/mcp-server/src/tools/manage-workflow.js";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { getDatabase, user } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const TEST_USER_ID = "test-manage-workflow-actions";

// Test workflow with various node types
const testWorkflow: WorkflowGraph = {
  id: "test-manage-actions-workflow",
  metadata: {
    name: "Test Manage Actions Workflow",
    version: "1.0.0",
    description: "Workflow for testing manage tool actions",
  },
  // Declare the variable the condition references (Step-6 blocking validation requires
  // every referenced variable to be a declared global or a node-id.name local).
  variableRegistry: { result: { type: "string", description: "Step result for condition check" } },
  nodes: [
    {
      id: "start",
      type: "start",
      initialData: { variables: { testVar: { description: "Test variable", value: "value" } } },
      connections: { default: "step-1" },
    },
    {
      id: "step-1",
      type: "agent-directive",
      directive: "First step directive with searchable text about validation",
      completionCondition: "Step 1 completed successfully",
      connections: { success: "check-condition" },
    },
    {
      id: "check-condition",
      type: "condition",
      condition: { operator: "eq", left: { contextPath: "result" }, right: "success" },
      connections: { true: "step-2", false: "error-handler" },
    },
    {
      id: "step-2",
      type: "agent-directive",
      directive: "Second step with different content about processing",
      completionCondition: "Processing finished",
      connections: { success: "end" },
    },
    {
      id: "error-handler",
      type: "agent-directive",
      directive: "Handle errors and cleanup",
      completionCondition: "Errors handled",
      connections: { success: "end" },
    },
    {
      id: "end",
      type: "end",
      finalOutput: ["result"],
    },
  ],
};

// Large workflow for testing (100+ nodes requirement from plan)
function createLargeWorkflow(nodeCount: number): WorkflowGraph {
  const nodes: WorkflowGraph["nodes"] = [
    {
      id: "start",
      type: "start",
      connections: { default: "node-1" },
    },
  ];

  for (let i = 1; i <= nodeCount; i++) {
    const nextNode = i < nodeCount ? `node-${i + 1}` : "end";
    nodes.push({
      id: `node-${i}`,
      type: "agent-directive",
      directive: `Directive for node ${i} with unique content ${i * 100}`,
      completionCondition: `Node ${i} completed`,
      connections: { success: nextNode },
    });
  }

  nodes.push({
    id: "end",
    type: "end",
  });

  return {
    id: "test-large-workflow",
    metadata: {
      name: "Large Test Workflow",
      version: "1.0.0",
      description: `Test workflow with ${nodeCount} nodes`,
    },
    nodes,
  };
}

describe("Manage Workflow Actions Integration Tests", () => {
  let repository: DatabaseRepository;
  let testWorkflowId: string;
  let largeWorkflowId: string | null = null;

  beforeAll(async () => {
    repository = new DatabaseRepository();

    // Create test user
    const db = getDatabase();
    const now = new Date().toISOString();

    try {
      await db.insert(user).values({
        id: TEST_USER_ID,
        email: `${TEST_USER_ID}@test.com`,
        name: "Manage Workflow Actions Test User",
        handle: TEST_USER_ID,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }

    // Create test workflow and capture UUID
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
    // Cleanup test workflows
    try {
      await repository.deleteWorkflow(testWorkflowId, TEST_USER_ID);
      if (largeWorkflowId) {
        await repository.deleteWorkflow(largeWorkflowId, TEST_USER_ID);
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("get-structure action", () => {
    test("returns metadata and stats without full node content", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.success).toBe(true);
      expect(result.data.workflowId).toBe(testWorkflowId);
      expect(result.data.metadata).toEqual({
        name: "Test Manage Actions Workflow",
        version: "1.0.0",
        description: "Workflow for testing manage tool actions",
      });

      // Stats should be present
      expect(result.data.stats).toBeDefined();
      expect(result.data.stats.totalNodes).toBe(6);
      expect(result.data.stats.byType).toBeDefined();
      expect(result.data.stats.byType["agent-directive"]).toBe(3);
      expect(result.data.stats.byType["condition"]).toBe(1);

      // Graph should have connections
      expect(result.data.graph).toBeDefined();
      expect(result.data.graph.length).toBe(6);
    });

    test("handles large workflows (100+ nodes) without truncation", async () => {
      // Create large workflow
      const largeWorkflow = createLargeWorkflow(105);

      const createResult = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: largeWorkflow,
          overwrite: true,
        });
      });
      largeWorkflowId = createResult.data.workflowId;

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: largeWorkflowId!,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.stats.totalNodes).toBe(107); // 105 nodes + start + end
      expect(result.data.graph.length).toBe(107);

      // Verify all nodes are in graph
      const nodeIds = result.data.graph.map((n: { nodeId: string }) => n.nodeId);
      expect(nodeIds).toContain("start");
      expect(nodeIds).toContain("end");
      expect(nodeIds).toContain("node-1");
      expect(nodeIds).toContain("node-105");
    });

    test("returns error for non-existent workflow", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
          workflowId: "non-existent-workflow",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("requires workflowId parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-structure",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("get-node action", () => {
    test("returns specific node by ID", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
          nodeId: "step-1",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.node).toBeDefined();
      expect(result.data.node.id).toBe("step-1");
      expect(result.data.node.type).toBe("agent-directive");
      expect(result.data.node.directive).toContain("validation");
    });

    test("returns start node with initialData", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
          nodeId: "start",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.node.type).toBe("start");
      expect(result.data.node.initialData).toEqual({
        variables: { testVar: { description: "Test variable", value: "value" } },
      });
    });

    test("returns condition node with condition object", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
          nodeId: "check-condition",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.node.type).toBe("condition");
      expect(result.data.node.condition).toBeDefined();
      expect(result.data.node.condition.operator).toBe("eq");
    });

    test("returns error for non-existent node", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
          nodeId: "non-existent-node",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("requires nodeId parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "get-node",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("search-nodes action", () => {
    test("finds nodes by directive text", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "validation",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBe(1);
      expect(result.data.results[0].nodeId).toBe("step-1");
      expect(result.data.results[0].matchedIn).toContain("directive");
    });

    test("finds nodes by completionCondition", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "Processing finished",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBe(1);
      expect(result.data.results[0].nodeId).toBe("step-2");
      expect(result.data.results[0].matchedIn).toContain("completionCondition");
    });

    test("supports regex patterns with |", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "validation|processing",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBe(2);

      const nodeIds = result.data.results.map((r: { nodeId: string }) => r.nodeId);
      expect(nodeIds).toContain("step-1");
      expect(nodeIds).toContain("step-2");
    });

    test("is case insensitive", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "VALIDATION",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBe(1);
    });

    test("returns snippets with matches", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "validation",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.results[0].snippet).toBeDefined();
      expect(result.data.results[0].snippet).toContain("validation");
    });

    test("returns empty results for no matches", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
          query: "nonexistenttext12345",
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.resultCount).toBe(0);
      expect(result.data.results).toHaveLength(0);
    });

    test("requires query parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "search-nodes",
          workflowId: testWorkflowId,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("validate action", () => {
    test("validates correct workflow structure", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: testWorkflow,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(true);
      expect(result.data.errorCount).toBe(0);
    });

    test("accepts a workflow without a top-level id (server-assigned)", async () => {
      // A workflow definition file omits the top-level id — the server assigns
      // one on save. Validation must therefore NOT require it.
      const workflowWithoutId = {
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: workflowWithoutId,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(true);
      expect(result.data.errorCount).toBe(0);
    });

    test("detects invalid connections", async () => {
      const invalidWorkflow = {
        id: "test-invalid",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "non-existent" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: invalidWorkflow,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(false);
      expect(
        result.data.errors.some(
          (e: { message: string }) =>
            e.message.includes("non-existent") || e.message.includes("connection"),
        ),
      ).toBe(true);
    });

    test("returns warnings for unreachable nodes", async () => {
      const workflowWithOrphan = {
        id: "test-orphan",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          {
            id: "orphan",
            type: "agent-directive",
            directive: "Orphan node",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: workflowWithOrphan,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.warningCount).toBeGreaterThan(0);
      expect(
        result.data.warnings.some(
          (w: { message: string }) =>
            w.message.includes("orphan") || w.message.includes("Unreachable"),
        ),
      ).toBe(true);
    });

    test("requires workflow parameter", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });

    test("detects duplicate node IDs", async () => {
      const workflowWithDuplicates = {
        id: "test-duplicates",
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "A",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          {
            id: "step",
            type: "agent-directive",
            directive: "B",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: workflowWithDuplicates,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(false);
      expect(
        result.data.errors.some((e: { message: string }) => e.message.includes("Duplicate")),
      ).toBe(true);
    });

    test("detects invalid metadata version", async () => {
      const workflowBadVersion = {
        id: "test-bad-version",
        metadata: { name: "Test", version: "not-semver", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "end" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "validate",
          workflow: workflowBadVersion,
        });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(false);
      expect(result.data.errorCount).toBeGreaterThan(0);
    });

    test("accepts a flow whose output-scope declarations are correct", async () => {
      const validScopeWorkflow = {
        id: "test-scope-valid",
        metadata: { name: "Scope Valid", version: "1.0.0", description: "Correct scopes" },
        variableRegistry: {
          score: { type: "number", description: "Score written by produce" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Produce a score and a note",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              globalInputs: ["score"],
              properties: { note: { type: "string" } },
              required: ["score"],
            },
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({ action: "validate", workflow: validScopeWorkflow });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(true);
      expect(result.data.errorCount).toBe(0);
    });

    test("rejects a global write that is not declared in the registry", async () => {
      const undeclaredGlobalWorkflow = {
        id: "test-scope-undeclared-global",
        metadata: { name: "Undeclared Global", version: "1.0.0", description: "Bad scope" },
        variableRegistry: {
          score: { type: "number", description: "Declared global" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Write an undeclared global",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              // `total` is NOT in the registry.
              globalInputs: ["total"],
              properties: {},
              required: ["total"],
            },
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({ action: "validate", workflow: undeclaredGlobalWorkflow });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(false);
      expect(
        result.data.errors.some(
          (e: { message: string }) =>
            e.message.includes("'total'") && e.message.includes("variableRegistry"),
        ),
      ).toBe(true);
    });

    test("flags a local output that shadows a declared global name", async () => {
      const shadowWorkflow = {
        id: "test-scope-shadow",
        metadata: { name: "Shadow", version: "1.0.0", description: "Shadowing scope" },
        variableRegistry: {
          score: { type: "number", description: "Declared global" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Declare score as both global and local",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              globalInputs: ["score"],
              // `score` also described as a local output → shadowing.
              properties: { score: { type: "number" } },
              required: ["score"],
            },
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({ action: "validate", workflow: shadowWorkflow });
      });

      expect(result.success).toBe(true);
      expect(result.data.valid).toBe(false);
      expect(
        result.data.errors.some(
          (e: { message: string }) => e.message.includes("'score'") && e.message.includes("shadow"),
        ),
      ).toBe(true);
    });
  });

  describe("validation on create/edit entry points", () => {
    test("create rejects workflow with duplicate node IDs", async () => {
      const invalidWorkflow = {
        id: `test-create-dup-${Date.now()}`,
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "step" } },
          {
            id: "step",
            type: "agent-directive",
            directive: "A",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          {
            id: "step",
            type: "agent-directive",
            directive: "B",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: invalidWorkflow,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("create rejects workflow with invalid connection targets", async () => {
      const invalidWorkflow = {
        id: `test-create-badconn-${Date.now()}`,
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        nodes: [
          { id: "start", type: "start", connections: { default: "non-existent" } },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: invalidWorkflow,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("create rejects a global write not declared in the registry", async () => {
      const invalidWorkflow = {
        id: `test-create-undeclared-global-${Date.now()}`,
        metadata: { name: "Test", version: "1.0.0", description: "Test" },
        variableRegistry: {
          score: { type: "number", description: "Declared global" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "produce" } },
          {
            id: "produce",
            type: "agent-directive",
            directive: "Write an undeclared global",
            completionCondition: "Done",
            inputSchema: {
              type: "object",
              globalInputs: ["total"],
              properties: {},
              required: ["total"],
            },
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "create",
          workflow: invalidWorkflow,
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    test("edit rejects changes that create invalid connections", async () => {
      const result = await runWithMCPContext({ userId: TEST_USER_ID }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: testWorkflowId,
          changes: {
            updateNodes: [
              {
                nodeId: "start",
                changes: { connections: { default: "non-existent-node" } },
              },
            ],
          },
        });
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("variableRegistry persistence (create/edit)", () => {
    const registryUserId = TEST_USER_ID;
    let registryWorkflowId: string;

    afterAll(async () => {
      try {
        await repository.deleteWorkflow(registryWorkflowId, registryUserId);
      } catch {
        // ignore cleanup errors
      }
    });

    test("create persists the declared variableRegistry (round-trip)", async () => {
      const graph: WorkflowGraph = {
        id: "test-registry-roundtrip",
        metadata: {
          name: "Registry Roundtrip",
          version: "1.0.0",
          description: "Verifies the registry survives create + reload",
        },
        variableRegistry: {
          counter: { type: "number", description: "A declared counter", default: 0 },
          label: { type: "string", description: "A declared label" },
        },
        nodes: [
          { id: "start", type: "start", connections: { default: "step-1" } },
          {
            id: "step-1",
            type: "agent-directive",
            // References both declared globals — must validate under Step-6 rules.
            directive: "Counter is {{counter}}, label is {{label}}.",
            completionCondition: "Reported",
            connections: { success: "end" },
          },
          { id: "end", type: "end" },
        ],
      };

      const createResult = await runWithMCPContext({ userId: registryUserId }, async () => {
        return manageWorkflow({ action: "create", workflow: graph, overwrite: true });
      });

      expect(createResult.success).toBe(true);
      registryWorkflowId = createResult.data.workflowId;

      // Reload from the database and confirm the registry was persisted intact.
      const stored = await repository.getWorkflow(registryWorkflowId, registryUserId);
      expect(stored).not.toBeNull();
      expect(stored!.workflow.variableRegistry).toEqual({
        counter: { type: "number", description: "A declared counter", default: 0 },
        label: { type: "string", description: "A declared label" },
      });
    });

    test("edit replaces the variableRegistry via changes.variableRegistry", async () => {
      const newRegistry = {
        counter: { type: "number", description: "A declared counter", default: 0 },
        label: { type: "string", description: "A declared label" },
        extra: { type: "boolean", description: "An added flag" },
      };

      const editResult = await runWithMCPContext({ userId: registryUserId }, async () => {
        return manageWorkflow({
          action: "edit",
          workflowId: registryWorkflowId,
          changes: { variableRegistry: newRegistry },
        });
      });

      expect(editResult.success).toBe(true);

      const stored = await repository.getWorkflow(registryWorkflowId, registryUserId);
      expect(stored).not.toBeNull();
      expect(stored!.workflow.variableRegistry).toEqual(newRegistry);
    });
  });
});
