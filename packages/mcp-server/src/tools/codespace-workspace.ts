import type { CallToolResult, ResourceLink } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingHttpHeaders } from "node:http";
import type { Readable } from "node:stream";
import {
  CodespaceResourceError,
  getBaseUrl,
  type CodespaceNativeReferenceFetcher,
  type CodespaceTransferService,
} from "@mcp-moira/shared";
import { z } from "zod";
import type { CodespaceCall } from "./manage-codespaces.js";
import { codespaceNativeFileSchema } from "./tool-schemas.js";
import { previewImageBytes } from "./codespace-image-preview.js";

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
    request: {
      method: string;
      path: string;
      body?: unknown;
    },
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface WorkspaceAttachments {
  fetcher: CodespaceNativeReferenceFetcher;
  publisher: Pick<CodespaceTransferService, "ingestStream">;
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

/** Keep execution observations; runner proofs and service identity stay in the workspace. */
export function workspaceCommandStatus(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    [
      "state",
      "reason",
      "archived",
      "exitCode",
      "startedAt",
      "runtimeMs",
      "stdoutBytes",
      "stderrBytes",
      "sessionCaptureDropped",
      "error",
    ]
      .filter((key) => data[key] !== undefined)
      .map((key) => [key, data[key]]),
  );
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
      known ??
      (requestId
        ? {
            code: "WORKSPACE_OUTCOME_UNCONFIRMED",
            message:
              "The reply was lost. Inspect the original request identity before repeating a mutation.",
          }
        : {
            code: "WORKSPACE_UNAVAILABLE",
            message: "The workspace reply is unavailable. Retry this read after reconnecting.",
          }),
    ...(requestId ? { request_id: requestId } : {}),
  });
}

export function workspaceQuery(input: Record<string, unknown>): string {
  return new URLSearchParams(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

export async function readWorkspaceBytes(
  response: { statusCode: number; body: Readable },
  maximum: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const bytes = await readWorkspaceBytes({ ...response, statusCode: 200 }, 64 * 1024);
      let details: unknown;
      try {
        details = JSON.parse(bytes.toString("utf8"));
      } catch {
        /* Transport refusal is unconfirmed without a valid receipt. */
      }
      throw Object.assign(new Error("Workspace byte stream refused"), { details });
    }
    for await (const chunk of response.body) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum)
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "The response exceeds the requested observation window",
        );
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, size);
  } finally {
    response.body.destroy();
  }
}

export async function collectWorkspaceCommand(
  client: WorkspaceToolClient,
  userId: string,
  resourceId: string,
  requestId: string,
  options: { waitMs?: number; stdoutBytes?: number; stderrBytes?: number } = {},
): Promise<CallToolResult> {
  const operation = await client.json(userId, resourceId, {
    method: "GET",
    path: `/v1/operations/${requestId}?${workspaceQuery({ waitMs: options.waitMs ?? 0 })}`,
  });
  const status = workspaceCommandStatus(operation);
  if (operation.error || operation.state === "absent" || operation.state === "unknown")
    return workspaceResult({ ...status, request_id: requestId });
  const output: Record<string, unknown> = {};
  for (const stream of ["stdout", "stderr"] as const) {
    const length = (stream === "stdout" ? options.stdoutBytes : options.stderrBytes) ?? 64 * 1024;
    const total = operation[`${stream}Bytes`];
    if (total === 0 || total === undefined) {
      output[stream] = "";
      continue;
    }
    const response = await client.request(userId, resourceId, {
      method: "GET",
      path: `/v1/operations/${requestId}/output?${workspaceQuery({ stream, offset: 0, length })}`,
    });
    const bytes = await readWorkspaceBytes(response, length);
    output[stream] = bytes.toString("utf8");
    if (typeof total === "number" && total > bytes.length) {
      output[`${stream}_truncated`] = true;
      output[`${stream}_total_bytes`] = total;
    }
  }
  return workspaceResult({ ...status, request_id: requestId, ...output });
}

