import { getCorsAllowedOrigins, getExtraTrustedOrigins } from "./env.js";
import { getBaseUrl } from "./urls.js";

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

export function getBrowserOriginAllowlist(): Set<string> {
  const origins = new Set<string>([getBaseUrl()]);
  for (const origin of getExtraTrustedOrigins()) origins.add(origin.trim());
  for (const origin of getCorsAllowedOrigins()) origins.add(origin);
  return origins;
}

export function isBrowserOriginAllowed(
  origin: string | undefined,
  allowlist: Set<string> = getBrowserOriginAllowlist(),
): boolean {
  if (!origin) return true;
  return allowlist.has(origin) || isLocalDevelopmentOrigin(origin);
}
