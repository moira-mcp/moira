import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import {
  encodeReference,
  decodeReference,
  isReference,
} from "../../shared/src/codespaces/workspace-references.mjs";
import {
  createWorkspaceRequestId,
  WORKSPACE_REQUEST_ID_PATTERN,
} from "../../shared/src/codespaces/workspace-request-id.mjs";
import { canonicalJson } from "../../shared/src/utils/canonical-json.ts";
import { createSemanticFiles, semanticRefusal, positive } from "./semantic-files.mjs";
import { utf8Window } from "./utf8-window.mjs";
import { previewImageBytes } from "./image-preview.mjs";
import { operationState } from "../../shared/src/codespaces/workspace-operation-state.mjs";
import { WORKSPACE_TOOL_SCHEMAS } from "../../shared/src/codespaces/workspace-tool-schemas.ts";
import { safeRelativePath } from "./file-primitives.mjs";

const same = (left, right) => canonicalJson(left) === canonicalJson(right);
const native = (file) => ({
  fileId: file.file_id,
  downloadUrl: file.download_url,
  ...(file.file_name === undefined ? {} : { fileName: file.file_name }),
  ...(file.mime_type === undefined ? {} : { mimeType: file.mime_type }),
  ...(file.size_bytes === undefined ? {} : { declaredSize: file.size_bytes }),
});
const kinds = {
  exec: "command",
  write: "file-change",
  "native-upload": "file-change",
  patch: "file-change",
  "pull-request": "pull-request",
  communication: "delivery",
  "security-acquisition": "unknown",
};
const commandFields = (data) =>
  Object.fromEntries(
    [
      "state",
      "reason",
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
const mimeTypes = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".csv": "text/csv",
};
function intentDescription(action, request) {
  if (action.startsWith("command_")) {
    const executable = request.command.argv ? basename(request.command.argv[0]) : undefined;
    const label =
      executable && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(executable)
        ? `Run ${executable}`
        : request.command.script
          ? "Run script"
          : "Run command";
    return request.session ? `${label} in session ${request.session.name}` : label;
  }
  if (action === "session_close") return `Close session ${request.name}`;
  if (action === "file_patch")
    return `Patch ${safeRelativePath(request.files[0].path)}${request.files.length > 1 ? " (multiple files)" : ""}`;
  if (action === "pull_request_create")
    return `Create pull request ${request.head} → ${request.base}`;
  if (request.path) return `${action} ${safeRelativePath(request.path)}`;
  if (action === "file_upload")
    return `Upload ${request.target.create ? safeRelativePath(request.target.create.path) : decodeReference(request.target.replace.file, "file").path}`;
  return action;
}
const fields = {
  operation_find: ["owner", "kind", "query", "cursor"],
  operation_get: ["reference"],
  process_output: ["process", "stream", "cursor", "max_bytes"],
  process_stop: ["process"],
  file_stat: ["path"],
  file_read: ["path", "window", "max_bytes"],
  code_search: ["path", "query", "mode", "max_matches", "max_bytes"],
  file_preview: ["path", "max_bytes"],
  file_download: ["path", "file_name", "mime_type", "max_bytes"],
  file_create: ["path", "text"],
  file_replace: ["path", "text", "expected"],
  file_patch: ["files"],
  file_upload: ["target", "file"],
  command_run: [
    "command",
    "session",
    "cwd",
    "env",
    "stdin_text",
    "background",
    "timeout_seconds",
    "max_stdout_bytes",
    "max_stderr_bytes",
  ],
  command_run_native: [
    "command",
    "session",
    "cwd",
    "env",
    "stdin_file",
    "background",
    "timeout_seconds",
    "max_stdout_bytes",
    "max_stderr_bytes",
  ],
  session_close: ["name"],
  pull_request_read: ["query"],
  pull_request_create: ["head", "base", "title", "body", "draft"],
  communication_deliver: ["owner", "file", "kind", "message", "format", "silent", "channel"],
  communication_deliver_publication: [
    "publication",
    "kind",
    "message",
    "format",
    "silent",
    "channel",
  ],
};

/** Semantic adapter inside the original owner; it never owns a second result or invocation store. */
export function createSemanticOwner({
  owner,
  engine,
  binding,
  ownerSelector,
  publicationScope,
  readAccepted,
  readInput,
  readResult,
  listRequests,
}) {
  const selector = () => {
    if (!ownerSelector) semanticRefusal("OWNER_REFERENCE_UNAVAILABLE");
    return ownerSelector;
  };
  const checkOwner = (value) => {
    if (!same(value, selector())) semanticRefusal("FOREIGN_OWNER_REFERENCE");
  };
  const files = createSemanticFiles({ engine, owner, selector, binding });
  const processRef = (requestId) => encodeReference("process", { owner: selector(), requestId });
  const operationRef = (requestId, kind) =>
    encodeReference("operation", { owner: selector(), requestId, kind });
  const decodeOperation = (reference) => {
    const value = decodeReference(
      reference,
      isReference(reference, "process") ? "process" : "operation",
    );
    checkOwner(value.owner);
    return value;
  };
  const project = async (requestId, requestedKind, data) => {
    const accepted = await readAccepted(requestId);
    const kind = accepted?.intent?.kind ?? kinds[accepted?.kind] ?? requestedKind ?? "unknown";
    const description =
      accepted?.intent?.description ?? (kind === "unknown" ? "Original owner operation" : kind);
    const operation = operationRef(requestId, kind);
    const rawState = data.state;
    const state = operationState(data);
    const result =
      kind === "command" || kind === "session"
        ? commandFields(data)
        : Object.fromEntries(
            Object.entries(data).filter(
              ([key]) =>
                ![
                  "requestId",
                  "request_id",
                  "security_request_id",
                  "requestDigest",
                  "remoteMarker",
                ].includes(key),
            ),
          );
    const ok =
      !["failed", "cancelled", "timed_out", "not_started"].includes(rawState) &&
      !data.error &&
      data.outcome?.ok !== false;
    return {
      operation,
      kind,
      description,
      state,
      ...(kind === "command" ? { process: processRef(requestId) } : {}),
      ...(state === "completed"
        ? {
            outcome:
              data.outcome ??
              (ok
                ? { ok: true, result }
                : {
                    ok: false,
                    error: data.error ?? {
                      code: data.reason ?? "OWNER_OPERATION_REFUSED",
                      message: "The original owner operation did not succeed.",
                    },
                    result,
                  }),
          }
        : {}),
      ...(state === "unconfirmed" ? { original: result } : {}),
      ...(data.security_request_id
        ? { security_operation: operationRef(data.security_request_id, "unknown") }
        : {}),
    };
  };
  const find = async (request = {}) => {
    if (request.owner) {
      const decoded =
        typeof request.owner === "string"
          ? decodeReference(
              request.owner,
              isReference(request.owner, "controller") ? "controller" : "workspace",
            )
          : request.owner;
      if (decoded.kind) checkOwner(decoded);
      else checkWorkspace(decoded);
    }
    const keys = (await listRequests())
      .filter((key) => WORKSPACE_REQUEST_ID_PATTERN.test(key))
      .sort();
    const start = request.cursor === undefined ? 0 : keys.indexOf(request.cursor) + 1;
    if (request.cursor !== undefined && !start) semanticRefusal("INVALID_OPERATION_CURSOR");
    const operations = [];
    let last;
    for (const requestId of keys.slice(start)) {
      last = requestId;
      const accepted = await readAccepted(requestId);
      if (!accepted) continue;
      const kind = accepted.intent?.kind ?? kinds[accepted.kind] ?? "unknown";
      const description = accepted.intent?.description ?? "Original owner operation";
      if (request.kind && request.kind !== kind) continue;
      if (request.query && !description.toLowerCase().includes(request.query.toLowerCase()))
        continue;
      // Listing metadata does not collect provider/security operations or clean their custody.
      const result = await readResult(requestId, accepted);
      operations.push({
        operation: operationRef(requestId, kind),
        kind,
        description,
        state: operationState(result),
        ...(accepted.intent?.createdAt ? { created_at: accepted.intent.createdAt } : {}),
        ...(kind === "command" ? { process: processRef(requestId) } : {}),
      });
      if (operations.length === 50) break;
    }
    return {
      operations,
      ...(last && keys.indexOf(last) < keys.length - 1 ? { next_cursor: last } : {}),
    };
  };
  const checkWorkspace = (workspace) => {
    const selected =
      typeof workspace === "string" ? decodeReference(workspace, "workspace") : workspace;
    const address = selector(),
      scope = publicationScope();
    if (
      (address.kind === "github" && selected.resourceId !== address.resourceId) ||
      (address.kind === "local" && selected.provider !== "local-sandboxes") ||
      (address.kind === "local" && selected.deviceId && selected.deviceId !== address.deviceId) ||
      (scope && selected.resourceId !== scope.resourceId)
    )
      semanticRefusal("FOREIGN_OWNER_REFERENCE");
  };
  const output = async (reference, stream, cursor, maximum) => {
    const selected = decodeOperation(reference);
    const process = processRef(selected.requestId);
    let offset = 0;
    if (cursor) {
      const value = decodeReference(cursor, "output-cursor");
      if (value.process !== process || value.stream !== stream)
        semanticRefusal("OUTPUT_CURSOR_CONFLICT");
      offset = value.offset;
    }
    if (!["stdout", "stderr"].includes(stream)) semanticRefusal("INVALID_STREAM");
    maximum = positive(maximum, 64 * 1024);
    const status = await owner.inspect(selected.requestId);
    const read = await owner.outputRange(
      selected.requestId,
      stream,
      offset,
      maximum + 3,
      async ({ body, total }) => {
        const parts = [];
        for await (const bytes of body) parts.push(bytes);
        return { bytes: Buffer.concat(parts), total };
      },
    );
    const terminal = [
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "not_started",
      "interrupted",
    ].includes(status.state);
    const decoded = utf8Window(read.bytes, maximum, { terminal });
    if (decoded.minimum_bytes)
      semanticRefusal("TEXT_WINDOW_TOO_SMALL", { minimum_bytes: decoded.minimum_bytes });
    if (decoded.binary) semanticRefusal("BINARY_OUTPUT_REQUIRES_DOWNLOAD");
    const next = offset + decoded.bytes;
    return {
      process,
      stream,
      text: decoded.text,
      total_bytes: read.total,
      ...(decoded.pending_utf8 ? { pending_utf8: true } : {}),
      ...(!terminal || next < read.total
        ? { next_cursor: encodeReference("output-cursor", { process, stream, offset: next }) }
        : {}),
    };
  };
  const execute = async (action, request = {}, { requestId, signal, source } = {}) => {
    let schema = fields[action] && WORKSPACE_TOOL_SCHEMAS[action];
    if (!schema) semanticRefusal("INVALID_SEMANTIC_REQUEST");
    // The actual local Unix owner is the guest CLI's implicit workspace selection.
    if (schema.shape.workspace) schema = schema.partial({ workspace: true });
    if (action === "operation_find") schema = schema.partial({ owner: true });
    if (source && action === "file_upload") schema = schema.omit({ file: true });
    const parsed = schema.safeParse(request);
    if (!parsed.success || (source && action === "command_run" && request.stdin_text !== undefined))
      semanticRefusal("INVALID_SEMANTIC_REQUEST");
    request = parsed.data;
    selector();
    if (request.workspace) checkWorkspace(request.workspace);
    if (action === "operation_find") return find(request);
    if (action === "operation_get") {
      const selected = decodeOperation(request.reference);
      return project(selected.requestId, selected.kind, await owner.inspect(selected.requestId));
    }
    if (action === "process_output")
      return output(request.process, request.stream, request.cursor, request.max_bytes);
    if (action === "process_stop") {
      const selected = decodeOperation(request.process);
      return project(selected.requestId, "command", await owner.cancel(selected.requestId));
    }
    if (action === "file_stat") return files.stat(request);
    if (action === "file_read") return files.read(request);
    if (action === "code_search")
      return owner.file(
        {
          action: "search",
          path: request.path,
          query: request.query,
          mode: request.mode ?? "literal",
          maxMatches: request.max_matches,
          maxBytes: request.max_bytes,
        },
        signal,
      );
    if (action === "file_preview") {
      const chunks = [];
      await owner.fileRange(request.path, 0, null, async ({ body, total }) => {
        if (request.max_bytes !== undefined && total > positive(request.max_bytes))
          semanticRefusal("PREVIEW_WINDOW_EXCEEDED");
        for await (const bytes of body) chunks.push(bytes);
      });
      return previewImageBytes(Buffer.concat(chunks));
    }
    if (action === "file_download") {
      const file = await owner.publish({
        path: request.path,
        fileName: request.file_name ?? basename(request.path),
        mimeType:
          request.mime_type ??
          mimeTypes[extname(request.path).toLowerCase()] ??
          "application/octet-stream",
        ...(request.max_bytes === undefined ? {} : { maxBytes: request.max_bytes }),
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
    if (action === "pull_request_read")
      return owner.pullRequestAction({
        action: request.query.number !== undefined ? "pull_request_get" : "pull_request_find",
        input: request.query,
      });
    requestId ??= createWorkspaceRequestId();
    if (!WORKSPACE_REQUEST_ID_PATTERN.test(requestId)) semanticRefusal("INVALID_REQUEST_ID");
    const kind = action.startsWith("command_")
      ? "command"
      : action === "session_close"
        ? "session"
        : action.startsWith("file_")
          ? "file-change"
          : action === "pull_request_create"
            ? "pull-request"
            : action.startsWith("communication_")
              ? "delivery"
              : undefined;
    if (!kind) semanticRefusal("UNSUPPORTED_SEMANTIC_ACTION");
    const immutable = globalThis.structuredClone(request);
    for (const field of ["file", "stdin_file"])
      if (immutable[field]) delete immutable[field].download_url;
    const intent = {
      kind,
      description: intentDescription(action, request),
      digest: createHash("sha256")
        .update(canonicalJson({ action, request: immutable }))
        .digest("hex"),
    };
    // An internally retained invocation is collected before any fresh file observation/source work.
    const accepted = await readAccepted(requestId);
    if (accepted && kind !== "delivery") {
      if (accepted.intent?.digest !== intent.digest) semanticRefusal("REQUEST_ID_CONFLICT");
      if (source) {
        const originalInput = action === "file_upload" ? accepted : await readInput(requestId);
        const hash = createHash("sha256");
        let size = 0;
        for await (const bytes of source) {
          hash.update(bytes);
          size += bytes.length;
        }
        if (
          !originalInput ||
          originalInput.size !== size ||
          originalInput.sha256 !== hash.digest("hex")
        )
          semanticRefusal("REQUEST_ID_CONFLICT");
      }
      return project(requestId, kind, await owner.inspect(requestId));
    }
    let data;
    if (action === "command_run" || action === "command_run_native" || action === "session_close") {
      const command = request.command ?? {};
      if (source) await owner.input(requestId, source);
      data = await owner.execute({
        requestId,
        ...command,
        cwd: request.cwd,
        env: request.env,
        ...(request.session
          ? { session: request.session.name, sessionStart: request.session.mode === "open" }
          : action !== "session_close" && command.script
            ? { session: `command-${requestId.slice(4)}`, sessionStart: true, sessionEnd: true }
            : {}),
        ...(action === "session_close" ? { session: request.name, sessionEnd: true } : {}),
        ...(source
          ? { inputReady: true }
          : action === "command_run_native"
            ? { nativeInput: native(request.stdin_file) }
            : { stdinText: request.stdin_text ?? "" }),
        ...(request.timeout_seconds === undefined
          ? {}
          : { timeoutMs: request.timeout_seconds * 1000 }),
        intent,
      });
      if (!request.background && action !== "session_close")
        data = await owner.observe(requestId, 10_000, signal);
      const result = await project(requestId, kind, data);
      if (
        action !== "session_close" &&
        !["absent", "unknown", "not_started"].includes(data.state)
      ) {
        for (const stream of ["stdout", "stderr"]) {
          if (data[`${stream}Bytes`] === undefined) continue;
          const value = await output(
            processRef(requestId),
            stream,
            undefined,
            request[`max_${stream}_bytes`],
          );
          result[stream] = value.text;
          if (value.next_cursor) result[`${stream}_cursor`] = value.next_cursor;
          if (value.pending_utf8) result[`${stream}_pending_utf8`] = true;
        }
      }
      return result;
    }
    if (action === "file_create") {
      if (typeof request.text !== "string" || !request.text.isWellFormed())
        semanticRefusal("INVALID_TEXT");
      data = await owner.write({
        requestId,
        path: request.path,
        expected: { exists: false },
        source: [Buffer.from(request.text)],
        intent,
      });
    } else if (action === "file_replace") data = await files.replace(request, requestId, intent);
    else if (action === "file_patch") data = await files.patch(request, requestId, intent);
    else if (action === "file_upload") {
      const path =
        request.target.create?.path ?? decodeReference(request.target.replace.file, "file").path;
      const expected = request.target.create
        ? { exists: false }
        : files.expectedFile(request.target.replace.file, path);
      data = source
        ? await owner.write({ requestId, path, expected, source, intent })
        : await owner.nativeUpload({
            requestId,
            path,
            expected,
            file: native(request.file),
            intent,
          });
    } else if (action === "pull_request_create")
      data = await owner.pullRequestAction({
        action: "pull_request_create",
        requestId,
        input: Object.fromEntries(
          ["head", "base", "title", "body", "draft"]
            .filter((key) => request[key] !== undefined)
            .map((key) => [key, request[key]]),
        ),
        intent,
      });
    else if (action === "communication_deliver" || action === "communication_deliver_publication")
      data = await owner.submitCommunication({
        action: "deliver",
        requestId,
        kind: request.kind,
        text: request.message ?? "",
        format: request.format,
        silent: request.silent,
        ...(request.channel ? { channelIds: [request.channel] } : {}),
        source:
          action === "communication_deliver"
            ? { type: "native", file: native(request.file) }
            : { type: "publication", referenceId: request.publication },
      });
    return project(requestId, kind, data);
  };
  const effectKind = (action) =>
    action.startsWith("command_")
      ? "command"
      : action === "session_close"
        ? "session"
        : ["file_create", "file_replace", "file_patch", "file_upload"].includes(action)
          ? "file-change"
          : action === "pull_request_create"
            ? "pull-request"
            : action.startsWith("communication_deliver")
              ? "delivery"
              : null;
  return {
    execute: async (action, request, options = {}) => {
      const kind = effectKind(action);
      const requestId = kind
        ? (options.requestId ?? createWorkspaceRequestId())
        : options.requestId;
      try {
        return await execute(action, request, { ...options, requestId });
      } catch (error) {
        if (kind && ownerSelector) error.operation = operationRef(requestId, kind);
        if (ownerSelector && WORKSPACE_REQUEST_ID_PATTERN.test(error.securityRequestId ?? ""))
          error.securityOperation = operationRef(error.securityRequestId, "unknown");
        throw error;
      }
    },
    find,
  };
}
