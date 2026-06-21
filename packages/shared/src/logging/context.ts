/**
 * AsyncLocalStorage-based request context for logging
 * Provides requestId and userId propagation without prop drilling
 *
 * Service is stored globally (per process), not per request
 */

import { AsyncLocalStorage } from "async_hooks";
import { randomUUID } from "crypto";
import type { Service } from "./logger.js";

/**
 * Resource IDs extracted from input for structured logging
 * Fields matching *Id pattern are extracted here (not sanitized - they're IDs)
 */
export interface ResourceIds {
  workflowId?: string;
  executionId?: string;
  processId?: string;
  userId?: string;
  nodeId?: string;
  [key: string]: string | undefined;
}

/**
 * Request context stored in AsyncLocalStorage
 * Only per-request data - service is global
 */
export interface RequestContext {
  requestId: string;
  userId?: string;
  startTime: number;
  /** Operation identifier: "POST /api/workflows" | "mcp:start" | "step:execute" */
  operation?: string;
  /** Sanitized and truncated input data for error diagnostics */
  inputData?: unknown;
  /** Extracted resource IDs for structured logging */
  resourceIds?: ResourceIds;
  /** Agent identifier for prompt override (e.g., "claude", "chatgpt") */
  agent?: string | null;
  /** Model identifier for prompt override (e.g., "claude-opus-4-5-20251101") */
  model?: string | null;
}

// Global AsyncLocalStorage instance
const asyncLocalStorage = new AsyncLocalStorage<RequestContext>();

// Global service for this process (set once at startup)
let globalService: Service | undefined;

/**
 * Set the global service for this process
 * Called once at startup of mcp-server or web-backend
 */
export function setGlobalService(service: Service): void {
  globalService = service;
}

/**
 * Get the global service for this process
 */
export function getGlobalService(): Service | undefined {
  return globalService;
}

/**
 * Get audit source from global service
 * Maps service to audit source value
 */
export function getAuditSource(): "mcp" | "web" | undefined {
  if (globalService === "mcp-server") return "mcp";
  if (globalService === "web-backend") return "web";
  return undefined;
}

/**
 * Get current request context from AsyncLocalStorage
 * Returns undefined if not in a request context
 */
export function getRequestContext(): RequestContext | undefined {
  return asyncLocalStorage.getStore();
}

/**
 * Run a function within a request context
 * All code executed within the callback will have access to the context
 */
export function runWithContext<T>(context: Partial<RequestContext>, fn: () => T): T {
  const fullContext: RequestContext = {
    requestId: context.requestId || randomUUID(),
    userId: context.userId,
    startTime: context.startTime || Date.now(),
    // Include agent/model for hierarchical prompt override resolution
    agent: context.agent,
    model: context.model,
  };

  return asyncLocalStorage.run(fullContext, fn);
}

/**
 * Run an async function within a request context
 */
export async function runWithContextAsync<T>(
  context: Partial<RequestContext>,
  fn: () => Promise<T>,
): Promise<T> {
  const fullContext: RequestContext = {
    requestId: context.requestId || randomUUID(),
    userId: context.userId,
    startTime: context.startTime || Date.now(),
    // Include agent/model for hierarchical prompt override resolution
    agent: context.agent,
    model: context.model,
  };

  return asyncLocalStorage.run(fullContext, fn);
}

/**
 * Update the current context with additional fields
 * Only works if already inside a context
 */
export function updateContext(updates: Partial<RequestContext>): void {
  const current = asyncLocalStorage.getStore();
  if (current) {
    Object.assign(current, updates);
  }
}

/**
 * Generate a new request ID
 */
export function generateRequestId(): string {
  return randomUUID();
}
