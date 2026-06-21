/**
 * Tool Registry for centralized tool management
 * Implements centralized system as specified in development plan milestone 1.2
 */

import { MoiraTool, ToolResult } from "./interfaces/tool-interface.js";
import { ERRORS } from "../messages/index.js";
import { mcpToolCallsTotal } from "@mcp-moira/shared";

export class ToolRegistry {
  private tools = new Map<string, MoiraTool>();

  /**
   * Register a tool in the registry
   */
  register<T extends MoiraTool>(tool: T): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Execute a tool by name with parameters
   */

  async execute<TParams, _TResult>(
    toolName: string,
    params: TParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<ToolResult<any>> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      mcpToolCallsTotal.inc({ tool: toolName, status: "not_found" });
      return {
        success: false,
        error: ERRORS.tool_not_found(toolName),
      };
    }

    try {
      const result = await tool.execute(params);
      mcpToolCallsTotal.inc({ tool: toolName, status: result.success ? "success" : "error" });
      return result;
    } catch (error) {
      mcpToolCallsTotal.inc({ tool: toolName, status: "exception" });
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get all registered tool names
   */
  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Get tool by name
   */
  getTool(name: string): MoiraTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Check if tool is registered
   */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Clear all tools
   */
  clear(): void {
    this.tools.clear();
  }
}

// Export singleton instance
export const toolRegistry = new ToolRegistry();
