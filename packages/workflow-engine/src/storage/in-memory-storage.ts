/**
 * In-Memory Storage for Graph Workflow Engine
 * Test-friendly storage without file system operations
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { WorkflowExecution } from "../types/index.js";
import {
  IGraphStorage,
  WorkflowGraph,
  WorkflowLoadResult,
  WorkflowListItem,
} from "../interfaces/core-interfaces.js";
import { GraphValidator } from "../validation/graph-validator.js";
import { createLogger } from "@mcp-moira/shared";

export class InMemoryGraphStorage implements IGraphStorage {
  private logger = createLogger({ component: "InMemoryGraphStorage" });
  private executions: Map<string, WorkflowExecution> = new Map();
  private workflows: Map<string, { workflow: WorkflowGraph; userId: string; visibility: string }> =
    new Map();
  private workflowsPath: string;
  private validator: GraphValidator;
  private defaultUserId: string;

  constructor(
    workflowsPath = "./tests-graph/workflows",
    schemaPath?: string,
    defaultUserId = "test-user-123",
  ) {
    this.workflowsPath = workflowsPath;
    this.validator = new GraphValidator(schemaPath);
    this.defaultUserId = defaultUserId;

    // Load all workflow files into memory at initialization
    this.loadAllWorkflowsSync();

    this.logger.info("InMemoryGraphStorage initialized", {
      workflowsPath: this.workflowsPath,
      workflowsLoaded: this.workflows.size,
      defaultUserId: this.defaultUserId,
    });
  }

  /**
   * Load all workflow files from disk into memory at initialization
   */
  private loadAllWorkflowsSync(): void {
    try {
      if (fs.existsSync(this.workflowsPath)) {
        const files = fs.readdirSync(this.workflowsPath);
        const jsonFiles = files.filter((file) => file.endsWith(".json"));

        for (const file of jsonFiles) {
          try {
            const filePath = path.join(this.workflowsPath, file);
            const data = fs.readFileSync(filePath, "utf-8");
            const workflow = JSON.parse(data) as WorkflowGraph;

            // Definition files have no server-assigned id; derive one from the
            // slug or filename so the in-memory map and list items stay keyed.
            const effectiveId =
              workflow.id ?? (workflow as { slug?: string }).slug ?? file.replace(/\.json$/, "");
            const storedWorkflow = { ...workflow, id: effectiveId };

            // Store as public workflow under defaultUserId
            this.workflows.set(effectiveId, {
              workflow: storedWorkflow,
              userId: this.defaultUserId,
              visibility: "public",
            });
          } catch (error) {
            this.logger.debug("Failed to load workflow file", {
              file,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        this.logger.debug("Workflows pre-loaded from files", {
          count: jsonFiles.length,
          loaded: this.workflows.size,
        });
      }
    } catch (error) {
      this.logger.debug("Failed to load workflows directory", {
        path: this.workflowsPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Save workflow execution state (in memory)
   */
  async saveExecution(execution: WorkflowExecution): Promise<void> {
    this.executions.set(execution.executionId, { ...execution });

    this.logger.debug("Execution saved to memory", {
      executionId: execution.executionId.slice(0, 8),
      status: execution.status,
      currentNodeId: execution.currentNodeId,
    });
  }

  /**
   * Load workflow execution state (from memory)
   */
  async getExecution(executionId: string): Promise<WorkflowExecution | null> {
    const execution = this.executions.get(executionId);

    this.logger.debug("Execution retrieved from memory", {
      executionId: executionId.slice(0, 8),
      found: !!execution,
      status: execution?.status,
    });

    return execution ? { ...execution } : null;
  }

  /**
   * Delete workflow execution (from memory)
   */
  async deleteExecution(executionId: string): Promise<void> {
    const deleted = this.executions.delete(executionId);

    this.logger.debug("Execution deleted from memory", {
      executionId: executionId.slice(0, 8),
      existed: deleted,
    });
  }

  /**
   * List all workflow executions (from memory)
   */
  async listExecutions(): Promise<WorkflowExecution[]> {
    const executions = Array.from(this.executions.values());

    this.logger.debug("Executions listed from memory", {
      count: executions.length,
    });

    return executions.map((e) => ({ ...e }));
  }

  /**
   * Save workflow graph definition (in memory)
   */
  async saveWorkflow(graph: WorkflowGraph, userId: string): Promise<void> {
    // id is server-assigned; generate one for a new (id-less) graph.
    const workflowId = graph.id ?? randomUUID();
    this.workflows.set(workflowId, {
      workflow: { ...graph, id: workflowId },
      userId,
      visibility: "private",
    });

    this.logger.debug("Workflow saved to memory", {
      workflowId,
      userId: userId.slice(0, 8),
      workflowName: graph.metadata.name,
      nodeCount: graph.nodes.length,
    });
  }

  /**
   * Load workflow graph definition (from memory only, no file fallback)
   */
  async getWorkflow(workflowId: string, userId: string): Promise<WorkflowGraph | null> {
    const entry = this.workflows.get(workflowId);

    if (!entry) {
      this.logger.debug("Workflow not found in memory", {
        workflowId,
        userId: userId.slice(0, 8),
      });
      return null;
    }

    // Access control: owner or public
    if (entry.userId === userId || entry.visibility === "public") {
      this.logger.debug("Workflow retrieved from memory", {
        workflowId,
        userId: userId.slice(0, 8),
        workflowName: entry.workflow.metadata.name,
      });
      return { ...entry.workflow };
    }

    this.logger.debug("Workflow access denied", {
      workflowId,
      userId: userId.slice(0, 8),
      ownerId: entry.userId.slice(0, 8),
    });
    return null;
  }

  /**
   * List workflows accessible to user (owned + public, from memory only)
   */
  async listWorkflows(userId: string): Promise<WorkflowGraph[]> {
    const accessible: WorkflowGraph[] = [];

    for (const entry of this.workflows.values()) {
      if (entry.userId === userId || entry.visibility === "public") {
        accessible.push({ ...entry.workflow });
      }
    }

    this.logger.debug("Workflows listed", {
      userId: userId.slice(0, 8),
      count: accessible.length,
    });

    return accessible;
  }

  /**
   * Delete workflow (with access control)
   */
  async deleteWorkflow(workflowId: string, userId: string): Promise<void> {
    const entry = this.workflows.get(workflowId);

    if (!entry) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    if (entry.userId !== userId) {
      throw new Error(`Access denied: workflow ${workflowId} belongs to ${entry.userId}`);
    }

    this.workflows.delete(workflowId);

    this.logger.debug("Workflow deleted from memory", {
      workflowId,
      userId: userId.slice(0, 8),
    });
  }

  /**
   * Clear all in-memory data (for testing)
   */
  clear(): void {
    this.executions.clear();
    this.workflows.clear();
    this.logger.debug("In-memory storage cleared");
  }

  /**
   * Get workflow with validation - NEW METHOD
   */
  async getWorkflowWithValidation(workflowId: string, userId: string): Promise<WorkflowLoadResult> {
    // First try to get workflow
    const workflow = await this.getWorkflow(workflowId, userId);

    if (!workflow) {
      return {
        validation: {
          valid: false,
          errors: [
            {
              type: "schema",
              message: `Workflow '${workflowId}' not found or access denied`,
            },
          ],
          warnings: [],
        },
        filePath: path.join(this.workflowsPath, `${workflowId}.json`),
      };
    }

    // Validate workflow
    const validation = await this.validator.validateWorkflow(workflow);

    return {
      workflow: validation.valid ? workflow : undefined,
      validation,
      filePath: path.join(this.workflowsPath, `${workflowId}.json`),
    };
  }

  /**
   * List workflows with validation status - NEW METHOD
   */
  async listWorkflowsWithValidation(userId: string): Promise<WorkflowListItem[]> {
    const workflowItems: WorkflowListItem[] = [];
    const now = Date.now();

    for (const [workflowId, entry] of this.workflows.entries()) {
      // Access control: owner or public
      if (entry.userId !== userId && entry.visibility !== "public") {
        continue;
      }

      try {
        const validation = await this.validator.validateWorkflow(entry.workflow);

        workflowItems.push({
          id: workflowId,
          metadata: entry.workflow.metadata,
          filePath: path.join(this.workflowsPath, `${workflowId}.json`),
          validation,
          workflow: validation.valid ? entry.workflow : undefined,
          userId: entry.userId,
          visibility: entry.visibility as "public" | "private",
          createdAt: now,
          updatedAt: now,
        });
      } catch (error) {
        workflowItems.push({
          id: workflowId,
          metadata: entry.workflow.metadata,
          filePath: path.join(this.workflowsPath, `${workflowId}.json`),
          validation: {
            valid: false,
            errors: [
              {
                type: "schema",
                message: `Validation failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            warnings: [],
          },
          userId: entry.userId,
          visibility: entry.visibility as "public" | "private",
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    this.logger.debug("Workflows listed with validation", {
      userId: userId.slice(0, 8),
      total: workflowItems.length,
      valid: workflowItems.filter((w) => w.validation.valid).length,
      invalid: workflowItems.filter((w) => !w.validation.valid).length,
    });

    return workflowItems;
  }

  /**
   * Get storage statistics
   */
  getStats(): {
    executionCount: number;
    workflowCount: number;
    memoryUsage: number;
  } {
    return {
      executionCount: this.executions.size,
      workflowCount: this.workflows.size,
      memoryUsage: JSON.stringify([...this.executions.values(), ...this.workflows.values()]).length,
    };
  }
}
