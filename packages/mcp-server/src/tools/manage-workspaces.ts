import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import {
  WorkspaceConnectionError,
  WorkspaceResourceError,
  createLogger,
  getBaseUrl,
  projectWorkspaceSummary,
  recordWorkspaceRejection,
  type WorkspaceObservabilityService,
  type WorkspaceConnectionService,
  type WorkspaceFileOperationResponse,
  type WorkspaceFileRequest,
  type WorkspaceFileService,
  type WorkspaceNativeFileReference,
  type WorkspaceOperationRecord,
  type WorkspaceOperationResponse,
  type WorkspaceOperationService,
  type WorkspaceResourceRecord,
  type WorkspaceResourceService,
} from "@mcp-moira/shared";
import { z } from "zod";
import { getUserContext } from "../core/request-context.js";
import {
  workspaceApplyPatchRequestSchema,
  workspaceCreateSchema,
  workspaceDeleteSchema,
  workspaceDownloadRequestSchema,
  workspaceExecRequestSchema,
  workspaceGetSchema,
  workspaceListSchema,
  workspaceNativeFileSchema,
  workspaceReadRequestSchema,
  workspaceSearchRequestSchema,
  workspaceStartSchema,
  workspaceStatRequestSchema,
  workspaceStopSchema,
  workspaceUploadRequestSchema,
  workspaceWriteRequestSchema,
  workspaceExpectedSchema,
} from "./tool-schemas.js";

export type WorkspaceToolName =
  | "workspace_create"
  | "workspace_list"
  | "workspace_get"
  | "workspace_start"
  | "workspace_stop"
  | "workspace_delete"
  | "workspace_exec"
  | "workspace_stat"
  | "workspace_search"
  | "workspace_read"
  | "workspace_write"
  | "workspace_apply_patch"
  | "workspace_upload"
  | "workspace_download";

export function workspaceToolLogContext(
  name: string,
  params: unknown,
): { inputData: { workspace_tool: string }; resourceIds: Record<string, string> } {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const resourceIds: Record<string, string> = {};
  const workspaceId = workspaceGetSchema.shape.workspace_id.safeParse(record.workspace_id);
  const operationId = workspaceGetSchema.shape.workspace_id.safeParse(record.operation_id);
  if (workspaceId.success) resourceIds.workspaceId = workspaceId.data;
  if (operationId.success) resourceIds.operationId = operationId.data;
  return { inputData: { workspace_tool: name }, resourceIds };
}

type WorkspaceToolParams = {
  workspace_create: z.infer<typeof workspaceCreateSchema>;
  workspace_list: z.infer<typeof workspaceListSchema>;
  workspace_get: z.infer<typeof workspaceGetSchema>;
  workspace_start: z.infer<typeof workspaceStartSchema>;
  workspace_stop: z.infer<typeof workspaceStopSchema>;
  workspace_delete: z.infer<typeof workspaceDeleteSchema>;
  workspace_exec: z.infer<typeof workspaceExecRequestSchema>;
  workspace_stat: z.infer<typeof workspaceStatRequestSchema>;
  workspace_search: z.infer<typeof workspaceSearchRequestSchema>;
  workspace_read: z.infer<typeof workspaceReadRequestSchema>;
  workspace_write: z.infer<typeof workspaceWriteRequestSchema>;
  workspace_apply_patch: z.infer<typeof workspaceApplyPatchRequestSchema>;
  workspace_upload: z.infer<typeof workspaceUploadRequestSchema>;
  workspace_download: z.infer<typeof workspaceDownloadRequestSchema>;
};

/**
 * Strict per-tool request contracts applied after the SDK validated the flat published
 * object: exactly one stdin form, a resume call carries only its identity, and a download
 * resume still names its bounded output metadata.
 */
