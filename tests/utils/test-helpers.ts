/**
 * Test Helpers - Source of Truth
 * All test utilities defined here, registered globally by tests/setup.ts
 */

import * as fs from "fs";
import * as path from "path";
import type { InMemoryRepository, UniversalGraphExecutor } from "@mcp-moira/workflow-engine";
import {
  InMemoryRepository as InMemoryRepositoryImpl,
  UniversalGraphExecutor as UniversalGraphExecutorImpl,
} from "@mcp-moira/workflow-engine";
import { MCPEngineClass } from "@mcp-moira/mcp-server";

// Test constants
export const TEST_WORKFLOWS_PATH = "./tests/workflows";
export const TEST_USER_ID = "test-user-123";

/**
 * Create InMemoryRepository with preloaded test workflows
 */
export async function createTestRepository(): Promise<InMemoryRepository> {
  const repository = new InMemoryRepositoryImpl();

  // Load workflow .json files directly
  if (fs.existsSync(TEST_WORKFLOWS_PATH)) {
    const files = fs.readdirSync(TEST_WORKFLOWS_PATH);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(TEST_WORKFLOWS_PATH, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const workflow = JSON.parse(content);
        // Use slug as id if id is not present (for backwards compatibility)
        if (!workflow.id && workflow.slug) {
          workflow.id = workflow.slug;
        }
        await repository.saveWorkflow(workflow, TEST_USER_ID, "public");
      }
    }
  }

  return repository;
}

/**
 * Create executor with preloaded test repository
 */
export async function createTestExecutor(): Promise<{
  repository: InMemoryRepository;
  executor: UniversalGraphExecutor;
}> {
  const repository = await createTestRepository();
  const executor = new UniversalGraphExecutorImpl(repository);

  return { repository, executor };
}

/**
 * Create MCPEngine with InMemoryRepository for testing
 */
export async function createTestMCPEngine(): Promise<{
  engine: MCPEngineClass;
  repository: InMemoryRepository;
}> {
  const repository = await createTestRepository();
  const engine = new MCPEngineClass(repository);

  return { engine, repository };
}

/**
 * Test utilities class
 */
export class TestUtils {
  static createTestContext(variables = {}, userId = "test-user-123") {
    return {
      variables,
      nodeStates: {},
      executionId: "test-execution-id",
      workflowId: "test-workflow",
      userId,
    };
  }

  static createSimpleWorkflow(id = "test-workflow") {
    return {
      id,
      metadata: {
        name: "Test Workflow",
        version: "1.0.0",
        description: "Test workflow for unit testing",
      },
      nodes: [
        {
          type: "start",
          id: "start",
          connections: { default: "test-action" },
        },
        {
          type: "agent-directive",
          id: "test-action",
          directive: "Perform test action",
          completionCondition: "Action completed",
          connections: { success: "end" },
        },
        {
          type: "end",
          id: "end",
        },
      ],
    };
  }
}
