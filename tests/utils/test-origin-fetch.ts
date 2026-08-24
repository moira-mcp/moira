import { getTestRequestOrigin } from "./test-config.js";

type OriginProvider = () => string;

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const inputMethod = input instanceof Request ? input.method : "GET";
  return (init?.method ?? inputMethod).toUpperCase();
}

function mergedHeaders(input: Parameters<typeof fetch>[0], init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

/**
 * Make direct Node.js auth requests carry the same Origin a browser would send.
 * Safe methods, non-auth endpoints, and explicit Origin headers are unchanged.
 */
export function createTestOriginFetch(
  fetchImplementation: typeof fetch,
  originProvider: OriginProvider = getTestRequestOrigin,
): typeof fetch {
  return (async (input, init) => {
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    if (["GET", "HEAD", "OPTIONS"].includes(method) || !url.pathname.startsWith("/api/auth/")) {
      return fetchImplementation(input, init);
    }

    const headers = mergedHeaders(input, init);
    if (!headers.has("Origin")) headers.set("Origin", originProvider());
    return fetchImplementation(input, { ...init, headers });
  }) as typeof fetch;
}

const INSTALL_MARKER = Symbol.for("moira.test-origin-fetch-installed");

/** Install once in a Node.js test process. */
export function installTestOriginFetch(): void {
  const globalState = globalThis as typeof globalThis & { [INSTALL_MARKER]?: boolean };
  if (globalState[INSTALL_MARKER]) return;
  globalState.fetch = createTestOriginFetch(globalState.fetch.bind(globalState));
  globalState[INSTALL_MARKER] = true;
}
