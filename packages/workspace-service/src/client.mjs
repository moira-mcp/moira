import { request } from "node:http";
import { Buffer } from "node:buffer";

/** Shared private Unix HTTP transport for the owner CLI and tool presentation. */
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

export async function workspaceJson(socketPath, method, path, body) {
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
    throw Object.assign(new Error("Workspace service rejected the request"), {
      httpStatus: response.statusCode,
      details: value,
    });
  }
  return value;
}