const WORKSPACE_REQUEST_SCHEMAS: { [Name in WorkspaceToolName]: z.ZodTypeAny } = {
  workspace_create: workspaceCreateSchema,
  workspace_list: workspaceListSchema,
  workspace_get: workspaceGetSchema,
  workspace_start: workspaceStartSchema,
  workspace_stop: workspaceStopSchema,
  workspace_delete: workspaceDeleteSchema,
  workspace_exec: workspaceExecRequestSchema,
  workspace_stat: workspaceStatRequestSchema,
  workspace_search: workspaceSearchRequestSchema,
  workspace_read: workspaceReadRequestSchema,
  workspace_write: workspaceWriteRequestSchema,
  workspace_apply_patch: workspaceApplyPatchRequestSchema,
  workspace_upload: workspaceUploadRequestSchema,
  workspace_download: workspaceDownloadRequestSchema,
};

/** Narrow published workspace input to the exact request form; rejects mixed or partial forms. */
export function parseWorkspaceToolParams<Name extends WorkspaceToolName>(
  name: Name,
  params: unknown,
): WorkspaceToolParams[Name] {
  return WORKSPACE_REQUEST_SCHEMAS[name].parse(params) as WorkspaceToolParams[Name];
}

type WorkspaceNewToolParams<Name extends WorkspaceToolName> = Exclude<
  WorkspaceToolParams[Name],
  { operation_id: string }
>;

export interface WorkspaceToolServices {
  connection: Pick<WorkspaceConnectionService, "getStatus">;
  observability: Pick<WorkspaceObservabilityService, "readiness">;
  resource: Pick<
    WorkspaceResourceService,
    | "listRepositories"
    | "listResources"
    | "getWorkspace"
    | "create"
    | "startWorkspace"
    | "stopWorkspace"
    | "deleteWorkspace"
  > | null;
  operation: Pick<
    WorkspaceOperationService,
    "execute" | "executeNativeReference" | "get" | "reconcile"
  > | null;
  file: Pick<
    WorkspaceFileService,
    "execute" | "uploadReference" | "downloadReference" | "reconcile" | "reconcileDownloadReference"
  > | null;
}

const PROVIDER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "WORKSPACE_AUTHORIZATION_REQUIRED",
  "WORKSPACE_PROVIDER_UNAVAILABLE",
  "WORKSPACE_RESOURCE_INVALID",
]);

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  CONNECTION_REQUIRED: "Connect GitHub in Moira Settings before using cloud workspaces.",
  INSTALLATION_REQUIRED: "Complete the GitHub App installation in Moira Settings.",
  REPOSITORY_NOT_ALLOWED: "The repository is not approved for this connection.",
  WORKSPACE_NOT_CONFIGURED: "Cloud workspaces are not configured on this Moira instance.",
  AUTH_REFRESH_FAILED: "GitHub authorization must be repaired in Moira Settings.",
  AUTH_GRANT_REVOCATION_REQUIRED: "Revoke and reconnect the GitHub grant in Moira Settings.",
  CREDENTIAL_UNREADABLE: "Restore or reconnect the GitHub credential in Moira Settings.",
  AUTHORIZATION_FAILED: "GitHub authorization could not be used.",
  WORKSPACE_PROVIDER_DISABLED: "Cloud workspace operations are disabled.",
  WORKSPACE_PROVIDER_UNAVAILABLE: "The cloud workspace provider is unavailable.",
  WORKSPACE_POLICY_LIMIT: "A workspace quota, concurrency, size or time limit was reached.",
  WORKSPACE_OPERATION_BUSY:
    "Workspace operation capacity is busy; wait for pending operations before retrying.",
  WORKSPACE_RESULT_EXPIRED:
    "The retained operation result has expired. Do not repeat a mutation without inspecting the workspace first.",
  WORKSPACE_AUTHORIZATION_REQUIRED: "Restore workspace repository access in Moira Settings.",
  WORKSPACE_CREATE_REJECTED: "Workspace creation was rejected.",
  WORKSPACE_CREATE_PENDING: "Workspace creation or cleanup is still pending.",
  WORKSPACE_NOT_RUNNING: "The workspace is not ready and running.",
  WORKSPACE_GENERATION_CONFLICT:
    "The workspace or its authorization changed; refresh workspace state before continuing.",
  WORKSPACE_RESOURCE_INVALID: "The workspace input or current authorization is invalid.",
  WORKSPACE_NOT_FOUND: "Workspace was not found.",
  WORKSPACE_BINARY_READ_REQUIRES_DOWNLOAD:
    "The requested range is not UTF-8 text; use workspace_download for binary bytes.",
  WORKSPACE_OPERATION_PENDING: "The workspace operation has not reached a terminal result.",
  WORKSPACE_OPERATION_FAILED: "The workspace command failed; inspect its output and exit code.",
  WORKSPACE_OPERATION_CANCELLED: "The workspace operation was cancelled.",
  WORKSPACE_OPERATION_TIMED_OUT: "The workspace operation reached its execution deadline.",
  WORKSPACE_FILE_REJECTED:
    "The file operation was rejected; inspect the path and file preconditions before retrying.",
  INTERNAL_ERROR: "The workspace operation failed safely.",
};

