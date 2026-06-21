/**
 * Unit tests for the registry-schema remigration pure logic (#565).
 *
 * strengthen: restores lost JSON Schema keywords from a historical source into a current entry —
 *   only adds, never weakens, never removes, and never copies a keyword onto a mismatched type.
 * mergeOldSchemas: merges all pre-migration schemas observed for one output name into ONE safe
 *   source — union enums, loosest bounds, skip-on-conflict — so a shared global is never narrowed
 *   below what any node legitimately produced (the gate-rejects-valid-value defect class of #565).
 * inferGateEnums: derives a gate variable's enum from the literal values its condition nodes
 *   compare it against (Tier B heuristic).
 * collectExpressionTargets: finds globals mutated by expression nodes (counters) so value-bounding
 *   keywords are not restored for them (a counter must not be pinned to its reset value — #565).
 * bumpMinor: semver minor bump used for changed flows.
 */

import { describe, test, expect } from "@jest/globals";
import {
  strengthen,
  mergeOldSchemas,
  inferGateEnums,
  collectExpressionTargets,
  bumpMinor,
} from "../../../scripts/remigrate-registry-schemas.js";

describe("strengthen", () => {
  test("adds missing constraint keywords from the source", () => {
    const target: Record<string, unknown> = { type: "string", description: "Gate" };
    const source: Record<string, unknown> = { type: "string", enum: ["yes", "no"] };
    const added = strengthen(target, source);
    expect(added).toEqual(["enum"]);
    expect(target).toEqual({ type: "string", description: "Gate", enum: ["yes", "no"] });
  });

  test("restores array items and nested object properties", () => {
    const target: Record<string, unknown> = { type: "array", description: "Tags" };
    const source: Record<string, unknown> = { type: "array", items: { type: "string" } };
    strengthen(target, source);
    expect(target.items).toEqual({ type: "string" });
  });

  test("never overwrites a keyword the target already has", () => {
    const target: Record<string, unknown> = { type: "string", enum: ["a"] };
    const source: Record<string, unknown> = { type: "string", enum: ["x", "y"] };
    const added = strengthen(target, source);
    expect(added).toEqual([]);
    expect(target.enum).toEqual(["a"]);
  });

  test("never removes the target's description", () => {
    const target: Record<string, unknown> = { type: "string", description: "Keep me" };
    const source: Record<string, unknown> = { type: "string" };
    strengthen(target, source);
    expect(target.description).toBe("Keep me");
  });

  test("is idempotent — a second run adds nothing", () => {
    const target: Record<string, unknown> = { type: "string", description: "Gate" };
    const source: Record<string, unknown> = { type: "string", enum: ["yes", "no"] };
    strengthen(target, source);
    const secondAdded = strengthen(target, source);
    expect(secondAdded).toEqual([]);
  });

  test("copies nothing when source and target types disagree", () => {
    const target: Record<string, unknown> = { type: "number", description: "Count" };
    const source: Record<string, unknown> = { type: "string", enum: ["yes", "no"], pattern: "x" };
    const added = strengthen(target, source);
    expect(added).toEqual([]);
    expect(target).toEqual({ type: "number", description: "Count" });
  });

  test("skips a type-specific keyword that does not apply to the target type", () => {
    // `items` is array-only; the target is a string. Copying it would compile under non-strict
    // AJV but is meaningless, so it must be refused even though the source declares it.
    const target: Record<string, unknown> = { type: "string", description: "Name" };
    const source: Record<string, unknown> = {
      type: "string",
      items: { type: "string" },
      minLength: 2,
    };
    const added = strengthen(target, source);
    expect(added).toEqual(["minLength"]);
    expect("items" in target).toBe(false);
  });
});

