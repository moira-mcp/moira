import { describe, expect, test } from "@jest/globals";
import { GraphValidator } from "../../../packages/workflow-engine/src/validation/graph-validator.js";
import { inlineGlobalInputs } from "../../../packages/workflow-engine/src/types/graph-nodes.js";
import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";

const itemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    dependencies: { type: "array", items: { type: "string" } },
  },
  required: ["id", "dependencies"],
};

const orderedPlanSchema = {
  type: "array",
  xOrderedUniqueReferences: { idProperty: "id", referencesProperty: "dependencies" },
  items: itemSchema,
};

describe("workflow schema keywords", () => {
  test("accepts a unique ordered plan and remains usable after a prior error", () => {
    const duplicate = [
      { id: "a", dependencies: [] },
      { id: "a", dependencies: ["a"] },
    ];
    const valid = [
      { id: "a", dependencies: [] },
      { id: "b", dependencies: ["a"] },
    ];

    expect(SchemaValidator.validate(duplicate, orderedPlanSchema).isValid).toBe(false);
    expect(SchemaValidator.validate(valid, orderedPlanSchema).isValid).toBe(true);
  });

  test.each([
    [[{ id: "a", dependencies: ["a"] }], "self reference"],
    [[{ id: "a", dependencies: ["missing"] }], "unknown reference"],
    [
      [
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: [] },
      ],
      "forward reference",
    ],
  ])("rejects %s", (plan) => {
    expect(SchemaValidator.validate(plan, orderedPlanSchema).isValid).toBe(false);
  });

  test("validates an evidence ledger against the current plan and repair boundary", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      xEvidenceBoundary: {
        reachProperty: "reach",
        boundaryProperty: "repair_from",
        planProperty: "steps",
        ledgerProperty: "evidence_ledger",
        workReach: "work",
        checkedReaches: ["plan", "work"],
      },
      properties: {
        reach: { enum: ["plan", "work"] },
        repair_from: { type: "integer" },
        evidence_ledger: { type: "array" },
      },
      required: ["reach", "repair_from", "evidence_ledger"],
    };
    const context = {
      steps: [{ id: "a" }, { id: "b" }],
      evidence_ledger: [
        { item_id: "a", status: "verified", actual_result: "one", verification: "proof-a" },
        { item_id: "b", status: "verified", actual_result: "two", verification: "proof-b" },
      ],
    };
    const first = context.evidence_ledger[0];
    const second = context.evidence_ledger[1];

    expect(
      SchemaValidator.validate(
        { reach: "plan", repair_from: 1, evidence_ledger: [first] },
        schema,
        context,
      ).isValid,
    ).toBe(true);
    expect(
      SchemaValidator.validate(
        { reach: "plan", repair_from: 1, evidence_ledger: [first, second] },
        schema,
        context,
      ).isValid,
    ).toBe(false);
    expect(
      SchemaValidator.validate(
        {
          reach: "plan",
          repair_from: 1,
          evidence_ledger: [{ ...first, actual_result: "rewritten" }],
        },
        schema,
        context,
      ).isValid,
    ).toBe(false);
    expect(
      SchemaValidator.validate(
        {
          reach: "plan",
          repair_from: 1,
          evidence_ledger: [{ ...first, verification: "rewritten" }],
        },
        schema,
        context,
      ).isValid,
    ).toBe(false);
    expect(
      SchemaValidator.validate(
        {
          reach: "plan",
          repair_from: 1,
          evidence_ledger: [{ item_id: "a", status: "skipped" }],
        },
        schema,
        context,
      ).isValid,
    ).toBe(false);
    expect(
      SchemaValidator.validate(
        { reach: "work", repair_from: 1, evidence_ledger: [first, second] },
        schema,
        context,
      ).isValid,
    ).toBe(true);
    expect(
      SchemaValidator.validate(
        {
          reach: "work",
          repair_from: 1,
          evidence_ledger: [first, { item_id: "b", status: "failed" }],
        },
        schema,
        context,
      ).isValid,
    ).toBe(false);
  });

  test("preserves contextual validation after global-input inlining", () => {
    const node = inlineGlobalInputs(
      {
        id: "repair",
        type: "agent-directive",
        directive: "repair",
        completionCondition: "repaired",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          xEvidenceBoundary: {
            reachProperty: "reach",
            boundaryProperty: "repair_from",
            planProperty: "steps",
            ledgerProperty: "ledger",
            workReach: "work",
            checkedReaches: ["work"],
          },
          properties: { repair_from: { type: "integer" } },
          required: ["reach", "repair_from", "ledger"],
          globalInputs: ["reach", "ledger"],
        },
        connections: { success: "end" },
      },
      {
        reach: { type: "string", description: "reach", enum: ["work"] },
        ledger: { type: "array", description: "ledger" },
      },
    );
    const schema = node.inputSchema as Record<string, unknown>;

    expect(
      SchemaValidator.validate(
        {
          reach: "work",
          repair_from: 0,
          ledger: [{ item_id: "a", status: "verified" }],
        },
        schema,
        {
          steps: [{ id: "a" }],
          ledger: [{ item_id: "a", status: "verified" }],
        },
      ).isValid,
    ).toBe(true);
  });

  test.each([
    [[{ id: "changed", action: "first", expected_result: "one" }], "stable identity"],
    [[{ id: "a", action: "changed", expected_result: "one" }], "completed action"],
    [[{ id: "a", action: "first", expected_result: "changed" }], "completed expected result"],
  ])("rejects replacement of protected %s", (steps) => {
    const schema = {
      type: "object",
      additionalProperties: false,
      xPreservePlanPrefix: { planProperty: "steps", boundaryContextProperty: "current_step" },
      properties: { steps: { type: "array" } },
      required: ["steps"],
    };
    const context = {
      current_step: 1,
      steps: [{ id: "a", action: "first", expected_result: "one" }],
    };

    expect(SchemaValidator.validate({ steps }, schema, context).isValid).toBe(false);
  });

  test("accepts a changed suffix when the protected prefix is deeply equal", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      xPreservePlanPrefix: { planProperty: "steps", boundaryContextProperty: "current_step" },
      properties: { steps: { type: "array" } },
      required: ["steps"],
    };
    const prefix = { id: "a", action: "first", expected_result: "one" };
    expect(
      SchemaValidator.validate(
        { steps: [prefix, { id: "b", action: "new", expected_result: "two" }] },
        schema,
        { current_step: 1, steps: [prefix, { id: "old" }] },
      ).isValid,
    ).toBe(true);
  });

  test("accepts a non-mutating response without a replacement plan", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      xPreservePlanPrefix: { planProperty: "steps", boundaryContextProperty: "current_step" },
      properties: {
        repair_status: { enum: ["repaired", "blocked"] },
        steps: { type: "array" },
      },
      required: ["repair_status"],
    };

    expect(
      SchemaValidator.validate({ repair_status: "blocked" }, schema, {
        current_step: 1,
        steps: [{ id: "a" }],
      }).isValid,
    ).toBe(true);
  });

  test("GraphValidator compiles valid keyword declarations and rejects malformed config", async () => {
    const workflow = (keyword: unknown) => ({
      id: "keyword-test",
      metadata: { name: "Keyword test", version: "1.0.0", description: "Keyword test" },
      variableRegistry: {
        steps: {
          ...orderedPlanSchema,
          description: "ordered plan",
          xOrderedUniqueReferences: keyword,
        },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "write" } },
        {
          id: "write",
          type: "agent-directive",
          directive: "write",
          completionCondition: "written",
          inputSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
            required: ["steps"],
            globalInputs: ["steps"],
          },
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    });
    const validator = new GraphValidator();

    expect(
      (
        await validator.validateUnified(
          workflow(orderedPlanSchema.xOrderedUniqueReferences) as never,
        )
      ).valid,
    ).toBe(true);
    const invalid = await validator.validateUnified(workflow({ idProperty: "id" }) as never);
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.some((issue) => issue.message.includes("referencesProperty"))).toBe(true);
  });
});
