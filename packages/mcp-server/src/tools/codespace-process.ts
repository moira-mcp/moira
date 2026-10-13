import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUserContext } from "../core/request-context.js";
import {
  codespaceToolLogContext,
  errorResult,
  getCodespaceToolServices,
  type CodespaceCall,
  type CodespaceToolServices,
} from "./manage-codespaces.js";
import {
  executeWorkspaceAction,
  readWorkspaceBytes,
  workspaceQuery,
  workspaceResult,
  workspaceFailure,
  workspaceCommandStatus,
} from "./codespace-workspace.js";
import {
  CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS,
  type CodespaceProcessAction,
} from "./tool-schemas.js";

type Params = {
  [A in CodespaceProcessAction]: z.infer<(typeof CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS)[A]>;
};
type ProcessCall = {
  [A in CodespaceProcessAction]: { action: A; request: Params[A] };
}[CodespaceProcessAction];
const actions = z.enum(["start", "get", "read", "stop"]);

export function codespaceProcessLogContext(params: unknown) {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  return codespaceToolLogContext({ ...record, request_id: record.process_id ?? record.request_id });
}

function parse(params: unknown): ProcessCall {
  const { action, ...request } = z.object({ action: actions }).passthrough().parse(params);
  return {
    action,
    request: CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS[action].parse(request),
  } as ProcessCall;
}

export async function executeCodespaceProcess(
  call: ProcessCall,
  userId: string,
  initial: CodespaceToolServices,
): Promise<CallToolResult> {
  const id = call.request.codespace_id;
  const client = initial.workspace;
  try {
    if (call.action === "start") {
      const result = await executeWorkspaceAction(
        { action: "exec", request: call.request } as CodespaceCall,
        userId,
        client,
        { background: true, attachments: initial.attachments },
      );
      return workspaceResult({ ...result.structuredContent, process_id: call.request.request_id });
    }
    const requestId =
      "request_id" in call.request ? call.request.request_id : call.request.process_id;
    if (call.action === "read") {
      const request = call.request;
      const response = await client.request(userId, id, {
        method: "GET",
        path: `/v1/operations/${requestId}/output?${workspaceQuery({ stream: request.stream, offset: request.offset, length: request.length })}`,
      });
      const bytes = await readWorkspaceBytes(response, request.length);
      return workspaceResult({
        process_id: requestId,
        stream: request.stream,
        offset: request.offset,
        total_bytes: Number(response.headers["x-moira-total-size"] ?? bytes.length),
        text: bytes.toString("utf8"),
      });
    }
    const data = await client.json(userId, id, {
      method: call.action === "stop" ? "POST" : "GET",
      path: `/v1/operations/${requestId}${call.action === "stop" ? "/cancel" : ""}`,
    });
    return workspaceResult({
      ...workspaceCommandStatus(data),
      process_id: requestId,
      request_id: requestId,
    });
  } catch (error) {
    const requestId =
      "request_id" in call.request
        ? call.request.request_id
        : "process_id" in call.request
          ? call.request.process_id
          : undefined;
    const failure = workspaceFailure(error, requestId);
    return workspaceResult({
      ...failure.structuredContent,
      ...(requestId ? { process_id: requestId } : {}),
    });
  }
}

export async function manageCodespaceProcess(params: unknown): Promise<CallToolResult> {
  const { userId } = getUserContext();
  let call: ProcessCall;
  try {
    call = parse(params);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return errorResult("CODESPACE_REQUEST_INVALID");
  }
  return executeCodespaceProcess(call, userId, await getCodespaceToolServices());
}
