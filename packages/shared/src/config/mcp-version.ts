/**
 * MCP Server Version Management (#196)
 *
 * Provides access to monorepo version for OAuth token creation and version checks.
 * Reads from root package.json - single source of truth for all processes.
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
