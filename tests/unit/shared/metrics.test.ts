/**
 * Unit tests for metrics module
 * Tests normalizeRoute function for route path normalization
 */

import { describe, it, expect } from "@jest/globals";
import { normalizeRoute } from "@mcp-moira/shared";

describe("Metrics - normalizeRoute", () => {
  describe("UUID patterns", () => {
    it("should normalize UUID v4 patterns to :id", () => {
      expect(normalizeRoute("/api/workflows/550e8400-e29b-41d4-a716-446655440000")).toBe(
        "/api/workflows/:id",
      );
    });

    it("should normalize multiple UUIDs in path", () => {
      expect(
        normalizeRoute(
          "/api/workflows/550e8400-e29b-41d4-a716-446655440000/steps/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        ),
      ).toBe("/api/workflows/:id/steps/:id");
    });

    it("should handle uppercase UUIDs", () => {
      expect(normalizeRoute("/api/users/A1B2C3D4-E5F6-7890-ABCD-EF1234567890")).toBe(
        "/api/users/:id",
      );
    });
  });

  describe("alphanumeric ID patterns (20+ chars)", () => {
    it("should normalize long alphanumeric IDs to :id", () => {
      expect(normalizeRoute("/api/admin/users/Z0d6YnYHXwf2ieBe9q72GLyv4OSMJQSb")).toBe(
        "/api/admin/users/:id",
      );
    });

    it("should normalize session IDs", () => {
      expect(normalizeRoute("/api/sessions/abc123def456ghi789jkl012mno345")).toBe(
        "/api/sessions/:id",
      );
    });

    it("should not normalize short alphanumeric strings", () => {
      expect(normalizeRoute("/api/workflows/short")).toBe("/api/workflows/short");
    });
  });

  describe("numeric ID patterns", () => {
    it("should normalize numeric IDs to :id", () => {
      expect(normalizeRoute("/api/items/12345")).toBe("/api/items/:id");
    });

    it("should normalize multiple numeric IDs", () => {
      expect(normalizeRoute("/api/users/123/posts/456")).toBe("/api/users/:id/posts/:id");
    });

    it("should normalize single digit IDs", () => {
      expect(normalizeRoute("/api/page/1")).toBe("/api/page/:id");
    });
  });

  describe("token patterns (32+ chars with base64url)", () => {
    it("should normalize base64url tokens with underscores and dashes to :token", () => {
      // Token pattern requires 32+ chars with base64url chars (including - and _)
      expect(normalizeRoute("/api/tokens/abc123_def456-ghi789_jkl012-mno345pqr")).toBe(
        "/api/tokens/:token",
      );
    });

    it("should normalize long tokens with mixed chars", () => {
      // Long alphanumeric without special chars gets normalized by alphanumeric pattern first
      // Token pattern specifically targets base64url with - or _ chars
      expect(normalizeRoute("/api/verify/aBc123-XyZ789_token-value_here-now")).toBe(
        "/api/verify/:token",
      );
    });
  });

  describe("edge cases", () => {
    it('should return "unknown" for empty path', () => {
      expect(normalizeRoute("")).toBe("unknown");
    });

    it("should handle root path", () => {
      expect(normalizeRoute("/")).toBe("/");
    });

    it("should preserve static paths without IDs", () => {
      expect(normalizeRoute("/api/health")).toBe("/api/health");
      expect(normalizeRoute("/api/workflows")).toBe("/api/workflows");
      expect(normalizeRoute("/api/auth/sign-in/email")).toBe("/api/auth/sign-in/email");
    });

    it("should handle paths with query strings (path only, no query)", () => {
      // normalizeRoute only receives path, not query string
      expect(normalizeRoute("/api/users/123")).toBe("/api/users/:id");
    });

    it("should handle mixed patterns", () => {
      // Alphanumeric 20+ chars gets :id, numeric gets :id
      expect(normalizeRoute("/api/users/123/tokens/abcdefghijklmnopqrstuvwxyz123456")).toBe(
        "/api/users/:id/tokens/:id",
      );
    });
  });

  describe("real-world routes", () => {
    it("should normalize admin user routes", () => {
      expect(normalizeRoute("/api/admin/users/uLokEFR28kjnwkVZI9SAHz6gw55rnDxE/sessions")).toBe(
        "/api/admin/users/:id/sessions",
      );
    });

    it("should normalize workflow execution routes", () => {
      expect(normalizeRoute("/api/executions/c816f4d1-40a1-4e01-8228-8d12c5f62615")).toBe(
        "/api/executions/:id",
      );
    });

    it("should normalize OAuth routes", () => {
      expect(normalizeRoute("/api/auth/mcp/authorize")).toBe("/api/auth/mcp/authorize");
    });

    it("should normalize settings routes", () => {
      expect(normalizeRoute("/api/settings/ui.theme")).toBe("/api/settings/ui.theme");
    });
  });
});
