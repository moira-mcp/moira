import { CodespaceResourceError, type CodespaceTransportAvailability } from "./resource-types.js";

export async function requireCodespaceTransportAvailable(
  transport: CodespaceTransportAvailability,
): Promise<void> {
  try {
    if ((await transport.health()).ok === true) return;
  } catch {
    // Health failures have the same bounded public outcome as an unavailable connector.
  }
  throw new CodespaceResourceError(
    "CODESPACE_PROVIDER_UNAVAILABLE",
    "Codespace connector is unavailable",
  );
}