describe("mergeOldSchemas", () => {
  test("returns the single schema unchanged when only one was observed", () => {
    const s = { type: "string", enum: ["a", "b"] };
    expect(mergeOldSchemas([s])).toEqual({ schema: s });
  });

  test("unions enum sets so the merged global accepts every node's legitimate value", () => {
    // The real test-suite-audit case: two gates, different enums, one shared global `decision`.
    const merged = mergeOldSchemas([
      { type: "string", enum: ["skip", "abort"] },
      { type: "string", enum: ["report_with_warnings", "revert_all", "abort"] },
    ]);
    expect(merged.conflict).toBeUndefined();
    expect(merged.schema?.enum).toEqual(["abort", "report_with_warnings", "revert_all", "skip"]);
  });

  test("drops a bound an open-bounded sibling left unconstrained (absence = unbounded)", () => {
    // The real news-to-podcast case: rank-news has {min:3,max:7}; revise-news-selection has {min:3}
    // (no max). The revise node accepted any count >= 3, so the merged global must NOT cap at 7 —
    // a legitimate selection of 8 must remain valid. `minimum:3` is declared by BOTH → it survives.
    const merged = mergeOldSchemas([
      { type: "number", minimum: 3, maximum: 7 },
      { type: "number", minimum: 3 },
    ]);
    expect(merged.schema?.minimum).toBe(3);
    expect("maximum" in (merged.schema as Record<string, unknown>)).toBe(false);
  });

  test("does NOT pin a loop counter to enum:[1] when a sibling left it open", () => {
    // The real robust-task::current_step case: a loop counter incremented `previous + 1`. One node
    // declared enum:[1], two declared only {minimum:1}. The open nodes accepted 2, 3, … so the
    // merged global must carry NO enum, or step 2 would be rejected and the loop break at step 1.
    const merged = mergeOldSchemas([
      { type: "number", minimum: 1 },
      { type: "number", enum: [1] },
      { type: "number", minimum: 1 },
    ]);
    expect("enum" in (merged.schema as Record<string, unknown>)).toBe(false);
    // minimum:1 is declared by two of three observations — the third omits it → unbounded → dropped.
    expect("minimum" in (merged.schema as Record<string, unknown>)).toBe(false);
    expect(merged.schema).toEqual({ type: "number" });
  });

  test("keeps the loosest bound only when EVERY observation declares it", () => {
    const merged = mergeOldSchemas([
      { type: "number", minimum: 5, maximum: 7 },
      { type: "number", minimum: 1, maximum: 99 },
    ]);
    expect(merged.schema?.minimum).toBe(1);
    expect(merged.schema?.maximum).toBe(99);
  });

  test("does not co-emit numeric bounds alongside a surviving enum", () => {
    const merged = mergeOldSchemas([
      { type: "number", enum: [1, 2], minimum: 1 },
      { type: "number", enum: [2, 3], minimum: 1 },
    ]);
    expect(merged.schema?.enum).toEqual([1, 2, 3]);
    expect("minimum" in (merged.schema as Record<string, unknown>)).toBe(false);
  });

  test("reports a conflict (no schema) when observed types disagree", () => {
    const merged = mergeOldSchemas([
      { type: "string", enum: ["1"] },
      { type: "number", minimum: 1 },
    ]);
    expect(merged.schema).toBeUndefined();
    expect(merged.conflict).toMatch(/type disagreement/);
  });

  test("drops items (any element) when element schemas are irreconcilable (type mismatch)", () => {
    // items reconciliation recurses; a type disagreement inside items has no safe merge, so items is
    // dropped (loosest: any element) rather than the whole name becoming a hard conflict.
    const merged = mergeOldSchemas([
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "number" } },
    ]);
    expect(merged.conflict).toBeUndefined();
    expect("items" in (merged.schema as Record<string, unknown>)).toBe(false);
    expect(merged.schema?.type).toBe("array");
  });

  test("reconciles array items: UNION of element properties, INTERSECTION of required", () => {
    // The real architecture-design-flow::glossary / bounded_contexts case: two writers, object
    // elements with different property sets and required lists.
    const merged = mergeOldSchemas([
      {
        type: "array",
        items: {
          type: "object",
          properties: {
            term: { type: "string" },
            definition: { type: "string" },
            context: { type: "string" },
          },
          required: ["term", "definition"],
        },
        minItems: 10,
      },
      {
        type: "array",
        items: {
          type: "object",
          properties: { term: { type: "string" }, definition: { type: "string" } },
          required: ["term", "definition"],
        },
        minItems: 5,
      },
    ]);
    const items = merged.schema?.items as Record<string, unknown>;
    expect(Object.keys(items.properties as object).sort()).toEqual([
      "context",
      "definition",
      "term",
    ]);
    expect(items.required).toEqual(["term", "definition"]);
    expect(merged.schema?.minItems).toBe(5); // loosest
  });

  test("required is the INTERSECTION when writers require different keys", () => {
    const merged = mergeOldSchemas([
      {
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a", "b"],
      },
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    ]);
    expect(merged.schema?.required).toEqual(["a"]);
    expect(Object.keys(merged.schema?.properties as object).sort()).toEqual(["a", "b"]);
  });

  test("adopts a structural keyword only when EVERY observation declares it and they agree", () => {
    const merged = mergeOldSchemas([
      { type: "array", items: { type: "string" } },
      { type: "array", items: { type: "string" } },
    ]);
    expect(merged.schema?.items).toEqual({ type: "string" });
  });

  test("drops a structural keyword an open sibling left unconstrained (absence = unbounded)", () => {
    // One node typed its array elements, the other accepted any element. The merged global must
    // accept any element too — so `items` is dropped, not adopted from the one declarer.
    const merged = mergeOldSchemas([
      { type: "array", items: { type: "string" } },
      { type: "array" },
    ]);
    expect("items" in (merged.schema as Record<string, unknown>)).toBe(false);
  });
});

