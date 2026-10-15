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
import { workspaceRequest, workspaceJson as control } from "./client.mjs";
import { workspaceFailure } from "./presentation.mjs";
import { validateOwnerPullRequestInput } from "./github-owner.mjs";
import { scopedCredentialFailureOutcome } from "../../shared/src/codespaces/scoped-credential-types.ts";
import { WORKSPACE_REQUEST_ID_PATTERN } from "../../shared/src/codespaces/workspace-request-id.mjs";
export { workspaceRequest } from "./client.mjs";

function httpFailure(status) {
  const error = new Error("Workspace service rejected the request");
  error.httpStatus = status;
  return error;
}

/** Raw input/file requests still consume the same sanitized owner error projection. */
async function ownerReply(response, requestId) {
  try {
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return response.statusCode >= 400
      ? workspaceFailure({ httpStatus: response.statusCode, details: value }, requestId)
      : value;
  } catch (error) {
    return workspaceFailure(error, requestId);
  }
}

function invalidInput() {
  return Object.assign(new Error("CLI input is invalid"), {
    details: { error: { code: "CLI_REQUEST_INVALID" } },
  });
}

function jsonInput(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw invalidInput();
  }
}

async function nativeDescriptor() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const descriptor = jsonInput(Buffer.concat(chunks).toString("utf8"));
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor))
    throw invalidInput();
  return descriptor;
}

