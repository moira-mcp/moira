import { APP_PREFIX } from "../constants/routes";

/**
 * Validate returnUrl parameter for safe redirect after login.
 * Only allows relative URLs (starting with "/") to prevent open redirect attacks.
 *
 * Safe in both Web-UI modes: the open-redirect guards (`//`, `/\`, `://`, `..`)
 * are mode-independent, and the login/register loop-guard is prefix-aware
 * (rejects `${APP_PREFIX}/login` and `${APP_PREFIX}/register`).
 */
export function validateReturnUrl(url: string | null): string | null {
  if (!url) return null;

  // Must be a relative path starting with "/"
  // Reject: external URLs, data: URLs, javascript: URLs
  if (!url.startsWith("/")) return null;

  // Reject protocol-relative URLs (//evil.com, /\evil.com) which start with "/"
  // but resolve to an external origin.
  if (url.startsWith("//") || url.startsWith("/\\")) return null;

  // Reject path traversal attempts
  if (url.includes("..")) return null;

  // Reject protocol-like patterns within the path
  if (url.includes("://")) return null;

  // Don't redirect to login/register pages (would loop). Prefix-aware: in /app
  // mode these are /app/login and /app/register; in root mode /login, /register.
  if (url.startsWith(`${APP_PREFIX}/login`)) return null;
  if (url.startsWith(`${APP_PREFIX}/register`)) return null;

  return url;
}

/**
 * Build login URL with returnUrl parameter.
 * Returns plain login URL if current path is the app root.
 */
export function buildLoginUrlWithReturn(currentPath: string, loginRoute: string): string {
  // Don't add returnUrl for the app root ("/" in root mode, "/app/" in /app mode).
  if (currentPath === "/" || currentPath === `${APP_PREFIX}/`) return loginRoute;

  const validated = validateReturnUrl(currentPath);
  if (!validated) return loginRoute;

  return `${loginRoute}?returnUrl=${encodeURIComponent(validated)}`;
}
