import {
  canonicalJson,
  getSqliteInstance,
  WorkspaceAuthRepository,
  type CommunicationOwnerScope,
} from "@mcp-moira/shared";
import { getLocalDeviceService } from "./codespace-services.js";
import { authorizeWorkspaceAgentCredential } from "./workspace-services.js";
import { isWorkspaceOwnerConnected } from "./workspace-client.js";

/** Resolve an existing private actor before accepting an unbounded framed metadata stream. */
export async function authenticateCommunicationOwner(bearer: string): Promise<void> {
  let workspace;
  try {
    workspace = new WorkspaceAuthRepository(getSqliteInstance()).authenticate(bearer);
  } catch {
    // Device and workspace credentials have separate existing stores, never an MCP fallback.
  }
  if (workspace) {
    await authorizeWorkspaceAgentCredential(
      bearer,
      workspace.resourceId,
      workspace.resourceGeneration,
    );
    return;
  }
  const device = getLocalDeviceService().authenticateDevice(bearer);
  await authorizeCommunicationOwner(bearer, {
    kind: "controller",
    userId: device.userId,
    deviceId: device.deviceId,
    deviceGeneration: device.deviceGeneration,
    connectionId: device.connectionId,
  });
}

/** Authenticates the actual source actor; a valid user MCP credential is not an owner credential. */
export async function authorizeCommunicationOwner(
  bearer: string,
  scope: CommunicationOwnerScope,
): Promise<string> {
  if (scope.kind === "workspace") {
    const binding = await authorizeWorkspaceAgentCredential(
      bearer,
      scope.resourceId,
      scope.resourceGeneration,
    );
    const actual = {
      kind: "workspace",
      resourceId: binding.resourceId,
      resourceGeneration: binding.resourceGeneration,
      authorizationGeneration: binding.authorizationGeneration,
      environmentIdentity: binding.environmentIdentity,
    };
    if (canonicalJson(actual) !== canonicalJson(scope)) throw new Error("owner_scope_refused");
    return binding.userId;
  }
  const device = getLocalDeviceService().authenticateDevice(bearer);
  if (
    device.userId !== scope.userId ||
    device.deviceId !== scope.deviceId ||
    device.deviceGeneration !== scope.deviceGeneration ||
    device.connectionId !== scope.connectionId
  )
    throw new Error("owner_scope_refused");
  if (
    !(await isWorkspaceOwnerConnected({
      kind: "controller",
      userId: device.userId,
      resourceId: device.deviceId,
      resourceGeneration: device.deviceGeneration,
      authorizationGeneration: device.deviceGeneration,
      connectionId: device.connectionId,
      expiresAt: null,
    }))
  )
    throw new Error("owner_unavailable");
  return device.userId;
}

export async function authorizeControllerPublication(deviceId: string): Promise<string> {
  const row = getSqliteInstance()
    .prepare("SELECT userId FROM codespaceLocalDevice WHERE id=?")
    .get(deviceId) as { userId: string } | undefined;
  if (!row) throw new Error("owner_unavailable");
  const device = getLocalDeviceService().getDeviceIdentity(row.userId, deviceId);
  if (
    device.status !== "active" ||
    !(await isWorkspaceOwnerConnected({
      kind: "controller",
      userId: device.userId,
      resourceId: device.deviceId,
      resourceGeneration: device.deviceGeneration,
      authorizationGeneration: device.deviceGeneration,
      connectionId: device.connectionId,
      expiresAt: null,
    }))
  )
    throw new Error("owner_unavailable");
  return row.userId;
}
