import { logger } from "../utils/logger.js";
/**
 * Validation Service - Integration with Unified Validation System
 * Wraps GraphValidator using the unified validation API (validateUnified).
 */

import path from "path";
import { fileURLToPath } from "url";

import { WorkflowGraph, WorkflowValidationStatus } from "../types/index.js";

// Import unified validation system
import { GraphValidator } from "@mcp-moira/workflow-engine";
import type { UnifiedValidationResult } from "@mcp-moira/workflow-engine";

// ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Service for validating workflows using existing MCP validation system
 */
export class WorkflowValidationService {
  private validator: GraphValidator | null = null;
  private initializationError: string | null = null;

  constructor() {
    try {
      this.validator = new GraphValidator();
      logger.info("✅ GraphValidator initialized successfully");
    } catch (error) {
      this.initializationError =
        error instanceof Error ? error.message : "Unknown GraphValidator initialization error";
      logger.error("❌ CRITICAL: Failed to initialize GraphValidator:", this.initializationError);
      logger.error("❌ This will cause validation service to be unavailable");
      logger.error("❌ Full error details:", error);
    }
  }

  /**
   * Validate workflow using unified validation API
   */
  async validateWorkflow(workflow: WorkflowGraph): Promise<WorkflowValidationStatus> {
    try {
      if (!this.validator) {
        throw new Error(`GraphValidator not available: ${this.initializationError}`);
      }

      // Use unified validation API (single source of truth)
      const result = await this.validator.validateUnified(workflow);

      return this.convertUnifiedToStatus(result, workflow);
    } catch (error) {
      return {
        isValid: false,
        nodeValidation: {},
        globalErrors: [
          `Validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
        globalWarnings: [],
      };
    }
  }

  /**
   * Validate workflow from file content
   */
  async validateWorkflowFromFile(filePath: string): Promise<WorkflowValidationStatus> {
    try {
      const { readFile } = await import("fs/promises");
      const content = await readFile(filePath, "utf-8");
      const workflow: WorkflowGraph = JSON.parse(content);

      return await this.validateWorkflow(workflow);
    } catch (error) {
      return {
        isValid: false,
        nodeValidation: {},
        globalErrors: [
          `File validation error: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
        globalWarnings: [],
      };
    }
  }

  /**
   * Batch validate multiple workflows
   */
  async validateWorkflows(
    workflows: Array<{ folder: string; id: string; workflow: WorkflowGraph }>,
  ): Promise<{
    results: Array<{
      folder: string;
      id: string;
      validation: WorkflowValidationStatus;
      error?: string;
    }>;
    summary: {
      total: number;
      valid: number;
      invalid: number;
      errors: number;
    };
  }> {
    const results = [];
    let validCount = 0;
    let invalidCount = 0;
    let errorCount = 0;

    for (const { folder, id, workflow } of workflows) {
      try {
        const validation = await this.validateWorkflow(workflow);
        results.push({ folder, id, validation });

        if (validation.isValid) {
          validCount++;
        } else {
          invalidCount++;
        }
      } catch (error) {
        errorCount++;
        results.push({
          folder,
          id,
          validation: {
            isValid: false,
            nodeValidation: {},
            globalErrors: [
              `Validation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
            ],
            globalWarnings: [],
          },
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return {
      results,
      summary: {
        total: workflows.length,
        valid: validCount,
        invalid: invalidCount,
        errors: errorCount,
      },
    };
  }

  /**
   * Check if workflow is compatible with visualization system
   */
  async checkVisualizationCompatibility(workflow: WorkflowGraph): Promise<{
    isCompatible: boolean;
    issues: string[];
    warnings: string[];
  }> {
    const issues: string[] = [];
    const warnings: string[] = [];

    // Check for required start node
    const startNodes = workflow.nodes.filter((node) => node.type === "start");
    if (startNodes.length === 0) {
      issues.push("Workflow must have exactly one start node");
    } else if (startNodes.length > 1) {
      warnings.push("Multiple start nodes found, only first will be displayed");
    }

    // Check for end nodes
    const endNodes = workflow.nodes.filter((node) => node.type === "end");
    if (endNodes.length === 0) {
      warnings.push("No end node found - workflow may appear incomplete in visualization");
    }

    // Check supported node types
    const supportedTypes = [
      "start",
      "agent-directive",
      "condition",
      "end",
      "telegram-notification",
      "subgraph",
      "expression",
      "read-note",
      "write-note",
      "upsert-note",
      "lock",
      "teleport",
    ];
    workflow.nodes.forEach((node) => {
      if (!supportedTypes.includes(node.type)) {
        issues.push(`Unsupported node type for visualization: ${node.type} (node: ${node.id})`);
      }
    });

    // Validate node connections
    workflow.nodes.forEach((node) => {
      if (node.connections) {
        Object.values(node.connections).forEach((targetId) => {
          const targetExists = workflow.nodes.some((n) => n.id === targetId);
          if (!targetExists) {
            issues.push(`Node ${node.id} references non-existent target: ${targetId}`);
          }
        });
      }
    });

    // Check for disconnected nodes
    const connectedNodes = new Set<string>();
    workflow.nodes.forEach((node) => {
      if (node.connections) {
        Object.values(node.connections).forEach((targetId) => {
          if (typeof targetId === "string") {
            connectedNodes.add(targetId);
          }
        });
      }
    });

    workflow.nodes.forEach((node) => {
      if (node.type !== "start" && !connectedNodes.has(node.id)) {
        warnings.push(`Node ${node.id} appears to be disconnected (no incoming connections)`);
      }
    });

    return {
      isCompatible: issues.length === 0,
      issues,
      warnings,
    };
  }

  /**
   * Convert UnifiedValidationResult to WorkflowValidationStatus format
   */
  private convertUnifiedToStatus(
    result: UnifiedValidationResult,
    workflow: WorkflowGraph,
  ): WorkflowValidationStatus {
    const nodeValidation: Record<
      string,
      { isValid: boolean; errors: string[]; warnings: string[] }
    > = {};

    // Initialize all nodes as valid by default
    workflow.nodes.forEach((node) => {
      nodeValidation[node.id] = {
        isValid: true,
        errors: [],
        warnings: [],
      };
    });

    // Process unified issues into node-specific and global buckets
    for (const issue of result.issues) {
      if (issue.nodeId && nodeValidation[issue.nodeId]) {
        if (issue.severity === "error") {
          nodeValidation[issue.nodeId].isValid = false;
          nodeValidation[issue.nodeId].errors.push(issue.message);
        } else {
          nodeValidation[issue.nodeId].warnings.push(issue.message);
        }
      }
    }

    // Separate global issues (no nodeId)
    const globalErrors = result.issues
      .filter((i) => i.severity === "error" && !i.nodeId)
      .map((i) => i.message);

    const globalWarnings = result.issues
      .filter((i) => i.severity === "warning" && !i.nodeId)
      .map((i) => i.message);

    return {
      isValid: result.valid,
      nodeValidation,
      globalErrors,
      globalWarnings,
    };
  }

  /**
   * Get validation system status
   */
  getValidationSystemStatus(): {
    available: boolean;
    version?: string;
    features: string[];
    error?: string;
  } {
    return {
      available: this.validator !== null,
      version: this.validator ? "0.1.0-mcp-integrated" : undefined,
      error: this.initializationError || undefined,
      features: this.validator
        ? [
            "Full MCP GraphValidator integration",
            "JSON Schema validation with AJV",
            "Advanced structure validation",
            "Node type validation",
            "Connection validation",
            "References validation",
            "Best practices warnings",
            "Performance warnings",
          ]
        : [],
    };
  }
}
