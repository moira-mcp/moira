/**
 * MCP Request Context - User authentication context propagation
 * Uses AsyncLocalStorage for thread-safe context isolation
 * Integrates with shared logging context for request tracing
 */

import { AsyncLocalStorage } from "async_hooks";
import { runWithContextAsync, generateRequestId } from "@mcp-moira/shared";

export interface MCPRequestContext {
  userId: string;
  email?: string;
  /** Agent identifier for prompt override (e.g., "claude", "chatgpt") */
  agent?: string | null;
  /** Model identifier for prompt override (e.g., "claude-opus-4-5-20251101") */
  model?: string | null;
}

export const requestContext = new AsyncLocalStorage<MCPRequestContext>();

export function getUserContext(): MCPRequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    throw new Error("User context not available - authentication required");
  }
  return ctx;
}

/**
 * Run MCP request with both user context and logging context
 * Provides requestId and userId for all logs within the request
 * Also propagates agent/model for hierarchical prompt override resolution
 * Note: service is taken from global variable (set at process startup)
 */
export async function runWithMCPContext<T>(
  userContext: MCPRequestContext,
  fn: () => Promise<T>,
): Promise<T> {
  const requestId = generateRequestId();

  // Run with shared logging context (includes agent/model for prompt resolution)
  return runWithContextAsync(
    {
      requestId,
      userId: userContext.userId,
      startTime: Date.now(),
      // Propagate agent/model for hierarchical prompt resolution in workflow-engine
      agent: userContext.agent,
      model: userContext.model,
    },
    async () => {
      // Nested context: MCP user context inside logging context
      return requestContext.run(userContext, fn);
    },
  );
}