const SETUP_ERROR_CODES = new Set([
  "CONNECTION_REQUIRED",
  "INSTALLATION_REQUIRED",
  "WORKSPACE_NOT_CONFIGURED",
  "AUTH_REFRESH_FAILED",
  "AUTH_GRANT_REVOCATION_REQUIRED",
  "CREDENTIAL_UNREADABLE",
  "AUTHORIZATION_FAILED",
  "REPOSITORY_NOT_ALLOWED",
  "WORKSPACE_AUTHORIZATION_REQUIRED",
]);

class BinaryWorkspaceReadError extends Error {}

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(code: string, settingsUrl?: string, retryable = false): CallToolResult {
  const error = {
    code,
    message: SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.INTERNAL_ERROR,
    retryable,
    ...(settingsUrl && SETUP_ERROR_CODES.has(code) ? { settings_url: settingsUrl } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error },
    isError: true,
  };
}

function projectWorkspace(workspace: WorkspaceResourceRecord): Record<string, unknown> {
  return { ...projectWorkspaceSummary(workspace) };
}

function projectOperation(response: WorkspaceOperationResponse | WorkspaceFileOperationResponse) {
  const { operation } = response;
  return {
    operation_id: operation.id,
    workspace_id: operation.resourceId,
    kind: operation.kind,
    state: operation.state,
    input_bytes: operation.inputBytes,
    output_bytes: operation.outputBytes,
    exit_code: operation.exitCode,
    deadline_at: operation.deadlineAt,
    result_expires_at: operation.resultExpiresAt,
  };
}

function projectExecResult(result: NonNullable<WorkspaceOperationResponse["result"]>) {
  return {
    state: result.state,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
  };
}

function operationResult(
  operation: ReturnType<typeof projectOperation>,
  result: Record<string, unknown> | null,
  projectionError?: string,
): CallToolResult {
  const code =
    projectionError ??
    (operation.state === "failed"
      ? operation.kind === "exec"
        ? "WORKSPACE_OPERATION_FAILED"
        : "WORKSPACE_FILE_REJECTED"
      : operation.state === "cancelled"
        ? "WORKSPACE_OPERATION_CANCELLED"
        : operation.state === "timed_out"
          ? "WORKSPACE_OPERATION_TIMED_OUT"
          : undefined);
  const response = jsonResult({
    operation,
    result,
    ...(code ? { error: { code, message: SAFE_ERROR_MESSAGES[code], retryable: false } } : {}),
  });
  return code ? { ...response, isError: true } : response;
}

function fileOperationResult(response: WorkspaceFileOperationResponse): CallToolResult {
  const operation = projectOperation(response);
  try {
    return operationResult(operation, response.result ? projectFileResult(response.result) : null);
  } catch (error) {
    if (error instanceof BinaryWorkspaceReadError) {
      return operationResult(operation, null, "WORKSPACE_BINARY_READ_REQUIRES_DOWNLOAD");
    }
    throw error;
  }
}

function projectVersion(version: { size: number; sha256: string; modifiedAt: number } | null) {
  return version
    ? { size_bytes: version.size, sha256: version.sha256, modified_at: version.modifiedAt }
    : null;
}

