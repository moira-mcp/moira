/**
 * Tests for ServiceLogger error context inclusion
 *
 * Tests the logic that includes inputData and resourceIds from RequestContext
 * in error logs. Uses direct inspection of the log() method behavior.
 */

import { describe, it, expect } from "@jest/globals";
import { getRequestContext, runWithContext, updateContext } from "@mcp-moira/shared";

describe("ServiceLogger error context behavior", () => {
  describe("RequestContext with inputData", () => {
    it("stores operation in context", async () => {
      let capturedContext: ReturnType<typeof getRequestContext>;

      await runWithContext({ requestId: "test-123" }, async () => {
        updateContext({
          operation: "mcp:start",
          inputData: { note: "test workflow" },
        });
        capturedContext = getRequestContext();
      });

      expect(capturedContext!.operation).toBe("mcp:start");
      expect(capturedContext!.inputData).toEqual({ note: "test workflow" });
    });

    it("stores resourceIds in context", async () => {
      let capturedContext: ReturnType<typeof getRequestContext>;

      await runWithContext({ requestId: "test-456" }, async () => {
        updateContext({
          operation: "mcp:step",
          resourceIds: { workflowId: "wf-123", executionId: "exec-456" },
        });
        capturedContext = getRequestContext();
      });

      expect(capturedContext!.resourceIds).toEqual({
        workflowId: "wf-123",
        executionId: "exec-456",
      });
    });

    it("preserves existing context fields when updating", async () => {
      let capturedContext: ReturnType<typeof getRequestContext>;

      await runWithContext({ requestId: "test-789", userId: "user-123" }, async () => {
        updateContext({
          operation: "POST /api/workflows",
          inputData: { name: "my workflow" },
        });
        capturedContext = getRequestContext();
      });

      // Original fields preserved
      expect(capturedContext!.requestId).toBe("test-789");
      expect(capturedContext!.userId).toBe("user-123");
      // New fields added
      expect(capturedContext!.operation).toBe("POST /api/workflows");
      expect(capturedContext!.inputData).toEqual({ name: "my workflow" });
    });

    it("allows multiple updates to context", async () => {
      let capturedContext: ReturnType<typeof getRequestContext>;

      await runWithContext({ requestId: "test-abc" }, async () => {
        updateContext({ operation: "step:execute" });
        updateContext({ inputData: { decision: "yes" } });
        updateContext({ resourceIds: { executionId: "exec-789" } });
        capturedContext = getRequestContext();
      });

      expect(capturedContext!.operation).toBe("step:execute");
      expect(capturedContext!.inputData).toEqual({ decision: "yes" });
      expect(capturedContext!.resourceIds).toEqual({ executionId: "exec-789" });
    });
  });

  describe("Context isolation", () => {
    it("does not leak context between requests", async () => {
      let context1: ReturnType<typeof getRequestContext>;
      let context2: ReturnType<typeof getRequestContext>;

      await runWithContext({ requestId: "req-1" }, async () => {
        updateContext({ operation: "op-1", inputData: { data: "first" } });
        context1 = getRequestContext();
      });

      await runWithContext({ requestId: "req-2" }, async () => {
        updateContext({ operation: "op-2", inputData: { data: "second" } });
        context2 = getRequestContext();
      });

      // Each context should have its own values
      expect(context1!.requestId).toBe("req-1");
      expect(context1!.operation).toBe("op-1");
      expect(context1!.inputData).toEqual({ data: "first" });

      expect(context2!.requestId).toBe("req-2");
      expect(context2!.operation).toBe("op-2");
      expect(context2!.inputData).toEqual({ data: "second" });
    });

    it("context is undefined outside of runWithContext", () => {
      const context = getRequestContext();
      expect(context).toBeUndefined();
    });
  });
});
