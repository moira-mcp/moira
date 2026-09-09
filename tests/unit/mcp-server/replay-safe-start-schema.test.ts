import { describe, expect, test } from "@jest/globals";
import {
  startRequestSchema,
  startSchema,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import { startWorkflow } from "../../../packages/mcp-server/src/tools/start-workflow.js";

describe("replay-safe start schema", () => {
  test("the runtime schema enforces the exact prepare and execute phases", () => {
    expect(
      startRequestSchema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
      }).success,
    ).toBe(true);
    expect(
      startRequestSchema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
    expect(
      startRequestSchema.safeParse({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
        workflowId: "moira/quick-task",
      }).success,
    ).toBe(false);
    for (const invalid of [
      { action: "prepare", parentExecutionId: "none" },
      { action: "prepare", workflowId: "moira/quick-task" },
      { action: "execute" },
      { action: "execute", startAttemptId: "not-a-uuid" },
      {
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
        unknown: true,
      },
    ]) {
      expect(startRequestSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      startRequestSchema.safeParse({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(true);
  });

  test("the public schema describes both start phases as one root object", () => {
    expect(
      startSchema.safeParse({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
        workflowId: "descriptive-public-superset",
      }).success,
    ).toBe(true);
    expect(startSchema.safeParse({ workflowId: "moira/quick-task" }).success).toBe(false);
    expect(
      startSchema.safeParse({ action: "prepare", workflowId: "workflow", unknown: true }).success,
    ).toBe(false);
  });

  test("the MCP handler rejects mixed execute fields before reading request or workflow state", async () => {
    await expect(
      startWorkflow({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
        workflowId: "moira/quick-task",
      }),
    ).rejects.toThrow();
  });
});
