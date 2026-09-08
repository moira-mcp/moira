import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stepSchema } from "../../../packages/mcp-server/src/tools/tool-schemas.js";
import {
  resolveToolDescription,
  TOOL_DEFINITIONS,
} from "../../../packages/mcp-server/src/tools/tool-definitions.js";

describe("replay-safe step public contract", () => {
  test("requires the server-issued attempt independently of workflow input", () => {
    expect(stepSchema.safeParse({ processId: "process", input: {} }).success).toBe(false);
    expect(
      stepSchema.safeParse({ processId: "process", attemptId: "attempt", input: {} }).success,
    ).toBe(true);
    expect(stepSchema.safeParse({ processId: "process", attemptId: "attempt" }).success).toBe(true);
  });

  test("teaches every static step variant to carry the attempt identity", () => {
    const step = TOOL_DEFINITIONS.find((definition) => definition.name === "step")!;
    for (const description of [
      resolveToolDescription(step),
      resolveToolDescription(step, { agent: "cursor" }),
    ]) {
      expect(description).toContain("attemptId");
      expect(description).toContain("required even when the workflow accepts an empty response");
      expect(description).toContain("ATTEMPT_CONFLICT");
      expect(description).toContain("read session current_step automatically");
      expect(description).toContain("returned directive and input schema");
      expect(description).toContain("ATTEMPT_INVALID_OR_EXPIRED");
      expect(description).toContain("do not reuse the unavailable attempt");
      expect(description).toContain("ATTEMPT_OUTCOME_UNKNOWN");
      expect(description).not.toContain('step({ processId: "abc123" })');
    }
  });

  test("keeps runtime lifecycle instructions aligned with the attempt protocol", () => {
    for (const name of ["list", "start"] as const) {
      const definition = TOOL_DEFINITIONS.find((candidate) => candidate.name === name)!;
      expect(resolveToolDescription(definition)).toContain("step({ processId, attemptId })");
      expect(resolveToolDescription(definition)).not.toContain("step(processId) →");
    }
    for (const source of [
      "config/prompts/systemPrompt.md",
      "config/prompts/agents/cursor/systemReminder.md",
    ]) {
      const content = readFileSync(resolve(process.cwd(), source), "utf8");
      expect(content).toContain("attemptId");
      expect(content).not.toContain("step(processId, input)");
      expect(content).not.toMatch(/mcp__moira__step\(\{ processId: "\.\.\.", input:/);
    }

    const systemPrompt = readFileSync(
      resolve(process.cwd(), "config/prompts/systemPrompt.md"),
      "utf8",
    );
    expect(systemPrompt).toContain("ATTEMPT_CONFLICT");
    expect(systemPrompt).toContain('session({ action: "current_step", executionId })');
    expect(systemPrompt).toContain("returned directive and input schema");
    expect(systemPrompt).toContain("ATTEMPT_INVALID_OR_EXPIRED");
    expect(systemPrompt).toContain("do not reuse the unavailable attempt");
  });
});
