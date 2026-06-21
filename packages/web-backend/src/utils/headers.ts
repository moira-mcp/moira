/**
 * Header conversion utilities for Better Auth integration
 *
 * Better Auth API expects Web API Headers, but Express provides IncomingHttpHeaders.
 * This utility converts between the two formats.
 */

import type { IncomingHttpHeaders } from "http";

/**
 * Convert Express/Node.js IncomingHttpHeaders to Web API Headers
 * Better Auth API requires Headers type for authentication methods
 */
export function toHeaders(incomingHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      // Multiple values for same header (e.g., set-cookie)
      for (const v of value) {
        headers.append(key, v);
      }
    } else {
      headers.set(key, value);
    }
  }

  return headers;
}