function projectFileResult(result: NonNullable<WorkspaceFileOperationResponse["result"]>) {
  if ("state" in result) return { action: result.action, state: result.state, code: result.code };
  switch (result.action) {
    case "stat":
      return {
        action: result.action,
        stat: {
          path: result.stat.path,
          type: result.stat.type,
          size_bytes: result.stat.size,
          mode: result.stat.mode,
          modified_at: result.stat.modifiedAt,
          version: projectVersion(result.stat.version),
        },
      };
    case "search":
      return {
        action: result.action,
        matches: result.matches,
        truncated: result.truncated,
      };
    case "write":
    case "upload":
      return {
        action: result.action,
        path: result.path,
        previous: projectVersion(result.previous),
        current: projectVersion(result.current),
      };
    case "apply_patch":
      return {
        action: result.action,
        files: result.files.map((file) => ({
          path: file.path,
          previous: projectVersion(file.previous),
          current: projectVersion(file.current),
        })),
        summary: {
          files_changed: result.summary.filesChanged,
          edits_applied: result.summary.editsApplied,
          inserted_bytes: result.summary.insertedBytes,
          deleted_bytes: result.summary.deletedBytes,
          entries: result.summary.entries.map((entry) => ({
            path: entry.path,
            edits: entry.edits,
            inserted_bytes: entry.insertedBytes,
            deleted_bytes: entry.deletedBytes,
          })),
          truncated: result.summary.truncated,
        },
      };
    case "read": {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      } catch {
        throw new BinaryWorkspaceReadError();
      }
      return {
        action: result.action,
        path: result.path,
        offset: result.offset,
        total_size: result.totalSize,
        sha256: result.sha256,
        text,
      };
    }
    case "download":
      throw new Error("Download bytes must be projected as a resource link");
  }
}

function publicNativeReference(
  file: z.infer<typeof workspaceNativeFileSchema>,
): WorkspaceNativeFileReference {
  return {
    fileId: file.file_id,
    downloadUrl: file.download_url,
    fileName: file.file_name,
    mimeType: file.mime_type,
    declaredSize: file.size_bytes,
  };
}

function publicExpected(expected: z.infer<typeof workspaceExpectedSchema>) {
  return {
    exists: expected.exists,
    ...(expected.size_bytes !== undefined ? { size: expected.size_bytes } : {}),
    ...(expected.sha256 !== undefined ? { sha256: expected.sha256 } : {}),
  };
}

async function loadServices(): Promise<WorkspaceToolServices> {
  const services = await import("@mcp-moira/web-backend/services");
  return {
    connection: services.getWorkspaceConnectionService(),
    observability: services.getWorkspaceObservabilityService(),
    resource: services.getWorkspaceResourceService(),
    operation: services.getWorkspaceOperationService(),
    file: services.getWorkspaceFileService(),
  };
}

type WorkspaceToolServicesLoader = () => Promise<WorkspaceToolServices>;
let workspaceToolServicesLoader: WorkspaceToolServicesLoader = loadServices;

export function setWorkspaceToolServicesLoaderForTests(
  loader: WorkspaceToolServicesLoader,
): () => void {
  const previous = workspaceToolServicesLoader;
  workspaceToolServicesLoader = loader;
  return () => {
    if (workspaceToolServicesLoader === loader) workspaceToolServicesLoader = previous;
  };
}

const logger = createLogger({ component: "ManageWorkspaces" });

// Unexpected failures must stay diagnosable server-side. The request context already carries
// the tool name and opaque workspace/operation IDs; no agent input is added here.
type WorkspaceToolFailureReporter = (name: WorkspaceToolName, error: unknown) => void;
let reportUnexpectedFailure: WorkspaceToolFailureReporter = (name, error) => {
  logger.error("Workspace tool failed unexpectedly", error, { workspace_tool: name });
};

export function setWorkspaceToolFailureReporterForTests(
  reporter: WorkspaceToolFailureReporter,
): () => void {
  const previous = reportUnexpectedFailure;
  reportUnexpectedFailure = reporter;
  return () => {
    if (reportUnexpectedFailure === reporter) reportUnexpectedFailure = previous;
  };
}

