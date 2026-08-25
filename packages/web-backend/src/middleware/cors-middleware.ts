/**
 * CORS Middleware Configuration
 * Configures Cross-Origin Resource Sharing for frontend-backend communication.
 *
 * Allowed origins are an explicit allowlist rather than a reflect-any policy.
 * The allowlist is assembled from:
 *   - the application's own public origin (`getBaseUrl()`, from MOIRA_HOST)
 *   - `EXTRA_TRUSTED_ORIGINS` (shared with Better Auth trusted origins)
 *   - `CORS_ALLOWED_ORIGINS` (explicit deploy-time list)
 *   - localhost dev origins (safe default so local self-host works out of the box)
 *
 * Requests without an `Origin` header (server-to-server, curl, same-origin
 * navigation) are allowed — CORS only governs cross-origin browser requests.
 */

import cors from "cors";
import { CorsOptions } from "cors";
import { getBrowserOriginAllowlist, isBrowserOriginAllowed } from "@mcp-moira/shared";

/**
 * Decide whether an Origin is allowed.
 */
export function isOriginAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  return isBrowserOriginAllowed(origin, allowlist);
}

/**
 * Setup CORS middleware with an explicit origin allowlist.
 */
export function setupCorsMiddleware() {
  const allowlist = getBrowserOriginAllowlist();

  return cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, allowlist)) {
        callback(null, true);
      } else {
        // Reject without throwing: the response simply lacks CORS headers, so
        // the browser blocks it. Non-browser clients are unaffected.
        callback(null, false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: "*",
    exposedHeaders: ["WWW-Authenticate", "Set-Cookie"],
    optionsSuccessStatus: 200,
  });
}

export function getHealthCorsOptions(): CorsOptions {
  return {
    origin: "*", // Health check accessible from anywhere for monitoring
    methods: ["GET"],
    allowedHeaders: ["Content-Type"],
  };
}
