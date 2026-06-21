/**
 * MCP E2E Tests - Workflow CRUD Operations
 * Tests: create_workflow, edit_workflow
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { CRUD_WORKFLOWS } = MCP_TEST_DATA;

describe("MCP Workflow CRUD Tools E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;
  let testWorkflowId: string;
  const createdWorkflows: string[] = [];

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    // Cleanup all test workflows
    for (const workflowId of createdWorkflows) {
      try {
        await callMCPTool(client, "manage", { workflowId });
      } catch (e) {
        // Ignore cleanup errors
      }
    }
    if (testWorkflowId) {
      try {
        await callMCPTool(client, "manage", { workflowId: testWorkflowId });
      } catch (e) {
        // Ignore
      }
    }
    await cleanup();
  });

  test("create_workflow creates valid workflow", async () => {
    const workflow = {
      ...CRUD_WORKFLOWS.SIMPLE_CREATE,
    };

    const result = await callMCPTool(client, "manage", {
      action: "create",
      workflow,
      overwrite: false,
    });

    // create_workflow returns {success, workflowId, validation: {valid}}
    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("workflowId");
    expect(result).toHaveProperty("validation.valid", true);

    testWorkflowId = result.workflowId;
    const testSlug = result.slug;

    // Verify workflow exists - list returns id as "ownerHandle/slug" format
    const listResult = await callMCPTool(client, "list", {});
    const workflows = listResult.workflows || listResult;
    // Match by slug since list id is now "handle/slug" format, not UUID
    const created = workflows.find((wf: any) => wf.slug === testSlug);
    expect(created).toBeDefined();
    expect(created.name).toBe(CRUD_WORKFLOWS.SIMPLE_CREATE.metadata.name);

    createdWorkflows.push(testWorkflowId);
  });

  test("create_workflow with overwrite replaces existing", async () => {
    const originalWorkflow = {
      ...CRUD_WORKFLOWS.SIMPLE_CREATE,
    };

    // Create original
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: originalWorkflow,
    });
    const workflowId = createResult.workflowId;
    const originalSlug = createResult.slug;
    createdWorkflows.push(workflowId);

    // Overwrite with new version - use the returned workflowId
    const updatedWorkflow = {
      ...originalWorkflow,
      id: workflowId, // Specify id to overwrite the same workflow
      metadata: {
        ...originalWorkflow.metadata,
        ...CRUD_WORKFLOWS.UPDATED_VERSION.metadata,
      },
    };

    const result = await callMCPTool(client, "manage", {
      action: "create",
      workflow: updatedWorkflow,
      overwrite: true,
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("validation.valid", true);

    // Verify updated - match by slug since list id is now "handle/slug" format
    const listResult2 = await callMCPTool(client, "list", {});
    const workflowsList = listResult2.workflows || listResult2;
    const updated = workflowsList.find((wf: any) => wf.slug === originalSlug);
    expect(updated).toBeDefined();
    expect(updated.name).toBe(CRUD_WORKFLOWS.UPDATED_VERSION.metadata.name);
    expect(updated.description).toBe(CRUD_WORKFLOWS.UPDATED_VERSION.metadata.description);
  });

  test("create_workflow validates workflow structure", async () => {
    const result = await callMCPTool<string>(client, "manage", {
      action: "create",
      workflow: CRUD_WORKFLOWS.INVALID_EMPTY_NODES,
    });

    // MCP tool returns error message string for validation failures
    expect(typeof result).toBe("string");
    expect(result.toLowerCase()).toMatch(/error|validation|invalid/);
  });

  test("edit_workflow updates metadata", async () => {
    // Use existing test workflow
    if (!testWorkflowId) {
      console.warn("No test workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "edit",
      workflowId: testWorkflowId,
      changes: {
        metadata: {
          name: "Updated Test CRUD Workflow",
          description: "Updated description via edit_workflow",
        },
      },
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("workflowId", testWorkflowId);
    expect(result).toHaveProperty("validation.valid", true);

    // Verify changes
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
    });

    expect(details.metadata.name).toBe("Updated Test CRUD Workflow");
    expect(details.metadata.description).toBe("Updated description via edit_workflow");
  });

  test("edit_workflow adds nodes", async () => {
    if (!testWorkflowId) {
      console.warn("No test workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "edit",
      workflowId: testWorkflowId,
      changes: {
        addNodes: [CRUD_WORKFLOWS.NEW_NODE],
      },
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("validation.valid", true);

    // Verify node added
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
    });

    const addedNode = details.nodes.find((n: any) => n.id === CRUD_WORKFLOWS.NEW_NODE.id);
    expect(addedNode).toBeDefined();
    expect(addedNode.directive).toBe(CRUD_WORKFLOWS.NEW_NODE.directive);
  });

  test("edit_workflow updates nodes", async () => {
    if (!testWorkflowId) {
      console.warn("No test workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "edit",
      workflowId: testWorkflowId,
      changes: {
        updateNodes: [
          {
            nodeId: CRUD_WORKFLOWS.NEW_NODE.id,
            changes: {
              directive: "Updated directive text",
              completionCondition: "Updated completion condition",
            },
          },
        ],
      },
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("validation.valid", true);

    // Verify update
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
    });

    const updatedNode = details.nodes.find((n: any) => n.id === CRUD_WORKFLOWS.NEW_NODE.id);
    expect(updatedNode.directive).toBe("Updated directive text");
    expect(updatedNode.completionCondition).toBe("Updated completion condition");
  });

  test("edit_workflow removes nodes", async () => {
    if (!testWorkflowId) {
      console.warn("No test workflow available, skipping");
      return;
    }

    const result = await callMCPTool(client, "manage", {
      action: "edit",
      workflowId: testWorkflowId,
      changes: {
        removeNodes: [CRUD_WORKFLOWS.NEW_NODE.id],
      },
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("validation.valid", true);

    // Verify removed
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: testWorkflowId,
    });

    const removedNode = details.nodes.find((n: any) => n.id === CRUD_WORKFLOWS.NEW_NODE.id);
    expect(removedNode).toBeUndefined();
  });

  test("edit_workflow validates connection integrity", async () => {
    // Create workflow with 3 nodes
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        metadata: {
          name: "Connection Test",
          version: "1.0.0",
          description: "Test connection validation",
        },
        nodes: [
          { type: "start", id: "start", connections: { default: "middle" } },
          {
            type: "agent-directive",
            id: "middle",
            directive: "Middle step",
            completionCondition: "Done",
            connections: { success: "end" },
          },
          { type: "end", id: "end" },
        ],
      },
    });

    const testId = createResult.workflowId;
    createdWorkflows.push(testId);

    // Try to remove middle node - should return error
    const result = await callMCPTool<string>(client, "manage", {
      action: "edit",
      workflowId: testId,
      changes: {
        removeNodes: ["middle"],
      },
    });

    // MCP tool returns error message for validation failures
    expect(typeof result).toBe("string");
    expect(result.toLowerCase()).toMatch(/error|validation|connection|broken/);
  });

  test("create_workflow defaults to private visibility", async () => {
    const workflow = {
      ...CRUD_WORKFLOWS.SIMPLE_CREATE,
    };

    const createResult = await callMCPTool(client, "manage", { action: "create", workflow });
    const workflowId = createResult.workflowId;
    createdWorkflows.push(workflowId);

    // Verify visibility is private
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId,
    });

    expect(details.visibility).toBe("private");
  });

  test("create_workflow respects explicit visibility parameter", async () => {
    // Create public workflow
    const publicResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        ...CRUD_WORKFLOWS.SIMPLE_CREATE,
        visibility: "public",
      },
    });
    const publicWorkflowId = publicResult.workflowId;
    createdWorkflows.push(publicWorkflowId);

    // Create private workflow
    const privateResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        ...CRUD_WORKFLOWS.SIMPLE_CREATE,
        visibility: "private",
      },
    });
    const privateWorkflowId = privateResult.workflowId;
    createdWorkflows.push(privateWorkflowId);

    const publicDetails = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: publicWorkflowId,
    });
    const privateDetails = await callMCPTool(client, "manage", {
      action: "get",
      workflowId: privateWorkflowId,
    });

    expect(publicDetails.visibility).toBe("public");
    expect(privateDetails.visibility).toBe("private");
  });

  test("edit_workflow preserves visibility when not specified", async () => {
    // Create private workflow
    const createResult = await callMCPTool(client, "manage", {
      action: "create",
      workflow: {
        ...CRUD_WORKFLOWS.SIMPLE_CREATE,
      },
    });
    const workflowId = createResult.workflowId;
    createdWorkflows.push(workflowId);

    // Edit metadata without touching visibility
    await callMCPTool(client, "manage", {
      action: "edit",
      workflowId,
      changes: {
        metadata: {
          name: "Updated Name",
          description: "Updated description",
        },
      },
    });

    // Verify visibility still private
    const details = await callMCPTool(client, "manage", {
      action: "get",
      workflowId,
    });

    expect(details.visibility).toBe("private");
    expect(details.metadata.name).toBe("Updated Name");
  });
});
