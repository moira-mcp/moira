/**
 * Registry-as-JSON-Schema model tests (#565)
 *
 * The variableRegistry entry is a full JSON Schema property: `type` and `description`
 * are required, and any JSON Schema keyword (enum, items, properties, pattern, format,
 * minLength, minimum, ...) may be added. The workflow schema must accept rich entries
 * and still accept the simple {type, description} form (backward compatibility).
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

describe("Registry-as-JSON-Schema model", () => {
  const validator = new GraphValidator();

  test("accepts a simple {type, description} entry (backward compatible)", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({ name: { type: "string", description: "Project name" } }),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts an enum-constrained string entry", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        approved: { type: "string", description: "Approval gate", enum: ["yes", "no"] },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts an array entry with an items schema", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        tags: {
          type: "array",
          description: "Tag list",
          items: { type: "string", minLength: 1 },
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts an object entry with a nested properties schema", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        metric: {
          type: "object",
          description: "Primary metric",
          properties: {
            name: { type: "string" },
            target: { type: "number" },
          },
          required: ["name"],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("accepts a string entry with pattern and length constraints", async () => {
    const result = await validator.validateUnified(
      makeWorkflow({
        path: {
          type: "string",
          description: "Workspace-relative path",
          pattern: "^\\./moira-ws/.+",
          minLength: 12,
        },
      }),
    );
    expect(result.valid).toBe(true);
  });

  test("still requires type and description on a registry entry", async () => {
    const result = await validator.validateUnified(makeWorkflow({ broken: { enum: ["a", "b"] } }));
    expect(result.valid).toBe(false);
  });
});
