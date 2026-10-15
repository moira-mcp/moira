import { Buffer } from "node:buffer";
import { URLSearchParams } from "node:url";
import { TextDecoder } from "node:util";
import { workspaceRequest, workspaceJson } from "./client.mjs";
import { previewImageBytes } from "./image-preview.mjs";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.mjs";

export function workspaceResult(data) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
  };
  return data.error ||
    ["failed", "not_started", "timed_out", "interrupted"].includes(String(data.state))
    ? { ...result, isError: true }
    : result;
}

function commandStatus(data) {
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

function query(input) {
  return new URLSearchParams(
    Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)]),
  ).toString();
}

function expected(input) {
  return {
    exists: input.exists,
    ...(input.size_bytes !== undefined ? { size: input.size_bytes } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  };
}

function nativeReference(file) {
  return {
    fileId: file.file_id,
    downloadUrl: file.download_url,
    ...(file.file_name !== undefined ? { fileName: file.file_name } : {}),
    ...(file.mime_type !== undefined ? { mimeType: file.mime_type } : {}),
    ...(file.size_bytes !== undefined ? { declaredSize: file.size_bytes } : {}),
  };
}

async function bytes(response, maximum) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const value = Buffer.from(chunk);
      size += value.length;
      if (
        response.statusCode >= 200 &&
        response.statusCode < 300 &&
        maximum !== undefined &&
        size > maximum
      )
        throw Object.assign(new Error("Observation bound exceeded"), {
          details: { error: { code: "CODESPACE_RESOURCE_INVALID" } },
        });
      chunks.push(value);
    }
    const data = Buffer.concat(chunks, size);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      let details;
      try {
        details = JSON.parse(data.toString("utf8"));
      } catch {
        /* No confirmed refusal without an owner receipt. */
      }
      throw Object.assign(new Error("Workspace byte stream refused"), { details });
    }
    return data;
  } finally {
    response.destroy();
  }
}

async function range(socketPath, path, length) {
  const response = await workspaceRequest(socketPath, "GET", path);
  const value = await bytes(response, length);
  return { value, total: Number(response.headers["x-moira-total-size"] ?? value.length) };
}

async function collect(socketPath, requestId, options = {}) {
  const operation = await workspaceJson(
    socketPath,
    "GET",
    `/v1/operations/${requestId}?${query({ waitMs: options.waitMs ?? 10_000 })}`,
  );
  const status = commandStatus(operation);
  if (operation.error || operation.state === "absent" || operation.state === "unknown")
    return workspaceResult({ ...status, request_id: requestId });
  const output = {};
  for (const stream of ["stdout", "stderr"]) {
    const length = options[`${stream}Bytes`] ?? 64 * 1024;
    const total = operation[`${stream}Bytes`];
    if (total === 0 || total === undefined) {
      output[stream] = "";
      continue;
    }
    const result = await range(
      socketPath,
      `/v1/operations/${requestId}/output?${query({ stream, offset: 0, length })}`,
      length,
    );
    output[stream] = result.value.toString("utf8");
    if (typeof total === "number" && total > result.value.length) {
      output[`${stream}_truncated`] = true;
      output[`${stream}_total_bytes`] = total;
    }
  }
  return workspaceResult({ ...status, request_id: requestId, ...output });
}

export function workspaceFailure(error, requestId) {
  const candidate = error?.details?.error;
  const scopedOutcome = scopedCredentialFailureOutcome(candidate?.code);
  const trustedReply =
    !Number.isInteger(error?.httpStatus) || error.httpStatus < 500 || scopedOutcome !== null;
  const known =
    trustedReply &&
    candidate &&
    typeof candidate.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,79}$/.test(candidate.code)
      ? {
          code: candidate.code,
          message:
            scopedOutcome === "unconfirmed"
              ? "Scoped credential operation outcome is unconfirmed"
              : scopedOutcome === "refused"
                ? "Scoped credential operation refused"
                : "The workspace refused this request.",
          ...(["unsafe_access", "concurrent_change", "precondition"].includes(candidate.reason)
            ? { reason: candidate.reason }
            : {}),
        }
      : undefined;
  return workspaceResult({
    error:
      (known && !["WORKSPACE_OUTCOME_UNKNOWN", "WORKSPACE_OUTCOME_UNCONFIRMED"].includes(known.code)
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
    ...(scopedOutcome !== null &&
    WORKSPACE_REQUEST_ID_PATTERN.test(error?.details?.security_request_id ?? "")
      ? { security_request_id: error.details.security_request_id }
      : {}),
  });
}

