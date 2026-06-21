/**
 * Context Mapping Utilities for Subgraph Execution
 * Handles parent-child context isolation and variable mapping
 * Refactored to use PathResolver utility for DRY compliance
 */

import { ExecutionContext } from "../types/base-types.js";
import { createLogger } from "@mcp-moira/shared";
import { PathResolver } from "./path-resolver.js";

export class ContextMapper {
  private static logger = createLogger({ component: "ContextMapper" });

  /**
   * Create isolated child context from parent using input mapping
   */
  static createChildContext(
    parentContext: ExecutionContext,
    inputMapping: Record<string, string>,
    childWorkflowId: string,
    childExecutionId: string,
  ): ExecutionContext {
    const timer = this.logger.startTimer();

    // Initialize child variables with mapped parent values
    const childVariables: Record<string, unknown> = {};

    for (const [parentPath, childKey] of Object.entries(inputMapping)) {
      try {
        const parentValue = PathResolver.resolveVariablePath(parentContext.variables, parentPath);

        // Deep clone objects to ensure isolation
        childVariables[childKey] = this.deepClone(parentValue);

        this.logger.debug("Mapped parent variable to child", {
          parentPath,
          childKey,
          hasValue: parentValue !== undefined,
          valueType: typeof parentValue,
        });
      } catch (error) {
        this.logger.debug("Failed to map parent variable", {
          parentPath,
          childKey,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with undefined value
        childVariables[childKey] = undefined;
      }
    }

    // Calculate new depth
    const currentDepth = parentContext._subgraphDepth || 0;
    const newDepth = currentDepth + 1;

    // Build subgraph chain for debugging
    const currentChain = parentContext._subgraphChain || [parentContext.workflowId];
    const newChain = [...currentChain, childWorkflowId];

    const childContext: ExecutionContext = {
      variables: childVariables,
      nodeStates: {}, // Fresh node states for child
      executionId: childExecutionId,
      workflowId: childWorkflowId,
      userId: parentContext.userId, // Inherit userId from parent

      // Subgraph tracking
      _subgraphDepth: newDepth,
      _parentExecutionId: parentContext.executionId,
      _subgraphChain: newChain,
    };

    this.logger.info("Created child context", {
      parentExecutionId: parentContext.executionId.slice(0, 8),
      childExecutionId: childExecutionId.slice(0, 8),
      parentWorkflowId: parentContext.workflowId,
      childWorkflowId,
      depth: newDepth,
      mappedVariables: Object.keys(childVariables).length,
      mappedVariableNames: Object.keys(childVariables),
      mappingDetails: Object.entries(inputMapping).map(([parentPath, childKey]) => ({
        parentPath,
        childKey,
        hasValue: childVariables[childKey] !== undefined,
        valueType: typeof childVariables[childKey],
      })),
      executionTime: timer.elapsed(),
    });

    return childContext;
  }

  /**
   * Map child context results back to parent using output mapping
   */
  static mergeChildResults(
    parentContext: ExecutionContext,
    childContext: ExecutionContext,
    outputMapping: Record<string, string>,
  ): void {
    const timer = this.logger.startTimer();
    let mappedCount = 0;

    for (const [childPath, parentKey] of Object.entries(outputMapping)) {
      try {
        const childValue = PathResolver.resolveVariablePath(childContext.variables, childPath);
        PathResolver.setVariablePath(parentContext.variables, parentKey, childValue);
        mappedCount++;

        this.logger.debug("Mapped child variable to parent", {
          childPath,
          parentKey,
          hasValue: childValue !== undefined,
          valueType: typeof childValue,
        });
      } catch (error) {
        this.logger.debug("Failed to map child variable to parent", {
          childPath,
          parentKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.info("Merged child results to parent", {
      parentExecutionId: parentContext.executionId.slice(0, 8),
      childExecutionId: childContext.executionId.slice(0, 8),
      mappedVariables: mappedCount,
      totalOutputMappings: Object.keys(outputMapping).length,
      executionTime: timer.elapsed(),
    });
  }

  /**
   * Validate that all paths in mapping are valid
   */
  static validateMapping(
    context: Record<string, unknown>,
    mapping: Record<string, string>,
    mappingType: "input" | "output",
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [sourcePath, targetKey] of Object.entries(mapping)) {
      try {
        // Validate source path can be resolved
        PathResolver.resolveVariablePath(context, sourcePath);

        // Validate target key is valid identifier
        if (!targetKey || typeof targetKey !== "string") {
          errors.push(`Invalid target key "${targetKey}" in ${mappingType} mapping`);
        }
      } catch (error) {
        errors.push(
          `Invalid ${mappingType} mapping "${sourcePath}" -> "${targetKey}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Deep clone value to ensure complete isolation
   */
  private static deepClone(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value !== "object") {
      return value; // Primitives are copied by value
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.deepClone(item));
    }

    // Handle objects
    const cloned: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      cloned[key] = this.deepClone(val);
    }

    return cloned;
  }
}
