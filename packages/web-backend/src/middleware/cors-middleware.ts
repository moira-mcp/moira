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
import { getBaseUrl, getExtraTrustedOrigins, getCorsAllowedOrigins } from "@mcp-moira/shared";

/**
 * Localhost dev origins allowed by default so a local self-host install works
 * without any CORS configuration. Covers the web-frontend dev server (4200) and
 * the backend port; both 127.0.0.1 and localhost forms.
 */
const LOCALHOST_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * Build the set of explicitly allowed origins from configuration.
 */
function buildAllowlist(): Set<string> {
  const origins = new Set<string>();

  // Own public origin (may throw if MOIRA_HOST unset in non-test runtime; in
  // that case the app would already have failed earlier, so this is safe here).
  try {
    origins.add(getBaseUrl());
  } catch {
    // MOIRA_HOST not configured — rely on localhost pattern + explicit lists.
  }

  for (const o of getExtraTrustedOrigins()) origins.add(o.trim());
  for (const o of getCorsAllowedOrigins()) origins.add(o);

  return origins;
}

/**
 * Decide whether an Origin is allowed.
 */
export function isOriginAllowed(origin: string | undefined, allowlist: Set<string>): boolean {
  // No Origin header: not a cross-origin browser request — allow.
  if (!origin) return true;
  if (allowlist.has(origin)) return true;
  if (LOCALHOST_ORIGIN_PATTERN.test(origin)) return true;
  return false;
}

/**
 * Setup CORS middleware with an explicit origin allowlist.
 */
export function setupCorsMiddleware() {
  const allowlist = buildAllowlist();

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
