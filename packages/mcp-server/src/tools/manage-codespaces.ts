import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import {
  CodespaceConnectionError,
  CodespaceResourceError,
  createLogger,
  getBaseUrl,
  projectCodespaceSummary,
  recordCodespaceRejection,
  type CodespaceObservabilityService,
  type CodespaceConnectionService,
  type CodespaceFileOperationResponse,
  type CodespaceFileRequest,
  type CodespaceFileService,
  type CodespaceNativeFileReference,
  type CodespaceGuidanceSituation,
  type CodespaceProviderGuidance,
  type CodespaceOperationRecord,
  type CodespaceOperationResponse,
  type CodespaceOperationService,
  type CodespaceResourceRecord,
  type CodespaceResourceService,
} from "@mcp-moira/shared";
import { z } from "zod";
import { getUserContext } from "../core/request-context.js";
import {
  codespaceGetSchema,
  codespaceNativeFileSchema,
  codespaceExpectedSchema,
  CODESPACE_ACTIONS,
  CODESPACE_ACTION_REQUEST_SCHEMAS,
  type CodespaceAction,
} from "./tool-schemas.js";

/**
 * Log context for the one codespace tool. The operation a call performs is its `action`, so that is
 * what the record names; an absent or non-string action reads as `unknown` rather than being
 * guessed, because the log is written before the action is validated.
 */
export function codespaceToolLogContext(params: unknown): {
  inputData: { codespace_action: string };
  resourceIds: Record<string, string>;
} {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const resourceIds: Record<string, string> = {};
  const codespaceId = codespaceGetSchema.shape.codespace_id.safeParse(record.codespace_id);
  const operationId = codespaceGetSchema.shape.codespace_id.safeParse(record.operation_id);
  if (codespaceId.success) resourceIds.codespaceId = codespaceId.data;
  if (operationId.success) resourceIds.operationId = operationId.data;
  const action = CODESPACE_ACTION_SCHEMA.safeParse(record.action);
  return { inputData: { codespace_action: action.success ? action.data : "unknown" }, resourceIds };
}

type CodespaceToolParams = {
  [Action in CodespaceAction]: z.infer<(typeof CODESPACE_ACTION_REQUEST_SCHEMAS)[Action]>;
};

/**
 * Strict per-action request contracts applied after the SDK validated the flat published object:
 * exactly one stdin form, a resume call carries only its identity, and a download resume still names
 * its bounded output metadata. The published object accepts every action's fields, so this is what
 * refuses a field belonging to a different action than the one requested.
 */
const CODESPACE_ACTION_SCHEMA = z.enum(CODESPACE_ACTIONS);

/**
 * Published input that matches no strict request form. The bounded detail names only schema
 * field paths and Zod's generic issue text, never the submitted values.
 */
export class CodespaceRequestInvalidError extends Error {
  constructor(readonly detail: string) {
    super(`Invalid codespace request: ${detail}`);
    this.name = "CodespaceRequestInvalidError";
  }
}

const MAX_REPORTED_ISSUES = 8;