function requireReady(
  status: ReturnType<WorkspaceConnectionService["getStatus"]>,
): { settingsUrl: string } | CallToolResult {
  if (status.state !== "connected") {
    const authorizationCode = [
      "AUTH_REFRESH_FAILED",
      "AUTH_GRANT_REVOCATION_REQUIRED",
      "CREDENTIAL_UNREADABLE",
      "AUTHORIZATION_FAILED",
    ].includes(status.reason ?? "")
      ? status.reason!
      : "AUTH_REFRESH_FAILED";
    const code =
      status.state === "installation_required"
        ? "INSTALLATION_REQUIRED"
        : status.state === "refresh_failed" || status.state === "revocation_pending"
          ? authorizationCode
          : status.state === "disabled" || status.state === "configuration_error"
            ? "WORKSPACE_NOT_CONFIGURED"
            : "CONNECTION_REQUIRED";
    return errorResult(code, status.settingsUrl, true);
  }
  return { settingsUrl: status.settingsUrl };
}

function isErrorResult(value: { settingsUrl: string } | CallToolResult): value is CallToolResult {
  return "content" in value;
}

function resourceLinkResult(
  operation: ReturnType<typeof projectOperation>,
  transfer: {
    referenceId: string;
    fileName: string;
    mimeType: string;
    size: number;
    sha256: string;
    expiresAt: number;
  },
): CallToolResult {
  const prefix = "workspace-file://";
  if (!transfer.referenceId.startsWith(prefix)) throw new Error("Invalid transfer handle");
  const token = transfer.referenceId.slice(prefix.length);
  const uri = `${getBaseUrl()}/api/workspaces/transfers/${encodeURIComponent(token)}`;
  const link: ResourceLink = {
    type: "resource_link",
    uri,
    name: transfer.fileName,
    description: "One-use private workspace download; the link expires automatically.",
    mimeType: transfer.mimeType,
    size: transfer.size,
  };
  const structuredContent = {
    operation,
    file: {
      name: transfer.fileName,
      mime_type: transfer.mimeType,
      size_bytes: transfer.size,
      sha256: transfer.sha256,
      expires_at: transfer.expiresAt,
    },
  };
  return { content: [link], structuredContent };
}

