/**
 * MCP Server Release Version
 *
 * Provides the diagnostic application release version advertised by the MCP server and returned
 * alongside catalog upgrade guidance. Catalog invalidation uses MCP_TOOLS_REVISION instead.
 * Reads from root package.json, the single release-version source for all processes.
 */

import { readFileSync } from "fs";
import { join } from "path";

let cachedVersion: string | null = null;

/**
 * Get monorepo version from root package.json
 * Cached after first read for performance
 */
export function getMcpServerVersion(): string | null {
  if (cachedVersion) {
    return cachedVersion;
  }

  // Try multiple paths to support both local dev and Docker
  const possiblePaths = [
    join(process.cwd(), "package.json"), // Running from monorepo root
    "/app/package.json", // Docker container
  ];

  for (const packagePath of possiblePaths) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
      if (packageJson.version) {
        cachedVersion = packageJson.version;
        return cachedVersion;
      }
    } catch {
      // Try next path
    }
  }

  return null;
}

/**
 * @deprecated Use getMcpServerVersion() instead - version is now read from root package.json
 */
export function setMcpServerVersion(_version: string): void {
  // No-op for backward compatibility
}
