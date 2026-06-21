/**
 * Context Helper Utilities for Subgraph Execution
 * Additional utilities for managing execution context and subgraph chains
 */

import { ExecutionContext } from "../types/base-types.js";
import { createLogger } from "@mcp-moira/shared";

export class ContextHelpers {
  private static logger = createLogger({ component: "ContextHelpers" });

  /**
   * Check if context is from a subgraph execution
   */
  static isSubgraphContext(context: ExecutionContext): boolean {
    return (context._subgraphDepth || 0) > 0;
  }

  /**
   * Check if context has reached maximum depth
   */
  static isMaxDepthReached(context: ExecutionContext, maxDepth: number = 100): boolean {
    return (context._subgraphDepth || 0) >= maxDepth;
  }

  /**
   * Get the root execution ID from subgraph chain
   */
  static getRootExecutionId(context: ExecutionContext): string {
    // If no parent, this is root
    if (!context._parentExecutionId) {
      return context.executionId;
    }

    // For now, we can't traverse up the chain without storage access
    // This would require the execution storage to walk up the parent chain
    // Return the immediate parent for now
    return context._parentExecutionId;
  }

  /**
   * Get full workflow execution chain
   */
  static getWorkflowChain(context: ExecutionContext): string[] {
    return context._subgraphChain || [context.workflowId];
  }

  /**
   * Check if workflow is in execution chain (circular reference detection)
   */
  static isWorkflowInChain(context: ExecutionContext, workflowId: string): boolean {
    const chain = this.getWorkflowChain(context);
    return chain.includes(workflowId);
  }

  /**
   * Create debug info string for context
   */
  static getDebugInfo(context: ExecutionContext): string {
    const depth = context._subgraphDepth || 0;
    const chain = this.getWorkflowChain(context);
    const isSubgraph = this.isSubgraphContext(context);

    return (
      `ExecutionContext[${context.executionId.slice(0, 8)}] ` +
      `depth=${depth} workflow=${context.workflowId} ` +
      `isSubgraph=${isSubgraph} chain=[${chain.join(" -> ")}]`
    );
  }

  /**
   * Clone context for new execution (preserves chain but creates new execution ID)
   */
  static cloneContextForNewExecution(
    context: ExecutionContext,
    newExecutionId: string,
    newWorkflowId?: string,
  ): ExecutionContext {
    return {
      variables: { ...context.variables },
      nodeStates: {},
      executionId: newExecutionId,
      workflowId: newWorkflowId || context.workflowId,
      userId: context.userId,
      _subgraphDepth: context._subgraphDepth,
      _parentExecutionId: context._parentExecutionId,
      _subgraphChain: context._subgraphChain ? [...context._subgraphChain] : undefined,
    };
  }

  /**
   * Extract execution statistics from context
   */
  static getExecutionStats(context: ExecutionContext): {
    depth: number;
    isSubgraph: boolean;
    chainLength: number;
    hasParent: boolean;
    workflowId: string;
    executionId: string;
  } {
    return {
      depth: context._subgraphDepth || 0,
      isSubgraph: this.isSubgraphContext(context),
      chainLength: this.getWorkflowChain(context).length,
      hasParent: !!context._parentExecutionId,
      workflowId: context.workflowId,
      executionId: context.executionId,
    };
  }

  /**
   * Validate context has required subgraph fields
   */
  static validateSubgraphContext(context: ExecutionContext): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!context.executionId) {
      errors.push("ExecutionContext must have executionId");
    }

    if (!context.workflowId) {
      errors.push("ExecutionContext must have workflowId");
    }

    if (context._subgraphDepth !== undefined && context._subgraphDepth < 0) {
      errors.push("Subgraph depth cannot be negative");
    }

    if (context._subgraphDepth && context._subgraphDepth > 0 && !context._parentExecutionId) {
      errors.push("Subgraph context must have parent execution ID when depth > 0");
    }

    if (context._subgraphChain && context._subgraphChain.length === 0) {
      errors.push("Subgraph chain cannot be empty if defined");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Create minimal context for testing
   */
  static createTestContext(
    workflowId: string = "test-workflow",
    executionId: string = "test-execution",
    variables: Record<string, unknown> = {},
    userId: string = "test-user-123",
  ): ExecutionContext {
    return {
      variables,
      nodeStates: {},
      executionId,
      workflowId,
      userId,
      _subgraphDepth: 0,
      _parentExecutionId: undefined,
      _subgraphChain: [workflowId],
    };
  }

  /**
   * Create child context for testing
   */
  static createTestChildContext(
    parentContext: ExecutionContext,
    childWorkflowId: string = "child-workflow",
    childExecutionId: string = "child-execution",
    variables: Record<string, unknown> = {},
  ): ExecutionContext {
    const currentDepth = parentContext._subgraphDepth || 0;
    const currentChain = parentContext._subgraphChain || [parentContext.workflowId];

    return {
      variables,
      nodeStates: {},
      executionId: childExecutionId,
      workflowId: childWorkflowId,
      userId: parentContext.userId,
      _subgraphDepth: currentDepth + 1,
      _parentExecutionId: parentContext.executionId,
      _subgraphChain: [...currentChain, childWorkflowId],
    };
  }

  /**
   * Log context transition for debugging
   */
  static logContextTransition(
    fromContext: ExecutionContext,
    toContext: ExecutionContext,
    operation: string,
  ): void {
    this.logger.debug(`Context transition: ${operation}`, {
      from: this.getDebugInfo(fromContext),
      to: this.getDebugInfo(toContext),
      operation,
    });
  }

  /**
   * Compare two contexts for debugging
   */
  static compareContexts(
    context1: ExecutionContext,
    context2: ExecutionContext,
  ): {
    same: boolean;
    differences: string[];
  } {
    const differences: string[] = [];

    if (context1.executionId !== context2.executionId) {
      differences.push(`executionId: ${context1.executionId} vs ${context2.executionId}`);
    }

    if (context1.workflowId !== context2.workflowId) {
      differences.push(`workflowId: ${context1.workflowId} vs ${context2.workflowId}`);
    }

    if ((context1._subgraphDepth || 0) !== (context2._subgraphDepth || 0)) {
      differences.push(`depth: ${context1._subgraphDepth} vs ${context2._subgraphDepth}`);
    }

    if (context1._parentExecutionId !== context2._parentExecutionId) {
      differences.push(`parent: ${context1._parentExecutionId} vs ${context2._parentExecutionId}`);
    }

    const chain1 = JSON.stringify(context1._subgraphChain || []);
    const chain2 = JSON.stringify(context2._subgraphChain || []);
    if (chain1 !== chain2) {
      differences.push(`chain: ${chain1} vs ${chain2}`);
    }

    return {
      same: differences.length === 0,
      differences,
    };
  }
}
