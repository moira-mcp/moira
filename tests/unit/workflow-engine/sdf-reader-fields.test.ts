/**
 * Every line an SDF notification writes from the run comes from a field the step writes for a
 * person, and the step cannot skip it: each source of a gate's reason, the unit result, the final
 * report's link and summaries, and the goal after a requirements revision. Checked on each node's
 * own schema, as the agent's answer is validated.
 */

import { describe, expect, test } from "@jest/globals";
import { inlineGlobalInputs, type AgentDirectiveNode } from "@mcp-moira/workflow-engine";
import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

const sdf = systemCatalogGraph("software-development-flow", "public");

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  allOf?: Array<{
    if: { properties: Record<string, { const?: unknown; enum?: unknown[] }> };
    then: { required: string[] };
  }>;
};

function schemaOf(nodeId: string): JsonSchema {
  const node = sdf.nodes.find((candidate) => candidate.id === nodeId)!;
  return (inlineGlobalInputs(node, sdf.variableRegistry) as AgentDirectiveNode)
    .inputSchema as JsonSchema;
}

/** A plausible value for a field, enough for its type, enum, bound and URL or file pattern. */
function sample(name: string, field: JsonSchema): unknown {
  if (field.enum) return field.enum[0];
  if (field.type === "integer" || field.type === "number") return field.minimum ?? 0;
  if (field.type === "boolean") return false;
  if (field.type === "array") return [{ title: "Implement the change" }];
  if (field.pattern?.includes("https")) return "https://report.example/";
  if (field.pattern?.includes("review")) return "./moira-ws/x/final-reviews/001/review.md";
  return `${name} value`;
}

/** A complete answer with `chosen` values, every field its schema then requires filled in. */
function answer(nodeId: string, chosen: Record<string, unknown>): Record<string, unknown> {
  const schema = schemaOf(nodeId);
  const result: Record<string, unknown> = { ...chosen };
  const fill = (names: string[]) => {
    for (const name of names) {
      if (!(name in result)) result[name] = sample(name, schema.properties?.[name] ?? {});
    }
  };
  fill(schema.required ?? []);
  for (const rule of schema.allOf ?? []) {
    const holds = Object.entries(rule.if.properties).every(([name, condition]) =>
      "const" in condition
        ? result[name] === condition.const
        : condition.enum?.includes(result[name]),
    );
    if (holds) fill(rule.then.required);
  }
  return result;
}

const accepts = (nodeId: string, value: Record<string, unknown>) =>
  SchemaValidator.validate(value, schemaOf(nodeId) as Record<string, unknown>).isValid;

const without = (value: Record<string, unknown>, field: string) => {
  const copy = { ...value };
  delete copy[field];
  return copy;
};

describe("SDF's reader fields are required where a message reads them", () => {
  test.each([
    ["assess-project-health", "health_outcome", "external_blocker"],
    ["validate-runtime", "validation_outcome", "external_blocker"],
    ["validate-expensive", "validation_outcome", "external_blocker"],
    ["validate-feature-wide", "validation_outcome", "external_blocker"],
    ["finalize-feature", "finalization_outcome", "external_blocker"],
    ["prepare-plan-unit-implementation", "preparation_outcome", "replan"],
    ["complete-plan-unit", "completion_outcome", "replan"],
    ["repair-cheap-validation", "repair_outcome", "replan"],
    ["review-test-adequacy", "review_outcome", "replan"],
    ["repair-test-adequacy", "repair_outcome", "replan"],
    ["review-architecture", "review_outcome", "replan"],
    ["repair-architecture", "repair_outcome", "replan"],
    ["repair-runtime", "repair_outcome", "replan"],
    ["update-unit-documentation", "documentation_outcome", "replan"],
    ["repair-expensive", "repair_outcome", "replan"],
    ["review-unit-completeness", "review_outcome", "replan"],
    ["repair-unit-completeness", "repair_outcome", "replan"],
  ])("%s gives the reason when %s is %s", (nodeId, field, value) => {
    const complete = answer(nodeId, { [field]: value, blocker_summary: "The registry is down" });
    expect(accepts(nodeId, complete)).toBe(true);
    expect(accepts(nodeId, without(complete, "blocker_summary"))).toBe(false);
  });

  test.each([
    ["review-unit-completeness", { review_outcome: "pass" }, "unit_result_summary"],
    ["create-final-report", {}, "final_report_url"],
    ["create-final-report", {}, "outcome_summary"],
    ["create-final-report", {}, "limitations_summary"],
    ["capture-task-and-context", {}, "goal_summary"],
    ["revise-requirements", {}, "goal_summary"],
    ["create-plan", {}, "plan_units"],
  ] as const)("%s cannot leave out %s", (nodeId, chosen, field) => {
    const complete = answer(nodeId, { ...chosen });
    expect(accepts(nodeId, complete)).toBe(true);
    expect(accepts(nodeId, without(complete, field))).toBe(false);
  });

  test("intake accepts an omitted or arbitrary bounded note independently of the mandatory goal", () => {
    const nodeId = "capture-task-and-context";
    const complete = answer(nodeId, { goal_summary: "Users can export their data" });
    expect(complete).not.toHaveProperty("execution_note");
    expect(accepts(nodeId, complete)).toBe(true);
    for (const execution_note of [
      "The test environment differs from production",
      "N",
      "N".repeat(120),
    ]) {
      expect(accepts(nodeId, { ...complete, execution_note })).toBe(true);
    }
    expect(accepts(nodeId, without(complete, "goal_summary"))).toBe(false);
  });

  test.each([
    ["non-string", 17],
    ["empty", ""],
    ["over maximum", "N".repeat(121)],
  ])("intake still rejects a supplied %s note", (_kind, execution_note) => {
    const nodeId = "capture-task-and-context";
    expect(accepts(nodeId, { ...answer(nodeId, {}), execution_note })).toBe(false);
  });
});
