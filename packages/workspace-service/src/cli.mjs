import { request } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkspaceRequestId,
  workspaceRequestUuid,
} from "../../shared/src/codespaces/workspace-request-id.ts";
import { Buffer } from "node:buffer";
import process from "node:process";

function httpFailure(status) {
  const error = new Error("Workspace service rejected the request");
  error.httpStatus = status;
  return error;
}

export function workspaceRequest(socketPath, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ socketPath, method, path, headers }, resolve);
    outgoing.once("error", reject);
    if (body && typeof body.pipe === "function") {
      body.once("error", (error) => outgoing.destroy(error));
      body.pipe(outgoing);
    } else outgoing.end(body);
  });
}

async function control(socketPath, method, path, body) {
  const response = await workspaceRequest(
    socketPath,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    { "content-type": "application/json" },
  );
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (response.statusCode >= 400) {
    throw httpFailure(response.statusCode);
  }
  return value;
}

export async function runWorkspaceCli(
  args,
  {
    socketPath = process.env.MOIRA_WORKSPACE_SOCKET ??
      join(homedir(), ".local/state/moira/workspace-service/service.sock"),
    stdout = process.stdout,
  } = {},
) {
  const [action, ...rest] = args;
  if (!action || action === "--help") {
    stdout.write(
      "moira-workspace exec [--request-id ws1-UUID] [--stdin] -- COMMAND [ARG...]\nmoira-workspace status|cancel REQUEST_ID\nmoira-workspace output REQUEST_ID [stdout|stderr]\nmoira-workspace stat|read|download PATH\nmoira-workspace write|upload [--request-id ws1-UUID] PATH SOURCE [EXPECTED_JSON]\nmoira-workspace search PATH QUERY\nmoira-workspace patch JSON_FILE (optional requestId in JSON)\n",
    );
    return;
  }
  let result;
  if (action === "exec") {
    let requestId;
    let useStdin = false;
    let index = 0;
    while (index < rest.length && rest[index] !== "--") {
      if (rest[index] === "--request-id") {
        if (rest[index + 1] === undefined) throw new Error("INVALID_WORKSPACE_REQUEST_ID");
        requestId = rest[index + 1];
        index += 2;
      } else if (rest[index] === "--stdin") {
        useStdin = true;
        index++;
      } else break;
    }
    if (rest[index] === "--") index++;
    if (requestId === undefined) requestId = createWorkspaceRequestId();
    workspaceRequestUuid(requestId);
    const argv = rest.slice(index);
    if (!argv.length) throw new Error("COMMAND_REQUIRED");
    // Publish identity before accepting bytes or starting the operation, so interrupted callers
    // can collect this same local journal entry rather than repeat the command.
    stdout.write(`${requestId}\n`);
    if (useStdin) {
      const response = await workspaceRequest(
        socketPath,
        "PUT",
        `/v1/operations/${requestId}/input`,
        process.stdin,
      );
      for await (const chunk of response) void chunk;
      if (response.statusCode >= 400) throw httpFailure(response.statusCode);
    }
    result = await control(socketPath, "POST", "/v1/exec", {
      requestId,
      argv,
      ...(useStdin ? { inputReady: true } : {}),
    });
  } else if (["status", "cancel"].includes(action)) {
    workspaceRequestUuid(rest[0]);
    result = await control(
      socketPath,
      action === "cancel" ? "POST" : "GET",
      `/v1/operations/${rest[0]}${action === "cancel" ? "/cancel" : ""}`,
    );
  } else if (action === "output" || ["read", "download"].includes(action)) {
    if (action === "output") workspaceRequestUuid(rest[0]);
    const path =
      action === "output"
        ? `/v1/operations/${rest[0]}/output?stream=${encodeURIComponent(rest[1] ?? "stdout")}`
        : `/v1/files/${action}?path=${encodeURIComponent(rest[0])}`;
    const response = await workspaceRequest(socketPath, "GET", path);
    if (response.statusCode >= 400) {
      response.resume();
      throw httpFailure(response.statusCode);
    }
    await new Promise((resolve, reject) => {
      response.once("error", reject);
      stdout.once("error", reject);
      response.once("end", resolve);
      response.pipe(stdout, { end: false });
    });
    return;
  } else if (["write", "upload"].includes(action)) {
    const requestId = rest[0] === "--request-id" ? rest[1] : createWorkspaceRequestId();
    workspaceRequestUuid(requestId);
    const files = rest[0] === "--request-id" ? rest.slice(2) : rest;
    stdout.write(`${requestId}\n`);
    const expected = files[2] ? JSON.parse(files[2]) : { exists: false };
    const response = await workspaceRequest(
      socketPath,
      "PUT",
      `/v1/files/${action}?requestId=${requestId}&path=${encodeURIComponent(files[0])}`,
      files[1] === "-" ? process.stdin : createReadStream(files[1]),
      { "x-moira-expected": JSON.stringify(expected) },
    );
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (response.statusCode >= 400) throw httpFailure(response.statusCode);
  } else if (action === "stat")
    result = await control(socketPath, "POST", "/v1/files/stat", { path: rest[0] });
  else if (action === "search")
    result = await control(socketPath, "POST", "/v1/files/search", {
      path: rest[0],
      query: rest[1],
      mode: "literal",
    });
  else if (action === "patch") {
    const body = JSON.parse(await readFile(rest[0], "utf8"));
    const requestId = body.requestId === undefined ? createWorkspaceRequestId() : body.requestId;
    workspaceRequestUuid(requestId);
    stdout.write(`${requestId}\n`);
    result = await control(socketPath, "POST", "/v1/files/patch", { ...body, requestId });
  } else throw new Error("UNKNOWN_COMMAND");
  stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkspaceCli(process.argv.slice(2)).catch((error) => {
    const diagnostic = Number.isInteger(error.httpStatus)
      ? `HTTP error status ${error.httpStatus}`
      : ["ECONNREFUSED", "ENOENT", "ECONNRESET", "EPIPE"].includes(error.code)
        ? `transport ${error.code}`
        : "process or protocol failure";
    process.stderr.write(
      `Workspace request could not be confirmed (${diagnostic}). For a mutation, collect the original request ID before retrying.\n`,
    );
    process.exitCode = 1;
  });
}
