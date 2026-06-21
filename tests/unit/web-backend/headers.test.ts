/**
 * Headers Utility Tests
 * Tests for toHeaders() function that converts Node.js IncomingHttpHeaders to Web API Headers
 */

import { toHeaders } from "../../../packages/web-backend/src/utils/headers.js";
import type { IncomingHttpHeaders } from "http";

describe("toHeaders", () => {
  it("should convert simple headers", () => {
    const incoming: IncomingHttpHeaders = {
      "content-type": "application/json",
      accept: "text/html",
    };

    const headers = toHeaders(incoming);

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("accept")).toBe("text/html");
  });

  it("should handle undefined values by skipping them", () => {
    const incoming: IncomingHttpHeaders = {
      "content-type": "application/json",
      "x-custom": undefined,
    };

    const headers = toHeaders(incoming);

    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBeNull();
  });

  it("should handle array values (multiple headers with same name)", () => {
    const incoming: IncomingHttpHeaders = {
      "set-cookie": ["session=abc123", "token=xyz789"],
    };

    const headers = toHeaders(incoming);

    // Headers.get() returns comma-separated values for multiple headers
    const setCookie = headers.get("set-cookie");
    expect(setCookie).toContain("session=abc123");
    expect(setCookie).toContain("token=xyz789");
  });

  it("should return instance of Headers", () => {
    const incoming: IncomingHttpHeaders = {};

    const headers = toHeaders(incoming);

    expect(headers).toBeInstanceOf(Headers);
  });

  it("should handle empty headers object", () => {
    const incoming: IncomingHttpHeaders = {};

    const headers = toHeaders(incoming);

    // Should not throw and return empty Headers
    expect(headers).toBeInstanceOf(Headers);
    expect([...headers.entries()]).toHaveLength(0);
  });

  it("should preserve header case sensitivity correctly", () => {
    // HTTP headers are case-insensitive, but Node.js lowercases them
    const incoming: IncomingHttpHeaders = {
      authorization: "Bearer token123",
      "x-request-id": "req-456",
    };

    const headers = toHeaders(incoming);

    // Headers API is case-insensitive on get
    expect(headers.get("Authorization")).toBe("Bearer token123");
    expect(headers.get("AUTHORIZATION")).toBe("Bearer token123");
    expect(headers.get("X-Request-ID")).toBe("req-456");
  });

  it("should handle typical Express request headers", () => {
    // Simulate typical Express request headers
    const incoming: IncomingHttpHeaders = {
      host: "localhost:3031",
      connection: "keep-alive",
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
      cookie: "session=abc123; userId=456",
      "content-type": "application/json",
      "content-length": "256",
    };

    const headers = toHeaders(incoming);

    expect(headers.get("host")).toBe("localhost:3031");
    expect(headers.get("cookie")).toBe("session=abc123; userId=456");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("should handle Better Auth required headers", () => {
    // Better Auth typically needs cookie and authorization headers
    const incoming: IncomingHttpHeaders = {
      cookie: "better-auth.session_token=eyJhbGc...",
      authorization: "Bearer token",
    };

    const headers = toHeaders(incoming);

    expect(headers.get("cookie")).toContain("better-auth.session_token");
    expect(headers.get("authorization")).toBe("Bearer token");
  });
});
