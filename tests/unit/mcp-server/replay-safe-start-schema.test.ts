import { describe, expect, test } from "@jest/globals";
import {
  startRequestSchema,
  startSchema,
} from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import { startWorkflow } from "../../../packages/mcp-server/src/tools/start-workflow.js";

describe("replay-safe start schema", () => {
  test("the public schema enforces the exact prepare and execute phases", () => {
    expect(
      startSchema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
      }).success,
    ).toBe(true);
    expect(
      startSchema.safeParse({
        action: "prepare",
        workflowId: "moira/quick-task",
        parentExecutionId: "none",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(false);
    expect(
      startSchema.safeParse({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
        workflowId: "moira/quick-task",
      }).success,
    ).toBe(false);
    expect(
      startRequestSchema.safeParse({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000000",
      }).success,
    ).toBe(true);
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
