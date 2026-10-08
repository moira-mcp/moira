import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  CodespaceConnectionError,
  CodespaceResourceError,
  createLogger,
  recordCodespaceRejection,
  type CodespaceExecRequest,
  type CodespaceOperationRecord,
  type CodespaceOperationResponse,
} from "@mcp-moira/shared";
import { z } from "zod";
import { getUserContext } from "../core/request-context.js";
import {
  codespaceToolLogContext,
  errorResult,
  getCodespaceToolServices,
  projectExecResult,
  type CodespaceToolServices,
} from "./manage-codespaces.js";
import {
  CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS,
  type CodespaceProcessAction,
} from "./tool-schemas.js";

type ProcessParams = {
  [Action in CodespaceProcessAction]: z.infer<
    (typeof CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS)[Action]
  >;
};
type ProcessCall = {
  [Action in CodespaceProcessAction]: { action: Action; request: ProcessParams[Action] };
}[CodespaceProcessAction];
const actions = z.enum(["start", "get", "read", "stop"]);
const logger = createLogger({ component: "CodespaceProcess" });

function result(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

export function codespaceProcessLogContext(params: unknown) {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  // The existing opaque projection discards all command, stdin, environment and file fields.
  return codespaceToolLogContext({ ...record, operation_id: record.process_id });
}

function parse(params: unknown): ProcessCall {
  const { action, ...request } = z.object({ action: actions }).passthrough().parse(params);
  return {
    action,
    request: CODESPACE_PROCESS_ACTION_REQUEST_SCHEMAS[action].parse(request),
  } as ProcessCall;
}

function project(response: CodespaceOperationResponse): CallToolResult {
  const operation = response.operation;
  const state =
    operation.state === "reserved"
      ? "starting"
      : operation.state === "cancel_pending"
        ? "stopping"
        : operation.state === "reconcile_pending"
          ? "unknown"
          : operation.state;
  const data = {
    process_id: operation.id,
    state,
    ...(response.result
      ? projectExecResult(response.result)
      : operation.exitCode !== null
        ? { exit_code: operation.exitCode }
        : {}),
    ...(operation.lastOutcome === "codespace_restarted" ? { interrupted_by_restart: true } : {}),
  };
  return result(data);
}

function requireOwnedProcess(
  services: CodespaceToolServices,
  userId: string,
  request: ProcessParams["get"],
): CodespaceOperationRecord {
  const operation = services.operation?.get(userId, request.process_id);
  if (!operation || operation.resourceId !== request.codespace_id || operation.kind !== "exec")
    throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Background process was not found");
  return operation;
}

export async function executeCodespaceProcess(
  call: ProcessCall,
  userId: string,
  services: CodespaceToolServices,
): Promise<CallToolResult> {
  try {
    if (services.select)
      services = services.select(userId, { codespaceId: call.request.codespace_id });
    const operation = services.operation;
    if (!operation)
      return errorResult(
        "CODESPACE_NOT_CONFIGURED",
        services.connection.getStatus(userId).settingsUrl,
      );
    if (call.action === "start") {
      const input = call.request;
      const request = {
        ...(input.argv !== undefined ? { argv: input.argv } : {}),
        ...(input.script !== undefined ? { script: input.script } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
        ...(input.env !== undefined ? { env: input.env } : {}),
        ...(input.session !== undefined
          ? {
              session: input.session,
              sessionStart: input.session_start,
              sessionEnd: input.session_end,
            }
          : {}),
        ...(input.timeout_seconds !== undefined ? { timeoutMs: input.timeout_seconds * 1000 } : {}),
        ...(input.max_stdout_bytes !== undefined ? { maxStdoutBytes: input.max_stdout_bytes } : {}),
        ...(input.max_stderr_bytes !== undefined ? { maxStderrBytes: input.max_stderr_bytes } : {}),
        background: true,
      } satisfies Omit<CodespaceExecRequest, "stdin">;
      const response =
        "stdin_file" in input
          ? await operation.executeNativeReference(userId, input.codespace_id, request, {
              fileId: input.stdin_file.file_id,
              downloadUrl: input.stdin_file.download_url,
              fileName: input.stdin_file.file_name,
              mimeType: input.stdin_file.mime_type,
              declaredSize: input.stdin_file.size_bytes,
            })
          : await operation.execute(userId, input.codespace_id, {
              ...request,
              stdin: { kind: "inline", bytes: Buffer.from(input.stdin_text ?? "", "utf8") },
            });
      return project(response);
    }
    requireOwnedProcess(services, userId, call.request);
    if (call.action === "read") {
      const input = call.request;
      const output = await operation.readOutput(userId, input.process_id, {
        stream: input.stream,
        offset: input.offset,
        length: input.length,
      });
      return result({
        process_id: input.process_id,
        stream: output.stream,
        offset: output.offset,
        total_bytes: output.totalBytes,
        text: output.bytes.toString("utf8"),
      });
    }
    if (call.action === "stop")
      return project(await operation.cancel(userId, call.request.process_id));
    const completed = await operation.reconcile(userId, call.request.process_id);
    const current = requireOwnedProcess(services, userId, call.request);
    return project({ operation: current, result: completed });
  } catch (error) {
    if (error instanceof CodespaceResourceError || error instanceof CodespaceConnectionError) {
      const failure = errorResult(
        error.code,
        undefined,
        false,
        error instanceof CodespaceResourceError ? error.detail : undefined,
      );
      return error instanceof CodespaceResourceError && error.operationId
        ? {
            ...result({ ...failure.structuredContent, process_id: error.operationId }),
            isError: true,
          }
        : failure;
    }
    logger.error("Codespace process failed unexpectedly", error, { codespace_action: call.action });
    return errorResult("INTERNAL_ERROR");
  }
}

export async function manageCodespaceProcess(params: unknown): Promise<CallToolResult> {
  const { userId } = getUserContext();
  let call: ProcessCall;
  try {
    call = parse(params);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    recordCodespaceRejection("CODESPACE_REQUEST_INVALID");
    return errorResult("CODESPACE_REQUEST_INVALID");
  }
  return executeCodespaceProcess(call, userId, await getCodespaceToolServices());
}
