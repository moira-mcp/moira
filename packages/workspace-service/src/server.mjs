import { createServer } from "node:http";
import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Buffer } from "node:buffer";
import process from "node:process";
import { URL } from "node:url";
import { once } from "node:events";
import { connect } from "node:net";
import { createWorkspaceOwner } from "./owner.mjs";
import { serveOwnerPublication } from "./publications.mjs";
import { executeOwnerTool } from "./presentation.mjs";
import {
  readOwnerFrame,
  settleOwnerFrame,
  OWNER_STREAM_CONTENT_TYPE,
} from "../../shared/src/http/owner-stream-frame.mjs";
import { readOwnerJsonBody as jsonBody } from "../../shared/src/http/request-body.mjs";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.ts";

function refuse(code, status = 400) {
  throw Object.assign(new Error(code), { publicCode: code, status });
}
function json(response, value, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
function expectedContentSize(request) {
  const value = request.headers["x-moira-content-size"];
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value))
  )
    refuse("INVALID_CONTENT_SIZE");
  return Number(value);
}

export async function startWorkspaceService(options) {
  const { socketPath } = options;
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  const stale = await lstat(socketPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stale) {
    if (!stale.isSocket() || stale.uid !== process.getuid?.()) refuse("UNSAFE_SOCKET", 409);
    await new Promise((resolve, reject) => {
      const probe = connect(socketPath);
      probe.once("connect", () => {
        probe.destroy();
        reject(new Error("WORKSPACE_SERVICE_ALREADY_RUNNING"));
      });
      probe.once("error", (error) =>
        ["ECONNREFUSED", "ENOENT"].includes(error.code) ? resolve() : reject(error),
      );
    });
    const current = await lstat(socketPath).catch(() => null);
    if (current && (current.dev !== stale.dev || current.ino !== stale.ino))
      refuse("SOCKET_OWNER_CHANGED", 409);
    if (current) await rm(socketPath);
  }
  const owner = await createWorkspaceOwner(options);
  const activeRequests = new Map();
  let closing;
  const sendRange = async (response, operation) => {
    const result = await operation(async ({ body, total, size }) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": size,
        "x-moira-range-size": size,
        "x-moira-total-size": total,
      });
      let final = Buffer.alloc(0);
      for await (const chunk of body) {
        if (response.destroyed) break;
        if (final.length)
          await new Promise((done, reject) => {
            const closed = () => done();
            response.once("close", closed);
            response.write(final, (error) => {
              response.off("close", closed);
              if (error && !response.destroyed) reject(error);
              else done();
            });
          });
        final = chunk;
      }
      return { final };
    });
    response.end(result.final);
  };
  const server = createServer(async (request, response) => {
    let settled;
    const completion = new Promise((resolve) => {
      settled = resolve;
    });
    activeRequests.set(request, { response, completion });
    try {
      const url = new URL(request.url, "http://workspace");
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname.startsWith("/v1/communication")) {
        if (
          request.method === "GET" &&
          /^\/v1\/communication\/operations\/ws1-[a-f0-9-]+$/.test(url.pathname)
        ) {
          return json(response, await owner.inspectCommunication(parts.at(-1)));
        }
        if (request.method === "POST" && url.pathname === "/v1/communication")
          return json(response, await owner.submitCommunication(await jsonBody(request)));
        if (request.method === "POST" && url.pathname === "/v1/communication/stream") {
          if (request.headers["content-type"] !== OWNER_STREAM_CONTENT_TYPE)
            refuse("COMMUNICATION_REQUEST_INVALID", 400);
          const frame = await readOwnerFrame(request);
          try {
            if (frame.control?.source?.type !== "stream")
              refuse("COMMUNICATION_REQUEST_INVALID", 400);
            const result = await owner.submitCommunication(frame.control, { stream: frame.body });
            settleOwnerFrame(request, response, frame);
            return json(response, result);
          } finally {
            settleOwnerFrame(request, response, frame);
          }
        }
        refuse("COMMUNICATION_REQUEST_INVALID", 404);
      }
      if (request.method === "GET" && url.pathname === "/v1/health")
        return json(response, {
          ...(await owner.health()),
          ...(options.remoteStatus ? { remote: options.remoteStatus() } : {}),
        });
      if (request.method === "POST" && url.pathname === "/v1/configuration/reload") {
        if (!options.reloadConfiguration) refuse("NOT_FOUND", 404);
        await options.reloadConfiguration();
        return json(response, await owner.health());
      }
      if (request.method === "POST" && url.pathname === "/v1/tools") {
        const controller = new globalThis.AbortController();
        const closed = () => controller.abort();
        response.once("close", closed);
        try {
          if (request.headers["content-type"] === OWNER_STREAM_CONTENT_TYPE) {
            const frame = await readOwnerFrame(request);
            try {
              if (!["file_upload", "command_run"].includes(frame.control?.action))
                refuse("INVALID_STREAM_ACTION");
              const result = await executeOwnerTool(owner, frame.control, {
                signal: controller.signal,
                source: frame.body,
              });
              settleOwnerFrame(request, response, frame);
              return json(response, result);
            } finally {
              settleOwnerFrame(request, response, frame);
            }
          }
          return json(
            response,
            await executeOwnerTool(owner, await jsonBody(request), { signal: controller.signal }),
          );
        } finally {
          response.off("close", closed);
        }
      }
      if (request.method === "POST" && url.pathname === "/v1/github/pull-requests") {
        return json(response, await owner.pullRequestAction(await jsonBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/files/publish")
        return json(response, await owner.publish(await jsonBody(request)));
      if (
        request.method === "GET" &&
        parts[0] === "v1" &&
        parts[1] === "publications" &&
        parts.length === 3
      ) {
        await serveOwnerPublication(owner.openPublication, parts[2], response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/native-upload") {
        return json(response, await owner.nativeUpload(await jsonBody(request)));
      }
      if (request.method === "POST" && url.pathname === "/v1/exec") {
        return json(response, await owner.execute(await jsonBody(request)));
      }
      if (parts[0] === "v1" && parts[1] === "operations") {
        const requestId = parts[2];
        if (request.method === "PUT" && parts[3] === "input")
          return json(
            response,
            await owner.input(requestId, request, expectedContentSize(request)),
          );
        if (request.method === "POST" && parts[3] === "cancel") {
          const result = await owner.cancel(requestId);
          return json(response, result);
        }
        if (request.method === "GET" && parts[3] === "output") {
          const name = url.searchParams.get("stream") ?? "stdout";
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const length = url.searchParams.has("length")
            ? Number(url.searchParams.get("length"))
            : null;
          await sendRange(response, (consume) =>
            owner.outputRange(requestId, name, offset, length, consume),
          );
          return;
        }
        if (request.method === "GET" && parts.length === 3) {
          const controller = new globalThis.AbortController();
          const closed = () => controller.abort();
          response.once("close", closed);
          try {
            return json(
              response,
              await owner.observe(
                requestId,
                Number(url.searchParams.get("waitMs") ?? 0),
                controller.signal,
              ),
            );
          } finally {
            response.off("close", closed);
          }
        }
      }
      if (parts[0] === "v1" && parts[1] === "files") {
        if (request.method === "GET" && ["read", "download"].includes(parts[2])) {
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const length = url.searchParams.has("length")
            ? Number(url.searchParams.get("length"))
            : null;
          await sendRange(response, (consume) =>
            owner.fileRange(url.searchParams.get("path"), offset, length, consume),
          );
          return;
        }
        if (request.method === "PUT" && ["write", "upload"].includes(parts[2])) {
          let expected;
          try {
            expected = JSON.parse(request.headers["x-moira-expected"] ?? "");
          } catch {
            refuse("INVALID_PRECONDITION");
          }
          return json(
            response,
            await owner.write({
              requestId: url.searchParams.get("requestId"),
              path: url.searchParams.get("path"),
              expected,
              source: request,
              expectedSize: expectedContentSize(request),
            }),
          );
        }
        if (request.method === "POST" && ["stat", "search", "patch"].includes(parts[2])) {
          const body = await jsonBody(request);
          if (parts[2] !== "patch") {
            const controller = new globalThis.AbortController();
            const closed = () => controller.abort();
            response.once("close", closed);
            try {
              return json(
                response,
                await owner.file({ ...body, action: parts[2] }, controller.signal),
              );
            } finally {
              response.off("close", closed);
            }
          }
          return json(response, await owner.patch(body));
        }
      }
      refuse("NOT_FOUND", 404);
    } catch (error) {
      if (
        request.url === "/v1/communication/stream" ||
        (request.url === "/v1/tools" &&
          request.headers["content-type"] === OWNER_STREAM_CONTENT_TYPE)
      )
        settleOwnerFrame(request, response);
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(
        response,
        {
          error: {
            code:
              error.publicCode ??
              (error.code === "ENOENT"
                ? "NOT_FOUND"
                : error.fileReason
                  ? "FILE_REJECTED"
                  : "WORKSPACE_OPERATION_ERROR"),
            ...(error.fileReason ? { reason: error.fileReason } : {}),
          },
          ...(scopedCredentialFailureOutcome(error.publicCode) !== null &&
          WORKSPACE_REQUEST_ID_PATTERN.test(error.securityRequestId ?? "")
            ? { security_request_id: error.securityRequestId }
            : {}),
        },
        error.status ?? (error.code === "ENOENT" ? 404 : 409),
      );
    } finally {
      activeRequests.delete(request);
      settled();
    }
  });
  server.requestTimeout = 0;
  server.timeout = 0;
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  const socketIdentity = await lstat(socketPath);
  return {
    server,
    owner,
    socketPath,
    close: () => {
      if (closing) return closing;
      // Fence before aborting preparation. Detached accepted commands retain their
      // journals and execution lifetime independently of these HTTP observers.
      closing = Promise.resolve().then(async () => {
        const httpClosed = new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        const ownerClosed = owner.close();
        const requests = [...activeRequests.entries()];
        for (const [request, { response }] of requests) {
          // Release stalled raw inputs and read observers, while allowing a fully
          // received native preparation to return its confirmed SOURCE_REFUSED.
          if (!request.complete || request.method === "GET") response.destroy();
        }
        await Promise.all(requests.map(([, { completion }]) => completion));
        await ownerClosed;
        server.closeAllConnections();
        await httpClosed;
        const current = await lstat(socketPath).catch(() => null);
        if (current?.dev === socketIdentity.dev && current?.ino === socketIdentity.ino)
          await rm(socketPath);
      });
      return closing;
    },
  };
}