describe("inferGateEnums", () => {
  function flowWithConditions(conditions: unknown[]) {
    return {
      nodes: conditions.map((condition, i) => ({ id: `c${i}`, type: "condition", condition })),
    } as Record<string, unknown>;
  }

  test("infers an enum from eq comparisons against a bare-name global", () => {
    const flow = flowWithConditions([
      { operator: "eq", left: { contextPath: "decision" }, right: "continue" },
      { operator: "eq", left: { contextPath: "decision" }, right: "reset" },
    ]);
    const enums = inferGateEnums(flow);
    expect(enums.get("decision")).toEqual(["continue", "reset"]);
  });

  test("ignores node-id.name locals (not globals)", () => {
    const flow = flowWithConditions([
      { operator: "eq", left: { contextPath: "approve.approved" }, right: "yes" },
    ]);
    expect(inferGateEnums(flow).has("approve.approved")).toBe(false);
  });

  test("excludes neq-against-empty presence checks (not gates)", () => {
    const flow = flowWithConditions([
      { operator: "neq", left: { contextPath: "local_workflow_path" }, right: "" },
    ]);
    expect(inferGateEnums(flow).has("local_workflow_path")).toBe(false);
  });

  test("walks nested and/or condition trees", () => {
    const flow = flowWithConditions([
      {
        operator: "or",
        conditions: [
          { operator: "eq", left: { contextPath: "error_action" }, right: "retry" },
          { operator: "eq", left: { contextPath: "error_action" }, right: "skip" },
        ],
      },
    ]);
    expect(inferGateEnums(flow).get("error_action")).toEqual(["retry", "skip"]);
  });

  test("does not collect a disallowed value from under a `not`", () => {
    // `not(eq(status, "blocked"))` means status must NOT be "blocked" — collecting it as an enum
    // member would suggest the very value the gate excludes.
    const flow = flowWithConditions([
      {
        operator: "not",
        condition: { operator: "eq", left: { contextPath: "status" }, right: "blocked" },
      },
    ]);
    expect(inferGateEnums(flow).has("status")).toBe(false);
  });
});

describe("collectExpressionTargets", () => {
  function flowWithExpressions(nodes: Array<{ type: string; expressions?: string[] }>) {
    return { nodes } as Record<string, unknown>;
  }

  test("collects the assignment target of an expression (a counter)", () => {
    const flow = flowWithExpressions([
      { type: "expression", expressions: ["step_retry = step_retry + 1"] },
      { type: "expression", expressions: ["step_retry = 0"] },
    ]);
    const targets = collectExpressionTargets(flow);
    expect(targets.has("step_retry")).toBe(true);
  });

  test("collects multiple distinct targets across nodes", () => {
    const flow = flowWithExpressions([
      { type: "expression", expressions: ["retry_count = retry_count + 1"] },
      { type: "expression", expressions: ["total = a + b"] },
    ]);
    const targets = collectExpressionTargets(flow);
    expect([...targets].sort()).toEqual(["retry_count", "total"]);
  });

  test("ignores node-id.name (non-global) assignment targets", () => {
    const flow = flowWithExpressions([
      { type: "expression", expressions: ["node-1.local = node-1.local + 1"] },
    ]);
    expect(collectExpressionTargets(flow).has("node-1.local")).toBe(false);
  });

  test("ignores non-expression nodes", () => {
    const flow = flowWithExpressions([{ type: "condition" }, { type: "agent-directive" }]);
    expect(collectExpressionTargets(flow).size).toBe(0);
  });

  test("a counter target's value-bounding keywords are dropped before restoration", () => {
    // strengthen still copies whatever the caller passes; the SOURCE for a counter is cleaned of
    // enum/minimum/maximum by main(). Emulate that cleaning to assert the contract end-to-end:
    // a reset-node source { type:number, enum:[0] } must NOT pin the counter.
    const source: Record<string, unknown> = {
      type: "number",
      description: "Retry counter",
      enum: [0],
      minimum: 0,
    };
    const VALUE_BOUNDING = ["enum", "minimum", "maximum"];
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source)) if (!VALUE_BOUNDING.includes(k)) cleaned[k] = v;
    const target: Record<string, unknown> = { type: "number", description: "Retry counter" };
    const added = strengthen(target, cleaned);
    expect(added).toEqual([]); // nothing value-bounding restored onto the counter
    expect("enum" in target).toBe(false);
    expect("minimum" in target).toBe(false);
  });
});

describe("bumpMinor", () => {
  test("increments the minor and zeroes the patch", () => {
    expect(bumpMinor("1.4.7")).toBe("1.5.0");
    expect(bumpMinor("0.0.0")).toBe("0.1.0");
  });

  test("returns null for non-semver input", () => {
    expect(bumpMinor("1.4")).toBeNull();
    expect(bumpMinor("v1.4.0")).toBeNull();
    expect(bumpMinor("1.x.0")).toBeNull();
  });
});
