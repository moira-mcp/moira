/**
 * Tests for logging context propagation
 * Verifies:
 * - Global service set at process startup
 * - AsyncLocalStorage context propagation (requestId, userId)
 * - Service enum values
 */

import { Service } from "../../../../packages/shared/src/logging/logger.js";
import {
  runWithContext,
  getRequestContext,
  setGlobalService,
  getGlobalService,
  getAuditSource,
} from "../../../../packages/shared/src/logging/context.js";

describe("Service Context Propagation", () => {
  // Reset global service before each test
  beforeEach(() => {
    // @ts-expect-error - accessing private for test reset
    setGlobalService(undefined as unknown as Service);
  });

  describe("Service enum", () => {
    it("should have only entry point services", () => {
      expect(Service.MCP_SERVER).toBe("mcp-server");
      expect(Service.WEB_BACKEND).toBe("web-backend");
      expect(Service.WEB_FRONTEND).toBe("web-frontend");
    });

    it("should NOT have WORKFLOW_ENGINE or SHARED", () => {
      // These were removed - verify they don't exist
      expect((Service as Record<string, string>).WORKFLOW_ENGINE).toBeUndefined();
      expect((Service as Record<string, string>).SHARED).toBeUndefined();
    });
  });

  describe("Global service", () => {
    it("should be undefined before initialization", () => {
      expect(getGlobalService()).toBeUndefined();
    });

    it("should store and retrieve global service", () => {
      setGlobalService(Service.MCP_SERVER);
      expect(getGlobalService()).toBe(Service.MCP_SERVER);
    });

    it("should persist across function calls", () => {
      setGlobalService(Service.WEB_BACKEND);

      const innerFunction = () => getGlobalService();
      const middleFunction = () => innerFunction();
      const outerFunction = () => middleFunction();

      expect(outerFunction()).toBe(Service.WEB_BACKEND);
    });
  });

  describe("Audit source from global service", () => {
    it("should return mcp for MCP_SERVER", () => {
      setGlobalService(Service.MCP_SERVER);
      expect(getAuditSource()).toBe("mcp");
    });

    it("should return web for WEB_BACKEND", () => {
      setGlobalService(Service.WEB_BACKEND);
      expect(getAuditSource()).toBe("web");
    });

    it("should return undefined for WEB_FRONTEND", () => {
      setGlobalService(Service.WEB_FRONTEND);
      expect(getAuditSource()).toBeUndefined();
    });

    it("should return undefined when no service set", () => {
      expect(getAuditSource()).toBeUndefined();
    });
  });

  describe("Request context (AsyncLocalStorage)", () => {
    it("should return undefined when outside context", () => {
      const ctx = getRequestContext();
      expect(ctx).toBeUndefined();
    });

    it("should store requestId in context", () => {
      const result = runWithContext({ requestId: "test-request-123" }, () => {
        const ctx = getRequestContext();
        return ctx?.requestId;
      });

      expect(result).toBe("test-request-123");
    });

    it("should store userId in context", () => {
      const result = runWithContext({ requestId: "test-request", userId: "user-456" }, () => {
        const ctx = getRequestContext();
        return ctx?.userId;
      });

      expect(result).toBe("user-456");
    });

    it("should preserve context through nested function calls", () => {
      const innerFunction = () => {
        const ctx = getRequestContext();
        return { requestId: ctx?.requestId, userId: ctx?.userId };
      };

      const middleFunction = () => innerFunction();
      const outerFunction = () => middleFunction();

      const result = runWithContext(
        { requestId: "nested-test", userId: "nested-user" },
        outerFunction,
      );

      expect(result.requestId).toBe("nested-test");
      expect(result.userId).toBe("nested-user");
    });

    it("should not be available after context exits", () => {
      runWithContext({ requestId: "temp-request" }, () => {
        expect(getRequestContext()).toBeDefined();
      });

      expect(getRequestContext()).toBeUndefined();
    });

    it("should generate requestId if not provided", () => {
      const result = runWithContext({}, () => {
        const ctx = getRequestContext();
        return ctx?.requestId;
      });

      expect(result).toBeDefined();
      // Should be UUID format
      expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("should set startTime automatically", () => {
      const before = Date.now();

      const result = runWithContext({ requestId: "timing-test" }, () => {
        const ctx = getRequestContext();
        return ctx?.startTime;
      });

      const after = Date.now();

      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after);
    });
  });

  describe("Context does NOT contain service or source", () => {
    it("should not have service field in RequestContext", () => {
      const result = runWithContext({ requestId: "no-service-test" }, () => {
        const ctx = getRequestContext();
        // TypeScript should not allow ctx?.service, but check runtime
        return ctx as unknown as Record<string, unknown>;
      });

      expect(result.service).toBeUndefined();
    });

    it("should not have source field in RequestContext", () => {
      const result = runWithContext({ requestId: "no-source-test" }, () => {
        const ctx = getRequestContext();
        return ctx as unknown as Record<string, unknown>;
      });

      expect(result.source).toBeUndefined();
    });
  });
});