/** Final agent-facing payload is produced at the same owner as execution/files and their journals. */
export async function executeOwnerTool(socketPath, { action, request }) {
  const requestId = request.request_id ?? request.process_id;
  try {
    if (["pull_request_create", "pull_request_get", "pull_request_find"].includes(action)) {
      const input =
        action === "pull_request_create"
          ? request.head === undefined
            ? undefined
            : {
                head: request.head,
                base: request.base,
                title: request.title,
                body: request.body,
                draft: request.draft,
              }
          : action === "pull_request_get"
            ? { number: request.pull_request_number }
            : { head: request.head, base: request.base };
      const data = await workspaceJson(socketPath, "POST", "/v1/github/pull-requests", {
        action,
        ...(action === "pull_request_create" ? { requestId } : {}),
        ...(input === undefined ? {} : { input }),
      });
      return workspaceResult({
        ...data,
        ...(action === "pull_request_create" && data.state === "unknown"
          ? {
              error: {
                code: "WORKSPACE_OUTCOME_UNCONFIRMED",
                message:
                  "The pull-request creation outcome is unconfirmed. Collect the original request ID and find the same head/base before considering another create.",
              },
            }
          : {}),
        ...(requestId ? { request_id: requestId } : {}),
      });
    }
    if (action === "process_get" || action === "process_stop") {
      const data = await workspaceJson(
        socketPath,
        action === "process_stop" ? "POST" : "GET",
        `/v1/operations/${requestId}${action === "process_stop" ? "/cancel" : ""}`,
      );
      return workspaceResult({
        ...commandStatus(data),
        process_id: requestId,
        request_id: requestId,
      });
    }
    if (action === "process_read") {
      const { value, total } = await range(
        socketPath,
        `/v1/operations/${requestId}/output?${query({ stream: request.stream, offset: request.offset, length: request.length })}`,
        request.length,
      );
      return workspaceResult({
        process_id: requestId,
        stream: request.stream,
        offset: request.offset,
        total_bytes: total,
        text: value.toString("utf8"),
      });
    }
    if (action === "exec" || action === "process_start") {
      if ("argv" in request || "script" in request || request.session_end) {
        const accepted = await workspaceJson(socketPath, "POST", "/v1/exec", {
          requestId,
          argv: request.argv,
          script: request.script,
          cwd: request.cwd,
          env: request.env,
          session: request.session,
          sessionStart: request.session_start,
          sessionEnd: request.session_end,
          ...(request.stdin_file
            ? { nativeInput: nativeReference(request.stdin_file) }
            : { stdinText: request.stdin_text ?? "" }),
          ...(request.timeout_seconds !== undefined
            ? { timeoutMs: request.timeout_seconds * 1000 }
            : {}),
        });
        if (action === "process_start")
          return workspaceResult({
            ...commandStatus(accepted),
            request_id: requestId,
            process_id: requestId,
          });
        if (accepted.error)
          return workspaceResult({ ...commandStatus(accepted), request_id: requestId });
      }
      return await collect(socketPath, requestId, {
        stdoutBytes: request.max_stdout_bytes,
        stderrBytes: request.max_stderr_bytes,
      });
    }
    if (action === "stat")
      return workspaceResult(
        await workspaceJson(socketPath, "POST", "/v1/files/stat", { path: request.path }),
      );
    if (action === "search")
      return workspaceResult(
        await workspaceJson(socketPath, "POST", "/v1/files/search", {
          path: request.path,
          query: request.query,
          mode: request.mode,
          maxMatches: request.max_matches,
          maxBytes: request.max_bytes,
        }),
      );
    if (action === "apply_patch")
      return workspaceResult(
        await workspaceJson(socketPath, "POST", "/v1/files/patch", {
          requestId,
          files: request.files.map((file) => ({
            path: file.path,
            expected: expected(file.expected),
            edits: file.edits,
          })),
        }),
      );
    if (action === "upload")
      return workspaceResult(
        await workspaceJson(socketPath, "POST", "/v1/files/native-upload", {
          requestId,
          path: request.path,
          expected: expected(request.expected),
          file: nativeReference(request.file),
        }),
      );
    if (action === "write") {
      const response = await workspaceRequest(
        socketPath,
        "PUT",
        `/v1/files/write?${query({ path: request.path, requestId })}`,
        Buffer.from(request.text),
        { "x-moira-expected": JSON.stringify(expected(request.expected)) },
      );
      return workspaceResult(JSON.parse((await bytes(response)).toString("utf8")));
    }
    if (action === "read") {
      const path =
        "stream" in request
          ? `/v1/operations/${requestId}/output?${query({ stream: request.stream, offset: request.offset, length: request.length })}`
          : `/v1/files/read?${query({ path: request.path, offset: request.offset, length: request.length })}`;
      const { value, total } = await range(socketPath, path, request.length);
      let text;
      try {
        text = new TextDecoder("utf8", { fatal: true }).decode(value);
      } catch {
        return workspaceResult({
          error: {
            code: "CODESPACE_BINARY_READ_REQUIRES_DOWNLOAD",
            message: "This range is not UTF-8 text. Download its binary bytes.",
          },
        });
      }
      return workspaceResult({ offset: request.offset, text, total_bytes: total });
    }
    if (action === "preview_image") {
      const { value } = await range(
        socketPath,
        `/v1/files/read?${query({ path: request.path, offset: 0 })}`,
        request.max_bytes,
      );
      return previewImageBytes(value);
    }
    if (action === "download") {
      const file = await workspaceJson(socketPath, "POST", "/v1/files/publish", {
        path: request.path,
        fileName: request.file_name,
        mimeType: request.mime_type,
        ...(request.max_bytes !== undefined ? { maxBytes: request.max_bytes } : {}),
      });
      return {
        content: [
          {
            type: "resource_link",
            uri: file.uri,
            name: file.fileName,
            mimeType: file.mimeType,
            size: file.size,
          },
        ],
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
    return workspaceResult({
      error: { code: "CODESPACE_RESOURCE_INVALID", message: "Unsupported workspace action." },
    });
  } catch (error) {
    const result = workspaceFailure(error, requestId);
    return action.startsWith("process_") && requestId
      ? workspaceResult({ ...result.structuredContent, process_id: requestId })
      : result;
  }
}
