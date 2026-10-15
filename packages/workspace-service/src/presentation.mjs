import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
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

async function range(owner, input, maximum) {
  const consume = async ({ body, total }) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (maximum !== undefined && size > maximum)
        throw Object.assign(new Error("Observation bound exceeded"), {
          details: { error: { code: "CODESPACE_RESOURCE_INVALID" } },
        });
      chunks.push(chunk);
    }
    return { value: Buffer.concat(chunks, size), total };
  };
  return input.path !== undefined
    ? await owner.fileRange(input.path, input.offset ?? 0, input.length ?? null, consume)
    : owner.outputRange(
        input.requestId,
        input.stream ?? "stdout",
        input.offset ?? 0,
        input.length ?? null,
        consume,
      );
}

async function collect(owner, requestId, options = {}, signal) {
  const operation = await owner.observe(requestId, options.waitMs ?? 10_000, signal);
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
    const result = await range(owner, { requestId, stream, offset: 0, length }, length);
    output[stream] = result.value.toString("utf8");
    if (typeof total === "number" && total > result.value.length) {
      output[`${stream}_truncated`] = true;
      output[`${stream}_total_bytes`] = total;
    }
  }
  return workspaceResult({ ...status, request_id: requestId, ...output });
}

export function workspaceFailure(error, requestId) {
  const candidate = error?.details?.error ?? {
    code:
      error?.publicCode ??
      (error?.code === "ENOENT" ? "NOT_FOUND" : error?.fileReason ? "FILE_REJECTED" : undefined),
    reason: error?.fileReason,
  };
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
    WORKSPACE_REQUEST_ID_PATTERN.test(
      error?.details?.security_request_id ?? error?.securityRequestId ?? "",
    )
      ? { security_request_id: error?.details?.security_request_id ?? error.securityRequestId }
      : {}),
  });
}

/** Final agent-facing payload is produced at the same owner as execution/files and their journals. */
export async function executeOwnerTool(owner, { action, request }, { signal } = {}) {
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
      const data = await owner.pullRequestAction({
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
      const data =
        action === "process_stop" ? await owner.cancel(requestId) : await owner.inspect(requestId);
      return workspaceResult({
        ...commandStatus(data),
        process_id: requestId,
        request_id: requestId,
      });
    }
    if (action === "process_read") {
      const { value, total } = await range(
        owner,
        { requestId, stream: request.stream, offset: request.offset, length: request.length },
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
        const accepted = await owner.execute({
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
      return await collect(
        owner,
        requestId,
        {
          stdoutBytes: request.max_stdout_bytes,
          stderrBytes: request.max_stderr_bytes,
        },
        signal,
      );
    }
    if (action === "stat")
      return workspaceResult(await owner.file({ action: "stat", path: request.path }, signal));
    if (action === "search")
      return workspaceResult(
        await owner.file(
          {
            action: "search",
            path: request.path,
            query: request.query,
            mode: request.mode,
            maxMatches: request.max_matches,
            maxBytes: request.max_bytes,
          },
          signal,
        ),
      );
    if (action === "apply_patch")
      return workspaceResult(
        await owner.patch({
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
        await owner.nativeUpload({
          requestId,
          path: request.path,
          expected: expected(request.expected),
          file: nativeReference(request.file),
        }),
      );
    if (action === "write") {
      return workspaceResult(
        await owner.write({
          requestId,
          path: request.path,
          expected: expected(request.expected),
          source: [Buffer.from(request.text)],
        }),
      );
    }
    if (action === "read") {
      const { value, total } = await range(
        owner,
        "stream" in request
          ? { requestId, stream: request.stream, offset: request.offset, length: request.length }
          : { path: request.path, offset: request.offset, length: request.length },
        request.length,
      );
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
      const { value } = await range(owner, { path: request.path, offset: 0 }, request.max_bytes);
      return previewImageBytes(value);
    }
    if (action === "download") {
      const file = await owner.publish({
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
