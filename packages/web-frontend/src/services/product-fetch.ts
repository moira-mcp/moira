import {
  revalidateReadSession,
  runReadInvalidatingEffect,
  suspendReadSession,
  notifyReadSessionChange,
} from "./read-scope";

/** Preserve native fetch responses. GET/security reads remain uncached; effects retire shared reads. */
export function productFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const method =
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET");
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()))
    return fetch(input, { ...init, cache: "no-store" });
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const changingIdentity =
    url.includes("/api/auth/") ||
    url.includes("/api/user/change-password") ||
    url.includes("/api/user/set-password");
  if (changingIdentity) {
    suspendReadSession();
    notifyReadSessionChange();
  }
  return runReadInvalidatingEffect(async () => {
    try {
      return await fetch(input, init);
    } finally {
      if (changingIdentity) {
        revalidateReadSession();
        notifyReadSessionChange();
      }
    }
  });
}
