import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import { CodespaceResourceError } from "@mcp-moira/shared";
import type { CodespaceCall } from "./manage-codespaces.js";

export interface WorkspaceToolClient {
  request(
    userId: string,
    resourceId: string,
    request: {
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: Uint8Array | AsyncIterable<Uint8Array>;
    },
    signal?: AbortSignal,
  ): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Readable }>;
  json(
    userId: string,
    resourceId: string,
    request: { method: string; path: string; body?: unknown },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export function workspaceResult(data: Record<string, unknown>): CallToolResult {
  const result = {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
  return data.error ||
    ["failed", "not_started", "timed_out", "interrupted"].includes(String(data.state))
    ? { ...result, isError: true }
    : result;
}

function refusal(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || !("error" in value)) return;
  const error = value.error;
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
  )
    return;
  const reason =
    "reason" in error &&
    typeof error.reason === "string" &&
    ["unsafe_access", "concurrent_change", "precondition"].includes(error.reason)
      ? error.reason
      : undefined;
  return {
    code: error.code,
    message: "The workspace refused this request.",
    ...(reason ? { reason } : {}),
  };
}

export function workspaceFailure(error: unknown, requestId?: string): CallToolResult {
  const known =
    error instanceof CodespaceResourceError
      ? { code: error.code, message: "The workspace request was refused." }
      : error && typeof error === "object" && "details" in error
        ? refusal(error.details)
        : undefined;
  return workspaceResult({
    error:
      (known &&
      !["WORKSPACE_OUTCOME_UNKNOWN", "WORKSPACE_OUTCOME_UNCONFIRMED"].includes(String(known.code))
        ? known
        : undefined) ??
      (requestId
        ? {
            code: "WORKSPACE_OUTCOME_UNCONFIRMED",
            message:
              "The request outcome is unconfirmed. Collect the original request ID before repeating a mutation.",
          }
        : {
            code: "WORKSPACE_UNAVAILABLE",
            message: "The workspace reply is unavailable. Retry this read after reconnecting.",
          }),
    ...(requestId ? { request_id: requestId } : {}),
  });
}

/** The cloud carries the final owner-produced payload without interpreting its contents. */
export async function executeWorkspaceAction(
  call: CodespaceCall | { action: string; request: Record<string, unknown> },
  userId: string,
  client: WorkspaceToolClient,
): Promise<CallToolResult> {
  const id = "codespace_id" in call.request ? call.request.codespace_id : undefined;
  if (typeof id !== "string")
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "This action requires a workspace",
    );
  try {
    return (await client.json(userId, id, {
      method: "POST",
      path: "/v1/tools",
      body: call,
    })) as unknown as CallToolResult;
  } catch (error) {
    const requestId =
      "request_id" in call.request
        ? call.request.request_id
        : "process_id" in call.request
          ? call.request.process_id
          : undefined;
    return workspaceFailure(error, typeof requestId === "string" ? requestId : undefined);
  }
}
