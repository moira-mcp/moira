/**
 * Unit tests for URL configuration module
 * Tests getHost, getProtocol, getBaseUrl, getMcpUrl, getApiUrl, getAuthUrl, isProduction, validateHostFormat
 */

import { describe, it, expect, afterEach } from "@jest/globals";

// Store original env values
const originalMoiraHost = process.env.MOIRA_HOST;
const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;
const originalStaticDomain = process.env.STATIC_ARTIFACTS_DOMAIN;

// Helper to dynamically import module (fresh import after env change)
async function importUrlModule() {
  // Clear module cache to get fresh import
  const modulePath = "@mcp-moira/shared/config/urls.js";
  // Note: Jest doesn't support dynamic module clearing easily,
  // so we test via direct function calls after setting env
  const module = await import("@mcp-moira/shared/config/urls.js");
  return module;
}

describe("URL Configuration", () => {
  afterEach(() => {
    // Restore original env after each test
    if (originalMoiraHost) {
      process.env.MOIRA_HOST = originalMoiraHost;
    } else {
      delete process.env.MOIRA_HOST;
    }
    if (originalBetterAuthSecret) {
      process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
    } else {
      delete process.env.BETTER_AUTH_SECRET;
    }
    if (originalStaticDomain) {
      process.env.STATIC_ARTIFACTS_DOMAIN = originalStaticDomain;
    } else {
      delete process.env.STATIC_ARTIFACTS_DOMAIN;
    }
  });

  describe("getHost()", () => {
    it("returns MOIRA_HOST when set", async () => {
      process.env.MOIRA_HOST = "test.example.com";
      const { getHost } = await importUrlModule();
      expect(getHost()).toBe("test.example.com");
    });

    it("returns fallback localhost:3030 when MOIRA_HOST not set in test env", async () => {
      delete process.env.MOIRA_HOST;
      const { getHost } = await importUrlModule();
      // In test environment, returns fallback instead of throwing
      expect(getHost()).toBe("localhost:3030");
    });

    it("returns localhost with port", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getHost } = await importUrlModule();
      expect(getHost()).toBe("localhost:3032");
    });
  });

  describe("getProtocol()", () => {
    it("returns http for localhost", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getProtocol } = await importUrlModule();
      expect(getProtocol()).toBe("http");
    });

    it("returns http for localhost without port", async () => {
      process.env.MOIRA_HOST = "localhost";
      const { getProtocol } = await importUrlModule();
      expect(getProtocol()).toBe("http");
    });

    it("returns https for production domain", async () => {
      process.env.MOIRA_HOST = "moira.example.com";
      const { getProtocol } = await importUrlModule();
      expect(getProtocol()).toBe("https");
    });

    it("returns https for any non-localhost domain", async () => {
      process.env.MOIRA_HOST = "staging.example.com:8080";
      const { getProtocol } = await importUrlModule();
      expect(getProtocol()).toBe("https");
    });
  });

  describe("getBaseUrl()", () => {
    it("returns http URL for localhost", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getBaseUrl } = await importUrlModule();
      expect(getBaseUrl()).toBe("http://localhost:3032");
    });

    it("returns https URL for production", async () => {
      process.env.MOIRA_HOST = "moira.example.com";
      const { getBaseUrl } = await importUrlModule();
      expect(getBaseUrl()).toBe("https://moira.example.com");
    });
  });

  describe("getMcpUrl()", () => {
    it("returns MCP endpoint URL", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getMcpUrl } = await importUrlModule();
      expect(getMcpUrl()).toBe("http://localhost:3032/mcp");
    });
  });

  describe("getApiUrl()", () => {
    it("returns API endpoint URL", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getApiUrl } = await importUrlModule();
      expect(getApiUrl()).toBe("http://localhost:3032/api");
    });
  });

  describe("getAuthUrl()", () => {
    it("returns Auth endpoint URL", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { getAuthUrl } = await importUrlModule();
      expect(getAuthUrl()).toBe("http://localhost:3032/api/auth");
    });
  });

  describe("isProduction()", () => {
    it("returns false for localhost", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { isProduction } = await importUrlModule();
      expect(isProduction()).toBe(false);
    });

    it("returns true for production domain", async () => {
      process.env.MOIRA_HOST = "moira.example.com";
      const { isProduction } = await importUrlModule();
      expect(isProduction()).toBe(true);
    });
  });

  describe("validateHostFormat()", () => {
    it("passes for valid localhost config", async () => {
      process.env.MOIRA_HOST = "localhost:3032";
      const { validateHostFormat } = await importUrlModule();
      expect(() => validateHostFormat()).not.toThrow();
    });

    it("passes for valid production config", async () => {
      process.env.MOIRA_HOST = "moira.example.com";
      const { validateHostFormat } = await importUrlModule();
      expect(() => validateHostFormat()).not.toThrow();
    });

    it("throws for host with protocol", async () => {
      process.env.MOIRA_HOST = "https://moira.example.com";
      const { validateHostFormat } = await importUrlModule();
      expect(() => validateHostFormat()).toThrow("MOIRA_HOST should be host only, not URL");
    });

    it("throws for host with path", async () => {
      process.env.MOIRA_HOST = "moira.example.com/api";
      const { validateHostFormat } = await importUrlModule();
      expect(() => validateHostFormat()).toThrow("MOIRA_HOST should not contain path");
    });

    it("uses fallback when MOIRA_HOST not set in test env", async () => {
      delete process.env.MOIRA_HOST;
      const { validateHostFormat } = await importUrlModule();
      // In test environment, uses fallback localhost:3030 instead of throwing
      expect(() => validateHostFormat()).not.toThrow();
    });
  });

  describe("getArtifactUrl()", () => {
    it("uses the per-artifact subdomain on deployed domains (https)", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { getArtifactUrl } = await importUrlModule();
      expect(getArtifactUrl("abc-123-uuid")).toBe("https://abc-123-uuid.static.example.com/");
    });

    it("uses the per-artifact subdomain on localhost over HTTP (no cert needed)", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.localhost:3033";
      const { getArtifactUrl } = await importUrlModule();
      expect(getArtifactUrl("abc-123-uuid")).toBe("http://abc-123-uuid.static.localhost:3033/");
    });
  });

  describe("resolveArtifactUuidFromHost()", () => {
    it("extracts uuid from a per-artifact subdomain", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost("my-uuid-1234.static.example.com")).toBe("my-uuid-1234");
    });

    it("strips a port from the host header", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost("my-uuid-1234.static.example.com:443")).toBe(
        "my-uuid-1234",
      );
    });

    it("returns null for the bare static domain (no subdomain)", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost("static.example.com")).toBeNull();
    });

    it("returns null for nested subdomains (more than one label)", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost("a.b.static.example.com")).toBeNull();
    });

    it("returns null for an unrelated host", async () => {
      process.env.STATIC_ARTIFACTS_DOMAIN = "static.example.com";
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost("example.com")).toBeNull();
    });

    it("returns null for undefined host", async () => {
      const { resolveArtifactUuidFromHost } = await importUrlModule();
      expect(resolveArtifactUuidFromHost(undefined)).toBeNull();
    });
  });
});
