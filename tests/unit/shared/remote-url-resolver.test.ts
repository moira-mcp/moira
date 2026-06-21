/**
 * Unit tests for remote URL resolver
 * Tests 2 modes: Local (Mac) and Remote (PC)
 */

import { describe, it, expect } from "@jest/globals";
import { resolveTestUrls } from "../../utils/remote-url-resolver.js";

describe("resolveTestUrls", () => {
  describe("Local mode (Mac)", () => {
    it("returns localhost for both baseUrl and fetchUrl", () => {
      const result = resolveTestUrls({
        DOCKER_PORT: "3030",
        PLAYWRIGHT_REMOTE: "false",
      });

      expect(result.baseUrl).toBe("http://localhost:3030");
      expect(result.fetchUrl).toBe("http://localhost:3030");
      expect(result.mcpUrl).toBe("http://localhost:3030/mcp");
      expect(result.connectOptions).toBeUndefined();
      expect(result.mode).toBe("Local (Mac)");
    });

    it("returns localhost when PLAYWRIGHT_REMOTE is absent", () => {
      const result = resolveTestUrls({ DOCKER_PORT: "3032" });

      expect(result.baseUrl).toBe("http://localhost:3032");
      expect(result.fetchUrl).toBe("http://localhost:3032");
      expect(result.connectOptions).toBeUndefined();
      expect(result.mode).toBe("Local (Mac)");
    });

    it("defaults to port 3030 when DOCKER_PORT not set", () => {
      const result = resolveTestUrls({});

      expect(result.baseUrl).toBe("http://localhost:3030");
      expect(result.fetchUrl).toBe("http://localhost:3030");
    });
  });

  describe("Remote mode (PC)", () => {
    it("returns localhost baseUrl but remote fetchUrl", () => {
      const result = resolveTestUrls({
        DOCKER_PORT: "3030",
        REMOTE_HOST: "192.0.2.1",
        PLAYWRIGHT_REMOTE: "true",
        PLAYWRIGHT_WS_ENDPOINT: "ws://192.0.2.1:3000/",
      });

      expect(result.baseUrl).toBe("http://localhost:3030");
      expect(result.fetchUrl).toBe("http://192.0.2.1:3030");
      expect(result.mcpUrl).toBe("http://localhost:3030/mcp");
      expect(result.connectOptions).toEqual({ wsEndpoint: "ws://192.0.2.1:3000/" });
      expect(result.mode).toBe("Remote (PC)");
    });

    it("constructs default wsEndpoint from REMOTE_HOST", () => {
      const result = resolveTestUrls({
        DOCKER_PORT: "3030",
        REMOTE_HOST: "192.168.1.100",
        PLAYWRIGHT_REMOTE: "true",
      });

      expect(result.connectOptions).toEqual({ wsEndpoint: "ws://192.168.1.100:3000/" });
      expect(result.fetchUrl).toBe("http://192.168.1.100:3030");
    });

    it("uses explicit PLAYWRIGHT_WS_ENDPOINT over default", () => {
      const result = resolveTestUrls({
        DOCKER_PORT: "3030",
        REMOTE_HOST: "192.168.1.100",
        PLAYWRIGHT_REMOTE: "true",
        PLAYWRIGHT_WS_ENDPOINT: "ws://custom-host:9999/",
      });

      expect(result.connectOptions).toEqual({ wsEndpoint: "ws://custom-host:9999/" });
    });

    it("throws when REMOTE_HOST not set in remote mode", () => {
      expect(() =>
        resolveTestUrls({
          DOCKER_PORT: "3030",
          PLAYWRIGHT_REMOTE: "true",
        }),
      ).toThrow("REMOTE_HOST is required in remote mode");
    });
  });

  describe("Port handling", () => {
    it("uses DOCKER_PORT from env", () => {
      const result = resolveTestUrls({ DOCKER_PORT: "3032" });

      expect(result.baseUrl).toBe("http://localhost:3032");
      expect(result.fetchUrl).toBe("http://localhost:3032");
    });

    it("baseUrl is always localhost regardless of mode", () => {
      const local = resolveTestUrls({ DOCKER_PORT: "3030" });
      const remote = resolveTestUrls({
        DOCKER_PORT: "3030",
        PLAYWRIGHT_REMOTE: "true",
        REMOTE_HOST: "10.0.0.1",
      });

      expect(local.baseUrl).toBe("http://localhost:3030");
      expect(remote.baseUrl).toBe("http://localhost:3030");
    });

    it("fetchUrl differs from baseUrl only in remote mode", () => {
      const local = resolveTestUrls({ DOCKER_PORT: "3030" });
      const remote = resolveTestUrls({
        DOCKER_PORT: "3030",
        PLAYWRIGHT_REMOTE: "true",
        REMOTE_HOST: "10.0.0.1",
      });

      expect(local.fetchUrl).toBe(local.baseUrl);
      expect(remote.fetchUrl).not.toBe(remote.baseUrl);
      expect(remote.fetchUrl).toBe("http://10.0.0.1:3030");
    });
  });
});
