import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { getUserContext } from "../core/request-context.js";
import {
  codespaceToolLogContext,
  errorResult,
  getCodespaceToolServices,
  type CodespaceToolServices,
} from "./manage-codespaces.js";
import { executeWorkspaceAction } from "./codespace-workspace.js";
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
  return executeWorkspaceAction(
    { action: `process_${call.action}`, request: call.request },
    userId,
    initial.workspace,
  );
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