function describeRequestIssues(error: z.ZodError): string {
  // A union failure reports the branch that came closest so the agent sees the field it
  // actually forgot rather than every alternative form.
  const closest = (issues: z.ZodIssue[]): z.ZodIssue[] =>
    issues.flatMap((issue) =>
      issue.code === "invalid_union"
        ? closest(
            issue.unionErrors
              .map((branch) => branch.issues)
              .reduce((best, branch) => (branch.length < best.length ? branch : best)),
          )
        : [issue],
    );
  const issues = closest(error.issues);
  const described = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map(
      (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "request"}: ${issue.message}`,
    );
  if (issues.length > MAX_REPORTED_ISSUES) described.push("…");
  return described.join("; ");
}

/**
 * Narrow published codespace input to the exact request form of its action; rejects an unknown
 * action and any mixed or partial form. `action` selects the contract and is not part of it, so it
 * is removed before the action's own schema sees the request.
 */
export function parseCodespaceToolParams(params: unknown): CodespaceCall {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {};
  const action = CODESPACE_ACTION_SCHEMA.safeParse(record.action);
  if (!action.success) throw new CodespaceRequestInvalidError(describeRequestIssues(action.error));
  const { action: _selected, ...request } = record;
  const parsed = CODESPACE_ACTION_REQUEST_SCHEMAS[action.data].safeParse(request);
  if (!parsed.success) throw new CodespaceRequestInvalidError(describeRequestIssues(parsed.error));
  return { action: action.data, request: parsed.data } as CodespaceCall;
}

type CodespaceNewToolParams<Action extends CodespaceAction> = Exclude<
  CodespaceToolParams[Action],
  { operation_id: string }
>;

export interface CodespaceToolServices {
  connection: Pick<CodespaceConnectionService, "getStatus" | "refreshGrants">;
  observability: Pick<CodespaceObservabilityService, "readiness" | "limits">;
  guidance: (situation: CodespaceGuidanceSituation) => {
    provider: string;
    situation: CodespaceGuidanceSituation;
    instruction: string | null;
    links: CodespaceProviderGuidance["links"];
  };
  resource: Pick<
    CodespaceResourceService,
    | "listRepositories"
    | "setupSituation"
    | "listResources"
    | "getCodespace"
    | "create"
    | "startCodespace"
    | "stopCodespace"
    | "deleteCodespace"
  > | null;
  operation: Pick<
    CodespaceOperationService,
    "execute" | "executeNativeReference" | "get" | "reconcile" | "readOutput" | "cancel"
  > | null;
  file: Pick<
    CodespaceFileService,
    "execute" | "uploadReference" | "downloadReference" | "reconcile" | "reconcileDownloadReference"
  > | null;
}

const PROVIDER_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "CODESPACE_AUTHORIZATION_REQUIRED",
  "CODESPACE_PROVIDER_UNAVAILABLE",
  "CODESPACE_RESOURCE_INVALID",
]);

const SAFE_ERROR_MESSAGES: Record<string, string> = {
  CONNECTION_REQUIRED: "Connect GitHub in Moira Settings before using cloud codespaces.",
  INSTALLATION_REQUIRED: "Complete the GitHub App installation in Moira Settings.",
  REPOSITORY_NOT_ALLOWED: "The repository is not approved for this connection.",
  CODESPACE_NOT_CONFIGURED: "Cloud codespaces are not configured on this Moira instance.",
  AUTH_REFRESH_FAILED: "GitHub authorization must be repaired in Moira Settings.",
  AUTH_GRANT_REVOCATION_REQUIRED: "Revoke and reconnect the GitHub grant in Moira Settings.",
  CREDENTIAL_UNREADABLE: "Restore or reconnect the GitHub credential in Moira Settings.",
  AUTHORIZATION_FAILED: "GitHub authorization could not be used.",
  CODESPACE_PROVIDER_DISABLED: "Cloud codespace operations are disabled.",
  CODESPACE_PROVIDER_UNAVAILABLE: "The cloud codespace provider is unavailable.",
  CODESPACE_POLICY_LIMIT: "A codespace quota, concurrency, size or time limit was reached.",
  CODESPACE_SESSION_UNAVAILABLE:
    "The named command session is not available in this codespace's current life.",
  CODESPACE_OPERATION_BUSY:
    "Codespace operation capacity is busy; wait for pending operations before retrying.",
  CODESPACE_RESULT_EXPIRED:
    "The retained operation result has expired. Do not repeat a mutation without inspecting the codespace first.",
  CODESPACE_AUTHORIZATION_REQUIRED: "Restore codespace repository access in Moira Settings.",
  CODESPACE_CREATE_REJECTED: "Codespace creation was rejected.",
  CODESPACE_CREATE_PENDING: "Codespace creation or cleanup is still pending.",
  CODESPACE_NOT_RUNNING: "The codespace is not ready and running.",
  CODESPACE_START_TIMEOUT:
    "The codespace was started for this call but is still starting; retry the same call shortly.",
  CODESPACE_GENERATION_CONFLICT:
    "The codespace or its authorization changed; refresh codespace state before continuing.",
  CODESPACE_RESOURCE_INVALID: "The codespace input or current authorization is invalid.",
  CODESPACE_REQUEST_INVALID: "The request does not match the tool's input schema.",
  CODESPACE_NOT_FOUND: "Codespace was not found.",
  CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD:
    "The requested range is not UTF-8 text; use the download action for binary bytes.",
  CODESPACE_OPERATION_PENDING: "The codespace operation has not reached a terminal result.",
  CODESPACE_OPERATION_FAILED: "The codespace command failed; inspect its output and exit code.",
  CODESPACE_OPERATION_INTERRUPTED:
    "The codespace restarted while this command was running, so its process did not survive and it produced no result. The files it had already written are still there; run the command again.",
  CODESPACE_OPERATION_OUTPUT_LIMIT:
    "The command was stopped because its retained output reached the codespace ceiling; its output up to that point remains readable.",
  CODESPACE_OPERATION_CANCELLED: "The codespace operation was cancelled.",
  CODESPACE_OPERATION_TIMED_OUT: "The codespace operation reached its execution deadline.",
  CODESPACE_FILE_REJECTED:
    "The file operation was rejected; inspect the path and file preconditions before retrying.",
  INTERNAL_ERROR: "The codespace operation failed safely.",
};

const SETUP_ERROR_CODES = new Set([
  "CONNECTION_REQUIRED",
  "INSTALLATION_REQUIRED",
  "CODESPACE_NOT_CONFIGURED",
  "AUTH_REFRESH_FAILED",
  "AUTH_GRANT_REVOCATION_REQUIRED",
  "CREDENTIAL_UNREADABLE",
  "AUTHORIZATION_FAILED",
  "REPOSITORY_NOT_ALLOWED",
  "CODESPACE_AUTHORIZATION_REQUIRED",
]);

class BinaryCodespaceReadError extends Error {}

function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

/** Codes whose refusal a user can act on, and which therefore carry the provider's links. */
const GUIDED_ERROR_CODES: ReadonlySet<string> = new Set([
  ...SETUP_ERROR_CODES,
  "CODESPACE_PROVIDER_DISABLED",
  "CODESPACE_POLICY_LIMIT",
]);

function errorResult(
  code: string,
  settingsUrl?: string,
  retryable = false,
  detail?: string,
  links: CodespaceProviderGuidance["links"] = [],
): CallToolResult {
  const safeMessage = SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.INTERNAL_ERROR;
  // A refusal the user can act on carries the same destinations the guidance action returns, so an
  // agent never has to compose a link or send the user hunting for the right page.
  const guided = GUIDED_ERROR_CODES.has(code) ? links : [];
  const error = {
    code,
    message: detail ? `${safeMessage} ${detail}` : safeMessage,
    retryable,
    ...(settingsUrl && SETUP_ERROR_CODES.has(code) ? { settings_url: settingsUrl } : {}),
    ...(guided.length > 0
      ? { links: guided.map((link) => ({ id: link.id, url: link.url, label: link.label })) }
      : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
    structuredContent: { error },
    isError: true,
  };
}

function projectCodespace(codespace: CodespaceResourceRecord): Record<string, unknown> {
  return { ...projectCodespaceSummary(codespace) };
}

/** An operation whose life ended with the codespace it ran in, rather than with its own command. */
function interruptedByRestart(operation: CodespaceOperationRecord): boolean {
  return operation.state === "failed" && operation.lastOutcome === "codespace_restarted";
}

function projectOperation(response: CodespaceOperationResponse | CodespaceFileOperationResponse) {
  const { operation } = response;
  return {
    // A command that ended because its codespace restarted is not a command that failed; the caller
    // has to be able to tell them apart to decide whether running it again is safe.
    ...(interruptedByRestart(operation) ? { interrupted_by_restart: true } : {}),
    operation_id: operation.id,
    codespace_id: operation.resourceId,
    kind: operation.kind,
    state: operation.state,
    input_bytes: operation.inputBytes,
    output_bytes: operation.outputBytes,
    exit_code: operation.exitCode,
    deadline_at: operation.deadlineAt,
    result_expires_at: operation.resultExpiresAt,
  };
}

function projectExecResult(result: NonNullable<CodespaceOperationResponse["result"]>) {
  return {
    state: result.state,
    stdout: result.stdout,
    stderr: result.stderr,
    exit_code: result.exitCode,
    // A script's end state is carried into its session unless it would not fit the ceiling, which
    // the caller is told rather than left to discover.
    session_capture_dropped: result.sessionCaptureDropped,
    // The payload above is the beginning of each stream; the complete streams stay in the
    // codespace and are read by range with the read action and this operation's identifier.
    stdout_total_bytes: result.stdoutTotalBytes,
    stderr_total_bytes: result.stderrTotalBytes,
    stdout_truncated: Buffer.byteLength(result.stdout) < result.stdoutTotalBytes,
    stderr_truncated: Buffer.byteLength(result.stderr) < result.stderrTotalBytes,
    output_limit_exceeded: result.outputLimitExceeded,
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
      ? operation.interrupted_by_restart
        ? "CODESPACE_OPERATION_INTERRUPTED"
        : operation.kind === "exec"
          ? "CODESPACE_OPERATION_FAILED"
          : "CODESPACE_FILE_REJECTED"
      : operation.state === "cancelled"
        ? "CODESPACE_OPERATION_CANCELLED"
        : operation.state === "timed_out"
          ? "CODESPACE_OPERATION_TIMED_OUT"
          : undefined);
  const response = jsonResult({
    operation,
    result,
    ...(code ? { error: { code, message: SAFE_ERROR_MESSAGES[code], retryable: false } } : {}),
  });
  return code ? { ...response, isError: true } : response;
}

function fileOperationResult(response: CodespaceFileOperationResponse): CallToolResult {
  const operation = projectOperation(response);
  try {
    return operationResult(operation, response.result ? projectFileResult(response.result) : null);
  } catch (error) {
    if (error instanceof BinaryCodespaceReadError) {
      return operationResult(operation, null, "CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD");
    }
    throw error;
  }
}

function projectVersion(version: { size: number; sha256: string; modifiedAt: number } | null) {
  return version
    ? { size_bytes: version.size, sha256: version.sha256, modified_at: version.modifiedAt }
    : null;
}

function projectFileResult(result: NonNullable<CodespaceFileOperationResponse["result"]>) {
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
        throw new BinaryCodespaceReadError();
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
  file: z.infer<typeof codespaceNativeFileSchema>,
): CodespaceNativeFileReference {
  return {
    fileId: file.file_id,
    downloadUrl: file.download_url,
    fileName: file.file_name,
    mimeType: file.mime_type,
    declaredSize: file.size_bytes,
  };
}

function publicExpected(expected: z.infer<typeof codespaceExpectedSchema>) {
  return {
    exists: expected.exists,
    ...(expected.size_bytes !== undefined ? { size: expected.size_bytes } : {}),
    ...(expected.sha256 !== undefined ? { sha256: expected.sha256 } : {}),
  };
}

async function loadServices(): Promise<CodespaceToolServices> {
  const services = await import("@mcp-moira/web-backend/services");
  return {
    connection: services.getCodespaceConnectionService(),
    observability: services.getCodespaceObservabilityService(),
    guidance: services.getCodespaceSetupGuidance,
    resource: services.getCodespaceResourceService(),
    operation: services.getCodespaceOperationService(),
    file: services.getCodespaceFileService(),
  };
}

type CodespaceToolServicesLoader = () => Promise<CodespaceToolServices>;
let codespaceToolServicesLoader: CodespaceToolServicesLoader = loadServices;

export function setCodespaceToolServicesLoaderForTests(
  loader: CodespaceToolServicesLoader,
): () => void {
  const previous = codespaceToolServicesLoader;
  codespaceToolServicesLoader = loader;
  return () => {
    if (codespaceToolServicesLoader === loader) codespaceToolServicesLoader = previous;
  };
}

const logger = createLogger({ component: "ManageCodespaces" });

// Unexpected failures must stay diagnosable server-side. The request context already carries
// the requested action and opaque codespace/operation IDs; no agent input is added here.
type CodespaceToolFailureReporter = (action: CodespaceAction, error: unknown) => void;
let reportUnexpectedFailure: CodespaceToolFailureReporter = (action, error) => {
  logger.error("Codespace tool failed unexpectedly", error, { codespace_action: action });
};

export function setCodespaceToolFailureReporterForTests(
  reporter: CodespaceToolFailureReporter,
): () => void {
  const previous = reportUnexpectedFailure;
  reportUnexpectedFailure = reporter;
  return () => {
    if (reportUnexpectedFailure === reporter) reportUnexpectedFailure = previous;
  };
}

function requireReady(
  status: ReturnType<CodespaceConnectionService["getStatus"]>,
  guidanceLinks: CodespaceProviderGuidance["links"],
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
            ? "CODESPACE_NOT_CONFIGURED"
            : "CONNECTION_REQUIRED";
    return errorResult(code, status.settingsUrl, true, undefined, guidanceLinks);
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
  const prefix = "codespace-file://";
  if (!transfer.referenceId.startsWith(prefix)) throw new Error("Invalid transfer handle");
  const token = transfer.referenceId.slice(prefix.length);
  const uri = `${getBaseUrl()}/api/codespaces/transfers/${encodeURIComponent(token)}`;
  const link: ResourceLink = {
    type: "resource_link",
    uri,
    name: transfer.fileName,
    description: "One-use private codespace download; the link expires automatically.",
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

/** One validated call: the action requested, and the request its own contract accepted. */
export type CodespaceCall = {
  [Action in CodespaceAction]: { action: Action; request: CodespaceToolParams[Action] };
}[CodespaceAction];

export async function executeCodespaceTool(
  call: CodespaceCall,
  userId: string,
  services: CodespaceToolServices,
): Promise<CallToolResult> {
  const { action } = call;
  const params = call.request as CodespaceToolParams[CodespaceAction];
  let status: ReturnType<CodespaceConnectionService["getStatus"]>;
  try {
    status = services.connection.getStatus(userId);
  } catch (error) {
    reportUnexpectedFailure(action, error);
    return errorResult("INTERNAL_ERROR");
  }
  let guidanceLinks: CodespaceProviderGuidance["links"] = [];
  try {
    // The provider's destinations, read once: a refusal the user can act on carries the same set the
    // guidance action returns, so the two can never disagree.
    guidanceLinks = services.guidance("ready").links;
    if (action === "list") {
      const instance = await services.observability.readiness();
      // The stored grants are a snapshot. Refresh it before answering, bounded by age, so a repository
      // the user added after connecting is not invisible until they reconnect; when the provider
      // cannot be reached the stored list is still the answer, and it says so rather than failing.
      const listInput = params as CodespaceToolParams["list"];
      const grants = await services.connection.refreshGrants(userId, {
        force: listInput.refresh === true,
      });
      status = services.connection.getStatus(userId);
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
        repositories_stale: grants.stale,
        codespaces: services.resource?.listResources(userId).map(projectCodespace) ?? [],
        limits: services.observability.limits(userId),
      });
    }

    if (action === "setup_help") {
      // What the user must do next and where. Moira knows the situation; the provider supplies the
      // words and the links, so the agent repeats a checkable instruction instead of inventing one.
      const grants = await services.connection.refreshGrants(userId);
      status = services.connection.getStatus(userId);
      const instance = await services.observability.readiness();
      const input = params as CodespaceToolParams["setup_help"];
      const situation: CodespaceGuidanceSituation = !services.resource
        ? "not_configured"
        : instance.state === "disabled" || instance.state === "control_disabled"
          ? "instance_disabled"
          : status.state === "connected"
            ? services.resource.setupSituation(userId, input.repository_id)
            : status.reason === "INSTALLATION_REQUIRED"
              ? "installation_required"
              : status.state === "refresh_failed" || status.state === "revocation_pending"
                ? "authorization_repair_required"
                : "connection_required";
      const guidance = services.guidance(situation);
      return jsonResult({
        situation: guidance.situation,
        provider: guidance.provider,
        reason: status.reason,
        instruction: guidance.instruction,
        repositories_stale: grants.stale,
        links: guidance.links.map((link) => ({ id: link.id, url: link.url, label: link.label })),
      });
    }

    if (action === "get") {
      if (!services.resource)
        return errorResult(
          "CODESPACE_NOT_CONFIGURED",
          status.settingsUrl,
          false,
          undefined,
          guidanceLinks,
        );
      const input = params as CodespaceToolParams["get"];
      return jsonResult({
        codespace: projectCodespace(services.resource.getCodespace(userId, input.codespace_id)),
      });
    }

    if (action === "create") {
      await services.connection.refreshGrants(userId);
      status = services.connection.getStatus(userId);
    }

    const ready = requireReady(status, guidanceLinks);
    if (isErrorResult(ready)) return ready;
    if (!services.resource || !services.operation || !services.file) {
      return errorResult(
        "CODESPACE_NOT_CONFIGURED",
        ready.settingsUrl,
        false,
        undefined,
        guidanceLinks,
      );
    }

    if (action === "read" && "stream" in params) {
      const input = params as Extract<CodespaceToolParams["read"], { stream: "stdout" | "stderr" }>;
      // The codespace is named in the request, so a mismatch is refused here exactly as the resume
      // path refuses one, rather than silently answering about another codespace's command.
      const owning = services.operation.get(userId, input.operation_id);
      if (!owning || owning.resourceId !== input.codespace_id || owning.kind !== "exec") {
        return errorResult("CODESPACE_NOT_FOUND");
      }
      const output = await services.operation.readOutput(userId, input.operation_id, {
        stream: input.stream,
        offset: input.offset,
        length: input.length,
      });
      return jsonResult({
        output: {
          operation_id: input.operation_id,
          stream: output.stream,
          offset: output.offset,
          total_bytes: output.totalBytes,
          text: output.bytes.toString("utf8"),
          truncated: output.offset + output.bytes.length < output.totalBytes,
        },
      });
    }

    if ("operation_id" in params) {
      const resumableKind: Partial<Record<CodespaceAction, CodespaceOperationRecord["kind"]>> = {
        exec: "exec",
        stat: "stat",
        search: "search",
        read: "read",
        write: "write",
        apply_patch: "apply_patch",
        upload: "upload",
        download: "download",
      };
      const expectedKind = resumableKind[action];
      const existing = services.operation.get(userId, params.operation_id);
      if (
        !expectedKind ||
        !existing ||
        existing.resourceId !== params.codespace_id ||
        existing.kind !== expectedKind
      ) {
        return errorResult("CODESPACE_NOT_FOUND");
      }
      if (action === "download") {
        const input = params as Extract<CodespaceToolParams["download"], { operation_id: string }>;
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
      if (action === "exec") {
        const input = params as Extract<CodespaceToolParams["exec"], { operation_id: string }>;
        if (input.cancel) {
          const cancelled = await services.operation.cancel(userId, input.operation_id);
          return operationResult(
            projectOperation(cancelled),
            cancelled.result ? projectExecResult(cancelled.result) : null,
          );
        }
        const result = await services.operation.reconcile(userId, params.operation_id);
        const operation = services.operation.get(userId, params.operation_id);
        if (!operation) return errorResult("CODESPACE_NOT_FOUND");
        return operationResult(
          projectOperation({ operation, result }),
          result ? projectExecResult(result) : null,
          result?.outputLimitExceeded ? "CODESPACE_OPERATION_OUTPUT_LIMIT" : undefined,
        );
      }
      const response = await services.file.reconcile(userId, params.operation_id);
      return fileOperationResult(response);
    }

    switch (action) {
      case "create": {
        const input = params as CodespaceToolParams["create"];
        const created = await services.resource.create(userId, input.repository_id, input.ref);
        return jsonResult({ codespace: projectCodespace(created.resource) });
      }
      case "start": {
        const input = params as CodespaceToolParams["start"];
        return jsonResult({
          codespace: projectCodespace(
            await services.resource.startCodespace(userId, input.codespace_id),
          ),
        });
      }
      case "stop": {
        const input = params as CodespaceToolParams["stop"];
        return jsonResult({
          codespace: projectCodespace(
            await services.resource.stopCodespace(userId, input.codespace_id),
          ),
          data_preserved: true,
        });
      }
      case "delete": {
        const input = params as CodespaceToolParams["delete"];
        return jsonResult({
          codespace: projectCodespace(
            await services.resource.deleteCodespace(
              userId,
              input.codespace_id,
              input.expected_generation,
            ),
          ),
          data_preserved: false,
        });
      }
      case "exec": {
        const input = params as CodespaceNewToolParams<"exec">;
        const request = {
          ...(input.argv !== undefined ? { argv: input.argv } : {}),
          ...(input.script !== undefined ? { script: input.script } : {}),
          ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
          ...(input.session !== undefined
            ? {
                session: input.session,
                sessionStart: input.session_start,
                sessionEnd: input.session_end,
              }
            : {}),
          ...(input.env !== undefined ? { env: input.env } : {}),
          // Absent stays absent: the service applies the default the requested mode implies.
          ...(input.timeout_seconds !== undefined
            ? { timeoutMs: input.timeout_seconds * 1000 }
            : {}),
          ...(input.max_stdout_bytes !== undefined
            ? { maxStdoutBytes: input.max_stdout_bytes }
            : {}),
          ...(input.max_stderr_bytes !== undefined
            ? { maxStderrBytes: input.max_stderr_bytes }
            : {}),
          background: input.background,
        };
        const response =
          "stdin_file" in input
            ? await services.operation.executeNativeReference(
                userId,
                input.codespace_id,
                request,
                publicNativeReference(input.stdin_file),
              )
            : await services.operation.execute(userId, input.codespace_id, {
                ...request,
                stdin: {
                  kind: "inline",
                  bytes: Buffer.from(input.stdin_text ?? "", "utf8"),
                },
              });
        return operationResult(
          projectOperation(response),
          response.result ? projectExecResult(response.result) : null,
          response.result?.outputLimitExceeded ? "CODESPACE_OPERATION_OUTPUT_LIMIT" : undefined,
        );
      }
      case "stat":
      case "search":
      case "read":
      case "write":
      case "apply_patch": {
        const request: CodespaceFileRequest =
          action === "stat"
            ? {
                action: "stat",
                path: (params as CodespaceNewToolParams<"stat">).path,
              }
            : action === "search"
              ? {
                  action: "search",
                  path: (params as CodespaceNewToolParams<"search">).path,
                  query: (params as CodespaceNewToolParams<"search">).query,
                  mode: (params as CodespaceNewToolParams<"search">).mode,
                  maxMatches: (params as CodespaceNewToolParams<"search">).max_matches,
                  maxBytes: (params as CodespaceNewToolParams<"search">).max_bytes,
                }
              : action === "read"
                ? {
                    action: "read",
                    path: (params as CodespaceNewToolParams<"read">).path,
                    offset: (params as CodespaceNewToolParams<"read">).offset,
                    length: (params as CodespaceNewToolParams<"read">).length,
                  }
                : action === "write"
                  ? {
                      action: "write",
                      path: (params as CodespaceNewToolParams<"write">).path,
                      bytes: Buffer.from((params as CodespaceNewToolParams<"write">).text, "utf8"),
                      expected: publicExpected(
                        (params as CodespaceNewToolParams<"write">).expected,
                      ),
                    }
                  : {
                      action: "apply_patch",
                      files: (params as CodespaceNewToolParams<"apply_patch">).files.map(
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
        const codespaceId = (params as { codespace_id: string }).codespace_id;
        const response = await services.file.execute(userId, codespaceId, request);
        return fileOperationResult(response);
      }
      case "upload": {
        const input = params as CodespaceNewToolParams<"upload">;
        const response = await services.file.uploadReference(userId, input.codespace_id, {
          path: input.path,
          reference: publicNativeReference(input.file),
          expected: publicExpected(input.expected),
        });
        return fileOperationResult(response);
      }
      case "download": {
        const input = params as CodespaceNewToolParams<"download">;
        const response = await services.file.downloadReference(userId, input.codespace_id, {
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
    }
    // `list` and `get` answered above, before the readiness gate; the compiler knows they cannot
    // reach this switch, which is why they are not cases of it.
  } catch (error) {
    if (error instanceof CodespaceConnectionError || error instanceof CodespaceResourceError) {
      recordCodespaceRejection(error.code);
      if (PROVIDER_REFUSAL_CODES.has(error.code)) {
        // The bounded internal message names only the provider's HTTP status; operators need
        // it to tell a permission gap from an outage, while the agent sees the safe code.
        logger.warn("Codespace provider refused the request", {
          codespace_action: action,
          code: error.code,
          detail: error.message,
        });
      }
      return errorResult(
        error.code,
        SETUP_ERROR_CODES.has(error.code) ? status.settingsUrl : undefined,
        [
          "CODESPACE_PROVIDER_UNAVAILABLE",
          "CODESPACE_POLICY_LIMIT",
          "CODESPACE_OPERATION_BUSY",
          "CODESPACE_CREATE_PENDING",
          "CODESPACE_NOT_RUNNING",
        ].includes(error.code),
        // Only the refusing code decides what the caller may be told; the boundary forwards the
        // bounded detail it already declared safe and never derives one from the error code.
        error instanceof CodespaceResourceError ? error.detail : undefined,
        guidanceLinks,
      );
    }
    reportUnexpectedFailure(action, error);
    return errorResult("INTERNAL_ERROR");
  }
}

export async function manageCodespaceTool(params: unknown): Promise<CallToolResult> {
  const { userId } = getUserContext();
  let parsed: ReturnType<typeof parseCodespaceToolParams>;
  try {
    parsed = parseCodespaceToolParams(params);
  } catch (error) {
    if (error instanceof CodespaceRequestInvalidError) {
      recordCodespaceRejection("CODESPACE_REQUEST_INVALID");
      return errorResult("CODESPACE_REQUEST_INVALID", undefined, false, error.detail);
    }
    throw error;
  }
  return executeCodespaceTool(parsed, userId, await codespaceToolServicesLoader());
}
