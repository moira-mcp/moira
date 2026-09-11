import { WorkspaceResourceError, type WorkspaceTransportAvailability } from "./resource-types.js";

export async function requireWorkspaceTransportAvailable(
  transport: WorkspaceTransportAvailability,
): Promise<void> {
  try {
    if ((await transport.health()).ok === true) return;
  } catch {
    // Health failures have the same bounded public outcome as an unavailable connector.
  }
  throw new WorkspaceResourceError(
    "WORKSPACE_PROVIDER_UNAVAILABLE",
    "Workspace connector is unavailable",
  );
}