export async function executeWorkspaceTool<Name extends WorkspaceToolName>(
  name: Name,
  params: WorkspaceToolParams[Name],
  userId: string,
  services: WorkspaceToolServices,
): Promise<CallToolResult> {
  let status: ReturnType<WorkspaceConnectionService["getStatus"]>;
  try {
    status = services.connection.getStatus(userId);
  } catch (error) {
    reportUnexpectedFailure(name, error);
    return errorResult("INTERNAL_ERROR");
  }
  try {
    if (name === "workspace_list") {
      const instance = await services.observability.readiness();
      return jsonResult({
        readiness: {
          state: status.state,
          reason: status.reason,
          settings_url: status.settingsUrl,
        },
        instance: {
          state: instance.state,
          reason: instance.reason,
          provider: instance.provider,
          connector: instance.connector.state,
        },
        repositories:
          services.resource?.listRepositories(userId).map((repository) => ({
            repository_id: repository.id,
            name: repository.fullName,
            private: repository.private,
          })) ?? [],
        workspaces: services.resource?.listResources(userId).map(projectWorkspace) ?? [],
      });
    }

    if (name === "workspace_get") {
      if (!services.resource) return errorResult("WORKSPACE_NOT_CONFIGURED", status.settingsUrl);
      const input = params as WorkspaceToolParams["workspace_get"];
      return jsonResult({
        workspace: projectWorkspace(services.resource.getWorkspace(userId, input.workspace_id)),
      });
    }

    const ready = requireReady(status);
    if (isErrorResult(ready)) return ready;
    if (!services.resource || !services.operation || !services.file) {
      return errorResult("WORKSPACE_NOT_CONFIGURED", ready.settingsUrl);
    }

    if ("operation_id" in params) {
      const resumableKind: Partial<Record<WorkspaceToolName, WorkspaceOperationRecord["kind"]>> = {
        workspace_exec: "exec",
        workspace_stat: "stat",
        workspace_search: "search",
        workspace_read: "read",
        workspace_write: "write",
        workspace_apply_patch: "apply_patch",
        workspace_upload: "upload",
        workspace_download: "download",
      };
      const expectedKind = resumableKind[name];
      const existing = services.operation.get(userId, params.operation_id);
      if (
        !expectedKind ||
        !existing ||
        existing.resourceId !== params.workspace_id ||
        existing.kind !== expectedKind
      ) {
        return errorResult("WORKSPACE_NOT_FOUND");
      }
      if (name === "workspace_download") {
        const input = params as Extract<
          WorkspaceToolParams["workspace_download"],
          { operation_id: string }
        >;
        const response = await services.file.reconcileDownloadReference(
          userId,
          input.operation_id,
          {
            fileName: input.file_name,
            mimeType: input.mime_type,
          },
        );
        const operation = projectOperation({ operation: response.operation, result: null });
        return response.transfer
          ? resourceLinkResult(operation, response.transfer)
          : operationResult(operation, null);
      }
      if (name === "workspace_exec") {
        const result = await services.operation.reconcile(userId, params.operation_id);
        const operation = services.operation.get(userId, params.operation_id);
        if (!operation) return errorResult("WORKSPACE_NOT_FOUND");
        return operationResult(
          projectOperation({ operation, result }),
          result ? projectExecResult(result) : null,
        );
      }
      const response = await services.file.reconcile(userId, params.operation_id);
      return fileOperationResult(response);
    }

    switch (name) {
      case "workspace_create": {
        const input = params as WorkspaceToolParams["workspace_create"];
        const created = await services.resource.create(userId, input.repository_id, input.ref);
        return jsonResult({ workspace: projectWorkspace(created.resource) });
      }
      case "workspace_start": {
        const input = params as WorkspaceToolParams["workspace_start"];
        return jsonResult({
          workspace: projectWorkspace(
            await services.resource.startWorkspace(userId, input.workspace_id),
          ),
        });
      }
      case "workspace_stop": {
        const input = params as WorkspaceToolParams["workspace_stop"];
        return jsonResult({
          workspace: projectWorkspace(
            await services.resource.stopWorkspace(userId, input.workspace_id),
          ),
          data_preserved: true,
        });
      }
      case "workspace_delete": {
        const input = params as WorkspaceToolParams["workspace_delete"];
        return jsonResult({
          workspace: projectWorkspace(
            await services.resource.deleteWorkspace(
              userId,
              input.workspace_id,
              input.expected_generation,
            ),
          ),
          data_preserved: false,
        });
      }
      case "workspace_exec": {
        const input = params as WorkspaceNewToolParams<"workspace_exec">;
        const request = {
          argv: input.argv,
          cwd: input.cwd,
          timeoutMs: input.timeout_seconds * 1000,
          ...(input.max_stdout_bytes !== undefined
            ? { maxStdoutBytes: input.max_stdout_bytes }
            : {}),
          ...(input.max_stderr_bytes !== undefined
            ? { maxStderrBytes: input.max_stderr_bytes }
            : {}),
        };
        const response =
          "stdin_file" in input
            ? await services.operation.executeNativeReference(
                userId,
                input.workspace_id,
                request,
                publicNativeReference(input.stdin_file),
              )
            : await services.operation.execute(userId, input.workspace_id, {
                ...request,
                stdin: {
                  kind: "inline",
                  bytes: Buffer.from(input.stdin_text ?? "", "utf8"),
                },
              });
        return operationResult(
          projectOperation(response),
          response.result ? projectExecResult(response.result) : null,
        );
      }
      case "workspace_stat":
      case "workspace_search":
      case "workspace_read":
      case "workspace_write":
      case "workspace_apply_patch": {
        const request: WorkspaceFileRequest =
          name === "workspace_stat"
            ? {
                action: "stat",
                path: (params as WorkspaceNewToolParams<"workspace_stat">).path,
              }
            : name === "workspace_search"
              ? {
                  action: "search",
                  path: (params as WorkspaceNewToolParams<"workspace_search">).path,
                  query: (params as WorkspaceNewToolParams<"workspace_search">).query,
                  mode: (params as WorkspaceNewToolParams<"workspace_search">).mode,
                  maxMatches: (params as WorkspaceNewToolParams<"workspace_search">).max_matches,
                  maxBytes: (params as WorkspaceNewToolParams<"workspace_search">).max_bytes,
                }
              : name === "workspace_read"
                ? {
                    action: "read",
                    path: (params as WorkspaceNewToolParams<"workspace_read">).path,
                    offset: (params as WorkspaceNewToolParams<"workspace_read">).offset,
                    length: (params as WorkspaceNewToolParams<"workspace_read">).length,
                  }
                : name === "workspace_write"
                  ? {
                      action: "write",
                      path: (params as WorkspaceNewToolParams<"workspace_write">).path,
                      bytes: Buffer.from(
                        (params as WorkspaceNewToolParams<"workspace_write">).text,
                        "utf8",
                      ),
                      expected: publicExpected(
                        (params as WorkspaceNewToolParams<"workspace_write">).expected,
                      ),
                    }
                  : {
                      action: "apply_patch",
                      files: (params as WorkspaceNewToolParams<"workspace_apply_patch">).files.map(
                        (file) => ({
                          path: file.path,
                          expected: publicExpected(file.expected),
                          edits: file.edits.map((edit) => ({
                            start: edit.start,
                            end: edit.end,
                            bytes: Buffer.from(edit.text, "utf8"),
                          })),
                        }),
                      ),
                    };
        const workspaceId = (params as { workspace_id: string }).workspace_id;
        const response = await services.file.execute(userId, workspaceId, request);
        return fileOperationResult(response);
      }
      case "workspace_upload": {
        const input = params as WorkspaceNewToolParams<"workspace_upload">;
        const response = await services.file.uploadReference(userId, input.workspace_id, {
          path: input.path,
          reference: publicNativeReference(input.file),
          expected: publicExpected(input.expected),
        });
        return fileOperationResult(response);
      }
      case "workspace_download": {
        const input = params as WorkspaceNewToolParams<"workspace_download">;
        const response = await services.file.downloadReference(userId, input.workspace_id, {
          path: input.path,
          maxBytes: input.max_bytes,
          fileName: input.file_name,
          mimeType: input.mime_type,
        });
        const operation = projectOperation({ operation: response.operation, result: null });
        return response.transfer
          ? resourceLinkResult(operation, response.transfer)
          : operationResult(operation, null);
      }
      case "workspace_list":
      case "workspace_get":
        throw new Error("Workspace tool was routed twice");
    }
  } catch (error) {
    if (error instanceof WorkspaceConnectionError || error instanceof WorkspaceResourceError) {
      recordWorkspaceRejection(error.code);
      if (PROVIDER_REFUSAL_CODES.has(error.code)) {
        // The bounded internal message names only the provider's HTTP status; operators need
        // it to tell a permission gap from an outage, while the agent sees the safe code.
        logger.warn("Workspace provider refused the request", {
          workspace_tool: name,
          code: error.code,
          detail: error.message,
        });
      }
      return errorResult(
        error.code,
        SETUP_ERROR_CODES.has(error.code) ? status.settingsUrl : undefined,
        [
          "WORKSPACE_PROVIDER_UNAVAILABLE",
          "WORKSPACE_POLICY_LIMIT",
          "WORKSPACE_OPERATION_BUSY",
          "WORKSPACE_CREATE_PENDING",
          "WORKSPACE_NOT_RUNNING",
        ].includes(error.code),
      );
    }
    reportUnexpectedFailure(name, error);
    return errorResult("INTERNAL_ERROR");
  }
}

export async function manageWorkspaceTool<Name extends WorkspaceToolName>(
  name: Name,
  params: unknown,
): Promise<CallToolResult> {
  const { userId } = getUserContext();
  return executeWorkspaceTool(
    name,
    parseWorkspaceToolParams(name, params),
    userId,
    await workspaceToolServicesLoader(),
  );
}
