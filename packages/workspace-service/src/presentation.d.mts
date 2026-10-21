import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { WorkspaceOwner } from "./owner.mjs";
export function executeOwnerTool(
  owner: WorkspaceOwner,
  call: { action: string; request: Record<string, unknown>; requestId?: string },
  options?: { signal?: AbortSignal; source?: AsyncIterable<Uint8Array> },
): Promise<CallToolResult>;
export function workspaceResult(data: Record<string, unknown>): CallToolResult;
export function workspaceFailure(error: unknown, requestId?: string): CallToolResult;