function expected(input: { exists: boolean; size_bytes?: number; sha256?: string }) {
  return {
    exists: input.exists,
    ...(input.size_bytes !== undefined ? { size: input.size_bytes } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  };
}

async function stageNativeInput(
  client: WorkspaceToolClient,
  attachments: WorkspaceAttachments,
  userId: string,
  resourceId: string,
  path: string,
  reference: z.infer<typeof codespaceNativeFileSchema>,
  headers?: Record<string, string>,
) {
  // Authorize the destination before contacting an attachment source.
  await client.json(userId, resourceId, { method: "GET", path: "/v1/health" });
  const fetched = await attachments.fetcher.fetch({
    fileId: reference.file_id,
    downloadUrl: reference.download_url,
    fileName: reference.file_name,
    mimeType: reference.mime_type,
    declaredSize: reference.size_bytes,
  });
  try {
    if (
      reference.size_bytes !== undefined &&
      fetched.contentLength !== null &&
      fetched.contentLength !== reference.size_bytes
    )
      throw new CodespaceResourceError(
        "CODESPACE_RESOURCE_INVALID",
        "Native attachment size changed",
      );
    const size = reference.size_bytes ?? fetched.contentLength;
    const response = await client.request(userId, resourceId, {
      method: "PUT",
      path,
      headers: { ...headers, ...(size !== null ? { "x-moira-content-size": String(size) } : {}) },
      body: fetched.body,
    });
    return JSON.parse((await readWorkspaceBytes(response, 64 * 1024)).toString("utf8")) as Record<
      string,
      unknown
    >;
  } finally {
    fetched.cancel?.();
  }
}

export async function executeWorkspaceAction(
  call: CodespaceCall,
  userId: string,
  client: WorkspaceToolClient,
  options: { background?: boolean; attachments?: WorkspaceAttachments } = {},
): Promise<CallToolResult> {
  const { action } = call;
  if (!("codespace_id" in call.request))
    throw new CodespaceResourceError(
      "CODESPACE_RESOURCE_INVALID",
      "This action requires a workspace",
    );
  const id = call.request.codespace_id;
  try {
    if (action === "exec") {
      const params = call.request;
      const requestId = params.request_id;
      if (
        "argv" in params ||
        "script" in params ||
        ("session_end" in params && params.session_end)
      ) {
        const command = params as Extract<typeof params, { session_end: boolean }> & {
          argv?: string[];
          script?: string;
          stdin_text?: string;
          stdin_file?: z.infer<typeof codespaceNativeFileSchema>;
        };
        if (command.stdin_file) {
          if (!options.attachments)
            throw new CodespaceResourceError(
              "CODESPACE_RESOURCE_INVALID",
              "Attachment service is unavailable",
            );
          await stageNativeInput(
            client,
            options.attachments,
            userId,
            id,
            `/v1/operations/${requestId}/input`,
            command.stdin_file,
          );
        }
        const accepted = await client.json(userId, id, {
          method: "POST",
          path: "/v1/exec",
          body: {
            requestId,
            argv: command.argv,
            script: command.script,
            cwd: command.cwd,
            env: command.env,
            session: command.session,
            sessionStart: command.session_start,
            sessionEnd: command.session_end,
            ...(command.stdin_file
              ? { inputReady: true }
              : { stdinText: command.stdin_text ?? "" }),
            ...(command.timeout_seconds !== undefined
              ? { timeoutMs: command.timeout_seconds * 1000 }
              : {}),
          },
        });
        if (accepted.error)
          return workspaceResult({ ...workspaceCommandStatus(accepted), request_id: requestId });
        if (options.background)
          return workspaceResult({
            ...workspaceCommandStatus(accepted),
            request_id: requestId,
          });
        return collectWorkspaceCommand(client, userId, id, requestId, {
          waitMs: 10_000,
          stdoutBytes: command.max_stdout_bytes,
          stderrBytes: command.max_stderr_bytes,
        });
      }
      return collectWorkspaceCommand(client, userId, id, requestId, { waitMs: 10_000 });
    }
    if (action === "stat")
      return workspaceResult(
        await client.json(userId, id, {
          method: "POST",
          path: "/v1/files/stat",
          body: { path: call.request.path },
        }),
      );
    if (action === "search") {
      if (!("path" in call.request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Search requires a path");
      const request = call.request;
      return workspaceResult(
        await client.json(userId, id, {
          method: "POST",
          path: "/v1/files/search",
          body: {
            path: request.path,
            query: request.query,
            mode: request.mode,
            maxMatches: request.max_matches,
            maxBytes: request.max_bytes,
          },
        }),
      );
    }
    if (action === "apply_patch") {
      if (!("files" in call.request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Patch requires edits");
      const request = call.request;
      return workspaceResult(
        await client.json(userId, id, {
          method: "POST",
          path: "/v1/files/patch",
          body: {
            requestId: request.request_id,
            files: request.files.map((file) => ({
              path: file.path,
              expected: expected(file.expected),
              edits: file.edits,
            })),
          },
        }),
      );
    }
    if (action === "write" || action === "upload") {
      if (!("path" in call.request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Write requires a path");
      const request = call.request;
      const path = `/v1/files/write?${workspaceQuery({ path: request.path, requestId: request.request_id })}`;
      const headers = { "x-moira-expected": JSON.stringify(expected(request.expected)) };
      if (action === "upload" && "file" in request) {
        if (!options.attachments)
          throw new CodespaceResourceError(
            "CODESPACE_RESOURCE_INVALID",
            "Attachment service is unavailable",
          );
        return workspaceResult(
          await stageNativeInput(
            client,
            options.attachments,
            userId,
            id,
            path,
            request.file,
            headers,
          ),
        );
      }
      if (!("text" in request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Write requires text");
      const response = await client.request(userId, id, {
        method: "PUT",
        path,
        headers,
        body: Buffer.from(request.text),
      });
      return workspaceResult(
        JSON.parse((await readWorkspaceBytes(response, 64 * 1024)).toString("utf8")) as Record<
          string,
          unknown
        >,
      );
    }
    if (action === "read") {
      if (!("length" in call.request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Read requires a range");
      const request = call.request;
      const path =
        "stream" in request
          ? `/v1/operations/${request.request_id}/output?${workspaceQuery({ stream: request.stream, offset: request.offset, length: request.length })}`
          : `/v1/files/read?${workspaceQuery({ path: request.path, offset: request.offset, length: request.length })}`;
      const response = await client.request(userId, id, { method: "GET", path });
      const bytes = await readWorkspaceBytes(response, request.length);
      let text: string;
      try {
        text = new TextDecoder("utf8", { fatal: true }).decode(bytes);
      } catch {
        return workspaceResult({
          error: {
            code: "CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD",
            message: "This range is not UTF-8 text. Download its binary bytes.",
          },
        });
      }
      return workspaceResult({
        offset: request.offset,
        text,
        total_bytes: Number(response.headers["x-moira-total-size"] ?? bytes.length),
      });
    }
    if (action === "preview_image" || action === "download") {
      if (!("path" in call.request))
        throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Download requires a path");
      const request = call.request;
      const response = await client.request(userId, id, {
        method: "GET",
        path: `/v1/files/read?${workspaceQuery({ path: request.path, offset: 0 })}`,
      });
      if (action === "preview_image")
        return previewImageBytes(
          await readWorkspaceBytes(response, request.max_bytes ?? 4 * 1024 * 1024),
        );
      if (response.statusCode !== 200) await readWorkspaceBytes(response, 64 * 1024);
      if (!("file_name" in request)) {
        response.body.destroy();
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Download requires a file name",
        );
      }
      const size = Number(response.headers["content-length"]);
      const total = Number(response.headers["x-moira-total-size"]);
      if (!Number.isSafeInteger(size) || size < 0 || size !== total) {
        response.body.destroy();
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "The download size is unavailable",
        );
      }
      if (request.max_bytes !== undefined && size > request.max_bytes) {
        response.body.destroy();
        return workspaceResult({
          error: {
            code: "CODESPACE_DOWNLOAD_BOUND_EXCEEDED",
            message: "The complete file exceeds your max_bytes download bound.",
          },
        });
      }
      if (!options.attachments) {
        response.body.destroy();
        throw new CodespaceResourceError(
          "CODESPACE_RESOURCE_INVALID",
          "Attachment service is unavailable",
        );
      }
      const file = await options.attachments.publisher.ingestStream(userId, {
        fileName: request.file_name,
        mimeType: request.mime_type,
        size,
        body: response.body,
      });
      const link: ResourceLink = {
        type: "resource_link",
        uri: `${getBaseUrl()}/api/codespaces/transfers/${encodeURIComponent(file.referenceId.slice("codespace-file://".length))}`,
        name: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
      };
      return {
        content: [link],
        structuredContent: {
          file: {
            reference_id: file.referenceId,
            name: file.fileName,
            mime_type: file.mimeType,
            size_bytes: file.size,
            sha256: file.sha256,
            expires_at: file.expiresAt,
          },
        },
      };
    }
    throw new CodespaceResourceError("CODESPACE_RESOURCE_INVALID", "Unsupported workspace action");
  } catch (error) {
    // The transport never retries a mutation; its original identity remains available for inspection.
    const requestId = "request_id" in call.request ? call.request.request_id : undefined;
    return workspaceFailure(error, requestId);
  }
}
