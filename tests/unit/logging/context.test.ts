/**
 * Tests for AsyncLocalStorage-based request context
 */

import {
  getRequestContext,
  runWithContext,
  runWithContextAsync,
  updateContext,
  generateRequestId,
} from "../../../packages/shared/src/logging/context.js";

describe("Request Context", () => {
  describe("generateRequestId", () => {
    it("should generate unique UUIDs", () => {
      const id1 = generateRequestId();
      const id2 = generateRequestId();

      expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("getRequestContext", () => {
    it("should return undefined when not in context", () => {
      const context = getRequestContext();
      expect(context).toBeUndefined();
    });
  });

  describe("runWithContext", () => {
    it("should provide context within callback", () => {
      const result = runWithContext({ requestId: "test-123" }, () => {
        const ctx = getRequestContext();
        return ctx;
      });

      expect(result).toBeDefined();
      expect(result?.requestId).toBe("test-123");
    });

    it("should generate requestId if not provided", () => {
      const result = runWithContext({}, () => {
        const ctx = getRequestContext();
        return ctx;
      });

      expect(result).toBeDefined();
      expect(result?.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it("should set startTime", () => {
      const before = Date.now();
      const result = runWithContext({}, () => {
        const ctx = getRequestContext();
        return ctx;
      });
      const after = Date.now();

      expect(result?.startTime).toBeGreaterThanOrEqual(before);
      expect(result?.startTime).toBeLessThanOrEqual(after);
    });

    it("should include userId when provided", () => {
      const result = runWithContext({ userId: "user-456" }, () => {
        const ctx = getRequestContext();
        return ctx;
      });

      expect(result?.userId).toBe("user-456");
    });

    it("should not have context after callback completes", () => {
      runWithContext({ requestId: "temp" }, () => {
        expect(getRequestContext()).toBeDefined();
      });

      expect(getRequestContext()).toBeUndefined();
    });
  });

  describe("runWithContextAsync", () => {
    it("should provide context within async callback", async () => {
      const result = await runWithContextAsync(
        { requestId: "async-123", userId: "user-async" },
        async () => {
          await Promise.resolve(); // Simulate async work
          const ctx = getRequestContext();
          return ctx;
        },
      );

      expect(result).toBeDefined();
      expect(result?.requestId).toBe("async-123");
      expect(result?.userId).toBe("user-async");
    });

    it("should maintain context across await points", async () => {
      const requestId = "await-test-123";

      const result = await runWithContextAsync({ requestId }, async () => {
        // First await
        await Promise.resolve();
        const ctx1 = getRequestContext();

        // Second await
        await new Promise((resolve) => setTimeout(resolve, 10));
        const ctx2 = getRequestContext();

        return { ctx1, ctx2 };
      });

      expect(result.ctx1?.requestId).toBe(requestId);
      expect(result.ctx2?.requestId).toBe(requestId);
    });
  });

  describe("updateContext", () => {
    it("should update existing context", () => {
      runWithContext({ requestId: "update-test" }, () => {
        updateContext({ userId: "updated-user" });
        const ctx = getRequestContext();
        expect(ctx?.userId).toBe("updated-user");
      });
    });

    it("should do nothing when not in context", () => {
      // Should not throw
      expect(() => {
        updateContext({ userId: "test" });
      }).not.toThrow();
    });
  });

  describe("nested contexts", () => {
    it("should isolate nested contexts", () => {
      runWithContext({ requestId: "outer", userId: "outer-user" }, () => {
        const outerCtx = getRequestContext();
        expect(outerCtx?.requestId).toBe("outer");

        runWithContext({ requestId: "inner", userId: "inner-user" }, () => {
          const innerCtx = getRequestContext();
          expect(innerCtx?.requestId).toBe("inner");
          expect(innerCtx?.userId).toBe("inner-user");
        });

        // After inner context, outer should be restored
        const restored = getRequestContext();
        expect(restored?.requestId).toBe("outer");
      });
    });
  });
});