function observationBound(value) {
  if (value === undefined) return undefined;
  const bound = Number(value);
  if (!Number.isSafeInteger(bound) || bound < 1) throw invalidInput();
  return bound;
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
      "moira-workspace pull-request-create [--request-id ws1-UUID] INPUT_JSON_FILE|-\nmoira-workspace pull-request-create --request-id ws1-UUID (collect original create only)\nmoira-workspace pull-request-get NUMBER\nmoira-workspace pull-request-find HEAD BASE\nPR creation retains its original owner receipt; after uncertainty collect that ID and find the same head/base before considering another create.\n",
    );
    stdout.write(
      "moira-workspace exec [--request-id ws1-UUID] [--stdin | --native-stdin] -- COMMAND [ARG...]\nmoira-workspace status|cancel REQUEST_ID\nmoira-workspace output REQUEST_ID [stdout|stderr]\nmoira-workspace stat|read|download PATH\nmoira-workspace write|upload [--request-id ws1-UUID] PATH SOURCE [EXPECTED_JSON]\nmoira-workspace native-upload [--request-id ws1-UUID] PATH [EXPECTED_JSON]\nmoira-workspace publish PATH FILE_NAME [MIME] [MAX_BYTES]\nmoira-workspace preview PATH [MAX_BYTES]\nmoira-workspace search PATH QUERY\nmoira-workspace patch JSON_FILE (optional requestId in JSON)\nNative modes read the native file descriptor JSON from stdin (file_id, download_url, optional file_name/mime_type/size_bytes); never pass its URL as an argument. Publish/preview return the same owner tool payload as MCP. After an unconfirmed mutation collect its original request ID; a confirmed refusal does not imply execution.\n",
    );
    return;
  }
  let result;
  if (action === "exec") {
    let requestId;
    let useStdin = false;
    let useNativeStdin = false;
    let index = 0;
    while (index < rest.length && rest[index] !== "--") {
      if (rest[index] === "--request-id") {
        if (rest[index + 1] === undefined) throw new Error("INVALID_WORKSPACE_REQUEST_ID");
        requestId = rest[index + 1];
        index += 2;
      } else if (rest[index] === "--stdin") {
        useStdin = true;
        index++;
      } else if (rest[index] === "--native-stdin") {
        useNativeStdin = true;
        index++;
      } else break;
    }
    if (rest[index] === "--") index++;
    if (requestId === undefined) requestId = createWorkspaceRequestId();
    workspaceRequestUuid(requestId);
    const argv = rest.slice(index);
    if (!argv.length) throw new Error("COMMAND_REQUIRED");
    if (useStdin && useNativeStdin) throw invalidInput();
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
      const prepared = await ownerReply(response, requestId);
      if (prepared.isError) result = prepared;
    }
    if (!result)
      result = useNativeStdin
        ? await control(socketPath, "POST", "/v1/tools", {
            action: "process_start",
            request: { request_id: requestId, argv, stdin_file: await nativeDescriptor() },
          })
        : await control(socketPath, "POST", "/v1/exec", {
            requestId,
            argv,
            ...(useStdin ? { inputReady: true } : {}),
          });
  } else if (["pull-request-create", "pull-request-get", "pull-request-find"].includes(action)) {
    const ownerAction = action.replaceAll("-", "_");
    let input;
    if (action === "pull-request-create") {
      const explicit = rest[0] === "--request-id";
      const requestId = explicit ? rest[1] : createWorkspaceRequestId();
      workspaceRequestUuid(requestId);
      const file = rest[explicit ? 2 : 0];
      if (!explicit && file === undefined) throw invalidInput();
      stdout.write(`${requestId}\n`);
      let details = {};
      if (file !== undefined) {
        try {
          details = validateOwnerPullRequestInput(
            "pull_request_create",
            file === "-" ? await nativeDescriptor() : jsonInput(await readFile(file, "utf8")),
          );
        } catch {
          throw invalidInput();
        }
      }
      input = { ...details, request_id: requestId };
    } else if (action === "pull-request-get") input = { pull_request_number: Number(rest[0]) };
    else input = { head: rest[0], base: rest[1] };
    result = await control(socketPath, "POST", "/v1/tools", {
      action: ownerAction,
      request: input,
    });
  } else if (action === "native-upload") {
    const requestId = rest[0] === "--request-id" ? rest[1] : createWorkspaceRequestId();
    workspaceRequestUuid(requestId);
    const files = rest[0] === "--request-id" ? rest.slice(2) : rest;
    if (!files[0] || files.length > 2) throw invalidInput();
    stdout.write(`${requestId}\n`);
    result = await control(socketPath, "POST", "/v1/tools", {
      action: "upload",
      request: {
        request_id: requestId,
        path: files[0],
        expected: files[1] ? jsonInput(files[1]) : { exists: false },
        file: await nativeDescriptor(),
      },
    });
  } else if (action === "publish") {
    if (!rest[0] || !rest[1] || rest.length > 4) throw invalidInput();
    result = await control(socketPath, "POST", "/v1/tools", {
      action: "download",
      request: {
        path: rest[0],
        file_name: rest[1],
        mime_type: rest[2] ?? "application/octet-stream",
        max_bytes: observationBound(rest[3]),
      },
    });
  } else if (action === "preview") {
    if (!rest[0] || rest.length > 2) throw invalidInput();
    result = await control(socketPath, "POST", "/v1/tools", {
      action: "preview_image",
      request: { path: rest[0], max_bytes: observationBound(rest[1]) },
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
    result = await ownerReply(response, requestId);
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
  if (result?.isError)
    throw Object.assign(new Error("Workspace owner reported an error"), {
      details: result.structuredContent,
      ownerResult: true,
    });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWorkspaceCli(process.argv.slice(2)).catch((error) => {
    const code = error?.details?.error?.code;
    if (code === "CLI_REQUEST_INVALID") {
      process.stderr.write("CLI input was refused before dispatch. No operation was submitted.\n");
      process.exitCode = 1;
      return;
    }
    const scopedOutcome = scopedCredentialFailureOutcome(code);
    if (scopedOutcome === "unconfirmed") {
      const securityId = error.details?.security_request_id;
      process.stderr.write(
        `Scoped credential operation ${code} is unconfirmed. ${
          WORKSPACE_REQUEST_ID_PATTERN.test(securityId ?? "")
            ? `Collect original security request ${securityId}`
            : "Inspect the owner receipt for its original security request ID"
        }; do not repeat the Git or pull-request operation.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (
      typeof code === "string" &&
      /^[A-Z][A-Z0-9_]{1,79}$/.test(code) &&
      (scopedOutcome === "refused" || (scopedOutcome === null && !/UNKNOWN|UNCONFIRMED/.test(code)))
    ) {
      process.stderr.write(
        `Workspace owner reported ${code}. Inspect the receipt; this confirmed result is not a lost reply.\n`,
      );
      process.exitCode = 1;
      return;
    }
    if (error.ownerResult && code === undefined) {
      process.stderr.write(
        "Workspace owner returned an error result. Inspect the printed reply.\n",
      );
      process.exitCode = 1;
      return;
    }
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
