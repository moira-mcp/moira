/**
 * Registry entry JSON Schema validation (#565)
 *
 * Each variableRegistry entry must be a compilable JSON Schema (type + description required,
 * any keyword allowed). A malformed entry (bad items/pattern) is a blocking error; a missing
 * description is a blocking error.
 */

import { describe, test, expect } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";

function makeWorkflow(variableRegistry: Record<string, unknown>) {
  return {
    id: "test",
    metadata: { name: "Test", version: "1.0.0", description: "Test" },
    variableRegistry,
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  };
}

function registryErrors(result: { issues: { field?: string; message: string }[] }, name: string) {
  return result.issues.filter((i) => i.field === `variableRegistry.${name}`);
}

describe("Registry entry JSON Schema validation", () => {
  const validator = new GraphValidator();

  test("a rich, well-formed entry passes", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        tags: {
          type: "array",
          description: "Tag list",
          items: { type: "string", enum: ["a", "b"] },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("a malformed items schema is a blocking error", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        bad: { type: "array", description: "Bad array", items: { type: "not-a-type" } },
      }),
    );
    expect(result.valid).toBe(false);
    expect(registryErrors(result, "bad").length).toBeGreaterThan(0);
  });

  test("an invalid pattern is a blocking error", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        code: { type: "string", description: "Code", pattern: "(" },
      }),
    );
    expect(result.valid).toBe(false);
    expect(registryErrors(result, "code").length).toBeGreaterThan(0);
  });

  test("a missing description is a blocking error", async () => {
    // description is required both by the graph schema (AJV) and by the registry-entry check;
    // either layer makes this invalid. The schema layer runs first and short-circuits structural
    // validation, so assert on the outcome (invalid) plus a description-related message anywhere.
    const result = await validator.validateUnified(makeWorkflow({ nodesc: { type: "string" } }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => /description/i.test(i.message))).toBe(true);
  });

  test("a simple {type, description} entry passes", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({ name: { type: "string", description: "Name" } }),
    );
    expect(result.valid).toBe(true);
  });
});
