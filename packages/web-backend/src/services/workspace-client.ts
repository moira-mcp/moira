import { connect } from "node:net";
import type { WorkspaceBinding, WorkspaceClient, WorkspaceRequest } from "./workspace-router.js";
import { jsonResponse, sendHttp } from "./workspace-router.js";

export const WORKSPACE_ROUTER_SOCKET = "/tmp/moira-workspace-router/router.sock";

/** Observe the authoritative backend registry without dispatching a call to the owner. */
export async function isWorkspaceOwnerConnected(
  binding: WorkspaceBinding,
  socketPath = WORKSPACE_ROUTER_SOCKET,
): Promise<boolean> {
  try {
    const result = await createWorkspaceClient(socketPath, binding.kind).json(
      binding.userId,
      binding.resourceId,
      {
        method: "GET",
        path: "/v1/router/presence",
        headers: {
          "x-moira-resource-generation": String(binding.resourceGeneration),
          "x-moira-authorization-generation": String(binding.authorizationGeneration),
          "x-moira-endpoint-identity":
            binding.kind === "workspace" ? binding.environmentIdentity : binding.connectionId,
        },
      },
    );
    return result.connected === true;
  } catch {
    return false;
  }
}

export function createWorkspaceClient(
  socketPath = WORKSPACE_ROUTER_SOCKET,
  kind: "workspace" | "controller" = "workspace",
): WorkspaceClient {
  const request: WorkspaceClient["request"] = (userId, resourceId, input, signal) => {
    const outgoing: WorkspaceRequest = {
      ...input,
      headers: {
        ...input.headers,
        "x-moira-user-id": userId,
        "x-moira-resource-id": resourceId,
        "x-moira-endpoint-kind": kind,
      },
    };
    return sendHttp(outgoing, signal, (ready) => {
      const socket = connect({ path: socketPath });
      const failed = (error: Error) => {
        socket.off("connect", connected);
        ready(error, socket);
      };
      const connected = () => {
        socket.off("error", failed);
        ready(null, socket);
      };
      socket.once("error", failed);
      socket.once("connect", connected);
    });
  };
  return {
    request,
    async json(userId, resourceId, input, signal) {
      const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
      return jsonResponse(
        await request(
          userId,
          resourceId,
          {
            ...input,
            body,
            headers: {
              ...input.headers,
              "content-type": "application/json",
              ...(body ? { "content-length": String(body.length) } : {}),
            },
          },
          signal,
        ),
      );
    },
  };
}

let client: WorkspaceClient | undefined;
let controllerClient: WorkspaceClient | undefined;
export function createControllerClient(socketPath = WORKSPACE_ROUTER_SOCKET): WorkspaceClient {
  return createWorkspaceClient(socketPath, "controller");
}
export function getControllerClient(): WorkspaceClient {
  return (controllerClient ??= createControllerClient());
}
export function getWorkspaceClient(): WorkspaceClient {
  return (client ??= createWorkspaceClient());
}
