import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export function executeOwnerTool(
  socketPath: string,
  call: { action: string; request: Record<string, unknown> },
): Promise<CallToolResult>;
export function workspaceResult(data: Record<string, unknown>): CallToolResult;
export function workspaceFailure(error: unknown, requestId?: string): CallToolResult;
