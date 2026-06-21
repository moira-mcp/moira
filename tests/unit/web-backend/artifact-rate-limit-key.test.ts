/**
 * Unit tests for the per-artifact rate-limit key generator.
 *
 * Regression guard for the requirement that a single artifact cannot be served
 * at abusive volume: the limiter must key by artifact uuid (resolved from the
 * REQUEST — subdomain or route param), not by client IP. The key
 * must be derived from the request alone because the keyGenerator runs before
 * the route handler body (so res.locals is not yet populated).
 */

import { describe, it, expect, afterEach } from "@jest/globals";
import type { Request } from "express";

const originalStaticDomain = process.env.STATIC_ARTIFACTS_DOMAIN;

async function importKeyFn() {
  const mod = await import("../../../packages/web-backend/src/middleware/rate-limit-middleware.js");
  return mod.artifactKeyFromRequest;
}

function makeReq(opts: { host?: string; path?: string; params?: { uuid?: string } }): Request {
  return {
    headers: { host: opts.host },
    path: opts.path ?? "/",
    params: opts.params ?? {},
  } as unknown as Request;
}

describe("artifactKeyFromRequest", () => {
  afterEach(() => {
    if (originalStaticDomain) {
      process.env.STATIC_ARTIFACTS_DOMAIN = originalStaticDomain;
    } else {
      delete process.env.STATIC_ARTIFACTS_DOMAIN;
    }
  });

  it("resolves uuid from a per-artifact subdomain (Host header)", async () => {
    process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
    const fn = await importKeyFn();
    expect(fn(makeReq({ host: "my-uuid-1234.static.example.com", path: "/" }))).toBe(
      "my-uuid-1234",
    );
  });

  it("resolves uuid from a route param (e.g. /__frame/:uuid)", async () => {
    process.env.STATIC_ARTIFACTS_DOMAIN = "localhost:3033";
    const fn = await importKeyFn();
    expect(
      fn(
        makeReq({
          host: "localhost:3033",
          path: "/__frame/abc1234567",
          params: { uuid: "abc1234567" },
        }),
      ),
    ).toBe("abc1234567");
  });

  it("returns null when no artifact uuid can be derived from the request", async () => {
    process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
    const fn = await importKeyFn();
    expect(fn(makeReq({ host: "static.example.com", path: "/" }))).toBeNull();
  });
});
